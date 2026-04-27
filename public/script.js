let currentUser = null;
let openChatTicketId = null;
let currentTab = 'tickets';
let searchTimeout = null;
let unreadCheckInterval = null;
let socket = null;

function connectWebSocket() {
    if (socket) socket.disconnect();
    socket = io();
    
    socket.on('connect', () => {
        console.log('✅ WebSocket подключен');
        if (currentUser) {
            socket.emit('user-connected', { userId: currentUser.id, username: currentUser.username, role: currentUser.role });
        }
    });
    
    socket.on('message-received', (data) => {
        console.log('📩 Новое сообщение:', data);
        if (openChatTicketId == data.ticketId) {
            appendMessageToChat(data);
            markMessagesAsRead(openChatTicketId, currentUser.role === 'admin' || currentUser.role === 'owner' ? 'admin' : 'user');
        }
        if (currentTab === 'tickets') updateTicketsList();
        updateUnreadBadge();
    });
    
    socket.on('unread-update', () => {
        updateUnreadBadge();
        if (currentTab === 'tickets') updateTicketsList();
    });
    
    socket.on('disconnect', () => console.log('❌ WebSocket отключен'));
}

function disconnectWebSocket() {
    if (socket) { socket.disconnect(); socket = null; }
}

// ============ ЗАЩИЩЁННАЯ API ФУНКЦИЯ ============
let lastRequestTime = 0;
const minRequestInterval = 500;

async function api(endpoint, data) {
    const now = Date.now();
    const timeSinceLast = now - lastRequestTime;
    
    if (timeSinceLast < minRequestInterval && lastRequestTime > 0) {
        await new Promise(resolve => setTimeout(resolve, minRequestInterval - timeSinceLast));
    }
    lastRequestTime = Date.now();
    
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (response.status === 403) {
            const result = await response.json();
            if (result.error === 'banned') { showBanScreen(); return { error: 'banned' }; }
        }
        if (response.status === 429) {
            return { error: 'Слишком много запросов. Подождите немного.' };
        }
        return await response.json();
    } catch (error) {
        console.error('API ошибка:', error);
        return { error: 'Ошибка соединения с сервером' };
    }
}

async function apiGet(endpoint) {
    const now = Date.now();
    const timeSinceLast = now - lastRequestTime;
    
    if (timeSinceLast < minRequestInterval && lastRequestTime > 0) {
        await new Promise(resolve => setTimeout(resolve, minRequestInterval - timeSinceLast));
    }
    lastRequestTime = Date.now();
    
    try {
        const response = await fetch(endpoint);
        if (response.status === 429) {
            return { error: 'Слишком много запросов. Подождите немного.' };
        }
        return await response.json();
    } catch (error) {
        console.error('API ошибка:', error);
        return { error: 'Ошибка соединения с сервером' };
    }
}

function showBanScreen() {
    const app = document.getElementById('app');
    app.innerHTML = `<div style="position:fixed; top:0; left:0; width:100%; height:100%; background:#000; display:flex; justify-content:center; align-items:center;"><div style="text-align:center;"><div style="font-size:80px;">🚫</div><h1 style="color:#ef4444;">ДОСТУП ЗАБЛОКИРОВАН</h1><p style="color:#fff;">Вы были заблокированы на данном сайте.</p></div></div>`;
    localStorage.removeItem('currentUser');
    currentUser = null;
    stopUnreadCheck();
    disconnectWebSocket();
}

async function refreshCurrentUser() {
    if (!currentUser) return null;
    const result = await api('/api/get-user', { userId: currentUser.id });
    if (result && !result.error) {
        const updatedUser = { ...currentUser, role: result.role, isBanned: result.isBanned };
        if (result.isBanned === 1) { showBanScreen(); return null; }
        currentUser = updatedUser;
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        return updatedUser;
    }
    return currentUser;
}

async function markMessagesAsRead(ticketId, readerRole) {
    await api('/api/mark-read', { ticketId, readerRole });
}

