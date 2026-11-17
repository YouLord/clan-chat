// ========================================
// Matiz Squad — Client App
// ========================================

const API_BASE = '';
const WS_PATH = '/socket.io';

// ─── State ───
let socket = null;
let token = localStorage.getItem('matiz_token') || null;
let currentUser = null;
let currentChannel = null;
let currentChannelType = null;
let channels = [];
let usersCache = new Map();
let messagesCache = new Map();
let typingUsers = new Map();
let replyToMessage = null;
let voicePeerConnections = new Map(); // userId -> RTCPeerConnection
let localStream = null;
let voiceChannelId = null;
let voiceMode = 'voice'; // 'voice' or 'ptt'
let pttKey = 'KeyX';
let pttActive = false;
let mediaDevices = { mics: [], speakers: [], cameras: [] };
let micTestInterval = null;

// ─── DOM Elements ───
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const authScreen = $('#auth-screen');
const mainScreen = $('#main-screen');
const loginForm = $('#login-form');
const registerForm = $('#register-form');
const authError = $('#auth-error');
const tabLogin = $('#tab-login');
const tabRegister = $('#tab-register');
const panelLogin = $('#panel-login');
const panelRegister = $('#panel-register');

const channelCategories = $('#channel-categories');
const messagesContainer = $('#messages-container');
const newMessagesBar = $('#new-messages-bar');
const messageInput = $('#message-input');
const sendBtn = $('#send-btn');
const replyPreview = $('#reply-preview');
const channelHeader = $('#channel-header');
const channelNameEl = $('#channel-name');
const channelTopicEl = $('#channel-topic');
const channelTypeIcon = $('#channel-type-icon');
const voiceJoinBtn = $('#voice-join-btn');
const messageInputArea = $('#message-input-area');
const membersList = $('#members-list');
const voiceUsersEl = $('#voice-users');
const rightSidebar = $('#right-sidebar');
const userNameEl = $('#user-name');
const userStatusEl = $('#user-status');
const userAvatarEl = $('#user-avatar');
const toasts = $('#toasts');

const voiceModal = $('#voice-modal');
const micSelect = $('#mic-select');
const speakerSelect = $('#speaker-select');
const cameraSelect = $('#camera-select');
const noiseSuppression = $('#noise-suppression');
const echoCancellation = $('#echo-cancellation');
const autoGain = $('#auto-gain');
const voiceModeRadios = $$('input[name="voice-mode"]');
const pttSetting = $('#ptt-setting');
const pttKeyInput = $('#ptt-key');
const micMeterFill = $('#mic-meter-fill');
const testMicBtn = $('#test-mic-btn');
const voiceJoinConfirm = $('#voice-join-confirm');
const voiceLeaveBtn = $('#voice-leave-btn');
const voiceModalClose = $('.modal-close', voiceModal);

const rsTabs = $$('.rs-tab');
const rsPanels = $$('.rs-panel');
const searchInput = $('#search-input');
const searchResults = $('#search-results');
const pinsList = $('#pins-list');

// ─── Init ───
document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupAuthTabs();
  setupForms();
  setupMessageInput();
  setupVoiceModal();
  setupRightSidebar();
  setupKeyboardShortcuts();
  await loadDevices();
  
  if (token) {
    try {
      await apiGet('/api/auth/me');
      showMainScreen();
    } catch (e) {
      logout();
    }
  }
}

// ─── Auth UI ───
function setupAuthTabs() {
  tabLogin.addEventListener('click', () => switchAuthTab('login'));
  tabRegister.addEventListener('click', () => switchAuthTab('register'));
}

function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  tabLogin.classList.toggle('active', isLogin);
  tabRegister.classList.toggle('active', !isLogin);
  panelLogin.classList.toggle('active', isLogin);
  panelRegister.classList.toggle('active', !isLogin);
  tabLogin.setAttribute('aria-selected', isLogin);
  tabRegister.setAttribute('aria-selected', !isLogin);
  authError.textContent = '';
}

function setupForms() {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(loginForm);
    await login(formData.get('username'), formData.get('password'));
  });
  
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(registerForm);
    const password = formData.get('password');
    const password2 = formData.get('password2');
    if (password !== password2) return showAuthError('Пароли не совпадают');
    await register(formData.get('username'), password);
  });
}

async function login(username, password) {
  setAuthLoading(true);
  try {
    const res = await apiPost('/api/auth/login', { username, password });
    token = res.token;
    currentUser = res.user;
    localStorage.setItem('matiz_token', token);
    showMainScreen();
  } catch (e) {
    showAuthError(e.message || 'Ошибка входа');
  } finally {
    setAuthLoading(false);
  }
}

