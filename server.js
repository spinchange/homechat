require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');
const db = require('./db');

// ─── Claude API ────────────────────────────────────────────────
let anthropic = null;
try {
  const _sdk = require('@anthropic-ai/sdk');
  const Anthropic = _sdk.default || _sdk;
  if (process.env.CLAUDE_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
    console.log('Claude API: ready');
  } else {
    console.log('Claude API: disabled (add CLAUDE_API_KEY to .env to enable)');
  }
} catch (e) {
  console.log('Claude API: disabled (SDK not found)');
}

// ─── Rooms ─────────────────────────────────────────────────────
const ROOMS_FILE = path.join(__dirname, 'rooms.json');
const DEFAULT_ROOMS = ['general', 'finances', 'travel', 'kids', 'appointments', 'events'];

// Rooms are stored as { name, creator } objects. creator: null = default (undeletable).
let rooms = DEFAULT_ROOMS.map(n => ({ name: n, creator: null }));
if (fs.existsSync(ROOMS_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    // Migrate old format (plain string array) to object array
    rooms = parsed.map(r => typeof r === 'string' ? { name: r, creator: null } : r);
  } catch {}
}

function saveRooms() {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms), 'utf8');
}

const PORT = 3000;

// Get local IP for display — prefer Wi-Fi/Ethernet, skip virtual and link-local
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/loopback|vethernet|vmware|virtualbox|hyper-v/i.test(name)) continue;
    for (const iface of addrs) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254')) {
        const priority = /wi.?fi|wireless|wlan/i.test(name) ? 0 : /ethernet|local area/i.test(name) ? 1 : 2;
        candidates.push({ address: iface.address, priority });
      }
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.address || 'localhost';
}

// ─── Room helpers ─────────────────────────────────────────────
function getRoomsForUser(name) {
  return rooms.filter(r => !r.members || r.members.includes(name));
}

function broadcastRoomLists() {
  for (const [name, sockets] of clients.entries()) {
    const userRooms = getRoomsForUser(name);
    const msg = JSON.stringify({ type: 'room_list', rooms: userRooms });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}

function broadcastToRoom(room, data) {
  if (!room.members) {
    broadcast(data);
  } else {
    for (const member of room.members) sendToUser(member, data);
  }
}

// ─── Known users (everyone who has ever posted) ────────────────
const knownUsers = new Set(db.getKnownUsers());
knownUsers.add('HomeBot');
knownUsers.add('Claude');

function broadcastKnownUsers() {
  broadcast({ type: 'known_users', users: Array.from(knownUsers) });
}

// ─── HomeBot ───────────────────────────────────────────────────
const HOMEBOT_COMMANDS = ['!ping','!uptime','!who','!storage','!network','!version','!help'];

function handleBotCommand(text, room) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();
  if (!HOMEBOT_COMMANDS.includes(cmd)) return;

  function respond(response) {
    const msg = { type: 'room_msg', room: room.name, from: 'HomeBot',
                  text: response, ts: Date.now() };
    db.saveMessage(msg);
    broadcastToRoom(room, msg);
  }

  switch (cmd) {
    case '!ping':
      respond('🏓 Pong!');
      break;

    case '!uptime': {
      const s = Math.floor(process.uptime());
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      respond(`⏱ Server uptime: ${d}d ${h}h ${m}m ${sec}s`);
      break;
    }

    case '!who': {
      const online = Array.from(clients.keys());
      respond(online.length
        ? `👥 Online (${online.length}): ${online.join(', ')}`
        : '👥 Nobody is online right now.');
      break;
    }

    case '!version':
      respond(`📦 HomeChat v${require('./package.json').version} · Node ${process.version} · ${process.platform}`);
      break;

    case '!storage':
      exec(
        'powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Name + \': \' + [math]::Round($_.Free/1GB,1) + \'GB free of \' + [math]::Round(($_.Used+$_.Free)/1GB,1) + \'GB\' }"',
        (err, stdout) => {
          if (err || !stdout.trim()) return respond('❌ Could not read disk info.');
          respond('💾 Disk space:\n' + stdout.trim());
        }
      );
      break;

    case '!network':
      exec('arp -a', (err, stdout) => {
        if (err || !stdout.trim()) return respond('❌ Could not read network info.');
        const ips = stdout.split('\n')
          .filter(l => /dynamic/i.test(l))
          .map(l => l.trim().split(/\s+/)[0])
          .filter(Boolean);
        respond(ips.length
          ? `📡 Devices on network (${ips.length}):\n${ips.join('\n')}`
          : '📡 No devices found.');
      });
      break;

    case '!help':
      respond(
        'HomeBot commands:\n' +
        '!ping      — check if bot is alive\n' +
        '!uptime    — server uptime\n' +
        '!who       — who\'s online in HomeChat\n' +
        '!storage   — disk space on the server\n' +
        '!network   — devices on the home network\n' +
        '!version   — app and Node version\n' +
        '!help      — show this list\n\n' +
        'Claude AI:\n' +
        '!claude <question>  — ask Claude anything\n' +
        '#claude room        — every message goes to Claude'
      );
      break;
  }
}

