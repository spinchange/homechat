/* ─── HomeChat Client ─────────────────────────────────────────── */

const HISTORY_LIMIT = 200;

// State
let myName = localStorage.getItem('hc_name') || '';
let ws = null;
let reconnectTimer = null;
let currentContext = null; // { type: 'room', room } | { type: 'dm', with }
let unread = {}; // key -> count  (key = 'room:name' | 'dm:name')
let messageHistory = {}; // key -> [{from, text, ts, ...}]
let onlineUsers = [];
let knownUsers = [];
let rooms = [];

// ─── DOM refs ──────────────────────────────────────────────────
const modalOverlay   = document.getElementById('modal-overlay');
const nameInput      = document.getElementById('name-input');
const nameSubmit     = document.getElementById('name-submit');
const roomList       = document.getElementById('room-list');
const peopleList     = document.getElementById('people-list');
const messages       = document.getElementById('messages');
const msgInput       = document.getElementById('msg-input');
const sendBtn        = document.getElementById('send-btn');
const chatTitle      = document.getElementById('chat-title');
const chatSubtitle   = document.getElementById('chat-subtitle');
const connStatus     = document.getElementById('conn-status');
const myNameDisplay  = document.getElementById('my-name-display');
const menuBtn        = document.getElementById('menu-btn');
const sidebar        = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const addRoomBtn     = document.getElementById('add-room-btn');
const newRoomForm    = document.getElementById('new-room-form');
const newRoomInput   = document.getElementById('new-room-input');
const newRoomCancel  = document.getElementById('new-room-cancel');
const newRoomSubmit  = document.getElementById('new-room-submit');
const newRoomPrivate = document.getElementById('new-room-private');
const newRoomMembers = document.getElementById('new-room-members');
const imgBtn         = document.getElementById('img-btn');
const imgInput       = document.getElementById('img-input');
const camBtn         = document.getElementById('cam-btn');
const camInput       = document.getElementById('cam-input');
const lightbox       = document.getElementById('lightbox');
const lightboxImg    = document.getElementById('lightbox-img');
const nameError      = document.getElementById('name-error');

// ─── Utility ───────────────────────────────────────────────────
function ctxKey(ctx) {
  if (!ctx) return null;
  return ctx.type === 'room' ? `room:${ctx.room}` : `dm:${ctx.with}`;
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── DM last-seen (for offline unread detection) ──────────────
function getDmLastSeen(user) {
  const seen = JSON.parse(localStorage.getItem('hc_dm_seen') || '{}');
  return seen[user] || 0;
}
function setDmLastSeen(user, ts) {
  const seen = JSON.parse(localStorage.getItem('hc_dm_seen') || '{}');
  seen[user] = ts;
  localStorage.setItem('hc_dm_seen', JSON.stringify(seen));
}

// ─── Add Room ─────────────────────────────────────────────────
function openNewRoomForm() {
  newRoomForm.classList.remove('hidden');
  newRoomInput.value = '';
  newRoomPrivate.checked = false;
  newRoomMembers.classList.add('hidden');
  newRoomMembers.innerHTML = '';
  // Populate member checkboxes from known users (excluding self)
  const others = knownUsers.filter(u => u !== myName && u !== 'HomeBot');
  if (others.length > 0) {
    others.forEach(user => {
      const label = document.createElement('label');
      label.className = 'member-checkbox';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = user;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(user));
      newRoomMembers.appendChild(label);
    });
  }
  newRoomInput.focus();
}

function closeNewRoomForm() {
  newRoomForm.classList.add('hidden');
  newRoomInput.value = '';
  newRoomPrivate.checked = false;
  newRoomMembers.classList.add('hidden');
}

function submitNewRoom() {
  const raw = newRoomInput.value.trim();
  if (!raw) { newRoomInput.focus(); return; }

  let members = null;
  if (newRoomPrivate.checked) {
    members = [...newRoomMembers.querySelectorAll('input:checked')].map(cb => cb.value);
  }

  send({ type: 'create_room', name: raw, members });
  closeNewRoomForm();
}

newRoomPrivate.addEventListener('change', () => {
  newRoomMembers.classList.toggle('hidden', !newRoomPrivate.checked);
});