function appendMessageToChat(data) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
    // Проверяем, нет ли уже такого сообщения (по id)
    if (data.id) {
        const existing = document.querySelector(`.message[data-msg-id="${data.id}"]`);
        if (existing) return;
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${data.sender === 'user' ? 'message-user' : (data.sender === 'admin' ? 'message-admin' : 'message-system')}`;
    if (data.id) messageDiv.setAttribute('data-msg-id', data.id);
    messageDiv.innerHTML = `<div>${escapeHtml(data.text)}</div><div class="message-meta">${data.sender === 'user' ? '👤 Пользователь' : (data.sender === 'admin' ? '🛡️ Модератор' : 'ℹ️ Система')} • ${new Date(data.timestamp).toLocaleString()}</div>`;
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function updateChatMessages(ticketId) {
    try {
        const result = await api('/api/ticket', { ticketId: ticketId });
        if (result && result.messages) {
            const chatMessages = document.getElementById('chatMessages');
            if (chatMessages) {
                chatMessages.innerHTML = '';
                result.messages.forEach(msg => {
                    const messageDiv = document.createElement('div');
                    messageDiv.className = `message ${msg.sender === 'user' ? 'message-user' : (msg.sender === 'admin' ? 'message-admin' : 'message-system')}`;
                    messageDiv.setAttribute('data-msg-id', msg.id);
                    messageDiv.innerHTML = `<div>${escapeHtml(msg.text)}</div><div class="message-meta">${msg.sender === 'user' ? '👤 Пользователь' : (msg.sender === 'admin' ? '🛡️ Модератор' : 'ℹ️ Система')} • ${new Date(msg.timestamp).toLocaleString()}</div>`;
                    chatMessages.appendChild(messageDiv);
                });
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
        }
    } catch (error) {
        console.error('Ошибка обновления чата:', error);
    }
}

async function updateUnreadBadge() {
    if (!currentUser) return;
    try {
        let tickets = (currentUser.role === 'owner' || currentUser.role === 'admin') 
            ? await apiGet('/api/all-tickets') 
            : await api('/api/my-tickets', { userId: currentUser.id });
        if (!tickets || !Array.isArray(tickets)) return;
        let unreadCount = tickets.filter(t => (t.unreadCount || 0) > 0).length;
        const ticketsTab = document.querySelector('.tab-btn[data-tab="tickets"]');
        if (ticketsTab) {
            let badge = ticketsTab.querySelector('.unread-badge');
            if (unreadCount > 0) {
                if (badge) { badge.textContent = unreadCount; badge.style.display = 'inline-block'; }
                else {
                    badge = document.createElement('span');
                    badge.className = 'unread-badge';
                    badge.style.cssText = 'background:#ef4444; color:white; border-radius:20px; padding:2px 8px; font-size:0.7rem; margin-left:8px; font-weight:bold;';
                    badge.textContent = unreadCount;
                    ticketsTab.appendChild(badge);
                }
            } else if (badge) badge.style.display = 'none';
        }
        document.title = unreadCount > 0 ? `(${unreadCount}) MONOLITH` : 'MONOLITH';
    } catch (error) { console.error(error); }
}

function startUnreadCheck() {
    if (unreadCheckInterval) clearInterval(unreadCheckInterval);
    updateUnreadBadge();
    unreadCheckInterval = setInterval(() => { if (currentUser) updateUnreadBadge(); }, 5000);
}

function stopUnreadCheck() {
    if (unreadCheckInterval) { clearInterval(unreadCheckInterval); unreadCheckInterval = null; }
}

async function render() {
    const app = document.getElementById('app');
    if (!app) return;
    if (currentUser) { const updated = await refreshCurrentUser(); if (!updated) return; }
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser && !currentUser) {
        currentUser = JSON.parse(savedUser);
        const updated = await refreshCurrentUser();
        if (!updated) return;
    }
    if (!currentUser) {
        stopUnreadCheck();
        disconnectWebSocket();
        app.innerHTML = renderAuthScreen();
        attachAuthEvents();
    } else {
        if (!socket) connectWebSocket();
        else socket.emit('user-connected', { userId: currentUser.id, username: currentUser.username, role: currentUser.role });
        startUnreadCheck();
        app.innerHTML = renderMainPanel();
        
        if (currentUser.role === 'owner') {
            currentTab = 'admin';
        } else if (currentUser.role === 'admin') {
            currentTab = 'moderator';
        } else {
            currentTab = 'tickets';
        }
        
        attachMainEvents();
        activateTab(currentTab);
        
        if (currentTab === 'tickets') await updateTicketsList();
        else if (currentTab === 'admin') await updateAdminPanel();
        else if (currentTab === 'moderator') await updateModeratorPanel();
    }
    if (openChatTicketId) await renderChatModal();
}

function renderAuthScreen() {
    return `<div class="card" style="max-width:500px; margin:40px auto;"><div class="card-title">MONOLITH</div><div class="auth-switch" id="authSwitch"><button class="switch-btn active" data-auth="login">🔐 Вход</button><button class="switch-btn" data-auth="register">📝 Регистрация</button></div><div id="authFormContainer">${renderLoginForm()}</div><div id="authMessage" style="margin-top:20px; color:#f87171; text-align:center;"></div></div>`;
}

function renderLoginForm() {
    return `<form id="loginFormElem"><div class="form-group"><label>👤 Логин</label><input type="text" id="loginUsername" required></div><div class="form-group"><label>🔒 Пароль</label><input type="password" id="loginPassword" required></div><button type="submit" class="btn-primary">Войти</button></form>`;
}

function renderRegisterForm() {
    return `<form id="registerFormElem"><div class="form-group"><label>👤 Логин</label><input type="text" id="regUsername" required></div><div class="form-group"><label>🔒 Пароль</label><input type="password" id="regPassword" required></div><button type="submit" class="btn-primary">Зарегистрироваться</button></form>`;
}

function renderMainPanel() {
    const isOwner = currentUser.role === 'owner';
    const isAdmin = currentUser.role === 'admin';
    const isUser = currentUser.role === 'user';
    const roleName = isOwner ? '👑 Владелец' : (isAdmin ? '🛡️ Модератор' : '👤 Пользователь');
    
    return `
        <div class="navbar">
            <div class="logo">MONOLITH${isOwner ? ' | Панель владельца' : (isAdmin ? ' | Панель модератора' : '')}</div>
            <div class="user-badge"><span> ${escapeHtml(currentUser.username)}</span><span class="status-badge" style="background:#333; color:white;">${roleName}</span><button class="logout-btn" id="logoutBtn">Выйти</button></div>
        </div>
        <div class="tabs-container">
            <div class="tabs">
                ${isUser ? '<button class="tab-btn" data-tab="create">📝 Создать обращение</button>' : ''}
                <button class="tab-btn" data-tab="tickets">💬 ${isUser ? 'Мои обращения' : 'Все обращения'} <span class="unread-badge" style="display:none;"></span></button>
                ${isAdmin ? '<button class="tab-btn" data-tab="moderator">🛡️ Управление пользователями</button>' : ''}
                ${isOwner ? '<button class="tab-btn" data-tab="admin">⚙️ Админ-панель</button>' : ''}
            </div>
            
            ${isUser ? `<div id="tab-create" class="tab-content"><div class="card"><div class="card-title"> Создать обращение</div><form id="createTicketForm"><div class="form-group"><label>📌 Тема</label><input type="text" id="ticketSubject" required></div><div class="form-group"><label>💬 Сообщение</label><textarea id="ticketMessage" rows="3" required></textarea></div><div class="form-group"><label>🎯 Discord ID</label><input type="text" id="ticketDiscordId" placeholder="username#1234" required></div><button type="submit" class="btn-primary">🚀 Отправить</button></form></div></div>` : ''}
            
            <div id="tab-tickets" class="tab-content">
                <div class="card">
                    <div class="card-title"> ${isUser ? 'Мои обращения' : 'Все обращения'}</div>
                    ${isAdmin ? '<div class="admin-note">💬 Вы можете отвечать и закрывать тикеты.</div>' : ''}
                    ${isOwner ? '<div class="admin-note">💬 Вы можете удалять тикеты.</div>' : ''}
                    <div id="ticketsListContainer">Загрузка...</div>
                </div>
            </div>
            
            ${isAdmin ? `
            <div id="tab-moderator" class="tab-content">
                <div class="card">
                    <div class="card-title">🛡️ Управление пользователями</div>
                    <div class="admin-note">⚠️ Вы можете блокировать/разблокировать только обычных пользователей.</div>
                    <div id="moderatorPanelContainer">Загрузка...</div>
                </div>
            </div>
            ` : ''}
            
            ${isOwner ? `
            <div id="tab-admin" class="tab-content">
                <div class="card">
                    <div class="card-title">⚙️ Админ-панель владельца</div>
                    <div id="adminPanelContainer">Загрузка...</div>
                </div>
            </div>
            ` : ''}
        </div>
    `;
}

async function updateTicketsList() {
    const container = document.getElementById('ticketsListContainer');
    if (!container) return;
    try {
        let tickets = (currentUser.role === 'owner' || currentUser.role === 'admin') 
            ? await apiGet('/api/all-tickets') 
            : await api('/api/my-tickets', { userId: currentUser.id });
        if (!tickets || tickets.length === 0) { container.innerHTML = '<div class="empty-state">📭 Нет обращений</div>'; return; }
        const isOwner = currentUser.role === 'owner';
        const isAdmin = currentUser.role === 'admin';
        container.innerHTML = tickets.map(ticket => {
            const hasUnread = (ticket.unreadCount || 0) > 0;
            const unreadHint = hasUnread ? '<span style="background:#ef4444; color:white; border-radius:20px; padding:2px 8px; font-size:0.7rem; margin-left:8px;">📩 Новое</span>' : '';
            return `<div class="ticket-list-item" style="${hasUnread ? 'border-left: 4px solid #ef4444;' : ''}">
                <div class="ticket-header"><span class="ticket-subject">${escapeHtml(ticket.subject)} ${unreadHint}</span><span class="ticket-date">📅 ${new Date(ticket.createdAt).toLocaleString()}</span></div>
                <div class="ticket-preview">${escapeHtml((ticket.message || '').substring(0, 100))}</div>
                <div class="ticket-meta">
                    <span class="discord-tag">🆔 ${escapeHtml(ticket.discordId)}</span>
                    ${(isAdmin || isOwner) && ticket.username ? `<span class="discord-tag">👤 ${escapeHtml(ticket.username)}</span>` : ''}
                    <span class="status-badge ${ticket.status === 'open' ? 'status-open' : 'status-closed'}">${ticket.status === 'open' ? '🟡 Открыт' : '⚫ Закрыт'}</span>
                    <button class="chat-btn" data-id="${ticket.id}">💬 Чат</button>
                    ${(isAdmin || isOwner) && ticket.status === 'open' ? `<button class="resolve-btn close-ticket-btn" data-id="${ticket.id}">✅ Закрыть</button>` : ''}
                    ${isOwner ? `<button class="resolve-btn delete-ticket-btn" data-id="${ticket.id}" style="background:#dc2626;">🗑️ Удалить</button>` : ''}
                </div>
            </div>`;
        }).join('');
        document.querySelectorAll('.chat-btn').forEach(btn => btn.addEventListener('click', async (e) => { e.preventDefault(); openChatTicketId = btn.getAttribute('data-id'); await renderChatModal(); }));
        document.querySelectorAll('.close-ticket-btn').forEach(btn => btn.addEventListener('click', async (e) => { const ticketId = btn.getAttribute('data-id'); if (confirm('Закрыть тикет?')) { await api('/api/close-ticket', { ticketId }); await updateTicketsList(); updateUnreadBadge(); } }));
        document.querySelectorAll('.delete-ticket-btn').forEach(btn => btn.addEventListener('click', async (e) => { const ticketId = btn.getAttribute('data-id'); if (confirm('Удалить тикет?')) { await api('/api/delete-ticket', { ticketId, ownerId: currentUser.id, ownerName: currentUser.username }); if (openChatTicketId == ticketId) closeChatModal(); await updateTicketsList(); updateUnreadBadge(); } }));
    } catch (error) { console.error(error); container.innerHTML = '<div class="empty-state">❌ Ошибка</div>'; }
}

async function renderChatModal() {
    try {
        const result = await api('/api/ticket', { ticketId: openChatTicketId });
        if (result.error) { closeChatModal(); return; }
        const ticket = result;
        const isAdmin = currentUser.role === 'admin' || currentUser.role === 'owner';
        const messages = ticket.messages || [];
        const isOpen = ticket.status === 'open';
        await markMessagesAsRead(openChatTicketId, isAdmin ? 'admin' : 'user');
        await updateTicketsList();
        await updateUnreadBadge();
        if (socket) socket.emit('join-ticket', openChatTicketId);
        const existingModal = document.getElementById('chatModal');
        if (existingModal) existingModal.remove();
        const modalHtml = `<div class="chat-modal" id="chatModal"><div class="chat-container"><div class="chat-header"><div><h3>💬 ${escapeHtml(ticket.subject)}</h3><small>Discord ID: ${escapeHtml(ticket.discordId)} | ${isOpen ? '🟡 Открыт' : '⚫ Закрыт'}</small></div><button class="close-chat" id="closeChatBtn">✕</button></div><div class="chat-messages" id="chatMessages">${messages.map(msg => `<div class="message ${msg.sender === 'user' ? 'message-user' : (msg.sender === 'admin' ? 'message-admin' : 'message-system')}" data-msg-id="${msg.id}"><div>${escapeHtml(msg.text)}</div><div class="message-meta">${msg.sender === 'user' ? '👤 Пользователь' : (msg.sender === 'admin' ? '🛡️ Модератор' : 'ℹ️ Система')} • ${new Date(msg.timestamp).toLocaleString()}</div></div>`).join('')}</div>${isOpen ? `<div class="chat-input-area"><input type="text" id="chatMessageInput" placeholder="Введите сообщение..."><button class="send-msg-btn" id="sendMessageBtn">📤 Отправить</button></div>` : '<div class="chat-input-area"><span>✉️ Тикет закрыт</span></div>'}${isAdmin && isOpen ? `<div style="padding:12px; text-align:right;"><button class="resolve-btn" id="closeTicketFromChatBtn">🔒 Закрыть</button></div>` : ''}</div></div>`;
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div);
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
        document.getElementById('closeChatBtn').addEventListener('click', closeChatModal);
        const sendBtn = document.getElementById('sendMessageBtn');
        const input = document.getElementById('chatMessageInput');
        
        if (sendBtn && input) {
            const sendMessage = async () => {
                const text = input.value.trim();
                if (!text) return;
                
                sendBtn.disabled = true;
                sendBtn.textContent = '⏳ Отправка...';
                
                // Отправляем только через API, НЕ через socket.emit
                const resultMessage = await api('/api/message', { 
                    ticketId: openChatTicketId, 
                    sender: isAdmin ? 'admin' : 'user', 
                    text: text 
                });
                
                if (resultMessage && resultMessage.success !== false) {
                    input.value = '';
                    // Обновляем чат через API, чтобы получить свежие сообщения
                    await updateChatMessages(openChatTicketId);
                    // Обновляем список тикетов и уведомления
                    await updateTicketsList();
                    updateUnreadBadge();
                } else {
                    alert('Ошибка отправки сообщения');
                }
                
                sendBtn.disabled = false;
                sendBtn.textContent = '📤 Отправить';
            };
            
            sendBtn.addEventListener('click', sendMessage);
            input.addEventListener('keypress', (e) => { 
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            });
        }
        
        const closeTicketBtn = document.getElementById('closeTicketFromChatBtn');
        if (closeTicketBtn) closeTicketBtn.addEventListener('click', async () => { 
            if (confirm('Закрыть тикет?')) { 
                await api('/api/close-ticket', { ticketId: openChatTicketId }); 
                closeChatModal(); 
                await updateTicketsList(); 
                updateUnreadBadge(); 
            } 
        });
    } catch (error) { console.error(error); closeChatModal(); }
}

function closeChatModal() {
    if (socket && openChatTicketId) socket.emit('leave-ticket', openChatTicketId);
    openChatTicketId = null;
    const modal = document.getElementById('chatModal');
    if (modal) modal.remove();
    render();
}

async function updateAdminPanel() {
    const container = document.getElementById('adminPanelContainer');
    if (!container) return;
    try {
        let users = await apiGet('/api/all-users');
        if (!users || users.error) {
            container.innerHTML = '<div class="empty-state">❌ Ошибка загрузки пользователей</div>';
            return;
        }
        container.innerHTML = `
            <div style="margin-bottom:25px;"><h3 style="color:white; margin-bottom:10px;">🔍 Поиск пользователя</h3><input type="text" id="searchUserInput" placeholder="Введите логин..." style="width:100%; padding:10px; background:#0a0a0a; border:1px solid #333; border-radius:8px; color:white;"></div>
            <div><h3 style="color:white; margin-bottom:10px;">👥 Управление пользователями</h3><div class="admin-note" style="margin-bottom:15px; padding:10px; background:#2a2a2a; border-radius:10px; font-size:0.8rem;">⚠️ После изменения роли пользователю, попросите его выйти и зайти заново.</div><div id="usersTableContainer">${renderAdminUsersTable(users)}</div></div>
            <div style="margin-top:30px;"><h3 style="color:white; margin-bottom:10px;">📜 Логи действий</h3><div class="tickets-table" style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse;"><thead><tr style="border-bottom:1px solid #333;"><th style="padding:10px; text-align:left;">Время</th><th style="padding:10px; text-align:left;">Пользователь</th><th style="padding:10px; text-align:left;">Действие</th><th style="padding:10px; text-align:left;">Детали</th></tr></thead><tbody id="logsTableBody"><tr><td colspan="4" style="text-align:center; padding:20px;">Загрузка...</td></tr></tbody></table></div></div>
        `;
        const logs = await apiGet('/api/all-logs');
        const logsBody = document.getElementById('logsTableBody');
        if (logsBody) logsBody.innerHTML = logs.length ? logs.map(log => `<tr style="border-bottom:1px solid #333;"><td style="padding:10px; font-size:0.75rem;">${new Date(log.timestamp).toLocaleString()}</td><td style="padding:10px;"><strong>${escapeHtml(log.username)}</strong></td><td style="padding:10px;">${escapeHtml(log.action)}</td><td style="padding:10px;">${escapeHtml(log.details || '')}</td></tr>`).join('') : '<tr><td colspan="4" style="text-align:center; padding:20px;">Логов пока нет</td></tr>';
        const searchInput = document.getElementById('searchUserInput');
        if (searchInput) searchInput.addEventListener('input', async (e) => { if (searchTimeout) clearTimeout(searchTimeout); searchTimeout = setTimeout(async () => { const query = e.target.value.trim(); const results = query === '' ? await apiGet('/api/all-users') : await api('/api/search-user', { username: query }); const usersContainer = document.getElementById('usersTableContainer'); if (usersContainer) usersContainer.innerHTML = renderAdminUsersTable(results); attachAdminActions(); }, 300); });
        attachAdminActions();
    } catch (error) { console.error(error); container.innerHTML = '<div class="empty-state">❌ Ошибка</div>'; }
}

function renderAdminUsersTable(users) {
    if (!users || users.length === 0) return '<div class="empty-state">Пользователи не найдены</div>';
    return `<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse;"><thead><tr style="border-bottom:1px solid #333;"><th style="padding:12px 8px; text-align:left;">ID</th><th style="padding:12px 8px; text-align:left;">Логин</th><th style="padding:12px 8px; text-align:left;">Роль</th><th style="padding:12px 8px; text-align:left;">Статус</th><th style="padding:12px 8px; text-align:left;">Действия</th></tr></thead><tbody>${users.map(user => `<tr style="border-bottom:1px solid #333;"><td style="padding:12px 8px;">${user.id}</td><td style="padding:12px 8px;"><strong>${escapeHtml(user.username)}</strong></td><td style="padding:12px 8px;"><span class="status-badge ${user.role === 'owner' ? 'status-open' : (user.role === 'admin' ? 'status-open' : 'status-closed')}">${user.role === 'owner' ? '👑 Владелец' : (user.role === 'admin' ? '🛡️ Модератор' : '👤 Пользователь')}</span></td><td style="padding:12px 8px;"><span class="status-badge" style="${user.isBanned ? 'background:#dc2626;' : 'background:#10b981;'}">${user.isBanned ? '🔒 Заблокирован' : '✅ Активен'}</span></td><td style="padding:12px 8px;">${user.role !== 'owner' ? `<div style="display:flex; gap:8px; flex-wrap:wrap;"><select id="roleSelect_${user.id}" style="padding:6px 10px; background:#0a0a0a; color:white; border:1px solid #333; border-radius:8px;"><option value="user" ${user.role === 'user' ? 'selected' : ''}>Пользователь</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Модератор</option></select><button class="resolve-btn" onclick="window.changeRole(${user.id})" style="padding:6px 12px;">💾 Роль</button>${user.isBanned ? `<button class="resolve-btn" style="background:#10b981; padding:6px 12px;" onclick="window.adminUnbanUser(${user.id})">🔓 Разбан</button>` : `<button class="resolve-btn" style="background:#f59e0b; padding:6px 12px;" onclick="window.adminBanUser(${user.id})">🔨 Бан</button>`}<button class="resolve-btn" style="background:#dc2626; padding:6px 12px;" onclick="window.adminDeleteUser(${user.id})">🗑️ Удалить</button></div>` : '<span style="color:#888;">Недоступно</span>'}</td></tr>`).join('')}</tbody></table></div>`;
}