// ─── Claude ───────────────────────────────────────────────────
async function handleClaudeMessage(prompt, room, requestingUser) {
  if (!anthropic) {
    const msg = { type: 'room_msg', room: room.name, from: 'Claude',
      text: '❌ Claude API not configured. Add CLAUDE_API_KEY to .env to enable.', ts: Date.now() };
    db.saveMessage(msg);
    broadcastToRoom(room, msg);
    return;
  }

  // Notify clients that Claude is thinking
  broadcastToRoom(room, { type: 'claude_thinking', room: room.name });

  try {
    const systemPrompt = `You are Claude, an AI assistant in HomeChat, a family home chat app. Be friendly, helpful, and concise. You're chatting in the #${room.name} room. The person talking to you is ${requestingUser}.`;

    // Get recent room history for context.
    // For the #claude room the current message is already saved, so we exclude it
    // (slice off the last item) to avoid duplication — the prompt is passed explicitly.
    // For !claude commands in other rooms the !claude message is filtered out below.
    const rawHistory = db.getRoomHistory(room.name, 30).slice(-20);
    const historyForContext = room.name === 'claude'
      ? rawHistory.slice(0, -1)   // exclude the just-saved message; we'll add prompt below
      : rawHistory;

    // Build an alternating user/assistant message array
    const rawMessages = [];
    for (const m of historyForContext) {
      if (!m.text || m.text.startsWith('!claude')) continue;
      rawMessages.push({
        role: m.from === 'Claude' ? 'assistant' : 'user',
        content: m.from === 'Claude' ? m.text : `${m.from}: ${m.text}`
      });
    }
    rawMessages.push({ role: 'user', content: prompt });

    // Merge consecutive same-role messages (API requires strict alternation)
    const apiMessages = [];
    for (const m of rawMessages) {
      if (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === m.role) {
        apiMessages[apiMessages.length - 1].content += '\n' + m.content;
      } else {
        apiMessages.push({ role: m.role, content: m.content });
      }
    }

    // Must start with 'user'
    while (apiMessages.length > 0 && apiMessages[0].role !== 'user') apiMessages.shift();
    if (apiMessages.length === 0) apiMessages.push({ role: 'user', content: prompt });

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: apiMessages
    });

    const responseText = response.content[0].text;
    const replyMsg = { type: 'room_msg', room: room.name, from: 'Claude', text: responseText, ts: Date.now() };
    db.saveMessage(replyMsg);
    broadcastToRoom(room, replyMsg);

  } catch (err) {
    console.error('Claude API error:', err.message);
    const errMsg = { type: 'room_msg', room: room.name, from: 'Claude',
      text: `❌ Sorry, something went wrong. (${err.message})`, ts: Date.now() };
    db.saveMessage(errMsg);
    broadcastToRoom(room, errMsg);
  }
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ─── Uploads ───────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const EXT_MAP = { jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', heic: 'heic', heif: 'heif' };

app.post('/upload', express.raw({ type: 'image/*', limit: '10mb' }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No image data' });
  const subtype = (req.headers['content-type'] || 'image/jpeg').split('/')[1]?.split(';')[0]?.toLowerCase() || 'jpeg';
  const ext = EXT_MAP[subtype] || 'jpg';
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  try {
    fs.writeFileSync(path.join(uploadsDir, filename), req.body);
    res.json({ url: `/uploads/${filename}` });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ─── Link Preview ──────────────────────────────────────────────
const previewCache = new Map(); // url -> preview data

app.get('/preview', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) return res.json({});
  if (previewCache.has(url)) return res.json(previewCache.get(url));
  try {
    const data = await fetchPreview(url);
    previewCache.set(url, data);
    if (previewCache.size > 200) previewCache.delete(previewCache.keys().next().value);
    res.json(data);
  } catch {
    res.json({});
  }
});

function fetchPreview(urlStr, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(urlStr); } catch { return reject(new Error('Bad URL')); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return reject(new Error('Bad protocol'));

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      { hostname: parsed.hostname, port: parsed.port || undefined,
        path: parsed.pathname + parsed.search, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HomeChat-Preview/1.0)', Accept: 'text/html' },
        timeout: 5000, rejectUnauthorized: false },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, urlStr).href;
          return fetchPreview(next, redirects + 1).then(resolve).catch(reject);
        }
        const ct = res.headers['content-type'] || '';
        if (!ct.includes('text/html')) return resolve({});
        let html = '';
        res.setEncoding('utf8');
        res.on('data', c => { html += c; if (html.length > 150000) res.destroy(); });
        res.on('end', () => resolve(parseOG(html, urlStr)));
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function parseOG(html, pageUrl) {
  const tag = (prop) => {
    const m =
      html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*?)["']`, 'i')) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']${prop}["']`, 'i'));
    return m ? decode(m[1]) : null;
  };
  const meta = (name) => {
    const m =
      html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*?)["']`, 'i')) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']${name}["']`, 'i'));
    return m ? decode(m[1]) : null;
  };

  const title       = tag('og:title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i) ? decode(html.match(/<title[^>]*>([^<]+)<\/title>/i)[1]) : null);
  const description = tag('og:description') || meta('description');
  const siteName    = tag('og:site_name') || new URL(pageUrl).hostname;
  let   image       = tag('og:image');

  // Resolve relative image URL
  if (image && !image.startsWith('http')) {
    try { image = new URL(image, pageUrl).href; } catch { image = null; }
  }

  return { title: title?.trim().slice(0, 200) || null,
           description: description?.trim().slice(0, 300) || null,
           image: image || null,
           siteName: siteName?.slice(0, 100) || null,
           url: pageUrl };
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// clients: name -> Set of WebSocket connections
const clients = new Map();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const sockets of clients.values()) {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}

function sendToUser(name, data) {
  const sockets = clients.get(name);
  if (!sockets) return;
  const msg = JSON.stringify(data);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function getUserList() {
  return Array.from(clients.keys());
}

wss.on('connection', (ws) => {
  let userName = null;

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === 'join') {
      const name = String(data.name || '').trim().slice(0, 32);
      if (!name) return;

      // Reject if name is already in use by an active connection
      if (clients.has(name) && clients.get(name).size > 0) {
        ws.send(JSON.stringify({ type: 'join_error', reason: 'name_taken' }));
        return;
      }

      userName = name;

      if (!clients.has(name)) {
        clients.set(name, new Set());
      }
      clients.get(name).add(ws);

      // Send current user list to everyone
      broadcast({ type: 'user_list', users: getUserList() });

      // Send room list, known users, and confirm join to this client
      ws.send(JSON.stringify({ type: 'room_list', rooms: getRoomsForUser(name) }));
      ws.send(JSON.stringify({ type: 'known_users', users: Array.from(knownUsers) }));
      ws.send(JSON.stringify({ type: 'joined', name }));

    } else if (data.type === 'history') {
      if (!userName) return;

      let history;
      if (data.context === 'room') {
        const room = rooms.find(r => r.name === data.room);
        if (!room || (room.members && !room.members.includes(userName))) return;
        history = db.getRoomHistory(data.room);
      } else if (data.context === 'dm') {
        history = db.getDMHistory(userName, data.with);
      } else {
        return;
      }

      ws.send(JSON.stringify({ type: 'history', context: data.context, room: data.room, with: data.with, messages: history }));

    } else if (data.type === 'room_msg') {
      if (!userName) return;

      const room = rooms.find(r => r.name === data.room);
      if (!room || (room.members && !room.members.includes(userName))) return;

      const imgUrl = typeof data.imgUrl === 'string' && /^\/uploads\/[\w.-]+$/.test(data.imgUrl) ? data.imgUrl : null;
      const msg = {
        type: 'room_msg',
        room: data.room,
        from: userName,
        text: String(data.text || '').slice(0, 2000),
        ts: Date.now()
      };
      if (imgUrl) msg.imgUrl = imgUrl;

      db.saveMessage(msg);
      broadcastToRoom(room, msg);
      if (!knownUsers.has(userName)) { knownUsers.add(userName); broadcastKnownUsers(); }

      if (msg.text.startsWith('!claude')) {
        const prompt = msg.text.replace(/^!claude\s*/, '').trim();
        if (prompt) {
          handleClaudeMessage(prompt, room, userName);
        } else {
          const helpMsg = { type: 'room_msg', room: room.name, from: 'Claude',
            text: 'Usage: !claude <your question>', ts: Date.now() };
          db.saveMessage(helpMsg);
          broadcastToRoom(room, helpMsg);
        }
      } else if (msg.text.startsWith('!')) {
        handleBotCommand(msg.text, room);
      } else if (room.name === 'claude') {
        // In the #claude room every non-command message auto-triggers Claude
        handleClaudeMessage(msg.text, room, userName);
      }

    } else if (data.type === 'dm') {
      if (!userName) return;

      const to = String(data.to || '').trim();
      if (!to || to === userName) return;

      const dmImgUrl = typeof data.imgUrl === 'string' && /^\/uploads\/[\w.-]+$/.test(data.imgUrl) ? data.imgUrl : null;
      const msg = {
        type: 'dm',
        from: userName,
        to,
        text: String(data.text || '').slice(0, 2000),
        ts: Date.now()
      };
      if (dmImgUrl) msg.imgUrl = dmImgUrl;

      db.saveMessage(msg);
      if (!knownUsers.has(userName)) { knownUsers.add(userName); broadcastKnownUsers(); }

      // Send to recipient and echo to sender (all their devices)
      sendToUser(to, msg);
      sendToUser(userName, msg);

    } else if (data.type === 'create_room') {
      if (!userName) return;

      // Slugify: lowercase, spaces→hyphens, strip non-alphanumeric/hyphen
      const name = String(data.name || '')
        .trim().toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);

      if (!name || rooms.some(r => r.name === name)) return;

      // members: null = public; array = private (creator always included)
      let members = null;
      if (Array.isArray(data.members)) {
        const valid = data.members
          .map(m => String(m).trim().slice(0, 32))
          .filter(m => knownUsers.has(m) && m !== userName);
        members = [userName, ...valid];
      }

      rooms.push({ name, creator: userName, members });
      saveRooms();
      broadcastRoomLists();

    } else if (data.type === 'delete_room') {
      if (!userName) return;

      const name = String(data.name || '').trim();
      const room = rooms.find(r => r.name === name);
      // Only the creator can delete their own room; default rooms (creator: null) are protected
      if (!room || room.creator === null || room.creator !== userName) return;

      rooms = rooms.filter(r => r.name !== name);
      saveRooms();
      broadcastRoomLists();

    } else if (data.type === 'reorder_rooms') {
      if (!userName) return;

      const names = data.rooms;
      if (!Array.isArray(names)) return;

      // Must match exactly the set of rooms this user can see
      const visibleNames = getRoomsForUser(userName).map(r => r.name);
      const incomingNames = [...names].map(n => String(n));
      if (JSON.stringify([...visibleNames].sort()) !== JSON.stringify([...incomingNames].sort())) return;

      // Rebuild: user's new order for their visible rooms, hidden rooms appended unchanged
      const hiddenRooms = rooms.filter(r => !visibleNames.includes(r.name));
      rooms = [...incomingNames.map(n => rooms.find(r => r.name === n)), ...hiddenRooms];
      saveRooms();
      broadcastRoomLists();

    } else if (data.type === 'delete_msg') {
      if (!userName) return;

      const id = String(data.id || '').slice(0, 64);
      if (!id) return;

      if (db.deleteMessage(id, userName)) {
        broadcast({ type: 'msg_deleted', id });
      }
    }
  });

  ws.on('close', () => {
    if (userName) {
      const sockets = clients.get(userName);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          clients.delete(userName);
        }
      }
      broadcast({ type: 'user_list', users: getUserList() });
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\nHomeChat running!`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}  ← open this on your phone\n`);
});