addRoomBtn.addEventListener('click', openNewRoomForm);
newRoomCancel.addEventListener('click', closeNewRoomForm);
newRoomSubmit.addEventListener('click', submitNewRoom);
newRoomInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitNewRoom(); }
  if (e.key === 'Escape') closeNewRoomForm();
});

// ─── Sidebar toggle (mobile) ──────────────────────────────────
function openSidebar() {
  sidebar.classList.add('open');
  sidebarOverlay.classList.add('open');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('open');
}
menuBtn.addEventListener('click', openSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);

// ─── Name Modal ────────────────────────────────────────────────
function showModal() {
  modalOverlay.classList.remove('hidden');
  nameInput.focus();
}

function submitName() {
  const n = nameInput.value.trim().slice(0, 32);
  if (!n) { nameInput.focus(); return; }
  nameError.textContent = '';
  myName = n;
  localStorage.setItem('hc_name', myName);
  modalOverlay.classList.add('hidden');
  myNameDisplay.textContent = `Signed in as ${myName}`;
  requestNotificationPermission();
  connectWS();
}

nameSubmit.addEventListener('click', submitName);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitName(); });

// ─── Notifications ─────────────────────────────────────────────
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showNotification(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (!document.hidden) return; // Only notify when tab is not focused
  try {
    const n = new Notification(title, { body, icon: '/icon.svg', tag: 'homechat-dm' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}

// ─── WebSocket ─────────────────────────────────────────────────
function connectWS() {
  if (ws) { ws.onclose = null; ws.close(); }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    connStatus.textContent = '';
    connStatus.classList.add('connected');
    ws.send(JSON.stringify({ type: 'join', name: myName }));
    // Reload current context history after reconnect
    if (currentContext) requestHistory(currentContext);
  };

  ws.onclose = () => {
    connStatus.textContent = 'Disconnected — reconnecting…';
    connStatus.classList.remove('connected');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, 2000);
  };

  ws.onerror = () => {}; // onclose handles it

  ws.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    handleMessage(data);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function requestHistory(ctx) {
  if (ctx.type === 'room') {
    send({ type: 'history', context: 'room', room: ctx.room });
  } else {
    send({ type: 'history', context: 'dm', with: ctx.with });
  }
}

// ─── Incoming message handler ──────────────────────────────────
function handleMessage(data) {
  switch (data.type) {

    case 'joined':
      // Confirmed join; request history for current context if any
      break;

    case 'join_error': {
      if (data.reason === 'name_taken') {
        const takenName = myName;
        myName = '';
        localStorage.removeItem('hc_name');
        nameError.textContent = `"${takenName}" is already in use. Choose another name.`;
        nameInput.value = takenName;
        showModal();
      }
      break;
    }

    case 'room_list': {
      const prevRoom = currentContext?.type === 'room' ? currentContext.room : null;
      rooms = data.rooms;
      renderRooms();
      if (!currentContext && rooms.length > 0) {
        // Auto-select first room on initial load
        selectContext({ type: 'room', room: rooms[0].name });
      } else if (prevRoom && !rooms.some(r => r.name === prevRoom)) {
        // Currently-viewed room was deleted — move to first available
        if (rooms.length > 0) {
          selectContext({ type: 'room', room: rooms[0].name });
        } else {
          currentContext = null;
          chatTitle.textContent = 'Select a room';
          chatSubtitle.textContent = '';
          messages.innerHTML = '';
        }
      }
      break;
    }

    case 'user_list':
      onlineUsers = data.users;
      renderPeople();
      break;

    case 'known_users': {
      knownUsers = data.users;
      renderPeople();
      // Prefetch DM histories so we can show unread badges for offline messages
      for (const user of knownUsers) {
        if (user !== myName) send({ type: 'history', context: 'dm', with: user });
      }
      break;
    }

    case 'history': {
      const ctx = data.context === 'room'
        ? { type: 'room', room: data.room }
        : { type: 'dm', with: data.with };
      const key = ctxKey(ctx);
      messageHistory[key] = data.messages;
      if (ctxKey(currentContext) === key) {
        renderMessages(messageHistory[key]);
        // Update last-seen when history arrives for open DM
        if (ctx.type === 'dm' && messageHistory[key].length > 0) {
          setDmLastSeen(ctx.with, messageHistory[key][messageHistory[key].length - 1].ts);
        }
      } else if (ctx.type === 'dm') {
        // Detect unread messages from while we were offline
        const msgs = messageHistory[key];
        const lastSeen = getDmLastSeen(ctx.with);
        const unreadCount = msgs.filter(m => m.from !== myName && m.ts > lastSeen).length;
        if (unreadCount > 0) {
          unread[key] = unreadCount;
          renderPeople();
        }
      }
      break;
    }

    case 'claude_thinking': {
      if (currentContext?.type === 'room' && currentContext.room === data.room) {
        showClaudeThinking();
      }
      break;
    }

    case 'room_msg': {
      if (data.from === 'Claude') removeClaudeThinking();

      const key = `room:${data.room}`;
      if (!messageHistory[key]) messageHistory[key] = [];
      messageHistory[key].push(data);
      if (messageHistory[key].length > HISTORY_LIMIT) {
        messageHistory[key] = messageHistory[key].slice(-HISTORY_LIMIT);
      }

      if (ctxKey(currentContext) === key) {
        appendMessage(data);
      } else {
        // Increment unread badge
        unread[key] = (unread[key] || 0) + 1;
        renderRooms();
      }
      break;
    }

    case 'dm': {
      const peer = data.from === myName ? data.to : data.from;
      const key = `dm:${peer}`;
      if (!messageHistory[key]) messageHistory[key] = [];
      messageHistory[key].push(data);
      if (messageHistory[key].length > HISTORY_LIMIT) {
        messageHistory[key] = messageHistory[key].slice(-HISTORY_LIMIT);
      }

      if (ctxKey(currentContext) === key) {
        appendMessage(data);
      } else if (data.from !== myName) {
        // Incoming DM from someone else
        unread[key] = (unread[key] || 0) + 1;
        renderPeople();
        showNotification(`HomeChat — DM from ${data.from}`, data.text);
      }
      break;
    }

    case 'msg_deleted': {
      const bubble = document.querySelector(`[data-msg-id="${data.id}"]`);
      if (bubble) {
        const group = bubble.closest('.msg-group');
        bubble.remove();
        if (group && group.querySelectorAll('.bubble').length === 0) {
          group.remove();
        }
      }
      for (const key of Object.keys(messageHistory)) {
        messageHistory[key] = messageHistory[key].filter(m => m.id !== data.id);
      }
      break;
    }
  }
}

// ─── Render rooms ─────────────────────────────────────────────
let dragSrc = null;

function renderRooms() {
  roomList.innerHTML = '';
  for (const room of rooms) {
    const key = `room:${room.name}`;
    const isActive = currentContext?.type === 'room' && currentContext.room === room.name;
    const count = unread[key] || 0;

    const item = document.createElement('div');
    item.className = 'sidebar-item' + (isActive ? ' active' : '');
    item.draggable = true;
    item.dataset.room = room.name;
    item.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <span class="room-prefix">${room.members ? '🔒' : '#'}</span>
      <span class="item-name">${room.name}</span>
      ${count > 0 && !isActive ? `<span class="badge">${count}</span>` : ''}
    `;
    item.addEventListener('click', () => {
      closeSidebar();
      selectContext({ type: 'room', room: room.name });
    });

    // Drag-and-drop reordering
    item.addEventListener('dragstart', e => {
      dragSrc = room.name;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.classList.add('dragging'), 0);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      roomList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrc && dragSrc !== room.name) item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!dragSrc || dragSrc === room.name) return;

      // Reorder locally and send to server
      const names = rooms.map(r => r.name);
      const fromIdx = names.indexOf(dragSrc);
      const toIdx = names.indexOf(room.name);
      names.splice(fromIdx, 1);
      names.splice(toIdx, 0, dragSrc);
      send({ type: 'reorder_rooms', rooms: names });
    });

    // Only show delete button for rooms this user created
    if (room.creator === myName) {
      const delBtn = document.createElement('button');
      delBtn.className = 'room-delete-btn';
      delBtn.title = `Delete #${room.name}`;
      delBtn.textContent = '×';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete #${room.name}?\n\nEveryone will lose access to this room.`)) {
          send({ type: 'delete_room', name: room.name });
        }
      });
      item.appendChild(delBtn);
    }

    roomList.appendChild(item);
  }
}