async function updateModeratorPanel() {
    const container = document.getElementById('moderatorPanelContainer');
    if (!container) {
        console.log('Контейнер moderatorPanelContainer не найден');
        return;
    }
    
    try {
        container.innerHTML = '<div class="empty-state">⏳ Загрузка пользователей...</div>';
        
        const allUsers = await apiGet('/api/all-users');
        
        if (!allUsers || allUsers.error) {
            console.error('Ошибка загрузки пользователей:', allUsers);
            container.innerHTML = '<div class="empty-state">❌ Ошибка загрузки пользователей</div>';
            return;
        }
        
        let users = allUsers.filter(u => u.role === 'user');
        
        console.log('Загружено пользователей:', users.length);
        
        container.innerHTML = `
            <div style="margin-bottom:25px;">
                <h3 style="color:white; margin-bottom:10px;">🔍 Поиск пользователя</h3>
                <input type="text" id="moderatorSearchInput" placeholder="Введите логин..." style="width:100%; padding:10px; background:#0a0a0a; border:1px solid #333; border-radius:8px; color:white;">
            </div>
            <div id="moderatorUsersTableContainer">
                ${renderModeratorUsersTable(users)}
            </div>
        `;
        
        const searchInput = document.getElementById('moderatorSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', async (e) => {
                if (searchTimeout) clearTimeout(searchTimeout);
                searchTimeout = setTimeout(async () => {
                    const query = e.target.value.trim();
                    let results;
                    if (query === '') {
                        results = allUsers.filter(u => u.role === 'user');
                    } else {
                        const searchResults = await api('/api/search-user', { username: query });
                        results = searchResults.filter(u => u.role === 'user');
                    }
                    const usersContainer = document.getElementById('moderatorUsersTableContainer');
                    if (usersContainer) {
                        usersContainer.innerHTML = renderModeratorUsersTable(results);
                        attachModeratorActions();
                    }
                }, 300);
            });
        }
        
        attachModeratorActions();
        
    } catch (error) {
        console.error('Ошибка в updateModeratorPanel:', error);
        container.innerHTML = '<div class="empty-state">❌ Ошибка загрузки данных</div>';
    }
}

