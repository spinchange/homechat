const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'messages.ndjson');

let messages = [];

// Load existing messages on startup
if (fs.existsSync(DATA_FILE)) {
  const lines = fs.readFileSync(DATA_FILE, 'utf8').split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  console.log(`Loaded ${messages.length} messages from disk.`);
}

function saveMessage(msg) {
  if (!msg.id) msg.id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  messages.push(msg);
  fs.appendFileSync(DATA_FILE, JSON.stringify(msg) + '\n', 'utf8');
}

function rewriteFile() {
  const content = messages.map(m => JSON.stringify(m)).join('\n');
  fs.writeFileSync(DATA_FILE, content ? content + '\n' : '', 'utf8');
}

function deleteMessage(id, fromName) {
  const idx = messages.findIndex(m => m.id === id && m.from === fromName);
  if (idx === -1) return false;
  messages.splice(idx, 1);
  rewriteFile();
  return true;
}

function getRoomHistory(room, limit = 200) {
  return messages
    .filter(m => m.type === 'room_msg' && m.room === room)
    .slice(-limit);
}

function getDMHistory(user1, user2, limit = 200) {
  return messages
    .filter(m =>
      m.type === 'dm' &&
      ((m.from === user1 && m.to === user2) ||
       (m.from === user2 && m.to === user1))
    )
    .slice(-limit);
}

function getKnownUsers() {
  const users = new Set();
  for (const m of messages) {
    if (m.from) users.add(m.from);
  }
  return Array.from(users);
}

module.exports = { saveMessage, getRoomHistory, getDMHistory, deleteMessage, getKnownUsers };