async function register(username, password) {
  setAuthLoading(true);
  try {
    const res = await apiPost('/api/auth/register', { username, password });
    token = res.token;
    currentUser = res.user;
    localStorage.setItem('matiz_token', token);
    showMainScreen();
  } catch (e) {
    showAuthError(e.message || 'Ошибка регистрации');
  } finally {
    setAuthLoading(false);
  }
}

function setAuthLoading(loading) {
  const btns = $$('button[type="submit"]', authScreen);
  btns.forEach(b => b.disabled = loading);
}

function showAuthError(msg) {
  authError.textContent = msg;
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem('matiz_token');
  if (socket) socket.disconnect();
  showAuthScreen();
}

function showAuthScreen() {
  mainScreen.classList.add('hidden');
  authScreen.classList.remove('hidden');
  switchAuthTab('login');
  loginForm.reset();
  registerForm.reset();
}

async function showMainScreen() {
  authScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  initSocket();
  await loadChannels();
  updateUserPanel();
  setupChannelHeader();
}

// ─── API Helpers ───
async function apiRequest(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const apiGet = (endpoint) => apiRequest(endpoint, { method: 'GET' });
const apiPost = (endpoint, body) => apiRequest(endpoint, { method: 'POST', body: JSON.stringify(body) });
const apiPatch = (endpoint, body) => apiRequest(endpoint, { method: 'PATCH', body: JSON.stringify(body) });
const apiDelete = (endpoint) => apiRequest(endpoint, { method: 'DELETE' });

// ─── Socket.io ───
function initSocket() {
  socket = io(WS_PATH, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
  });
  
  socket.on('connect', () => {
    console.log('🔗 Socket connected');
    if (currentChannel) joinChannel(currentChannel);
  });
  
  socket.on('disconnect', (reason) => {
    console.log('🔌 Socket disconnected:', reason);
  });
  
  socket.on('connect_error', (err) => {
    console.error('Socket error:', err.message);
    if (err.message === 'Invalid token') logout();
  });
  
  // Messages
  socket.on('new_message', (msg) => handleNewMessage(msg));
  socket.on('message_edited', (msg) => handleEditedMessage(msg));
  socket.on('message_deleted', ({ messageId, channelId }) => handleDeletedMessage(messageId, channelId));
  
  // Typing
  socket.on('user_typing', ({ userId, username, channelId }) => showTyping(userId, username, channelId));
  socket.on('user_stop_typing', ({ userId, channelId }) => hideTyping(userId, channelId));
  
  // User status
  socket.on('user_status', ({ userId, username, status }) => updateUserStatus(userId, status));
  
  // Voice
  socket.on('voice_state', ({ channelId, members, you }) => handleVoiceState(channelId, members, you));
  socket.on('voice_user_joined', ({ userId, username, avatar_url }) => handleVoiceUserJoined(channelId, userId, username, avatar_url));
  socket.on('voice_user_left', ({ userId }) => handleVoiceUserLeft(userId));
  socket.on('voice_signal', ({ from, signal }) => handleVoiceSignal(from, signal));
  socket.on('voice_user_mute', ({ userId, muted }) => updateVoiceUserMute(userId, muted));
  socket.on('voice_user_deafen', ({ userId, deafened }) => updateVoiceUserDeafen(userId, deafened));
}

// ─── Channels ───
async function loadChannels() {
  try {
    const res = await apiGet('/api/channels');
    channels = res.channels;
    renderChannels();
  } catch (e) {
    console.error('Failed to load channels:', e);
    showToast('Не удалось загрузить каналы', 'error');
  }
}

function renderChannels() {
  const textChannels = channels.filter(c => c.type === 'text');
  const voiceChannels = channels.filter(c => c.type === 'voice');
  
  channelCategories.innerHTML = '';
  
  // Text channels category
  if (textChannels.length) {
    const cat = createCategory('ТЕКСТОВЫЕ КАНАЛй', textChannels, false);
    channelCategories.appendChild(cat);
  }
  
  // Voice channels category
  if (voiceChannels.length) {
    const cat = createCategory('ГОЛОСОВЫЕ КАНАЛЫ', voiceChannels, true);
    channelCategories.appendChild(cat);
  }
}