function renderModeratorUsersTable(users) {
    if (!users || users.length === 0) {
        return '<div class="empty-state">👥 Нет обычных пользователей</div>';
    }
    
    return `
        <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse;">
                <thead>
                    <tr style="border-bottom:1px solid #333;">
                        <th style="padding:12px 8px; text-align:left;">ID</th>
                        <th style="padding:12px 8px; text-align:left;">Логин</th>
                        <th style="padding:12px 8px; text-align:left;">Статус</th>
                        <th style="padding:12px 8px; text-align:left;">Дата регистрации</th>
                        <th style="padding:12px 8px; text-align:left;">Действия</th>
                    </tr>
                </thead>
                <tbody>
                    ${users.map(user => `
                        <tr style="border-bottom:1px solid #333;">
                            <td style="padding:12px 8px;">${user.id}</td>
                            <td style="padding:12px 8px;"><strong>${escapeHtml(user.username)}</strong></td>
                            <td style="padding:12px 8px;">
                                <span class="status-badge" style="${user.isBanned ? 'background:#dc2626;' : 'background:#10b981;'}">
                                    ${user.isBanned ? '🔒 Заблокирован' : '✅ Активен'}
                                </span>
                            </td>
                            <td style="padding:12px 8px;">${new Date(user.createdAt).toLocaleString()}</td>
                            <td style="padding:12px 8px;">
                                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                                    ${user.isBanned ? 
                                        `<button class="resolve-btn" style="background:#10b981; padding:6px 12px;" data-userid="${user.id}" data-action="unban">🔓 Разблокировать</button>` : 
                                        `<button class="resolve-btn" style="background:#f59e0b; padding:6px 12px;" data-userid="${user.id}" data-action="ban">🔨 Заблокировать</button>`
                                    }
                                </div>
                            </td>
                        </table>
                    `).join('')}
                </tbody>
            <table>
        </div>
    `;
}