// ─── Render people ────────────────────────────────────────────
function renderPeople() {
  peopleList.innerHTML = '';

  // Build combined list: known users + anyone online not yet known, minus self
  const allUsers = [...new Set([...knownUsers, ...onlineUsers])].filter(u => u !== myName && u !== 'HomeBot' && u !== 'Claude');

  // Sort: online first, then offline alphabetically
  allUsers.sort((a, b) => {
    const aOnline = onlineUsers.includes(a);
    const bOnline = onlineUsers.includes(b);
    if (aOnline !== bOnline) return aOnline ? -1 : 1;
    return a.localeCompare(b);
  });

  for (const user of allUsers) {
    const key = `dm:${user}`;
    const isActive = currentContext?.type === 'dm' && currentContext.with === user;
    const isOnline = onlineUsers.includes(user);
    const count = unread[key] || 0;

    const item = document.createElement('div');
    item.className = 'sidebar-item' + (isActive ? ' active' : '') + (isOnline ? '' : ' offline-user');
    item.innerHTML = `
      <span class="online-dot${isOnline ? '' : ' dot-offline'}"></span>
      <span class="item-name">${escapeHtml(user)}</span>
      ${count > 0 && !isActive ? `<span class="badge">${count}</span>` : ''}
    `;
    item.addEventListener('click', () => {
      closeSidebar();
      selectContext({ type: 'dm', with: user });
    });
    peopleList.appendChild(item);
  }

  // Show myself
  const meItem = document.createElement('div');
  meItem.className = 'sidebar-item';
  meItem.style.cursor = 'default';
  meItem.innerHTML = `
    <span class="online-dot"></span>
    <span class="item-name" style="color:var(--text)">${escapeHtml(myName)} <span style="color:var(--text-muted);font-size:12px">(you)</span></span>
  `;
  peopleList.appendChild(meItem);
}