function createCategory(title, chans, isVoice) {
  const div = document.createElement('div');
  div.className = 'channel-category';
  div.innerHTML = `
    <div class="category-header">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        ${isVoice ? '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' : '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22 6 12 18 2 6"/>'}
      </svg>
      <span>${title}</span>
    </div>
    <ul class="channel-list"></ul>
  `;
  
  const list = div.querySelector('.channel-list');
  chans.forEach(ch => {
    const li = document.createElement('li');
    li.className = 'channel-item';
    li.innerHTML = `
      <button class="channel-btn" data-channel-id="${ch.id}" data-channel-type="${ch.type}" aria-label="${ch.name}${ch.topic ? ': ' + ch.topic : ''}">
        <span class="channel-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            ${ch.type === 'voice' 
              ? '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="19" x2="8" y2="22"/><line x1="16" y1="19" x2="16" y2="22"/>'
              : '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22 6 12 18 2 6"/>'}
          </svg>
        </span>
        <span>${escapeHtml(ch.name)}</span>
      </button>
    `;
    list.appendChild(li);
    
    const btn = li.querySelector('.channel-btn');
    btn.addEventListener('click', () => selectChannel(ch.id, ch.type));
    // Context menu for future features
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showChannelContextMenu(e, ch);
    });
  });
  
  return div;
}

function selectChannel(channelId, type) {
  // Update UI
  $$('.channel-btn').forEach(b => b.classList.remove('active'));
  const btn = $(`.channel-btn[data-channel-id="${channelId}"]`);
  if (btn) btn.classList.add('active');
  
  // Leave previous channel
  if (currentChannel && currentChannel !== channelId) {
    socket.emit('leave_channel', currentChannel);
    if (currentChannelType === 'voice') leaveVoiceChannel();
  }
  
  currentChannel = channelId;
  currentChannelType = type;
  
  // Join new channel
  socket.emit('join_channel', channelId);
  
  // Load messages if text channel
  if (type === 'text') {
    loadMessages(channelId);
    messageInputArea.classList.remove('hidden');
    voiceJoinBtn.classList.add('hidden');
  } else {
    messagesContainer.innerHTML = '';
    messageInputArea.classList.add('hidden');
    voiceJoinBtn.classList.remove('hidden');
  }
  
  updateChannelHeader(channelId, type);
  updateMembersList();
  closeSidebarOnMobile();
}

async function loadMessages(channelId, before = null) {
  try {
    const res = await apiGet(`/api/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`);
    const messages = res.messages;
    
    if (before) {
      // Prepend older messages
      messages.forEach(msg => prependMessage(msg));
    } else {
      // Replace all
      messagesContainer.innerHTML = '';
      messages.forEach(msg => appendMessage(msg));
      scrollToBottom(false);
    }
  } catch (e) {
    console.error('Failed to load messages:', e);
  }
}

function appendMessage(msg) {
  const el = createMessageElement(msg);
  messagesContainer.appendChild(el);
  messagesCache.set(msg.id, { ...msg, element: el });
  return el;
}

function prependMessage(msg) {
  const el = createMessageElement(msg);
  messagesContainer.insertBefore(el, messagesContainer.firstChild);
  messagesCache.set(msg.id, { ...msg, element: el });
}

