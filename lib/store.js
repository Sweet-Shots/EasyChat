'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SAVE_DEBOUNCE_MS = 400;

function slugify(name) {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'room';
}

/**
 * Every room is one JSON file inside the chats directory, so the host can read,
 * back up or hand-edit a conversation with nothing but a text editor.
 */
class ChatStore {
  constructor({ dir, maxMessages = 2000 }) {
    this.dir = dir;
    this.maxMessages = maxMessages;
    this.rooms = new Map();
    this.pendingSaves = new Map();
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    const entries = await fsp.readdir(this.dir);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const full = path.join(this.dir, entry);
      try {
        const room = JSON.parse(await fsp.readFile(full, 'utf8'));
        if (!room || typeof room.id !== 'string') throw new Error('missing room id');
        room.messages = Array.isArray(room.messages) ? room.messages : [];
        this.rooms.set(room.id, room);
      } catch (err) {
        console.warn(`[store] skipping ${entry}: ${err.message}`);
      }
    }
    if (this.rooms.size === 0) {
      await this.createRoom('General', 'The default room. Say hi.');
      await this.createRoom('Random', 'Off-topic, memes, GIF wars.');
    }
    return this;
  }

  filePath(id) {
    return path.join(this.dir, `${id}.json`);
  }

  listRooms() {
    return [...this.rooms.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((room) => ({
        id: room.id,
        name: room.name,
        topic: room.topic || '',
        messageCount: room.messages.length,
        lastActivity: room.messages.length ? room.messages[room.messages.length - 1].ts : room.createdAt,
      }));
  }

  getRoom(id) {
    return this.rooms.get(id) || null;
  }

  hasRoomNamed(name) {
    const wanted = name.trim().toLowerCase();
    return [...this.rooms.values()].some((room) => room.name.toLowerCase() === wanted);
  }

  async createRoom(name, topic = '') {
    const clean = name.trim().slice(0, 40);
    let id = slugify(clean);
    while (this.rooms.has(id)) id = `${slugify(clean)}-${crypto.randomBytes(2).toString('hex')}`;
    const room = { id, name: clean, topic: topic.slice(0, 120), createdAt: Date.now(), messages: [] };
    this.rooms.set(id, room);
    await this.save(id);
    return room;
  }

  addMessage(roomId, message) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.messages.push(message);
    if (room.messages.length > this.maxMessages) {
      room.messages.splice(0, room.messages.length - this.maxMessages);
    }
    this.scheduleSave(roomId);
    return message;
  }

  recentMessages(roomId, limit = 200) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return room.messages.slice(-limit);
  }

  scheduleSave(roomId) {
    if (this.pendingSaves.has(roomId)) return;
    const timer = setTimeout(() => {
      this.pendingSaves.delete(roomId);
      this.save(roomId).catch((err) => console.error(`[store] save failed for ${roomId}:`, err.message));
    }, SAVE_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.pendingSaves.set(roomId, timer);
  }

  async save(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const target = this.filePath(roomId);
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(room, null, 2), 'utf8');
    await fsp.rename(tmp, target);
  }

  /** Synchronous so it can run from a process exit handler. */
  flushSync() {
    for (const timer of this.pendingSaves.values()) clearTimeout(timer);
    this.pendingSaves.clear();
    for (const room of this.rooms.values()) {
      try {
        fs.writeFileSync(this.filePath(room.id), JSON.stringify(room, null, 2), 'utf8');
      } catch (err) {
        console.error(`[store] flush failed for ${room.id}:`, err.message);
      }
    }
  }
}

module.exports = { ChatStore, slugify };