// ─── Select context ───────────────────────────────────────────
function selectContext(ctx) {
  currentContext = ctx;
  const key = ctxKey(ctx);

  // Clear unread for this context
  delete unread[key];

  // Mark DM as read up to now
  if (ctx.type === 'dm' && messageHistory[key]?.length > 0) {
    setDmLastSeen(ctx.with, messageHistory[key][messageHistory[key].length - 1].ts);
  }

  // Update header
  if (ctx.type === 'room') {
    chatTitle.textContent = `#${ctx.room}`;
    chatSubtitle.textContent = '';
  } else {
    const isOnline = onlineUsers.includes(ctx.with);
    chatTitle.textContent = ctx.with;
    chatSubtitle.textContent = isOnline ? 'Online' : 'Offline';
  }

  // Update sidebar active states
  renderRooms();
  renderPeople();

  // Show cached history if we have it, then fetch fresh
  if (messageHistory[key]) {
    renderMessages(messageHistory[key]);
  } else {
    messages.innerHTML = '';
  }

  requestHistory(ctx);
  msgInput.focus();
}

// ─── Render messages (full rebuild) ───────────────────────────
function renderMessages(msgs) {
  messages.innerHTML = '';
  if (!msgs || msgs.length === 0) {
    messages.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px 20px;font-size:14px">No messages yet. Say hi!</div>';
    return;
  }

  let lastSender = null;
  let lastTs = 0;
  let currentGroup = null;

  for (const msg of msgs) {
    const sender = msg.from;
    const isMe = sender === myName;
    const timeDiff = msg.ts - lastTs;
    const newGroup = sender !== lastSender || timeDiff > 5 * 60 * 1000; // 5 min gap = new group

    if (newGroup) {
      const groupClass = isMe ? 'mine' : sender === 'HomeBot' ? 'bot' : sender === 'Claude' ? 'bot-claude' : 'theirs';
      currentGroup = document.createElement('div');
      currentGroup.className = 'msg-group ' + groupClass;
      currentGroup.dataset.sender = sender;

      if (!isMe) {
        const nameEl = document.createElement('div');
        nameEl.className = 'sender-name';
        if (sender === 'HomeBot') nameEl.textContent = '⚡ HomeBot';
        else if (sender === 'Claude') nameEl.textContent = '🤖 Claude';
        else nameEl.textContent = sender;
        currentGroup.appendChild(nameEl);
      }

      messages.appendChild(currentGroup);
      lastSender = sender;
    }

    currentGroup.appendChild(makeBubble(msg));

    lastTs = msg.ts;
  }

  // Add time to last group
  if (currentGroup && msgs.length > 0) {
    const lastMsg = msgs[msgs.length - 1];
    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time';
    timeEl.textContent = formatTime(lastMsg.ts);
    currentGroup.appendChild(timeEl);
  }

  scrollToBottom();
}