function createMessageElement(msg) {
  const isOwn = msg.user_id === currentUser.id;
  const user = usersCache.get(msg.user_id) || { username: msg.username, avatar_url: msg.avatar_url };
  usersCache.set(msg.user_id, user);
  
  const div = document.createElement('div');
  div.className = `message ${isOwn ? 'own' : ''} ${msg.type === 'system' ? 'system' : ''}`;
  div.dataset.messageId = msg.id;
  
  const time = new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const edited = msg.edited_at ? `<span class="message-edited">(изменено)</span>` : '';
  const replyHtml = msg.reply_to ? `
    <div class="message-reply">
      <div class="message-reply-author">${escapeHtml(msg.reply_to.username || 'Unknown')}</div>
      <div class="message-reply-content">${escapeHtml(msg.reply_to.content?.slice(0, 50) || '')}</div>
    </div>
  ` : '';
  
  div.innerHTML = `
    <div class="message-avatar" style="background: ${stringToColor(user.username)}">${getInitials(user.username)}</div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-author">${escapeHtml(user.username)}</span>
        <span class="message-time">${time}</span>
        ${edited}
      </div>
      ${replyHtml}
      <div class="message-text">${formatMessage(msg.content)}</div>
      <div class="message-actions">
        ${isOwn ? `
          <button class="message-action-btn reply-btn" title="Ответить">Ответить</button>
          <button class="message-action-btn edit-btn" title="Редактировать (↑)">Редактировать</button>
          <button class="message-action-btn delete-btn" title="Удалить">Удалить</button>
        ` : `
          <button class="message-action-btn reply-btn" title="Ответить">Ответить</button>
        `}
      </div>
    </div>
  `;
  
  // Action buttons
  const replyBtn = div.querySelector('.reply-btn');
  if (replyBtn) replyBtn.addEventListener('click', () => startReply(msg));
  
  const editBtn = div.querySelector('.edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => startEdit(msg));
  
  const deleteBtn = div.querySelector('.delete-btn');
  if (deleteBtn) deleteBtn.addEventListener('click', () => deleteMessage(msg.id));
  
  // Click avatar -> mention
  div.querySelector('.message-avatar').addEventListener('click', () => mentionUser(user.username));
  div.querySelector('.message-author').addEventListener('click', () => mentionUser(user.username));
  
  return div;
}

function formatMessage(text) {
  if (!text) return '';
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/```([\s\S]+?)```/g, '<pre><code>$1</code></pre>')
    .replace(/^>\s(.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g, '<br>');
}

function handleNewMessage(msg) {
  if (msg.channel_id !== currentChannel) return;
  appendMessage(msg);
  scrollToBottom(true);
}

function handleEditedMessage(msg) {
  const cached = messagesCache.get(msg.id);
  if (cached?.element) {
    const textEl = cached.element.querySelector('.message-text');
    const editedEl = cached.element.querySelector('.message-edited');
    if (textEl) textEl.innerHTML = formatMessage(msg.content);
    if (editedEl) editedEl.textContent = '(изменено)';
    cached.content = msg.content;
    cached.edited_at = msg.edited_at;
  }
}

function handleDeletedMessage(messageId, channelId) {
  if (channelId !== currentChannel) return;
  const cached = messagesCache.get(messageId);
  if (cached?.element) {
    cached.element.remove();
    messagesCache.delete(messageId);
  }
}

function scrollToBottom(smooth = true) {
  if (messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 100) {
    messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  } else {
    newMessagesBar.classList.remove('hidden');
  }
}

newMessagesBar.addEventListener('click', () => scrollToBottom(true));

// ─── Message Input ───
function setupMessageInput() {
  // Auto-resize textarea
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + 'px';
  });
  
  // Send message
  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !messageInput.value.trim()) {
      e.preventDefault();
      editLastOwnMessage();
    }
  });
  
  // Typing indicator
  let typingTimeout = null;
  messageInput.addEventListener('input', () => {
    if (!currentChannel || currentChannelType !== 'text') return;
    socket.emit('typing_start', currentChannel);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => socket.emit('typing_stop', currentChannel), 2000);
  });
}

async function sendMessage() {
  const content = messageInput.value.trim();
  if (!content || !currentChannel) return;
  
  const payload = { content, replyTo: replyToMessage?.id };
  try {
    await apiPost(`/api/channels/${currentChannel}/messages`, payload);
    messageInput.value = '';
    messageInput.style.height = 'auto';
    cancelReply();
    scrollToBottom(false);
  } catch (e) {
    showToast('Не удалось отправить сообщение', 'error');
  }
}

function startReply(msg) {
  replyToMessage = msg;
  replyPreview.classList.remove('hidden');
  replyPreview.innerHTML = `
    <span class="reply-preview-author">${escapeHtml(msg.username || 'Unknown')}</span>
    <span>${escapeHtml(msg.content?.slice(0, 50) || '')}</span>
    <button class="reply-preview-close" aria-label="Отменить ответ">&times;</button>
  `;
  replyPreview.querySelector('.reply-preview-close').addEventListener('click', cancelReply);
  messageInput.focus();
}

function cancelReply() {
  replyToMessage = null;
  replyPreview.classList.add('hidden');
  replyPreview.innerHTML = '';
}

async function startEdit(msg) {
  const newContent = prompt('Редактировать сообщение:', msg.content);
  if (newContent === null || newContent.trim() === msg.content) return;
  
  try {
    await apiPatch(`/api/messages/${msg.id}`, { content: newContent.trim() });
  } catch (e) {
    showToast('Не удалось отредактировать', 'error');
  }
}

async function deleteMessage(messageId) {
  if (!confirm('Удалить это сообщение?')) return;
  try {
    await apiDelete(`/api/messages/${messageId}`);
  } catch (e) {
    showToast('Не удалось удалить', 'error');
  }
}

function editLastOwnMessage() {
  const ownMessages = [...messagesContainer.querySelectorAll('.message.own')];
  if (ownMessages.length) {
    const last = ownMessages[ownMessages.length - 1];
    const msgId = last.dataset.messageId;
    const cached = messagesCache.get(msgId);
    if (cached) startEdit(cached);
  }
}

function mentionUser(username) {
  if (username === currentUser.username) return;
  const at = `@${username} `;
  if (!messageInput.value.endsWith(at)) {
    messageInput.value += at;
    messageInput.focus();
    messageInput.dispatchEvent(new Event('input'));
  }
}

