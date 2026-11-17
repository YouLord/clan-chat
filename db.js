const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

// PostgreSQL support (optional, for production with persistent DB)
let pgPool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

// SQLite path - на Render free tier будет /tmp (сбрасывается при деплое)
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'matiz.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

function init() {
  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_url TEXT,
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    );
    
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  `);

  // Channels table
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
      topic TEXT,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(type);
  `);

  // Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text' CHECK (type IN ('text', 'system', 'file')),
      reply_to TEXT,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE SET NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  `);

  // Channel members (for voice channels tracking)
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      is_muted INTEGER DEFAULT 0,
      is_deafened INTEGER DEFAULT 0,
      PRIMARY KEY (channel_id, user_id),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Insert default channels if empty
  const channelCount = db.prepare('SELECT COUNT(*) as c FROM channels').get().c;
  if (channelCount === 0) {
    const now = Date.now();
    const insertChannel = db.prepare('INSERT INTO channels (id, name, type, topic, position, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    
    insertChannel.run('general', 'general', 'text', 'Общий чат клана', 0, now);
    insertChannel.run('voice-main', '🔊 Главный войс', 'voice', 'Заходи и общайся', 0, now + 1);
    insertChannel.run('voice-chill', '🎮 Чилл войс', 'voice', 'Для игр и отдыха', 1, now + 2);
    insertChannel.run('memes', 'memes', 'text', 'Мемы и смешное', 1, now + 3);
    insertChannel.run('demos', 'demos', 'text', 'Демки и клипы', 2, now + 4);
    
    console.log('✅ Default channels created');
  }
}

// User functions
function createUser(username, password) {
  const id = require('crypto').randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  
  const stmt = db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)');
  stmt.run(id, username.toLowerCase(), passwordHash, now);
  
  return { id, username: username.toLowerCase(), created_at: now };
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase());
}

function getUserById(id) {
  return db.prepare('SELECT id, username, avatar_url, created_at, last_seen FROM users WHERE id = ?').get(id);
}

function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}

function updateLastSeen(userId) {
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
}

// Channel functions
function getChannels() {
  return db.prepare('SELECT * FROM channels ORDER BY type DESC, position, name').all();
}

function getChannelById(id) {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

function createChannel(name, type, topic = '') {
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const exists = db.prepare('SELECT id FROM channels WHERE id = ?').get(id);
  if (exists) throw new Error('Channel already exists');
  
  const maxPos = db.prepare('SELECT MAX(position) as m FROM channels WHERE type = ?').get(type)?.m ?? -1;
  const now = Date.now();
  
  db.prepare('INSERT INTO channels (id, name, type, topic, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, type, topic, maxPos + 1, now);
  
  return getChannelById(id);
}

// Message functions
function createMessage(channelId, userId, content, type = 'text', replyTo = null) {
  const id = require('crypto').randomUUID();
  const now = Date.now();
  
  db.prepare('INSERT INTO messages (id, channel_id, user_id, content, type, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, channelId, userId, content, type, replyTo, now);
  
  return getMessageById(id);
}

function getMessageById(id) {
  return db.prepare(`
    SELECT m.*, u.username, u.avatar_url
    FROM messages m
    JOIN users u ON m.user_id = u.id
    WHERE m.id = ?
  `).get(id);
}

function getMessages(channelId, limit = 100, before = null) {
  let query = `
    SELECT m.*, u.username, u.avatar_url
    FROM messages m
    JOIN users u ON m.user_id = u.id
    WHERE m.channel_id = ?
  `;
  const params = [channelId];
  
  if (before) {
    query += ' AND m.created_at < ?';
    params.push(before);
  }
  
  query += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(limit);
  
  const messages = db.prepare(query).all(...params);
  return messages.reverse(); // Oldest first
}

function editMessage(messageId, userId, newContent) {
  const now = Date.now();
  const result = db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND user_id = ?')
    .run(newContent, now, messageId, userId);
  return result.changes > 0 ? getMessageById(messageId) : null;
}

function deleteMessage(messageId, userId) {
  return db.prepare('DELETE FROM messages WHERE id = ? AND user_id = ?').run(messageId, userId).changes > 0;
}

// Voice channel members
function joinVoiceChannel(channelId, userId) {
  const now = Date.now();
  db.prepare('INSERT OR REPLACE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)')
    .run(channelId, userId, now);
}

function leaveVoiceChannel(channelId, userId) {
  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(channelId, userId);
}

function getVoiceChannelMembers(channelId) {
  return db.prepare(`
    SELECT cm.*, u.username, u.avatar_url
    FROM channel_members cm
    JOIN users u ON cm.user_id = u.id
    WHERE cm.channel_id = ?
  `).all(channelId);
}

function updateVoiceState(channelId, userId, { muted, deafened } = {}) {
  const updates = [];
  const params = [];
  
  if (muted !== undefined) {
    updates.push('is_muted = ?');
    params.push(muted ? 1 : 0);
  }
  if (deafened !== undefined) {
    updates.push('is_deafened = ?');
    params.push(deafened ? 1 : 0);
  }
  
  if (updates.length === 0) return;
  
  params.push(channelId, userId);
  db.prepare(`UPDATE channel_members SET ${updates.join(', ')} WHERE channel_id = ? AND user_id = ?`).run(...params);
}

function clearVoiceChannel(channelId) {
  db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(channelId);
}

module.exports = {
  init,
  createUser,
  getUserByUsername,
  getUserById,
  verifyPassword,
  updateLastSeen,
  getChannels,
  getChannelById,
  createChannel,
  createMessage,
  getMessageById,
  getMessages,
  editMessage,
  deleteMessage,
  joinVoiceChannel,
  leaveVoiceChannel,
  getVoiceChannelMembers,
  updateVoiceState,
  clearVoiceChannel,
  db,
  pgPool,
  pgQuery: async (text, params) => {
    if (!pgPool) throw new Error('PostgreSQL not configured');
    return pgPool.query(text, params);
  }
};