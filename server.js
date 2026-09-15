'use strict';

require('dotenv').config();

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { ChatStore } = require('./lib/store');
const gifs = require('./lib/gifs');

const PORT = Number(process.env.PORT || 3000);
const ROOM_PASSWORD = (process.env.ROOM_PASSWORD || '').trim();
const TENOR_API_KEY = (process.env.TENOR_API_KEY || '').trim();
const CHATS_DIR = process.env.CHATS_DIR
  ? path.resolve(process.env.CHATS_DIR)
  : path.join(__dirname, 'EasyChat Chats');
const MAX_MESSAGES_PER_ROOM = Number(process.env.MAX_MESSAGES_PER_ROOM || 2000);

const MAX_TEXT_LENGTH = 4000;
const HISTORY_LIMIT = 300;
const TYPING_TTL_MS = 6000;
const RATE_LIMIT = { messages: 10, windowMs: 10000 };

const store = new ChatStore({ dir: CHATS_DIR, maxMessages: MAX_MESSAGES_PER_ROOM });

const app = express();
app.use(express.json({ limit: '32kb' }));
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

app.get('/api/config', (_req, res) => {
  res.json({ requiresPassword: ROOM_PASSWORD.length > 0, gifsEnabled: TENOR_API_KEY.length > 0 });
});