// ─── Channel Header ───
function updateChannelHeader(channelId, type) {
  const channel = channels.find(c => c.id === channelId);
  if (!channel) return;
  
  channelTypeIcon.innerHTML = type === 'voice' 
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="19" x2="8" y2="22"/><line x1="16" y1="19" x2="16" y2="22"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22 6 12 18 2 6"/></svg>`;
  
  channelNameEl.textContent = channel.name;
  channelTopicEl.textContent = channel.topic || '';
  messageInput.placeholder = `Сообщение #${channel.name}`;
}

function setupChannelHeader() {
  voiceJoinBtn.addEventListener('click', () => openVoiceModal(currentChannel));
  $('#search-btn').addEventListener('click', () => openRightSidebar('search'));
  $('#pin-btn').addEventListener('click', () => openRightSidebar('pins'));
  $('#members-btn').addEventListener('click', () => openRightSidebar('members'));
  $('#user-settings').addEventListener('click', () => showToast('Настройки скоро...', 'info'));
  $('#sidebar-toggle').addEventListener('click', toggleSidebar);
}

// ─── Members / Right Sidebar ───
function updateMembersList() {
  // In a real app, we'd fetch from API. For now, show online users from cache.
  const onlineUsers = [...usersCache.entries()].filter(([id, u]) => u.status === 'online');
  
  membersList.innerHTML = onlineUsers.map(([id, user]) => `
    <div class="member-item" data-user-id="${id}">
      <div class="member-avatar" style="background: ${stringToColor(user.username)}">${getInitials(user.username)}</div>
      <span class="member-name">${escapeHtml(user.username)}</span>
      <span class="member-status" style="background: var(--text-positive)"></span>
    </div>
  `).join('');
  
  // Add current user if not in list
  if (currentUser && !usersCache.has(currentUser.id)) {
    const div = document.createElement('div');
    div.className = 'member-item';
    div.dataset.userId = currentUser.id;
    div.innerHTML = `
      <div class="member-avatar" style="background: ${stringToColor(currentUser.username)}">${getInitials(currentUser.username)}</div>
      <span class="member-name">${escapeHtml(currentUser.username)}</span>
      <span class="member-status" style="background: var(--text-positive)"></span>
    `;
    membersList.prepend(div);
  }
}

function updateVoiceUsers() {
  if (!voiceChannelId) {
    voiceUsersEl.hidden = true;
    return;
  }
  
  voiceUsersEl.hidden = false;
  const members = Array.from(voiceStates?.get(voiceChannelId)?.values() || []);
  // This would come from socket events in real implementation
}

function updateUserStatus(userId, status) {
  const user = usersCache.get(userId);
  if (user) {
    user.status = status;
    updateMembersList();
  }
}

function setupRightSidebar() {
  rsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      rsTabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      rsPanels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      $(`[data-panel="${target}"]`)?.classList.add('active');
    });
  });
  
  searchInput.addEventListener('input', debounce(async (e) => {
    const q = e.target.value.trim();
    if (!q || q.length < 2) { searchResults.innerHTML = ''; return; }
    // Search would need API endpoint
  }, 300));
}

function openRightSidebar(tab) {
  rightSidebar.classList.remove('hidden');
  $(`.rs-tab[data-tab="${tab}"]`)?.click();
}

function closeRightSidebar() {
  rightSidebar.classList.add('hidden');
}

// ─── Voice Chat (WebRTC Mesh) ───
async function loadDevices() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    mediaDevices.mics = devices.filter(d => d.kind === 'audioinput');
    mediaDevices.speakers = devices.filter(d => d.kind === 'audiooutput');
    mediaDevices.cameras = devices.filter(d => d.kind === 'videoinput');
    populateDeviceSelects();
  } catch (e) {
    console.warn('Media devices access denied:', e);
  }
}

function populateDeviceSelects() {
  const selects = [
    { el: micSelect, devices: mediaDevices.mics, defaultLabel: 'Микрофон' },
    { el: speakerSelect, devices: mediaDevices.speakers, defaultLabel: 'Наушники' },
    { el: cameraSelect, devices: mediaDevices.cameras, defaultLabel: 'Камера' }
  ];
  
  selects.forEach(({ el, devices, defaultLabel }) => {
    const current = el.value;
    el.innerHTML = `<option value="">${defaultLabel} по умолчанию</option>`;
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `${defaultLabel} ${devices.indexOf(d) + 1}`;
      el.appendChild(opt);
    });
    if (current) el.value = current;
  });
}