// ─── Append single message ─────────────────────────────────────
function appendMessage(msg) {
  const isMe = msg.from === myName;

  // Check if we can append to the last group
  const lastGroup = messages.querySelector('.msg-group:last-child');
  const isSameSender = lastGroup && (
    (isMe && lastGroup.classList.contains('mine')) ||
    (!isMe && lastGroup.dataset.sender === msg.from)
  );

  // Check time gap — find last bubble's approximate time
  // (We track it loosely; exact grouping is done in renderMessages)
  let group = null;
  if (isSameSender) {
    group = lastGroup;
    // Remove old time from last group if present
    const oldTime = group.querySelector('.msg-time');
    if (oldTime) oldTime.remove();
  } else {
    const groupClass = isMe ? 'mine' : msg.from === 'HomeBot' ? 'bot' : msg.from === 'Claude' ? 'bot-claude' : 'theirs';
    group = document.createElement('div');
    group.className = 'msg-group ' + groupClass;
    group.dataset.sender = msg.from;

    if (!isMe) {
      const nameEl = document.createElement('div');
      nameEl.className = 'sender-name';
      if (msg.from === 'HomeBot') nameEl.textContent = '⚡ HomeBot';
      else if (msg.from === 'Claude') nameEl.textContent = '🤖 Claude';
      else nameEl.textContent = msg.from;
      group.appendChild(nameEl);
    }

    messages.appendChild(group);
  }

  group.appendChild(makeBubble(msg));

  const timeEl = document.createElement('div');
  timeEl.className = 'msg-time';
  timeEl.textContent = formatTime(msg.ts);
  group.appendChild(timeEl);

  scrollToBottom();
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

// ─── Claude thinking indicator ─────────────────────────────────
function showClaudeThinking() {
  removeClaudeThinking();
  const indicator = document.createElement('div');
  indicator.id = 'claude-thinking';
  indicator.className = 'msg-group bot-claude';
  indicator.innerHTML = `
    <div class="sender-name">🤖 Claude</div>
    <div class="bubble claude-thinking-bubble">
      <span class="thinking-dot"></span>
      <span class="thinking-dot"></span>
      <span class="thinking-dot"></span>
    </div>
  `;
  messages.appendChild(indicator);
  scrollToBottom();
}

function removeClaudeThinking() {
  const el = document.getElementById('claude-thinking');
  if (el) el.remove();
}

// ─── Linkify ──────────────────────────────────────────────────
const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

function linkifyText(text) {
  const parts = text.split(URL_RE);
  const frag = document.createDocumentFragment();
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const a = document.createElement('a');
      a.href = part;
      a.textContent = part;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      frag.appendChild(a);
    } else if (part) {
      frag.appendChild(document.createTextNode(part));
    }
  });
  return frag;
}

async function addLinkPreview(bubble, url) {
  try {
    const res = await fetch(`/preview?url=${encodeURIComponent(url)}`);
    const d = await res.json();
    if (!d.title && !d.description) return;

    const card = document.createElement('a');
    card.className = 'link-preview';
    card.href = d.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    if (d.image) {
      const img = document.createElement('img');
      img.src = d.image;
      img.className = 'preview-img';
      img.alt = '';
      img.onerror = () => img.remove();
      card.appendChild(img);
    }

    const info = document.createElement('div');
    info.className = 'preview-info';
    if (d.siteName) {
      const s = document.createElement('div');
      s.className = 'preview-site';
      s.textContent = d.siteName;
      info.appendChild(s);
    }
    if (d.title) {
      const t = document.createElement('div');
      t.className = 'preview-title';
      t.textContent = d.title;
      info.appendChild(t);
    }
    if (d.description) {
      const desc = document.createElement('div');
      desc.className = 'preview-desc';
      desc.textContent = d.description;
      info.appendChild(desc);
    }
    card.appendChild(info);
    bubble.appendChild(card);
    scrollToBottom();
  } catch { /* silently skip */ }
}