function attachAdminActions() {
    window.changeRole = async (userId) => {
        const select = document.getElementById(`roleSelect_${userId}`);
        const newRole = select.value;
        const result = await api('/api/change-role', { userId, newRole, ownerId: currentUser.id, ownerName: currentUser.username });
        if (result.success) { alert('Роль изменена!'); await updateAdminPanel(); } else alert('Ошибка');
    };
    window.adminBanUser = async (userId) => {
        if (confirm('Заблокировать пользователя?')) {
            const result = await api('/api/ban-user', { userId, moderatorId: currentUser.id, moderatorName: currentUser.username, moderatorRole: currentUser.role });
            if (result.success) { alert('Пользователь заблокирован!'); await updateAdminPanel(); await updateModeratorPanel(); } else alert('Ошибка: ' + (result.error || ''));
        }
    };
    window.adminUnbanUser = async (userId) => {
        if (confirm('Разблокировать пользователя?')) {
            const result = await api('/api/unban-user', { userId, moderatorId: currentUser.id, moderatorName: currentUser.username, moderatorRole: currentUser.role });
            if (result.success) { alert('Пользователь разблокирован!'); await updateAdminPanel(); await updateModeratorPanel(); } else alert('Ошибка');
        }
    };
    window.adminDeleteUser = async (userId) => {
        if (confirm('Удалить пользователя?')) {
            const result = await api('/api/delete-user', { userId, ownerId: currentUser.id, ownerName: currentUser.username });
            if (result.success) { alert('Пользователь удален!'); await updateAdminPanel(); await updateModeratorPanel(); } else alert('Ошибка');
        }
    };
}