function setupVoiceModal() {
  // Device selectors
  [micSelect, speakerSelect, cameraSelect].forEach(sel => {
    sel.addEventListener('change', () => localStorage.setItem(`matiz_${sel.id}`, sel.value));
  });
  
  // Restore saved devices
  micSelect.value = localStorage.getItem('matiz_mic-select') || '';
  speakerSelect.value = localStorage.getItem('matiz_speaker-select') || '';
  cameraSelect.value = localStorage.getItem('matiz_camera-select') || '';
  
  // Audio settings
  [noiseSuppression, echoCancellation, autoGain].forEach(cb => {
    cb.addEventListener('change', () => localStorage.setItem(`matiz_${cb.id}`, cb.checked));
    cb.checked = localStorage.getItem(`matiz_${cb.id}`) !== 'false';
  });
  
  // Voice mode
  voiceModeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      voiceMode = radio.value;
      pttSetting.hidden = voiceMode !== 'ptt';
      localStorage.setItem('matiz_voice-mode', voiceMode);
    });
  });
  voiceMode = localStorage.getItem('matiz_voice-mode') || 'voice';
  $(`input[name="voice-mode"][value="${voiceMode}"]`).checked = true;
  pttSetting.hidden = voiceMode !== 'ptt';
  
  // PTT Key
  pttKeyInput.addEventListener('keydown', (e) => {
    e.preventDefault();
    pttKey = e.code;
    pttKeyInput.value = getKeyDisplayName(e.code);
    localStorage.setItem('matiz_ptt-key', pttKey);
  });
  pttKey = localStorage.getItem('matiz_ptt-key') || 'KeyX';
  pttKeyInput.value = getKeyDisplayName(pttKey);
  
  // Test mic
  testMicBtn.addEventListener('click', toggleMicTest);
  
  // Join/Leave
  voiceJoinConfirm.addEventListener('click', joinVoiceChannel);
  voiceLeaveBtn.addEventListener('click', leaveVoiceChannel);
  voiceModalClose.addEventListener('click', () => voiceModal.classList.add('hidden'));
  
  // Close on backdrop click
  voiceModal.addEventListener('click', (e) => {
    if (e.target === voiceModal) voiceModal.classList.add('hidden');
  });
}

function openVoiceModal(channelId) {
  if (!channelId) return;
  voiceChannelId = channelId;
  voiceModal.classList.remove('hidden');
  voiceLeaveBtn.hidden = true;
  voiceJoinConfirm.hidden = false;
  stopMicTest();
}

async function joinVoiceChannel() {
  const constraints = {
    audio: {
      deviceId: micSelect.value ? { exact: micSelect.value } : undefined,
      noiseSuppression: noiseSuppression.checked,
      echoCancellation: echoCancellation.checked,
      autoGainControl: autoGain.checked,
      sampleRate: 48000,
      channelCount: 1
    },
    video: false // voice only by default
  };
  
  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    // Set audio output device
    if (speakerSelect.value && 'setSinkId' in HTMLAudioElement.prototype) {
      const audioEl = new Audio();
      await audioEl.setSinkId(speakerSelect.value);
    }
    
    // Join via socket
    socket.emit('voice_join', voiceChannelId);
    
    // Create peer connections for existing members
    // (handled via voice_state event)
    
    voiceJoinConfirm.hidden = true;
    voiceLeaveBtn.hidden = false;
    startMicTest();
    
  } catch (e) {
    console.error('Failed to join voice:', e);
    showToast('Не удалось войти в голос: ' + e.message, 'error');
  }
}

function leaveVoiceChannel() {
  if (!voiceChannelId) return;
  
  socket.emit('voice_leave', voiceChannelId);
  
  // Close all peer connections
  voicePeerConnections.forEach(pc => pc.close());
  voicePeerConnections.clear();
  
  // Stop local stream
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  
  voiceChannelId = null;
  voiceModal.classList.add('hidden');
  stopMicTest();
}

function handleVoiceState(channelId, members, you) {
  voiceChannelId = channelId;
  voiceLeaveBtn.hidden = false;
  voiceJoinConfirm.hidden = true;
  
  // Create peer connections for each member
  members.forEach(member => {
    if (member.id !== you.id) createPeerConnection(member.id, true);
  });
}

function handleVoiceUserJoined(channelId, userId, username, avatar_url) {
  if (channelId !== voiceChannelId) return;
  createPeerConnection(userId, false);
  updateVoiceUsersList();
}

function handleVoiceUserLeft(userId) {
  const pc = voicePeerConnections.get(userId);
  if (pc) {
    pc.close();
    voicePeerConnections.delete(userId);
  }
  updateVoiceUsersList();
}