// ─── Make bubble (text or image) ──────────────────────────────
function makeBubble(msg) {
  const bubble = document.createElement('div');
  if (msg.imgUrl) {
    bubble.className = 'bubble bubble-img';
    const img = document.createElement('img');
    img.className = 'chat-img';
    img.src = msg.imgUrl;
    img.alt = 'image';
    img.addEventListener('click', () => openLightbox(msg.imgUrl));
    bubble.appendChild(img);
  } else {
    bubble.className = 'bubble';
    bubble.appendChild(linkifyText(msg.text));
    const urlMatch = msg.text.match(URL_RE);
    if (urlMatch) addLinkPreview(bubble, urlMatch[0]);
  }

  if (msg.id) {
    bubble.dataset.msgId = msg.id;
    if (msg.from === myName) {
      const delBtn = document.createElement('button');
      delBtn.className = 'msg-delete-btn';
      delBtn.title = 'Delete message';
      delBtn.textContent = '\xd7';
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (confirm('Delete this message?')) send({ type: 'delete_msg', id: msg.id });
      });
      bubble.appendChild(delBtn);
    }
  }

  return bubble;
}

// ─── Lightbox ─────────────────────────────────────────────────
function openLightbox(src) {
  lightboxImg.src = src;
  lightbox.classList.remove('hidden');
}
lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));
document.addEventListener('keydown', e => { if (e.key === 'Escape') lightbox.classList.add('hidden'); });

// ─── Image upload ─────────────────────────────────────────────
async function uploadAndSend(file) {
  if (!currentContext || !ws || ws.readyState !== WebSocket.OPEN) return;

  // file.type can be empty on some mobile browsers for camera captures;
  // fall back to extension check before giving up
  const knownImageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'];
  const ext = file.name.split('.').pop().toLowerCase();
  const isImage = file.type.startsWith('image/') || knownImageExts.includes(ext);
  if (!isImage) return;

  // Default to jpeg if type is missing (common for camera captures on mobile)
  const contentType = file.type || 'image/jpeg';

  imgBtn.disabled = true;
  camBtn.disabled = true;
  try {
    const res = await fetch('/upload', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: file
    });
    if (!res.ok) throw new Error('Upload failed');
    const { url } = await res.json();

    if (currentContext.type === 'room') {
      send({ type: 'room_msg', room: currentContext.room, text: '', imgUrl: url });
    } else {
      send({ type: 'dm', to: currentContext.with, text: '', imgUrl: url });
    }
  } catch (err) {
    alert('Image upload failed. Try a smaller image (max 10 MB).');
  } finally {
    imgBtn.disabled = false;
    camBtn.disabled = false;
  }
}

imgBtn.addEventListener('click', () => imgInput.click());
imgInput.addEventListener('change', () => {
  const file = imgInput.files[0];
  if (file) { uploadAndSend(file); imgInput.value = ''; }
});

camBtn.addEventListener('click', () => camInput.click());
camInput.addEventListener('change', () => {
  const file = camInput.files[0];
  if (file) { uploadAndSend(file); camInput.value = ''; }
});

// Paste image from clipboard
document.addEventListener('paste', e => {
  if (!currentContext) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) uploadAndSend(file);
      break;
    }
  }
});

// ─── Send message ─────────────────────────────────────────────
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !currentContext || !ws || ws.readyState !== WebSocket.OPEN) return;

  if (currentContext.type === 'room') {
    send({ type: 'room_msg', room: currentContext.room, text });
  } else {
    send({ type: 'dm', to: currentContext.with, text });
  }

  msgInput.value = '';
}

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ─── Escape HTML ──────────────────────────────────────────────
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Service Worker ───────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('SW registration failed:', err);
  });
}

// ─── Init ─────────────────────────────────────────────────────
function init() {
  if (!myName) {
    showModal();
  } else {
    modalOverlay.classList.add('hidden');
    myNameDisplay.textContent = `Signed in as ${myName}`;
    requestNotificationPermission();
    connectWS();
    // Room list + auto-select first room arrives via 'room_list' message after join
  }
}

init();
