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
    gateInvite: $('gate-invite'),
    gateInviteField: $('gate-invite-field'),
    gateSubtitle: $('gate-subtitle'),
    gateError: $('gate-error'),
    gateSubmit: $('gate-submit'),
    tabSignIn: $('tab-signin'),
    tabSignUp: $('tab-signup'),
    tabsSlider: $('tabs-slider'),
    signOut: $('sign-out'),
    meHost: $('me-host'),
    offline: $('offline'),
    offlineRetry: $('offline-retry'),

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

    attachRow: $('attach-row'),
    attachBtn: $('attach-btn'),
    fileInput: $('file-input'),
    drop: $('drop'),
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

    replyBar: $('reply-bar'),
    replyBarWho: $('reply-bar-who'),
    replyBarText: $('reply-bar-text'),
    replyBarCancel: $('reply-bar-cancel'),

    confirmModal: $('confirm-modal'),
    confirmText: $('confirm-text'),
    confirmCancel: $('confirm-cancel'),
    confirmOk: $('confirm-ok'),

    searchOpen: $('search-open'),
    searchModal: $('search-modal'),
    searchInput: $('search-input'),
    searchClose: $('search-close'),
    searchResults: $('search-results'),
    searchStatus: $('search-status'),

    meName: $('me-name'),
    meAvatar: $('me-avatar'),
    connState: $('conn-state'),
    toasts: $('toasts'),
  };

  const state = {
    quietUntil: Date.now() + 2000,
    faviconUnread: false,
    audio: null,
    reconnectTimer: null,
    queuedJoin: null,
    ws: null,
    me: '',
    token: '',
    mode: 'signin',
    isHost: false,
    requiresInvite: false,
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
    focusReturn: null,
    messages: [],
    rows: new Map(),
    replyTo: null,
    pendingDelete: '',
    hasMore: false,
    loadingHistory: false,
    searchTimer: null,
    pendingFiles: [],   // uploaded and signed, waiting to be sent
    uploading: 0,
    dragDepth: 0,
  };

  /* The sign-in token outlives the tab, so you stay signed in like any site. */
  function saveToken(token) {
    state.token = token || '';
    try {
      if (token) localStorage.setItem('easychat.token', token);
      else localStorage.removeItem('easychat.token');
    } catch {
      /* private mode - you stay signed in until the tab closes */
    }
  }

  function loadToken() {
    try {
      state.token = localStorage.getItem('easychat.token') || '';
    } catch {
      state.token = '';
    }
    return state.token;
  }

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

  function prettySize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

  function loadOlder() {
    if (state.loadingHistory || !state.hasMore || !state.messages.length) return;
    const oldest = state.messages[0];
    state.loadingHistory = true;
    el.inner.classList.add('messages__inner--loading');
    send({ type: 'history', roomId: state.roomId, before: oldest.ts });
  }

  el.messages.addEventListener('scroll', () => {
    if (el.messages.scrollTop < 90) loadOlder();
    state.stickToBottom = nearBottom();
    if (state.stickToBottom) {
      state.missed = 0;
      el.jump.hidden = true;
    }
  });
  el.jump.addEventListener('click', () => scrollToBottom(true));

  /* ---------- rendering ---------- */

  /* The messages for the room on screen. Keeping the list here means history
     can be prepended and a single message re-rendered without guesswork. */

  function clearMessages() {
    el.inner.textContent = '';
    state.messages = [];
    state.rows = new Map();
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

  function dropEmptyState() {
    const empty = el.inner.querySelector('.empty');
    if (empty) empty.remove();
  }

  function iconButton(label, path, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'act';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
    button.addEventListener('click', onClick);
    return button;
  }

  const ICON = {
    reply: '<path d="M9 7 4 12l5 5M4 12h8.5a6.5 6.5 0 0 1 6.5 6.5V19" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16v4ZM14.5 5.5l4 4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 10.5v6M13.5 10.5v6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  /* ---------- one message ---------- */

  function buildBubble(message, mine) {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${mine ? 'bubble--me' : 'bubble--them'}`;
    bubble.title = new Date(message.ts).toLocaleString();

    if (message.deleted) {
      bubble.classList.add('bubble--deleted');
      bubble.textContent =
        message.deletedBy && message.deletedBy !== message.user
          ? 'Message removed by the host'
          : 'Message deleted';
      bubble.removeAttribute('title');
      return bubble;
    }

    const kind = message.attachment && message.attachment.kind;

    if (kind === 'image') {
      bubble.classList.add('bubble--gif');
      const link = document.createElement('a');
      link.href = message.attachment.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.className = 'bubble__gif';
      img.loading = 'lazy';
      img.src = message.attachment.url;
      img.alt = message.attachment.name || 'Image';
      if (message.attachment.width && message.attachment.height) {
        img.style.aspectRatio = `${message.attachment.width} / ${message.attachment.height}`;
        img.style.width = `${Math.min(message.attachment.width, 320)}px`;
      }
      img.addEventListener('load', () => {
        if (state.stickToBottom) scrollToBottom(false);
      });
      link.appendChild(img);
      bubble.appendChild(link);
      if (message.text) {
        const caption = document.createElement('div');
        caption.className = 'bubble__caption';
        caption.innerHTML = EasyMarkdown.render(message.text, { me: state.me });
        bubble.appendChild(caption);
      }
      return bubble;
    }

    if (kind === 'file') {
      const card = document.createElement('a');
      card.className = 'file-card';
      card.href = message.attachment.url;
      card.download = message.attachment.name || 'file';
      card.innerHTML =
        '<span class="file-card__icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span>' +
        `<span class="file-card__body"><strong>${EasyMarkdown.escapeHtml(message.attachment.name || 'file')}</strong>` +
        `<span>${prettySize(message.attachment.size || 0)}</span></span>` +
        '<span class="file-card__down"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
      bubble.appendChild(card);
      if (message.text) {
        const caption = document.createElement('div');
        caption.className = 'bubble__caption';
        caption.innerHTML = EasyMarkdown.render(message.text, { me: state.me });
        bubble.appendChild(caption);
      }
      return bubble;
    }

    if (kind === 'gif') {
      bubble.classList.add('bubble--gif');
      const img = document.createElement('img');
      img.className = 'bubble__gif';
      img.loading = 'lazy';
      img.src = message.attachment.url;
      img.alt = message.attachment.title || 'GIF';
      if (message.attachment.width && message.attachment.height) {
        img.style.aspectRatio = `${message.attachment.width} / ${message.attachment.height}`;
        img.style.width = `${Math.min(message.attachment.width, 320)}px`;
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

    if (message.editedAt) {
      const mark = document.createElement('span');
      mark.className = 'bubble__edited';
      mark.textContent = 'edited';
      mark.title = `Edited ${new Date(message.editedAt).toLocaleString()}`;
      bubble.appendChild(mark);
    }
    return bubble;
  }

  function buildReplyQuote(message) {
    const quote = document.createElement('button');
    quote.type = 'button';
    quote.className = 'reply-quote';
    quote.dataset.target = message.replyTo.id;
    quote.innerHTML =
      `<span class="reply-quote__who">${EasyMarkdown.escapeHtml(message.replyTo.user)}</span>` +
      `<span class="reply-quote__text">${EasyMarkdown.escapeHtml(EasyMarkdown.plain(message.replyTo.excerpt))}</span>`;
    quote.addEventListener('click', () => jumpToMessage(message.replyTo.id));
    return quote;
  }

  function buildActions(message, mine) {
    const bar = document.createElement('div');
    bar.className = 'row__actions';
    bar.appendChild(iconButton('Reply', ICON.reply, () => startReply(message)));
    const fresh = Date.now() - message.ts < 15 * 60 * 1000;
    if (mine && fresh && !message.attachment) {
      bar.appendChild(iconButton('Edit', ICON.edit, () => startEdit(message)));
    }
    if (mine || state.isHost) {
      bar.appendChild(iconButton('Delete', ICON.trash, () => confirmDelete(message)));
    }
    return bar;
  }

  function buildRow(message, previous) {
    const mine = message.user === state.me;
    const stacked =
      previous &&
      previous.type === 'chat' &&
      previous.user === message.user &&
      !message.replyTo &&
      message.ts - previous.ts < 5 * 60 * 1000;

    const row = document.createElement('div');
    row.className = `row${mine ? ' row--me' : ''}${stacked ? ' row--stack' : ''}`;
    row.dataset.id = message.id;

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

    if (message.replyTo) body.appendChild(buildReplyQuote(message));
    body.appendChild(buildBubble(message, mine));
    if (!message.deleted) body.appendChild(buildActions(message, mine));

    row.appendChild(body);
    return row;
  }

  function dayDivider(ts) {
    const node = document.createElement('div');
    node.className = 'day';
    node.textContent = dayOf(ts);
    return node;
  }

  /* Rebuilt from state.messages, so prepending history cannot leave stale
     dividers or wrong grouping behind. */
  function renderAll() {
    el.inner.textContent = '';
    state.rows = new Map();
    let previous = null;
    let day = '';
    for (const message of state.messages) {
      const label = dayOf(message.ts);
      if (label !== day) {
        day = label;
        el.inner.appendChild(dayDivider(message.ts));
        previous = null;
      }
      if (message.type === 'system') {
        const node = document.createElement('div');
        node.className = 'sys';
        node.style.animation = 'none';
        node.textContent = message.text;
        el.inner.appendChild(node);
        previous = null;
        continue;
      }
      const row = buildRow(message, previous);
      row.style.animation = 'none';
      el.inner.appendChild(row);
      state.rows.set(message.id, row);
      previous = message;
    }
    state.lastDay = day;
  }

  function renderMessage(message, options) {
    const animate = !options || options.animate !== false;
    dropEmptyState();
    state.messages.push(message);

    const label = dayOf(message.ts);
    if (label !== state.lastDay) {
      state.lastDay = label;
      el.inner.appendChild(dayDivider(message.ts));
      state.lastMessage = null;
    }

    if (message.type === 'system') {
      const node = document.createElement('div');
      node.className = 'sys';
      node.textContent = message.text;
      if (!animate) node.style.animation = 'none';
      el.inner.appendChild(node);
      state.lastMessage = null;
      return;
    }

    const row = buildRow(message, state.lastMessage);
    if (!animate) row.style.animation = 'none';
    el.inner.appendChild(row);
    state.rows.set(message.id, row);
    state.lastMessage = message;
  }

  function applyUpdate(updated) {
    const index = state.messages.findIndex((message) => message.id === updated.id);
    if (index === -1) return;
    state.messages[index] = updated;
    const row = state.rows.get(updated.id);
    if (!row) return;
    const mine = updated.user === state.me;
    const body = row.querySelector('.row__body');
    body.querySelector('.bubble').replaceWith(buildBubble(updated, mine));
    const actions = body.querySelector('.row__actions');
    if (actions) actions.remove();
    if (!updated.deleted) body.appendChild(buildActions(updated, mine));
    const quote = body.querySelector('.reply-quote');
    if (updated.deleted && quote) quote.remove();
    row.classList.add('row--flash');
    setTimeout(() => row.classList.remove('row--flash'), 700);
  }

  function jumpToMessage(id) {
    const row = state.rows.get(id);
    if (!row) return toast('That message is further back than this view goes.');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('row--flash');
    setTimeout(() => row.classList.remove('row--flash'), 900);
  }

  /* ---------- replying, editing, deleting ---------- */

  function startReply(message) {
    state.replyTo = { id: message.id, user: message.user, excerpt: message.text || 'GIF' };
    el.replyBarWho.textContent = message.user;
    el.replyBarText.textContent = EasyMarkdown.plain(message.text || 'GIF').slice(0, 120);
    el.replyBar.hidden = false;
    el.input.focus();
  }

  function cancelReply() {
    state.replyTo = null;
    el.replyBar.hidden = true;
  }

  function startEdit(message) {
    const row = state.rows.get(message.id);
    if (!row || row.querySelector('.edit-box')) return;
    const bubble = row.querySelector('.bubble');
    const box = document.createElement('div');
    box.className = 'edit-box';
    const area = document.createElement('textarea');
    area.className = 'edit-box__input';
    area.value = message.text;
    area.rows = Math.min(6, message.text.split('\n').length);
    const hint = document.createElement('p');
    hint.className = 'edit-box__hint';
    hint.innerHTML = '<kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel';
    box.append(area, hint);
    bubble.replaceWith(box);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);

    // Enter and blur can both fire; only the first one counts
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const text = area.value.trim();
      if (box.parentNode) box.replaceWith(bubble);
      if (save && text && text !== message.text) send({ type: 'edit', id: message.id, text });
    };
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    area.addEventListener('blur', () => finish(true));
  }

  function confirmDelete(message) {
    state.pendingDelete = message.id;
    el.confirmText.textContent =
      message.user === state.me
        ? 'Delete this message? The text is removed for everyone.'
        : `Remove this message from ${message.user}? The text is removed for everyone.`;
    openDialog(el.confirmModal, el.confirmCancel);
  }

  // spoilers reveal on click - and, since they are focusable, on Enter/Space too
  function toggleSpoiler(node) {
    const open = node.classList.toggle('spoiler--open');
    node.setAttribute('aria-expanded', String(open));
  }

  el.inner.addEventListener('click', (event) => {
    const spoiler = event.target.closest('.spoiler');
    if (spoiler) toggleSpoiler(spoiler);
  });

  el.inner.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const spoiler = event.target.closest('.spoiler');
    if (!spoiler) return;
    event.preventDefault();
    toggleSpoiler(spoiler);
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
    openDialog(el.unlockModal, el.unlockInput);
  }

  function closeUnlock() {
    if (!el.unlockModal.hidden) closeDialog(el.unlockModal);
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
    paintFavicon(total > 0);
  }

  /* The favicon is drawn here rather than shipped as two files, so the unread
     dot always matches the mark in the sidebar. */
  function paintFavicon(unread) {
    if (state.faviconUnread === unread) return;
    state.faviconUnread = unread;
    const dot = unread
      ? "<circle cx='25' cy='7' r='6.5' fill='%23ef4444' stroke='%23fff' stroke-width='2'/>"
      : '';
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
      "<rect width='32' height='32' rx='9' fill='%232563eb'/>" +
      "<path d='M8 11.5A2.5 2.5 0 0 1 10.5 9h11A2.5 2.5 0 0 1 24 11.5v7a2.5 2.5 0 0 1-2.5 2.5H15l-4.4 3.5a.8.8 0 0 1-1.3-.6V21h-.3A1.5 1.5 0 0 1 8 19.5Z' fill='white'/>" +
      dot +
      '</svg>';
    let link = document.querySelector("link[rel='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = `data:image/svg+xml,${svg}`;
  }

  /* A short tone built in the browser - no audio file, nothing from a CDN. */
  function chime() {
    if (Date.now() < state.quietUntil) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      state.audio = state.audio || new Ctx();
      if (state.audio.state === 'suspended') state.audio.resume();
      const now = state.audio.currentTime;
      const gain = state.audio.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.09, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      gain.connect(state.audio.destination);
      [880, 1318.5].forEach((frequency, index) => {
        const osc = state.audio.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(frequency, now + index * 0.09);
        osc.connect(gain);
        osc.start(now + index * 0.09);
        osc.stop(now + 0.4);
      });
    } catch {
      /* audio is a nicety, never a requirement */
    }
  }

  function askToNotify() {
    if (!('Notification' in window) || !window.isSecureContext) return;
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }

  function notify(message, roomName, mentioned) {
    if (!document.hidden && !mentioned) return;
    chime();
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    try {
      const body = message.text || (message.attachment ? 'Sent a GIF' : '');
      const note = new Notification(`${message.user} in ${roomName}`, {
        body: body.slice(0, 140),
        tag: `easychat-${message.id}`,
        silent: true, // the chime already played
      });
      note.onclick = () => {
        window.focus();
        note.close();
      };
    } catch {
      /* some browsers refuse constructed notifications; the chime stands in */
    }
  }

  function mentionsMe(text) {
    if (!text || !state.me) return false;
    return new RegExp(`(^|\\s)@${state.me.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i').test(text);
  }

  function clearUnreadForRoom() {
    if (!state.roomId) return;
    if (state.unread.get(state.roomId)) {
      state.unread.set(state.roomId, 0);
      renderRooms();
    }
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
      el.offline.hidden = true;
      el.connState.textContent = 'Connected';
      el.connState.className = 'conn conn--live';
      if (state.queuedJoin) {
        const queued = state.queuedJoin;
        state.queuedJoin = null;
        send({ ...queued, roomId: state.roomId || queued.roomId, roomKeys: state.roomKeys });
      } else if (state.token) {
        send({
          type: 'join',
          mode: 'token',
          token: state.token,
          roomId: state.roomId || lastRoom(),
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
      if (!state.joined && !state.token) return;
      el.connState.textContent = 'Reconnecting…';
      el.connState.className = 'conn conn--down';
      state.reconnectAttempts += 1;
      // after a while, stop pretending and say what is actually going on
      if (state.reconnectAttempts >= 6) el.offline.hidden = false;
      const delay = Math.min(1000 * 2 ** (state.reconnectAttempts - 1), 15000);
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connect, delay);
    });

    ws.addEventListener('error', () => ws.close());
  }

  function handle(data) {
    switch (data.type) {
      case 'hello':
        state.gifsEnabled = Boolean(data.gifsEnabled);
        state.requiresInvite = Boolean(data.requiresInvite);
        // nobody has registered yet, so the first thing to do is create an account
        if (!data.anyAccounts && !state.token && !state.joined) setMode('signup');
        else el.gateInviteField.hidden = !(state.mode === 'signup' && state.requiresInvite);
        break;

      case 'welcome':
        state.me = data.username;
        state.isHost = Boolean(data.isHost);
        state.gifsEnabled = Boolean(data.gifsEnabled);
        state.rooms = data.rooms || [];
        if (data.token) saveToken(data.token);
        el.meHost.hidden = !state.isHost;
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
        state.quietUntil = Date.now() + 1500; // history is not "new messages"
        state.hasMore = data.messages.length >= 300;
        state.loadingHistory = false;
        cancelReply();
        if (!data.messages.length) showEmptyState(`#${data.room.name}`);
        else data.messages.forEach((message) => renderMessage(message, { animate: false }));
        renderMembers(data.members || []);
        renderRooms();
        renderTyping([]);
        restoreDraft(data.room.id);
        scrollToBottom(false);
        if (previous && previous !== data.room.id) el.input.focus();
        break;
      }

      case 'message': {
        const chat = data.message.type === 'chat' && data.message.user !== state.me;
        if (data.roomId !== state.roomId) {
          if (chat) {
            state.unread.set(data.roomId, (state.unread.get(data.roomId) || 0) + 1);
            renderRooms();
            const room = state.rooms.find((r) => r.id === data.roomId);
            notify(data.message, room ? room.name : 'another room', mentionsMe(data.message.text));
          }
          return;
        }
        if (chat) notify(data.message, el.roomName.textContent, mentionsMe(data.message.text));
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

      case 'message-update':
        if (data.roomId === state.roomId) applyUpdate(data.message);
        break;

      case 'history': {
        if (data.roomId !== state.roomId) return;
        state.loadingHistory = false;
        state.hasMore = Boolean(data.more);
        el.inner.classList.remove('messages__inner--loading');
        if (!data.messages.length) return;
        const keepHeight = el.messages.scrollHeight;
        const keepTop = el.messages.scrollTop;
        state.messages = data.messages.concat(state.messages);
        renderAll();
        el.messages.scrollTop = keepTop + (el.messages.scrollHeight - keepHeight);
        break;
      }

      case 'upload-ticket':
        if (state.ticketWaiter) {
          const resolve = state.ticketWaiter;
          state.ticketWaiter = null;
          resolve(data.ticket);
        }
        break;

      case 'search':
        renderSearchResults(data);
        break;

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
          if (el.roomModal.hidden) openDialog(el.roomModal, el.roomInput);
          return;
        }
        if (data.code === 'bad-token') {
          saveToken('');
          gateBusy(false);
          setMode('signin');
          showGateError(data.message);
          return;
        }
        if (!state.joined) {
          showGateError(data.message);
          gateBusy(false);
          el.gateSubmit.disabled = false;
          el.gateSubmit.querySelector('.btn__label').textContent =
            state.mode === 'signup' ? 'Create account' : 'Sign in';
          if (data.code === 'name-taken') el.gateUser.focus();
          return;
        }
        toast(data.message, 'error');
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

  function setMode(mode) {
    state.mode = mode;
    const up = mode === 'signup';
    el.tabSignIn.classList.toggle('tabs__tab--on', !up);
    el.tabSignUp.classList.toggle('tabs__tab--on', up);
    el.tabSignIn.setAttribute('aria-selected', String(!up));
    el.tabSignUp.setAttribute('aria-selected', String(up));
    el.tabsSlider.style.transform = up ? 'translateX(100%)' : 'translateX(0)';
    el.gateSubtitle.textContent = up
      ? 'Pick a name and a password. The name is yours after that.'
      : 'Sign in to keep your name to yourself.';
    el.gateInviteField.hidden = !(up && state.requiresInvite);
    el.gatePass.autocomplete = up ? 'new-password' : 'current-password';
    el.gatePass.placeholder = up ? 'At least 6 characters' : 'Your password';
    el.gateSubmit.querySelector('.btn__label').textContent = up ? 'Create account' : 'Sign in';
    el.gateError.hidden = true;
  }

  el.tabSignIn.addEventListener('click', () => setMode('signin'));
  el.tabSignUp.addEventListener('click', () => setMode('signup'));

  function gateBusy(busy, label) {
    el.gate.classList.toggle('gate--busy', busy);
    el.gateSubmit.disabled = busy;
    if (busy && label) el.gateSubtitle.textContent = label;
  }

  el.gateForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const username = el.gateUser.value.trim();
    const password = el.gatePass.value;
    if (username.length < 2) return showGateError('Pick a name with at least 2 characters.');
    if (!password) return showGateError('Type your password.');
    if (state.mode === 'signup' && password.length < 6) {
      return showGateError('Passwords need at least 6 characters.');
    }
    el.gateError.hidden = true;
    el.gateSubmit.disabled = true;
    el.gateSubmit.querySelector('.btn__label').textContent =
      state.mode === 'signup' ? 'Creating…' : 'Signing in…';
    const payload = {
      type: 'join',
      mode: state.mode,
      username,
      password,
      invite: el.gateInvite.value,
      roomId: lastRoom(),
      roomKeys: state.roomKeys,
    };
    if (!send(payload)) {
      state.queuedJoin = payload;
      connect();
    }
  });

  function signOut() {
    saveToken('');
    try {
      sessionStorage.removeItem('easychat.roomKeys');
      sessionStorage.removeItem('easychat.lastRoom');
      sessionStorage.removeItem('easychat.user');
    } catch {
      /* ignore */
    }
    state.joined = false;
    if (state.ws) state.ws.close();
    location.reload();
  }

  el.signOut.addEventListener('click', signOut);

  /* ---------- composer ---------- */

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 168)}px`;
  }

  function refreshSendState() {
    const hasContent =
      Boolean(el.input.value.trim()) || Boolean(state.pendingGif) || state.pendingFiles.length > 0;
    el.send.disabled = !hasContent || !state.roomId || state.uploading > 0;
  }

  function saveDraft() {
    if (!state.roomId) return;
    try {
      const text = el.input.value;
      if (text.trim()) localStorage.setItem(`easychat.draft.${state.roomId}`, text);
      else localStorage.removeItem(`easychat.draft.${state.roomId}`);
    } catch {
      /* ignore */
    }
  }

  function restoreDraft(roomId) {
    let text = '';
    try {
      text = localStorage.getItem(`easychat.draft.${roomId}`) || '';
    } catch {
      text = '';
    }
    el.input.value = text;
    autosize();
    refreshSendState();
  }

  el.input.addEventListener('input', () => {
    autosize();
    refreshSendState();
    saveDraft();
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
    if (!text && !state.pendingGif && !state.pendingFiles.length) return;
    const files = state.pendingFiles;
    state.pendingFiles = [];
    if (files.length) {
      [...el.attachRow.querySelectorAll('.attachment')].forEach((card) => {
        if (card !== el.attach) card.remove();
      });
      files.forEach((item, index) => {
        send({
          type: 'message',
          text: index === files.length - 1 && !state.pendingGif ? text : '',
          attachment: item.attachment,
          attachmentSig: item.signature,
          replyTo: index === 0 && state.replyTo ? state.replyTo.id : undefined,
        });
      });
      if (!state.pendingGif) {
        el.input.value = '';
        saveDraft();
        autosize();
        cancelReply();
        refreshSendState();
        stopTyping();
        return;
      }
    }

    const payload = { type: 'message', text };
    if (state.pendingGif) payload.gif = state.pendingGif;
    if (state.replyTo) payload.replyTo = state.replyTo.id;
    if (!send(payload)) return toast('Still reconnecting — try again in a second.', 'error');
    askToNotify();
    el.input.value = '';
    saveDraft();
    autosize();
    clearAttachment();
    cancelReply();
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

  /* ---------- images and files ---------- */

  function ticketFor() {
    return new Promise((resolve) => {
      state.ticketWaiter = resolve;
      if (!send({ type: 'upload-ticket' })) resolve(null);
      setTimeout(() => {
        if (state.ticketWaiter === resolve) {
          state.ticketWaiter = null;
          resolve(null);
        }
      }, 6000);
    });
  }

  function uploadOne(file, ticket) {
    return new Promise((resolve) => {
      const card = document.createElement('div');
      card.className = 'attachment attachment--busy';
      card.innerHTML =
        `<div class="attachment__ring"><span></span></div>` +
        `<div class="attachment__meta"><strong>${EasyMarkdown.escapeHtml(file.name)}</strong>` +
        `<span>${prettySize(file.size)}</span></div>`;
      el.attachRow.appendChild(card);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload?ticket=${encodeURIComponent(ticket)}`);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name).slice(0, 200));
      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        card.style.setProperty('--progress', `${percent}%`);
      });
      xhr.addEventListener('load', () => {
        card.remove();
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = {};
        }
        if (xhr.status !== 200 || !body.attachment) {
          toast(body.error || 'That file could not be sent.', 'error');
          return resolve(null);
        }
        resolve({ attachment: body.attachment, signature: body.signature });
      });
      xhr.addEventListener('error', () => {
        card.remove();
        toast('That file could not be sent.', 'error');
        resolve(null);
      });
      xhr.send(file);
    });
  }

  async function sendFiles(files) {
    if (!state.roomId) return toast('Pick a room first.', 'error');
    const list = [...files].slice(0, 6);
    if (!list.length) return;
    const ticket = await ticketFor();
    if (!ticket) return toast('Could not start the upload. Try again.', 'error');

    state.uploading += list.length;
    refreshSendState();
    for (const file of list) {
      const done = await uploadOne(file, ticket);
      state.uploading -= 1;
      if (done) {
        state.pendingFiles.push(done);
        showPendingFile(done.attachment);
      }
    }
    refreshSendState();
    el.input.focus();
  }

  function showPendingFile(attachment) {
    const card = document.createElement('div');
    card.className = 'attachment';
    if (attachment.kind === 'image') {
      const img = document.createElement('img');
      img.src = attachment.url;
      img.alt = attachment.name;
      card.appendChild(img);
    } else {
      const meta = document.createElement('div');
      meta.className = 'attachment__meta';
      meta.innerHTML =
        `<strong>${EasyMarkdown.escapeHtml(attachment.name)}</strong>` +
        `<span>${prettySize(attachment.size)}</span>`;
      card.appendChild(meta);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment__remove';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
    remove.addEventListener('click', () => {
      state.pendingFiles = state.pendingFiles.filter((item) => item.attachment.url !== attachment.url);
      card.remove();
      refreshSendState();
    });
    card.appendChild(remove);
    el.attachRow.appendChild(card);
  }

  el.attachBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    sendFiles(el.fileInput.files);
    el.fileInput.value = '';
  });

  el.input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    sendFiles(files);
  });

  ['dragenter', 'dragover'].forEach((kind) =>
    document.addEventListener(kind, (event) => {
      if (!state.joined || !event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      if (kind === 'dragenter') state.dragDepth += 1;
      el.drop.hidden = false;
    })
  );
  document.addEventListener('dragleave', () => {
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) el.drop.hidden = true;
  });
  document.addEventListener('drop', (event) => {
    if (!state.joined) return;
    event.preventDefault();
    state.dragDepth = 0;
    el.drop.hidden = true;
    if (event.dataTransfer?.files?.length) sendFiles(event.dataTransfer.files);
  });

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
    openDialog(el.roomModal, el.roomInput);
    el.roomInput.value = '';
    el.roomPasswordInput.value = '';
    el.roomTopicInput.value = '';
    el.roomError.hidden = true;
  });
  el.roomCancel.addEventListener('click', () => closeDialog(el.roomModal));
  el.roomModal.addEventListener('click', (event) => {
    if (event.target === el.roomModal) closeDialog(el.roomModal);
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
    closeDialog(el.roomModal);
    closeSidebar();
  });

  el.replyBarCancel.addEventListener('click', cancelReply);

  /* ---------- deleting ---------- */

  el.confirmCancel.addEventListener('click', () => {
    state.pendingDelete = '';
    closeDialog(el.confirmModal);
  });
  el.confirmModal.addEventListener('click', (event) => {
    if (event.target === el.confirmModal) {
      state.pendingDelete = '';
      closeDialog(el.confirmModal);
    }
  });
  el.confirmOk.addEventListener('click', () => {
    if (state.pendingDelete) send({ type: 'delete', id: state.pendingDelete });
    state.pendingDelete = '';
    closeDialog(el.confirmModal);
  });

  /* ---------- search ---------- */

  function openSearch() {
    if (!state.joined) return;
    openDialog(el.searchModal, el.searchInput);
    el.searchInput.value = '';
    el.searchResults.textContent = '';
    el.searchStatus.textContent = 'Type at least two characters.';
  }

  function closeSearch() {
    if (!el.searchModal.hidden) closeDialog(el.searchModal);
  }

  function renderSearchResults(data) {
    el.searchResults.textContent = '';
    if (!data.results.length) {
      el.searchStatus.textContent = data.q.length < 2 ? 'Type at least two characters.' : 'Nothing found.';
      return;
    }
    el.searchStatus.textContent = data.capped
      ? 'Showing the first 60 matches, newest first.'
      : `${data.results.length} ${data.results.length === 1 ? 'match' : 'matches'}, newest first.`;

    const needle = data.q.toLowerCase();
    for (const hit of data.results) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'hit';

      const head = document.createElement('div');
      head.className = 'hit__head';
      head.innerHTML =
        `<span class="hit__room">#${EasyMarkdown.escapeHtml(hit.roomName)}</span>` +
        `<span class="hit__who">${EasyMarkdown.escapeHtml(hit.user)}</span>` +
        `<span class="hit__when">${new Date(hit.ts).toLocaleString()}</span>`;

      const body = document.createElement('div');
      body.className = 'hit__text';
      // highlight the match without letting the message text become markup
      const index = hit.text.toLowerCase().indexOf(needle);
      if (index === -1) {
        body.textContent = hit.text;
      } else {
        body.append(
          document.createTextNode(hit.text.slice(0, index)),
          Object.assign(document.createElement('mark'), {
            textContent: hit.text.slice(index, index + needle.length),
          }),
          document.createTextNode(hit.text.slice(index + needle.length))
        );
      }

      item.append(head, body);
      item.addEventListener('click', () => {
        closeSearch();
        if (hit.roomId === state.roomId) {
          jumpToMessage(hit.messageId);
        } else {
          const room = state.rooms.find((r) => r.id === hit.roomId);
          if (room) openRoom(room);
          toast(`Opening #${hit.roomName}`);
        }
      });
      el.searchResults.appendChild(item);
    }
  }

  el.searchOpen.addEventListener('click', openSearch);
  el.searchClose.addEventListener('click', closeSearch);
  el.searchModal.addEventListener('click', (event) => {
    if (event.target === el.searchModal) closeSearch();
  });
  el.searchInput.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    const q = el.searchInput.value.trim();
    if (q.length < 2) {
      el.searchResults.textContent = '';
      el.searchStatus.textContent = 'Type at least two characters.';
      return;
    }
    el.searchStatus.textContent = 'Searching…';
    state.searchTimer = setTimeout(() => send({ type: 'search', q }), 220);
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

  /* Keeping Tab inside an open dialog, and returning focus where it started. */
  const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  function openDialog(node, focusTarget) {
    state.focusReturn = document.activeElement;
    node.hidden = false;
    setTimeout(() => (focusTarget || node.querySelector(FOCUSABLE))?.focus(), 60);
  }

  function closeDialog(node) {
    node.hidden = true;
    const back = state.focusReturn;
    state.focusReturn = null;
    if (back && document.contains(back)) back.focus();
  }

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      return openSearch();
    }
    if (event.key === 'Tab') {
      const dialog = [el.roomModal, el.unlockModal, el.searchModal, el.confirmModal].find(
        (node) => !node.hidden
      );
      if (!dialog) return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((node) => !node.disabled);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === 'Escape') {
      closeGifPanel();
      closeSidebar();
      closeUnlock();
      closeSearch();
      if (!el.confirmModal.hidden) {
        state.pendingDelete = '';
        closeDialog(el.confirmModal);
      }
      if (!el.roomModal.hidden) closeDialog(el.roomModal);
      if (state.replyTo && document.activeElement === el.input) cancelReply();
    }
  });

  window.addEventListener('beforeunload', stopTyping);

  /* A phone suspends the socket the moment you switch apps. Coming back to the
     tab should feel instant, not like waiting out a backoff timer. */
  function reconnectNow() {
    if (!state.token && !state.joined) return;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectAttempts = 0;
    connect();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    clearUnreadForRoom();
    reconnectNow();
  });
  window.addEventListener('online', reconnectNow);
  window.addEventListener('focus', () => clearUnreadForRoom());
  el.offlineRetry.addEventListener('click', () => {
    el.offline.hidden = true;
    reconnectNow();
  });

  /* ---------- boot ---------- */

  fetch('/api/config')
    .then((res) => res.json())
    .then((config) => {
      state.requiresInvite = Boolean(config.requiresInvite);
      state.gifsEnabled = Boolean(config.gifsEnabled);
      if (!config.anyAccounts && !state.token && !state.joined) setMode('signup');
      else setMode(state.mode);
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

  loadToken();
  loadRoomKeys();
  if (state.token) gateBusy(true, 'Signing you in…');
  refreshSendState();
  connect();
  if (!state.token) el.gateUser.focus();
})();