function createPeerConnection(userId, isInitiator) {
  if (voicePeerConnections.has(userId)) return;
  
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });
  
  voicePeerConnections.set(userId, pc);
  
  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
  
  // Handle incoming tracks
  pc.ontrack = (event) => {
    const [remoteStream] = event.streams;
    playRemoteStream(userId, remoteStream);
  };
  
  // ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('voice_signal', { channelId: voiceChannelId, targetId: userId, signal: { type: 'candidate', candidate: event.candidate } });
    }
  };
  
  // Connection state
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      console.log(`Peer ${userId} connection failed`);
    }
  };
  
  if (isInitiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      socket.emit('voice_signal', { channelId: voiceChannelId, targetId: userId, signal: { type: 'offer', sdp: offer.sdp } });
    }).catch(console.error);
  }
}

function handleVoiceSignal(from, signal) {
  let pc = voicePeerConnections.get(from);
  
  if (!pc && signal.type === 'offer') {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    voicePeerConnections.set(from, pc);
    
    pc.ontrack = (event) => playRemoteStream(from, event.streams[0]);
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice_signal', { channelId: voiceChannelId, targetId: from, signal: { type: 'candidate', candidate: e.candidate } });
    };
    
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }
  
  if (!pc) return;
  
  switch (signal.type) {
    case 'offer':
      pc.setRemoteDescription(new RTCSessionDescription(signal)).then(() => pc.createAnswer())
        .then(answer => pc.setLocalDescription(answer))
        .then(() => socket.emit('voice_signal', { channelId: voiceChannelId, targetId: from, signal: { type: 'answer', sdp: pc.localDescription.sdp } }))
        .catch(console.error);
      break;
    case 'answer':
      pc.setRemoteDescription(new RTCSessionDescription(signal)).catch(console.error);
      break;
    case 'candidate':
      pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(console.error);
      break;
  }
}

function playRemoteStream(userId, stream) {
  let audioEl = document.getElementById(`voice-audio-${userId}`);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = `voice-audio-${userId}`;
    audioEl.autoplay = true;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
  }
  audioEl.srcObject = stream;
}

function updateVoiceUserMute(userId, muted) {
  const btn = $(`.voice-control-btn.mute[data-user-id="${userId}"]`);
  if (btn) btn.classList.toggle('muted', muted);
}

function updateVoiceUserDeafen(userId, deafened) {
  const btn = $(`.voice-control-btn.deafen[data-user-id="${userId}"]`);
  if (btn) btn.classList.toggle('deafened', deafened);
}

function updateVoiceUsersList() {
  // Update UI for voice users in right sidebar
  const members = Array.from(voicePeerConnections.keys());
  voiceUsersEl.innerHTML = members.map(id => {
    const user = usersCache.get(id) || { username: `User ${id.slice(0,4)}` };
    return `
      <div class="voice-user">
        <div class="voice-user-avatar" style="background: ${stringToColor(user.username)}">${getInitials(user.username)}</div>
        <div class="voice-user-info">
          <div class="voice-user-name">${escapeHtml(user.username)}</div>
          <div class="voice-user-status">
            <span class="status-dot online"></span> Подключен
          </div>
        </div>
        <div class="voice-user-controls">
          <button class="voice-control-btn mute" data-user-id="${id}" title="Мут" aria-label="Мут"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg></button>
          <button class="voice-control-btn deafen" data-user-id="${id}" title="Глухой" aria-label="Глухой"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="19" x2="8" y2="22"/><line x1="16" y1="19" x2="16" y2="22"/></svg></button>
        </div>
      </div>
    `;
  }).join('');
  voiceUsersEl.hidden = false;
}

// ─── Mic Test ───
function startMicTest() {
  if (!localStream) return;
  testMicBtn.textContent = 'Остановить тест';
  
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(localStream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  
  micTestInterval = setInterval(() => {
    analyser.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const percent = Math.min(100, (avg / 128) * 100);
    micMeterFill.style.width = `${percent}%`;
    micMeterFill.style.background = percent > 50 ? 'var(--text-danger)' : percent > 20 ? 'var(--text-warning)' : 'linear-gradient(90deg, var(--text-positive), var(--brand-primary))';
  }, 50);
}

function stopMicTest() {
  if (micTestInterval) {
    clearInterval(micTestInterval);
    micTestInterval = null;
  }
  testMicBtn.textContent = 'Начать тест';
  micMeterFill.style.width = '0%';
}

function toggleMicTest() {
  if (micTestInterval) stopMicTest();
  else if (localStream) startMicTest();
}

// ─── PTT (Push-to-Talk) ───
document.addEventListener('keydown', (e) => {
  if (voiceMode !== 'ptt' || e.code !== pttKey || pttActive || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  pttActive = true;
  setMicrophoneEnabled(true);
});

document.addEventListener('keyup', (e) => {
  if (voiceMode !== 'ptt' || e.code !== pttKey || !pttActive) return;
  pttActive = false;
  setMicrophoneEnabled(false);
});

function setMicrophoneEnabled(enabled) {
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = enabled);
  }
}

