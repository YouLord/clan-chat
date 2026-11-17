const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

const JWT_SECRET = process.env.JWT_SECRET || 'matiz-squad-secret-change-in-production';
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// JWT middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  
  const token = auth.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Optional auth (for public routes)
function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    } catch (e) {}
  }
  next();
}

// ─── Auth Routes ───
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: 'Username 2-32 chars' });
  if (password.length < 4 || password.length > 128) return res.status(400).json({ error: 'Password 4-128 chars' });
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return res.status(400).json({ error: 'Only letters, numbers, _, -' });
  
  if (db.getUserByUsername(username)) return res.status(409).json({ error: 'Username taken' });
  
  const user = db.createUser(username, password);
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  
  const user = db.getUserByUsername(username);
  if (!user || !db.verifyPassword(user, password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  db.updateLastSeen(user.id);
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// ─── Channels ───
app.get('/api/channels', authMiddleware, (req, res) => {
  res.json({ channels: db.getChannels() });
});

app.post('/api/channels', authMiddleware, (req, res) => {
  const { name, type, topic } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'Name and type required' });
  if (!['text', 'voice'].includes(type)) return res.status(400).json({ error: 'Type: text or voice' });
  
  try {
    const channel = db.createChannel(name, type, topic || '');
    res.json({ channel });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

// ─── Messages ───
app.get('/api/channels/:channelId/messages', authMiddleware, (req, res) => {
  const { channelId } = req.params;
  const { limit = 100, before } = req.query;
  
  const channel = db.getChannelById(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  
  const messages = db.getMessages(channelId, parseInt(limit), before ? parseInt(before) : null);
  res.json({ messages });
});

app.post('/api/channels/:channelId/messages', authMiddleware, (req, res) => {
  const { channelId } = req.params;
  const { content, type = 'text', replyTo } = req.body;
  
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  
  const channel = db.getChannelById(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.type !== 'text') return res.status(400).json({ error: 'Not a text channel' });
  
  const message = db.createMessage(channelId, req.user.id, content.trim(), type, replyTo);
  res.json({ message });
});

app.patch('/api/messages/:messageId', authMiddleware, (req, res) => {
  const { messageId } = req.params;
  const { content } = req.body;
  
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  
  const message = db.editMessage(messageId, req.user.id, content.trim());
  if (!message) return res.status(404).json({ error: 'Message not found or not yours' });
  
  res.json({ message });
});

app.delete('/api/messages/:messageId', authMiddleware, (req, res) => {
  const { messageId } = req.params;
  const deleted = db.deleteMessage(messageId, req.user.id);
  if (!deleted) return res.status(404).json({ error: 'Message not found or not yours' });
  res.json({ success: true });
});

// ─── Voice Channels ───
app.get('/api/voice/:channelId/members', authMiddleware, (req, res) => {
  const { channelId } = req.params;
  const channel = db.getChannelById(channelId);
  if (!channel || channel.type !== 'voice') return res.status(404).json({ error: 'Voice channel not found' });
  
  const members = db.getVoiceChannelMembers(channelId);
  res.json({ members });
});

// ─── Health ───
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── SPA Fallback ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Socket.io ───
const userSockets = new Map(); // userId -> Set(socketId)
const socketUser = new Map();  // socketId -> userId
const voiceStates = new Map(); // channelId -> Map(userId -> {socketId, muted, deafened})

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  
  try {
    const user = jwt.verify(token, JWT_SECRET);
    socket.user = user;
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  const username = socket.user.username;
  
  // Track user sockets
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);
  socketUser.set(socket.id, userId);
  
  db.updateLastSeen(userId);
  broadcastUserStatus(userId, 'online');
  
  console.log(`🔗 ${username} connected (${socket.id})`);
  
  // ─── Text Chat ───
  socket.on('join_channel', (channelId) => {
    socket.join(`channel:${channelId}`);
    socket.currentChannel = channelId;
  });
  
  socket.on('leave_channel', (channelId) => {
    socket.leave(`channel:${channelId}`);
    if (socket.currentChannel === channelId) socket.currentChannel = null;
  });
  
  socket.on('typing_start', (channelId) => {
    socket.to(`channel:${channelId}`).emit('user_typing', { userId, username, channelId });
  });
  
  socket.on('typing_stop', (channelId) => {
    socket.to(`channel:${channelId}`).emit('user_stop_typing', { userId, channelId });
  });
  
  // ─── Voice Chat (WebRTC Signaling) ───
  socket.on('voice_join', (channelId) => {
    const channel = db.getChannelById(channelId);
    if (!channel || channel.type !== 'voice') return;
    
    socket.join(`voice:${channelId}`);
    socket.voiceChannel = channelId;
    
    // Register in DB
    db.joinVoiceChannel(channelId, userId);
    
    // Track voice state
    if (!voiceStates.has(channelId)) voiceStates.set(channelId, new Map());
    voiceStates.get(channelId).set(userId, {
      socketId: socket.id,
      muted: false,
      deafened: false
    });
    
    // Notify others in voice channel
    const members = db.getVoiceChannelMembers(channelId)
      .filter(m => m.user_id !== userId)
      .map(m => ({ id: m.user_id, username: m.username, avatar_url: m.avatar_url }));
    
    socket.emit('voice_state', { channelId, members, you: { id: userId, username } });
    socket.to(`voice:${channelId}`).emit('voice_user_joined', { 
      userId, username, avatar_url: db.getUserById(userId)?.avatar_url 
    });
    
    console.log(`🎤 ${username} joined voice ${channelId}`);
  });
  
  socket.on('voice_leave', (channelId) => {
    if (socket.voiceChannel !== channelId) return;
    
    socket.leave(`voice:${channelId}`);
    socket.voiceChannel = null;
    
    db.leaveVoiceChannel(channelId, userId);
    
    const state = voiceStates.get(channelId);
    if (state) state.delete(userId);
    
    socket.to(`voice:${channelId}`).emit('voice_user_left', { userId });
    console.log(`🎤 ${username} left voice ${channelId}`);
  });
  
  // WebRTC Signaling
  socket.on('voice_signal', ({ channelId, targetId, signal }) => {
    const targetSockets = userSockets.get(targetId);
    if (!targetSockets) return;
    
    targetSockets.forEach(targetSocketId => {
      io.to(targetSocketId).emit('voice_signal', { from: userId, signal });
    });
  });
  
  socket.on('voice_mute', ({ channelId, muted }) => {
    const state = voiceStates.get(channelId)?.get(userId);
    if (state) {
      state.muted = muted;
      db.updateVoiceState(channelId, userId, { muted });
      socket.to(`voice:${channelId}`).emit('voice_user_mute', { userId, muted });
    }
  });
  
  socket.on('voice_deafen', ({ channelId, deafened }) => {
    const state = voiceStates.get(channelId)?.get(userId);
    if (state) {
      state.deafened = deafened;
      db.updateVoiceState(channelId, userId, { deafened });
      socket.to(`voice:${channelId}`).emit('voice_user_deafen', { userId, deafened });
    }
  });
  
  // ─── Disconnect ───
  socket.on('disconnect', () => {
    userSockets.get(userId)?.delete(socket.id);
    socketUser.delete(socket.id);
    
    if (userSockets.get(userId)?.size === 0) {
      userSockets.delete(userId);
      broadcastUserStatus(userId, 'offline');
      
      // Leave voice channel
      if (socket.voiceChannel) {
        const channelId = socket.voiceChannel;
        db.leaveVoiceChannel(channelId, userId);
        const state = voiceStates.get(channelId);
        if (state) state.delete(userId);
        socket.to(`voice:${channelId}`).emit('voice_user_left', { userId });
      }
    }
    
    console.log(`🔌 ${username} disconnected (${socket.id})`);
  });
});

function broadcastUserStatus(userId, status) {
  const user = db.getUserById(userId);
  if (!user) return;
  
  io.emit('user_status', { userId, username: user.username, status });
}

// ─── Start ───
db.init();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║  🎮 Matiz Chat Server                        ║
║  HTTP:  http://0.0.0.0:${PORT}                  ║
║  WS:    ws://0.0.0.0:${PORT}                    ║
╚═══════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});