function attachModeratorActions() {
    const buttons = document.querySelectorAll('#moderatorUsersTableContainer .resolve-btn');
    
    buttons.forEach(btn => {
        btn.removeEventListener('click', handleModeratorAction);
        btn.addEventListener('click', handleModeratorAction);
    });
}

async function handleModeratorAction(e) {
    const btn = e.currentTarget;
    const userId = btn.getAttribute('data-userid');
    const action = btn.getAttribute('data-action');
    
    if (action === 'ban') {
        if (confirm('⚠️ Заблокировать этого пользователя? Он не сможет войти в систему.')) {
            const result = await api('/api/ban-user', { 
                userId, 
                moderatorId: currentUser.id, 
                moderatorName: currentUser.username, 
                moderatorRole: currentUser.role 
            });
            
            if (result.success) {
                alert('✅ Пользователь заблокирован!');
                await updateModeratorPanel();
                await updateTicketsList();
                updateUnreadBadge();
            } else {
                alert('❌ Ошибка: ' + (result.error || 'Неизвестная ошибка'));
            }
        }
    } else if (action === 'unban') {
        if (confirm('✅ Разблокировать этого пользователя?')) {
            const result = await api('/api/unban-user', { 
                userId, 
                moderatorId: currentUser.id, 
                moderatorName: currentUser.username, 
                moderatorRole: currentUser.role 
            });
            
            if (result.success) {
                alert('✅ Пользователь разблокирован!');
                await updateModeratorPanel();
                await updateTicketsList();
                updateUnreadBadge();
            } else {
                alert('❌ Ошибка: ' + (result.error || 'Неизвестная ошибка'));
            }
        }
    }
}