// ─── Typing Indicators ───
function showTyping(userId, username, channelId) {
  if (channelId !== currentChannel) return;
  typingUsers.set(userId, username);
  updateTypingDisplay();
}

function hideTyping(userId, channelId) {
  if (channelId !== currentChannel) return;
  typingUsers.delete(userId);
  updateTypingDisplay();
}

function updateTypingDisplay() {
  const typingEl = $('#typing-indicator');
  if (typingUsers.size === 0) {
    typingEl?.remove();
    return;
  }
  
  const names = [...typingUsers.values()].slice(0, 3).join(', ');
  const more = typingUsers.size > 3 ? ` и ещё ${typingUsers.size - 3}` : '';
  const text = `${names}${more} печатает${typingUsers.size > 1 ? 'ют' : 'ет'}...`;
  
  let el = $('#typing-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'typing-indicator';
    el.style.cssText = 'padding: 4px 16px; font-size: 0.8rem; color: var(--text-muted); height: 20px;';
    messagesContainer.parentElement.appendChild(el);
  }
  el.textContent = text;
}

// ─── User Panel ───
function updateUserPanel() {
  if (!currentUser) return;
  userNameEl.textContent = currentUser.username;
  userAvatarEl.textContent = getInitials(currentUser.username);
  userAvatarEl.style.background = stringToColor(currentUser.username);
  userStatusEl.innerHTML = '<span class="status-dot online"></span> Онлайн';
}

// ─── Mobile Sidebar ───
function toggleSidebar() {
  const sidebar = $('#sidebar');
  const overlay = $('#sidebar-overlay') || createOverlay();
  sidebar.classList.toggle('open');
  overlay.classList.toggle('visible');
}

function createOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'sidebar-overlay';
  overlay.className = 'sidebar-overlay';
  overlay.addEventListener('click', toggleSidebar);
  document.body.appendChild(overlay);
  return overlay;
}

function closeSidebarOnMobile() {
  if (window.innerWidth < 700) {
    $('#sidebar')?.classList.remove('open');
    $('#sidebar-overlay')?.classList.remove('visible');
  }
}

// ─── Keyboard Shortcuts ───
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+K - Search
    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault();
      openRightSidebar('search');
      setTimeout(() => searchInput.focus(), 100);
    }
    // Ctrl+Shift+S - Toggle sidebar
    if (e.ctrlKey && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      toggleSidebar();
    }
    // Escape - close modals/sidebar
    if (e.key === 'Escape') {
      voiceModal.classList.add('hidden');
      closeRightSidebar();
      cancelReply();
      if (window.innerWidth < 700) closeSidebarOnMobile();
    }
    // Alt+Up/Down - navigate channels
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      navigateChannels(e.key === 'ArrowUp' ? -1 : 1);
    }
  });
}

function navigateChannels(direction) {
  const btns = $$('.channel-btn:not(.hidden)');
  const currentIdx = btns.findIndex(b => b.classList.contains('active'));
  const nextIdx = (currentIdx + direction + btns.length) % btns.length;
  if (btns[nextIdx]) btns[nextIdx].click();
}

// ─── Toasts ───
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" aria-label="Закрыть">&times;</button>
  `;
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  toasts.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ─── Utils ───
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#039;');
}

function getInitials(name) {
  return name.split(/[\s_-]+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 50%)`;
}

function getKeyDisplayName(code) {
  const names = {
    'KeyX': 'X', 'KeyZ': 'Z', 'KeyC': 'C', 'KeyV': 'V', 'KeyB': 'B',
    'ShiftLeft': 'Левый Shift', 'ShiftRight': 'Правый Shift',
    'ControlLeft': 'Левый Ctrl', 'ControlRight': 'Правый Ctrl',
    'AltLeft': 'Левый Alt', 'AltRight': 'Правый Alt',
    'Space': 'Пробел', 'Backquote': '`', 'Backslash': '\\'
  };
  return names[code] || code.replace('Key', '').replace('Digit', '');
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function showChannelContextMenu(e, channel) {
  // Simple context menu for future features
  console.log('Channel context menu:', channel);
}