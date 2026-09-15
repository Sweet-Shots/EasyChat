/* ============================================================
   EasyChat client
   ============================================================ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    gate: $('gate'),
    gateForm: $('gate-form'),
    gateUser: $('gate-username'),
    gatePass: $('gate-password'),
    gatePassField: $('gate-password-field'),
    gateError: $('gate-error'),
    gateSubmit: $('gate-submit'),

    app: $('app'),
    scrim: $('scrim'),
    sidebar: $('sidebar'),
    sidebarOpen: $('sidebar-open'),
    sidebarClose: $('sidebar-close'),

    roomList: $('room-list'),
    memberList: $('member-list'),
    memberCount: $('member-count'),
    roomName: $('room-name'),
    roomTopic: $('room-topic'),
    roomOnline: $('room-online').querySelector('span'),

    messages: $('messages'),
    inner: $('messages-inner'),
    jump: $('jump'),
    typing: $('typing'),
    typingText: $('typing-text'),

    form: $('composer-form'),
    input: $('input'),
    send: $('send'),
    gifBtn: $('gif-btn'),
    attach: $('gif-attachment'),
    attachImg: $('gif-attachment-img'),
    attachRemove: $('gif-attachment-remove'),

    gifPanel: $('gif-panel'),
    gifSearch: $('gif-search'),
    gifClose: $('gif-close'),
    gifResults: $('gif-results'),
    gifStatus: $('gif-status'),

    roomModal: $('room-modal'),
    roomForm: $('room-form'),
    roomInput: $('room-input'),
    roomPasswordInput: $('room-password-input'),
    roomTopicInput: $('room-topic-input'),
    roomError: $('room-error'),
    roomCancel: $('room-cancel'),
    newRoom: $('new-room'),
    roomLock: $('room-lock'),

    unlockModal: $('unlock-modal'),
    unlockForm: $('unlock-form'),
    unlockTitle: $('unlock-title'),
    unlockInput: $('unlock-input'),
    unlockError: $('unlock-error'),
    unlockCancel: $('unlock-cancel'),

    meName: $('me-name'),
    meAvatar: $('me-avatar'),
    connState: $('conn-state'),
    toasts: $('toasts'),
  };

  const state = {
    ws: null,
    me: '',
    password: '',
    roomId: '',
    rooms: [],
    unread: new Map(),
    lastMessage: null,
    lastDay: '',
    pendingGif: null,
    typingSince: 0,
    reconnectAttempts: 0,
    joined: false,
    stickToBottom: true,
    missed: 0,
    gifsEnabled: false,
    roomKeys: {},      // roomId -> the password this browser has already used
    pendingUnlock: '', // room the unlock dialog is asking about
    pendingRoomKey: null, // password waiting to be confirmed by the server
  };

  /* Room passwords live in this tab only, so a reconnect does not re-ask. */
  function loadRoomKeys() {
    try {
      state.roomKeys = JSON.parse(sessionStorage.getItem('easychat.roomKeys') || '{}') || {};
    } catch {
      state.roomKeys = {};
    }
  }

  function rememberRoomKey(roomId, password) {
    state.roomKeys[roomId] = password;
    try {
      sessionStorage.setItem('easychat.roomKeys', JSON.stringify(state.roomKeys));
    } catch {
      /* private mode - the key just lives in memory */
    }
  }

  function rememberLastRoom(roomId) {
    try {
      sessionStorage.setItem('easychat.lastRoom', roomId);
    } catch {
      /* ignore */
    }
  }

  function lastRoom() {
    try {
      return sessionStorage.getItem('easychat.lastRoom') || '';
    } catch {
      return '';
    }
  }

  function forgetRoomKey(roomId) {
    delete state.roomKeys[roomId];
    try {
      sessionStorage.setItem('easychat.roomKeys', JSON.stringify(state.roomKeys));
    } catch {
      /* ignore */
    }
  }

  /* ---------- helpers ---------- */

  function hueOf(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
    return hash;
  }

  function avatarFor(name, size) {
    const node = document.createElement('div');
    node.className = `avatar${size ? ` avatar--${size}` : ''}`;
    const hue = hueOf(name);
    node.style.background = `linear-gradient(135deg, hsl(${hue} 78% 62%), hsl(${(hue + 32) % 360} 72% 48%))`;
    node.textContent = name.trim().charAt(0) || '?';
    node.title = name;
    return node;
  }

  function timeOf(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function dayOf(ts) {
    const date = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(date, today)) return 'Today';
    if (same(date, yesterday)) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function toast(message, kind) {
    const node = document.createElement('div');
    node.className = `toast${kind ? ` toast--${kind}` : ''}`;
    node.textContent = message;
    el.toasts.appendChild(node);
    setTimeout(() => {
      node.classList.add('toast--leaving');
      setTimeout(() => node.remove(), 320);
    }, 3200);
  }

  /* ---------- scrolling ---------- */

  function nearBottom() {
    const gap = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight;
    return gap < 120;
  }

  function scrollToBottom(smooth) {
    el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    state.stickToBottom = true;
    state.missed = 0;
    el.jump.hidden = true;
  }

  el.messages.addEventListener('scroll', () => {
    state.stickToBottom = nearBottom();
    if (state.stickToBottom) {
      state.missed = 0;
      el.jump.hidden = true;
    }
  });
  el.jump.addEventListener('click', () => scrollToBottom(true));

  /* ---------- rendering ---------- */

  function clearMessages() {
    el.inner.textContent = '';
    state.lastMessage = null;
    state.lastDay = '';
  }

  function showEmptyState(roomLabel) {
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    wrap.innerHTML =
      '<div class="empty__mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A3.5 3.5 0 0 1 6.5 3h11A3.5 3.5 0 0 1 21 6.5v7a3.5 3.5 0 0 1-3.5 3.5H10l-4.6 3.7A.9.9 0 0 1 4 20v-3.2A3.5 3.5 0 0 1 3 14.3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 8.5h8M8 12h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>' +
      '<h3>Nothing here yet</h3>' +
      `<p>Be the first to say something in ${EasyMarkdown.escapeHtml(roomLabel)}.</p>`;
    el.inner.appendChild(wrap);
  }

  function addDayDivider(ts) {
    const label = dayOf(ts);
    if (label === state.lastDay) return;
    state.lastDay = label;
    const node = document.createElement('div');
    node.className = 'day';
    node.textContent = label;
    el.inner.appendChild(node);
  }

  function renderMessage(message, options) {
    const animate = !options || options.animate !== false;
    const empty = el.inner.querySelector('.empty');
    if (empty) empty.remove();

    if (message.type === 'system') {
      addDayDivider(message.ts);
      const node = document.createElement('div');
      node.className = 'sys';
      node.textContent = message.text;
      if (!animate) node.style.animation = 'none';
      el.inner.appendChild(node);
      state.lastMessage = null;
      return;
    }

    addDayDivider(message.ts);

    const mine = message.user === state.me;
    const stacked =
      state.lastMessage &&
      state.lastMessage.user === message.user &&
      message.ts - state.lastMessage.ts < 5 * 60 * 1000;

    const row = document.createElement('div');
    row.className = `row${mine ? ' row--me' : ''}${stacked ? ' row--stack' : ''}`;
    if (!animate) row.style.animation = 'none';

    if (stacked) {
      const spacer = document.createElement('div');
      spacer.className = 'row__spacer';
      row.appendChild(spacer);
    } else {
      const avatar = avatarFor(message.user);
      avatar.classList.add('row__avatar');
      row.appendChild(avatar);
    }

    const body = document.createElement('div');
    body.className = 'row__body';

    if (!stacked) {
      const meta = document.createElement('div');
      meta.className = 'row__meta';
      const author = document.createElement('span');
      author.className = 'row__author';
      author.textContent = mine ? 'You' : message.user;
      const time = document.createElement('span');
      time.className = 'row__time';
      time.textContent = timeOf(message.ts);
      meta.append(author, time);
      body.appendChild(meta);
    }

    const bubble = document.createElement('div');
    bubble.className = `bubble ${mine ? 'bubble--me' : 'bubble--them'}`;
    bubble.title = new Date(message.ts).toLocaleString();

    if (message.attachment && message.attachment.kind === 'gif') {
      bubble.classList.add('bubble--gif');
      const img = document.createElement('img');
      img.className = 'bubble__gif';
      img.loading = 'lazy';
      img.src = message.attachment.url;
      img.alt = message.attachment.title || 'GIF';
      if (message.attachment.width && message.attachment.height) {
        img.style.aspectRatio = `${message.attachment.width} / ${message.attachment.height}`;
      }
      img.addEventListener('load', () => {
        if (state.stickToBottom) scrollToBottom(false);
      });
      bubble.appendChild(img);
      if (message.text) {
        const caption = document.createElement('div');
        caption.className = 'bubble__caption';
        caption.innerHTML = EasyMarkdown.render(message.text, { me: state.me });
        bubble.appendChild(caption);
      }
    } else {
      bubble.innerHTML = EasyMarkdown.render(message.text, { me: state.me });
    }

    body.appendChild(bubble);
    row.appendChild(body);
    el.inner.appendChild(row);
    state.lastMessage = message;
  }

  // spoilers reveal on click
  el.inner.addEventListener('click', (event) => {
    const spoiler = event.target.closest('.spoiler');
    if (spoiler) spoiler.classList.toggle('spoiler--open');
  });

  /* ---------- rooms & members ---------- */

  function renderRooms() {
    el.roomList.textContent = '';
    state.rooms.forEach((room, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `room${room.id === state.roomId ? ' room--active' : ''}`;
      button.style.animationDelay = `${Math.min(index * 30, 240)}ms`;

      const hash = document.createElement('span');
      hash.className = 'room__hash';
      if (room.locked) {
        hash.classList.add('room__hash--lock');
        hash.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10V8a4 4 0 0 1 8 0v2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><rect x="6" y="10" width="12" height="9" rx="2.2" fill="currentColor"/></svg>';
        hash.title = state.roomKeys[room.id] ? 'Password already given' : 'Password required';
      } else {
        hash.textContent = '#';
      }

      const name = document.createElement('span');
      name.className = 'room__name';
      name.textContent = room.name;

      button.append(hash, name);

      const unread = state.unread.get(room.id) || 0;
      if (unread && room.id !== state.roomId) {
        const badge = document.createElement('span');
        badge.className = 'room__badge room__badge--unread';
        badge.textContent = unread > 99 ? '99+' : String(unread);
        button.appendChild(badge);
      } else if (room.online) {
        const badge = document.createElement('span');
        badge.className = 'room__badge';
        badge.textContent = String(room.online);
        button.appendChild(badge);
      }

      button.addEventListener('click', () => {
        if (room.id === state.roomId) return closeSidebar();
        closeSidebar();
        openRoom(room);
      });

      item.appendChild(button);
      el.roomList.appendChild(item);
    });
    updateTitle();
  }

  function openRoom(room) {
    const key = state.roomKeys[room.id];
    if (room.locked && !key) return askForRoomPassword(room.id, room.name);
    send({ type: 'switch', roomId: room.id, password: key || '' });
  }

  function askForRoomPassword(roomId, roomName, errorText) {
    state.pendingUnlock = roomId;
    el.unlockTitle.textContent = `${roomName} is locked`;
    el.unlockInput.value = '';
    el.unlockError.hidden = !errorText;
    if (errorText) el.unlockError.textContent = errorText;
    el.unlockModal.hidden = false;
    setTimeout(() => el.unlockInput.focus(), 60);
  }

  function closeUnlock() {
    el.unlockModal.hidden = true;
    state.pendingUnlock = '';
  }

  function setComposerEnabled(enabled) {
    el.input.disabled = !enabled;
    el.gifBtn.disabled = !enabled;
    el.input.placeholder = enabled ? 'Message the room…' : 'Pick a room to start talking';
    refreshSendState();
  }

  function showNoRoom() {
    state.roomId = '';
    el.roomName.textContent = 'No room yet';
    el.roomName.classList.add('is-empty');
    el.roomTopic.hidden = true;
    el.roomLock.hidden = true;
    el.roomOnline.textContent = '0 online';
    clearMessages();
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    wrap.innerHTML =
      '<div class="empty__mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10V7.5a4 4 0 0 1 8 0V10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="4.5" y="10" width="15" height="10.5" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="15.2" r="1.5" fill="currentColor"/></svg></div>' +
      '<h3>Pick a room</h3>' +
      '<p>The rooms in the list need a password. Choose one and type its password, or create a room of your own.</p>';
    el.inner.appendChild(wrap);
    renderMembers([]);
    renderRooms();
    setComposerEnabled(false);
  }

  function renderMembers(members) {
    el.memberList.textContent = '';
    el.memberCount.textContent = String(members.length);
    el.roomOnline.textContent = `${members.length} online`;
    members.forEach((member, index) => {
      const item = document.createElement('li');
      item.className = 'member';
      item.style.animationDelay = `${Math.min(index * 24, 200)}ms`;
      item.appendChild(avatarFor(member.username, 'sm'));
      const name = document.createElement('span');
      name.className = 'member__name';
      name.textContent = member.username;
      item.appendChild(name);
      if (member.username === state.me) {
        const you = document.createElement('span');
        you.className = 'member__you';
        you.textContent = 'YOU';
        item.appendChild(you);
      }
      el.memberList.appendChild(item);
    });
  }

  function updateTitle() {
    let total = 0;
    for (const count of state.unread.values()) total += count;
    document.title = total ? `(${total}) EasyChat` : 'EasyChat';
  }

  /* ---------- typing ---------- */

  function renderTyping(users) {
    const others = users.filter((name) => name !== state.me);
    if (!others.length) {
      el.typing.hidden = true;
      el.typingText.textContent = '';
      return;
    }
    let text;
    if (others.length === 1) text = `${others[0]} is typing`;
    else if (others.length === 2) text = `${others[0]} and ${others[1]} are typing`;
    else if (others.length === 3) text = `${others[0]}, ${others[1]} and 1 other are typing`;
    else text = 'Several people are typing';
    el.typingText.textContent = text;
    const wasHidden = el.typing.hidden;
    el.typing.hidden = false;
    if (wasHidden && state.stickToBottom) scrollToBottom(false);
  }

  let typingStopTimer = null;
  function signalTyping() {
    const now = Date.now();
    if (now - state.typingSince > 3000) {
      state.typingSince = now;
      send({ type: 'typing', state: true });
    }
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(stopTyping, 3000);
  }

  function stopTyping() {
    clearTimeout(typingStopTimer);
    if (state.typingSince) {
      state.typingSince = 0;
      send({ type: 'typing', state: false });
    }
  }

  /* ---------- websocket ---------- */

  function send(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.reconnectAttempts = 0;
      el.connState.textContent = 'Connected';
      el.connState.className = 'conn conn--live';
      if (state.me) {
        send({
          type: 'join',
          username: state.me,
          password: state.password,
          roomId: state.roomId,
          roomKeys: state.roomKeys,
        });
      }
    });

    ws.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      handle(data);
    });

    ws.addEventListener('close', () => {
      if (!state.joined) return;
      el.connState.textContent = 'Reconnecting…';
      el.connState.className = 'conn conn--down';
      state.reconnectAttempts += 1;
      const delay = Math.min(1000 * 2 ** (state.reconnectAttempts - 1), 15000);
      setTimeout(connect, delay);
    });

    ws.addEventListener('error', () => ws.close());
  }

  function handle(data) {
    switch (data.type) {
      case 'hello':
        state.gifsEnabled = Boolean(data.gifsEnabled);
        el.gatePassField.hidden = !data.requiresPassword;
        break;

      case 'welcome':
        state.me = data.username;
        state.gifsEnabled = Boolean(data.gifsEnabled);
        state.rooms = data.rooms || [];
        enterApp();
        break;

      case 'rooms':
        state.rooms = data.rooms || [];
        if (state.pendingRoomKey && state.pendingRoomKey.roomId === null) {
          const made = state.rooms.find((room) => room.name === state.pendingRoomKey.name);
          if (made) state.pendingRoomKey.roomId = made.id;
        }
        renderRooms();
        break;

      case 'room': {
        const previous = state.roomId;
        state.roomId = data.room.id;
        state.unread.set(data.room.id, 0);
        if (state.pendingRoomKey && state.pendingRoomKey.roomId === data.room.id) {
          rememberRoomKey(data.room.id, state.pendingRoomKey.password);
        }
        state.pendingRoomKey = null;
        rememberLastRoom(data.room.id);
        closeUnlock();
        setComposerEnabled(true);
        el.roomLock.hidden = !data.room.locked;
        el.roomName.classList.remove('is-empty');
        el.roomName.textContent = data.room.name;
        el.roomTopic.textContent = data.room.topic || '';
        el.roomTopic.hidden = !data.room.topic;
        clearMessages();
        if (!data.messages.length) showEmptyState(`#${data.room.name}`);
        else data.messages.forEach((message) => renderMessage(message, { animate: false }));
        renderMembers(data.members || []);
        renderRooms();
        renderTyping([]);
        scrollToBottom(false);
        if (previous && previous !== data.room.id) el.input.focus();
        break;
      }

      case 'message': {
        if (data.roomId !== state.roomId) {
          if (data.message.type === 'chat') {
            state.unread.set(data.roomId, (state.unread.get(data.roomId) || 0) + 1);
            renderRooms();
          }
          return;
        }
        const stick = state.stickToBottom;
        renderMessage(data.message);
        if (stick || data.message.user === state.me) {
          scrollToBottom(false);
        } else if (data.message.type === 'chat') {
          state.missed += 1;
          el.jump.hidden = false;
        }
        break;
      }

      case 'no-room':
        showNoRoom();
        break;

      case 'presence':
        if (data.roomId === state.roomId) renderMembers(data.members || []);
        break;

      case 'typing':
        if (data.roomId === state.roomId) renderTyping(data.users || []);
        break;

      case 'error':
        if (data.code === 'room-locked') {
          state.pendingRoomKey = null;
          return askForRoomPassword(data.roomId, data.roomName);
        }
        if (data.code === 'bad-room-password' || data.code === 'unlock-throttled') {
          state.pendingRoomKey = null;
          forgetRoomKey(data.roomId);
          renderRooms();
          return askForRoomPassword(data.roomId, data.roomName, data.message);
        }
        if (data.code === 'weak-room-password' || data.code === 'dup-room' || data.code === 'bad-room') {
          el.roomError.textContent = data.message;
          el.roomError.hidden = false;
          el.roomModal.hidden = false;
          return;
        }
        if (!state.joined) showGateError(data.message);
        else toast(data.message, 'error');
        if (!state.joined) {
          el.gateSubmit.disabled = false;
          el.gateSubmit.querySelector('.btn__label').textContent = 'Enter chat';
        }
        break;

      default:
        break;
    }
  }

  /* ---------- gate ---------- */

  function showGateError(message) {
    el.gateError.textContent = message;
    el.gateError.hidden = false;
    el.gateError.style.animation = 'none';
    void el.gateError.offsetWidth;
    el.gateError.style.animation = '';
  }

  function enterApp() {
    state.joined = true;
    el.meName.textContent = state.me;
    const hue = hueOf(state.me);
    el.meAvatar.style.background = `linear-gradient(135deg, hsl(${hue} 78% 62%), hsl(${(hue + 32) % 360} 72% 48%))`;
    el.meAvatar.textContent = state.me.charAt(0);
    el.gate.classList.add('gate--leaving');
    setTimeout(() => {
      el.gate.hidden = true;
    }, 420);
    el.app.hidden = false;
    el.gifBtn.hidden = false;
    setTimeout(() => el.input.focus(), 260);
    try {
      sessionStorage.setItem('easychat.user', state.me);
    } catch {
      /* private mode - not important */
    }
  }

  el.gateForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const username = el.gateUser.value.trim();
    if (username.length < 2) return showGateError('Pick a name with at least 2 characters.');
    state.me = username;
    state.password = el.gatePass.value;
    el.gateError.hidden = true;
    el.gateSubmit.disabled = true;
    el.gateSubmit.querySelector('.btn__label').textContent = 'Connecting…';
    if (!send({ type: 'join', username, password: state.password, roomId: lastRoom(), roomKeys: state.roomKeys })) {
      connect();
    }
  });

  /* ---------- composer ---------- */

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 168)}px`;
  }

  function refreshSendState() {
    const hasContent = Boolean(el.input.value.trim()) || Boolean(state.pendingGif);
    el.send.disabled = !hasContent || !state.roomId;
  }

  el.input.addEventListener('input', () => {
    autosize();
    refreshSendState();
    if (el.input.value.trim()) signalTyping();
    else stopTyping();
  });

  el.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      el.form.requestSubmit();
    }
    if (event.key === 'Escape') closeGifPanel();
  });

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el.input.value.trim();
    if (!text && !state.pendingGif) return;
    const payload = { type: 'message', text };
    if (state.pendingGif) payload.gif = state.pendingGif;
    if (!send(payload)) return toast('Still reconnecting — try again in a second.', 'error');
    el.input.value = '';
    autosize();
    clearAttachment();
    refreshSendState();
    stopTyping();
  });

  function clearAttachment() {
    state.pendingGif = null;
    el.attach.hidden = true;
    el.attachImg.removeAttribute('src');
    refreshSendState();
  }

  el.attachRemove.addEventListener('click', clearAttachment);

  /* ---------- GIF picker ---------- */

  let gifTimer = null;

  function openGifPanel() {
    if (!state.gifsEnabled) {
      return toast('GIF search is off — the host needs to add a Tenor API key.', 'error');
    }
    el.gifPanel.hidden = false;
    el.gifPanel.classList.remove('gif-panel--closing');
    el.gifSearch.value = '';
    el.gifSearch.focus();
    loadGifs('');
  }

  function closeGifPanel() {
    if (el.gifPanel.hidden) return;
    el.gifPanel.classList.add('gif-panel--closing');
    setTimeout(() => {
      el.gifPanel.hidden = true;
      el.gifPanel.classList.remove('gif-panel--closing');
    }, 180);
  }

  async function loadGifs(query) {
    el.gifStatus.textContent = query ? `Searching “${query}”…` : 'Loading trending GIFs…';
    const url = query ? `/api/gifs/search?q=${encodeURIComponent(query)}` : '/api/gifs/trending';
    try {
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'GIF search failed.');
      renderGifs(body.results || []);
      el.gifStatus.textContent = body.results && body.results.length ? 'Powered by Tenor' : 'No GIFs found.';
    } catch (err) {
      el.gifResults.textContent = '';
      el.gifStatus.textContent = err.message;
    }
  }

  function renderGifs(results) {
    el.gifResults.textContent = '';
    el.gifResults.scrollTop = 0;
    results.forEach((gif, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gif-tile';
      button.style.animationDelay = `${Math.min(index * 18, 300)}ms`;
      const img = document.createElement('img');
      img.src = gif.preview;
      img.alt = gif.title;
      img.loading = 'lazy';
      if (gif.width && gif.height) img.style.aspectRatio = `${gif.width} / ${gif.height}`;
      button.appendChild(img);
      button.addEventListener('click', () => {
        state.pendingGif = {
          url: gif.url,
          preview: gif.preview,
          width: gif.width,
          height: gif.height,
          title: gif.title,
        };
        el.attachImg.src = gif.preview;
        el.attach.hidden = false;
        closeGifPanel();
        refreshSendState();
        el.input.focus();
      });
      el.gifResults.appendChild(button);
    });
  }

  el.gifBtn.addEventListener('click', () => {
    if (el.gifPanel.hidden) openGifPanel();
    else closeGifPanel();
  });
  el.gifClose.addEventListener('click', closeGifPanel);
  el.gifSearch.addEventListener('input', () => {
    clearTimeout(gifTimer);
    const query = el.gifSearch.value.trim();
    gifTimer = setTimeout(() => loadGifs(query), 320);
  });
  document.addEventListener('click', (event) => {
    if (el.gifPanel.hidden) return;
    if (el.gifPanel.contains(event.target) || el.gifBtn.contains(event.target)) return;
    closeGifPanel();
  });

  /* ---------- rooms UI ---------- */

  el.newRoom.addEventListener('click', () => {
    el.roomModal.hidden = false;
    el.roomInput.value = '';
    el.roomPasswordInput.value = '';
    el.roomTopicInput.value = '';
    el.roomError.hidden = true;
    setTimeout(() => el.roomInput.focus(), 60);
  });
  el.roomCancel.addEventListener('click', () => {
    el.roomModal.hidden = true;
  });
  el.roomModal.addEventListener('click', (event) => {
    if (event.target === el.roomModal) el.roomModal.hidden = true;
  });
  el.roomForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = el.roomInput.value.trim();
    const password = el.roomPasswordInput.value;
    if (name.length < 2) return;
    if (password.trim().length < 4) {
      el.roomError.textContent = 'Give the room a password of at least 4 characters.';
      el.roomError.hidden = false;
      return;
    }
    state.pendingRoomKey = { roomId: null, password: password.trim(), name };
    send({ type: 'create-room', name, topic: el.roomTopicInput.value.trim(), password: password.trim() });
    el.roomModal.hidden = true;
    closeSidebar();
  });

  /* ---------- unlocking a room ---------- */

  el.unlockForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const password = el.unlockInput.value;
    if (!password || !state.pendingUnlock) return;
    state.pendingRoomKey = { roomId: state.pendingUnlock, password };
    el.unlockError.hidden = true;
    send({ type: 'switch', roomId: state.pendingUnlock, password });
  });

  el.unlockCancel.addEventListener('click', closeUnlock);
  el.unlockModal.addEventListener('click', (event) => {
    if (event.target === el.unlockModal) closeUnlock();
  });

  function openSidebar() {
    el.sidebar.classList.add('sidebar--open');
    el.scrim.hidden = false;
  }
  function closeSidebar() {
    el.sidebar.classList.remove('sidebar--open');
    el.scrim.hidden = true;
  }
  el.sidebarOpen.addEventListener('click', openSidebar);
  el.sidebarClose.addEventListener('click', closeSidebar);
  el.scrim.addEventListener('click', closeSidebar);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeGifPanel();
      closeSidebar();
      closeUnlock();
      el.roomModal.hidden = true;
    }
  });

  window.addEventListener('beforeunload', stopTyping);

  /* ---------- boot ---------- */

  fetch('/api/config')
    .then((res) => res.json())
    .then((config) => {
      el.gatePassField.hidden = !config.requiresPassword;
      state.gifsEnabled = Boolean(config.gifsEnabled);
    })
    .catch(() => {
      /* the websocket hello covers this too */
    });

  try {
    const remembered = sessionStorage.getItem('easychat.user');
    if (remembered) el.gateUser.value = remembered;
  } catch {
    /* ignore */
  }

  loadRoomKeys();
  refreshSendState();
  connect();
  el.gateUser.focus();
})();