app.get('/api/gifs/:mode', async (req, res) => {
  if (!TENOR_API_KEY) {
    return res.status(503).json({ error: 'GIF search is not configured on this host.' });
  }
  const { mode } = req.params;
  const pos = typeof req.query.pos === 'string' ? req.query.pos.slice(0, 200) : '';
  try {
    if (mode === 'search') {
      const q = String(req.query.q || '').trim().slice(0, 100);
      if (!q) return res.json({ results: [], next: '' });
      return res.json(await gifs.search(TENOR_API_KEY, q, pos));
    }
    if (mode === 'trending') {
      return res.json(await gifs.featured(TENOR_API_KEY, pos));
    }
    return res.status(404).json({ error: 'Unknown GIF endpoint.' });
  } catch (err) {
    console.error('[gifs]', err.message);
    return res.status(502).json({ error: 'Could not reach Tenor. Try again in a moment.' });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

/** ws -> { id, username, roomId, joinedAt, stamps: number[] } */
const clients = new Map();
/** roomId -> Map(clientId, { username, expires }) */
const typingByRoom = new Map();

function passwordOk(candidate) {
  if (!ROOM_PASSWORD) return true;
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(ROOM_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function cleanUsername(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 24) return null;
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(name)) return null;
  return name;
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(roomId, payload, except = null) {
  const data = JSON.stringify(payload);
  for (const [ws, client] of clients) {
    if (client.roomId !== roomId || ws === except) continue;
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const [ws, client] of clients) {
    if (!client.username) continue;
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function membersOf(roomId) {
  const seen = new Map();
  for (const client of clients.values()) {
    if (client.roomId !== roomId || !client.username) continue;
    if (!seen.has(client.username)) seen.set(client.username, { username: client.username, since: client.joinedAt });
  }
  return [...seen.values()].sort((a, b) => a.username.localeCompare(b.username));
}

function pushPresence(roomId) {
  broadcast(roomId, { type: 'presence', roomId, members: membersOf(roomId) });
  broadcastAll({ type: 'rooms', rooms: roomsWithPresence() });
}

function roomsWithPresence() {
  const counts = new Map();
  for (const client of clients.values()) {
    if (!client.roomId || !client.username) continue;
    counts.set(client.roomId, (counts.get(client.roomId) || 0) + 1);
  }
  return store.listRooms().map((room) => ({ ...room, online: counts.get(room.id) || 0 }));
}

function pushTyping(roomId) {
  const typers = typingByRoom.get(roomId);
  const now = Date.now();
  const active = [];
  if (typers) {
    for (const [clientId, entry] of typers) {
      if (entry.expires <= now) typers.delete(clientId);
      else if (!active.includes(entry.username)) active.push(entry.username);
    }
  }
  broadcast(roomId, { type: 'typing', roomId, users: active });
}

function setTyping(client, isTyping) {
  if (!client.roomId) return;
  if (!typingByRoom.has(client.roomId)) typingByRoom.set(client.roomId, new Map());
  const typers = typingByRoom.get(client.roomId);
  if (isTyping) typers.set(client.id, { username: client.username, expires: Date.now() + TYPING_TTL_MS });
  else typers.delete(client.id);
  pushTyping(client.roomId);
}

function clearTypingEverywhere(client) {
  for (const [roomId, typers] of typingByRoom) {
    if (typers.delete(client.id)) pushTyping(roomId);
  }
}

function rateLimited(client) {
  const now = Date.now();
  client.stamps = client.stamps.filter((ts) => now - ts < RATE_LIMIT.windowMs);
  if (client.stamps.length >= RATE_LIMIT.messages) return true;
  client.stamps.push(now);
  return false;
}

function systemMessage(roomId, text) {
  const message = { id: crypto.randomUUID(), type: 'system', text, ts: Date.now() };
  store.addMessage(roomId, message);
  broadcast(roomId, { type: 'message', roomId, message });
}

/**
 * A dropped connection reconnects a second later, so "left"/"joined" is held
 * briefly: if the same name comes back to the room in time, nobody sees it.
 */
const pendingLeaves = new Map();
const LEAVE_GRACE_MS = 8000;

function leaveKey(roomId, username) {
  return `${roomId}\u0000${username}`;
}

function announceLeave(roomId, username) {
  const key = leaveKey(roomId, username);
  clearTimeout(pendingLeaves.get(key));
  const timer = setTimeout(() => {
    pendingLeaves.delete(key);
    systemMessage(roomId, `${username} left the room.`);
  }, LEAVE_GRACE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  pendingLeaves.set(key, timer);
}

function announceJoin(roomId, username) {
  const key = leaveKey(roomId, username);
  if (pendingLeaves.has(key)) {
    clearTimeout(pendingLeaves.get(key));
    pendingLeaves.delete(key);
    return; // they never really left
  }
  systemMessage(roomId, `${username} joined the room.`);
}

function enterRoom(ws, client, roomId) {
  const room = store.getRoom(roomId);
  if (!room) return send(ws, { type: 'error', code: 'no-room', message: 'That room no longer exists.' });

  const previous = client.roomId;
  if (previous === roomId) return;
  if (previous) {
    clearTypingEverywhere(client);
    announceLeave(previous, client.username);
  }
  client.roomId = roomId;
  send(ws, {
    type: 'room',
    room: { id: room.id, name: room.name, topic: room.topic },
    messages: store.recentMessages(roomId, HISTORY_LIMIT),
    members: membersOf(roomId),
  });
  announceJoin(roomId, client.username);
  if (previous) pushPresence(previous);
  pushPresence(roomId);
}

function handleJoin(ws, client, data) {
  if (client.username) return;
  const username = cleanUsername(data.username);
  if (!username) {
    return send(ws, {
      type: 'error',
      code: 'bad-username',
      message: '2 to 24 characters, letters/numbers/spaces and . _ - only.',
    });
  }
  if (!passwordOk(data.password)) {
    return send(ws, { type: 'error', code: 'bad-password', message: 'That passcode is not right.' });
  }
  client.username = username;
  client.joinedAt = Date.now();
  const rooms = roomsWithPresence();
  const wanted = rooms.some((room) => room.id === data.roomId) ? data.roomId : rooms[0].id;
  send(ws, { type: 'welcome', username, rooms, gifsEnabled: TENOR_API_KEY.length > 0 });
  enterRoom(ws, client, wanted);
}

function handleMessage(ws, client, data) {
  if (!client.roomId) return;
  if (rateLimited(client)) {
    return send(ws, { type: 'error', code: 'rate-limit', message: 'Slow down a moment.' });
  }

  const text = String(data.text || '').slice(0, MAX_TEXT_LENGTH).trim();
  const gif = data.gif && typeof data.gif === 'object' ? data.gif : null;
  let attachment = null;
  if (gif && typeof gif.url === 'string' && /^https:\/\/media\d*\.tenor\.com\//.test(gif.url)) {
    attachment = {
      kind: 'gif',
      url: gif.url,
      preview: typeof gif.preview === 'string' ? gif.preview : gif.url,
      width: Number(gif.width) || 320,
      height: Number(gif.height) || 240,
      title: String(gif.title || 'GIF').slice(0, 120),
    };
  }
  if (!text && !attachment) return;

  const message = {
    id: crypto.randomUUID(),
    type: 'chat',
    user: client.username,
    text,
    attachment,
    ts: Date.now(),
  };
  store.addMessage(client.roomId, message);
  setTyping(client, false);
  broadcast(client.roomId, { type: 'message', roomId: client.roomId, message });
  broadcastAll({ type: 'rooms', rooms: roomsWithPresence() });
}

async function handleCreateRoom(ws, client, data) {
  const name = String(data.name || '').trim().slice(0, 40);
  if (name.length < 2) {
    return send(ws, { type: 'error', code: 'bad-room', message: 'Room names need at least 2 characters.' });
  }
  if (store.hasRoomNamed(name)) {
    return send(ws, { type: 'error', code: 'dup-room', message: `"${name}" already exists.` });
  }
  const room = await store.createRoom(name, String(data.topic || '').trim());
  broadcastAll({ type: 'rooms', rooms: roomsWithPresence() });
  enterRoom(ws, client, room.id);
}

wss.on('connection', (ws) => {
  const client = { id: crypto.randomUUID(), username: null, roomId: null, joinedAt: 0, stamps: [] };
  clients.set(ws, client);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  send(ws, { type: 'hello', requiresPassword: ROOM_PASSWORD.length > 0, gifsEnabled: TENOR_API_KEY.length > 0 });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'join') return handleJoin(ws, client, data);
    if (!client.username) return send(ws, { type: 'error', code: 'not-joined', message: 'Join first.' });

    switch (data.type) {
      case 'message':
        return handleMessage(ws, client, data);
      case 'typing':
        return setTyping(client, Boolean(data.state));
      case 'switch':
        return enterRoom(ws, client, String(data.roomId || ''));
      case 'create-room':
        return void handleCreateRoom(ws, client, data);
      default:
        return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    clearTypingEverywhere(client);
    if (client.username && client.roomId) {
      announceLeave(client.roomId, client.username);
      pushPresence(client.roomId);
    }
  });

  ws.on('error', () => ws.terminate());
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();

const typingSweep = setInterval(() => {
  for (const roomId of typingByRoom.keys()) pushTyping(roomId);
}, 2500);
typingSweep.unref();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nSaving chats...');
  store.flushSync();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

store
  .init()
  .then(() => {
    server.listen(PORT, () => {
      console.log('');
      console.log('  EasyChat is running');
      console.log(`  Local:      http://localhost:${PORT}`);
      console.log(`  Chats:      ${CHATS_DIR}`);
      console.log(`  Passcode:   ${ROOM_PASSWORD ? 'required' : 'none (anyone with the link can join)'}`);
      console.log(`  GIF search: ${TENOR_API_KEY ? 'on (Tenor)' : 'off (set TENOR_API_KEY in .env)'}`);
      console.log('');
      console.log(`  Share it:   cloudflared tunnel --url http://localhost:${PORT}`);
      console.log('');
    });
  })
  .catch((err) => {
    console.error('Failed to start EasyChat:', err);
    process.exit(1);
  });