function attachAuthEvents() {
    const switchBtns = document.querySelectorAll('.switch-btn');
    const container = document.getElementById('authFormContainer');
    const messageDiv = document.getElementById('authMessage');
    function setAuthForm(type) {
        switchBtns.forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-auth') === type));
        container.innerHTML = type === 'login' ? renderLoginForm() : renderRegisterForm();
        if (type === 'login') document.getElementById('loginFormElem')?.addEventListener('submit', handleLogin);
        else document.getElementById('registerFormElem')?.addEventListener('submit', handleRegister);
        if (messageDiv) messageDiv.innerText = '';
    }
    const handleLogin = async (e) => { e.preventDefault(); const username = document.getElementById('loginUsername').value; const password = document.getElementById('loginPassword').value; const result = await api('/api/login', { username, password }); if (result.error === 'banned') { showBanScreen(); return; } if (result.error) messageDiv.innerText = result.error; else { currentUser = result.user; localStorage.setItem('currentUser', JSON.stringify(currentUser)); render(); } };
    const handleRegister = async (e) => { e.preventDefault(); const username = document.getElementById('regUsername').value; const password = document.getElementById('regPassword').value; const result = await api('/api/register', { username, password }); if (result.error) messageDiv.innerText = result.error; else { currentUser = result.user; localStorage.setItem('currentUser', JSON.stringify(currentUser)); render(); } };
    switchBtns.forEach(btn => btn.addEventListener('click', () => setAuthForm(btn.getAttribute('data-auth'))));
    setAuthForm('login');
}

function attachMainEvents() {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => activateTab(btn.getAttribute('data-tab'))));
    const createForm = document.getElementById('createTicketForm');
    if (createForm) createForm.addEventListener('submit', async (e) => { e.preventDefault(); const subject = document.getElementById('ticketSubject').value; const message = document.getElementById('ticketMessage').value; const discordId = document.getElementById('ticketDiscordId').value; if (!subject.trim() || !message.trim() || !discordId.trim()) { alert('Заполните все поля'); return; } const result = await api('/api/tickets', { userId: currentUser.id, discordId, subject, message }); if (result.success) { alert('Тикет отправлен!'); document.getElementById('ticketSubject').value = ''; document.getElementById('ticketMessage').value = ''; document.getElementById('ticketDiscordId').value = ''; activateTab('tickets'); await updateTicketsList(); } else alert('Ошибка'); });
    const logoutBtn = document.getElementById('logoutBtn'); if (logoutBtn) logoutBtn.addEventListener('click', () => { currentUser = null; localStorage.removeItem('currentUser'); stopUnreadCheck(); disconnectWebSocket(); render(); });
}

function activateTab(tabId) {
    currentTab = tabId;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.toggle('active', content.id === `tab-${tabId}`));
    if (tabId === 'tickets') updateTicketsList();
    if (tabId === 'admin' && currentUser?.role === 'owner') updateAdminPanel();
    if (tabId === 'moderator' && currentUser?.role === 'admin') updateModeratorPanel();
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

// ============ ЗАПУСК ПРИЛОЖЕНИЯ ============
render();