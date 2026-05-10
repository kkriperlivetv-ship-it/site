let currentUser = null;
let currentTicketId = null;
let socket = null;
let currentView = 'create';
let currentClientDiscordId = null;
let isModeratorView = false;

const TICKET_COOLDOWN_MS = 30 * 60 * 1000;
let savedDiscordId = localStorage.getItem('client_discord_id');

function checkCooldown(discordId) {
    const lastTicketTime = localStorage.getItem(`last_ticket_${discordId}`);
    if (lastTicketTime) {
        const timePassed = Date.now() - parseInt(lastTicketTime);
        if (timePassed < TICKET_COOLDOWN_MS) {
            const remainingMinutes = Math.ceil((TICKET_COOLDOWN_MS - timePassed) / 60000);
            return { allowed: false, remainingMinutes };
        }
    }
    return { allowed: true };
}

function setCooldown(discordId) {
    localStorage.setItem(`last_ticket_${discordId}`, Date.now().toString());
}

async function checkRoleActual() {
    if (!currentUser) return;
    try {
        const result = await api('/api/get-user', { userId: currentUser.id });
        if (result && result.role && result.role !== currentUser.role) {
            console.log('Роль изменилась с', currentUser.role, 'на', result.role);
            currentUser.role = result.role;
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            render();
        }
    } catch(e) {
        console.log('Ошибка проверки роли:', e);
    }
}

function connectWebSocket() {
    if (socket && socket.connected) return;
    if (socket) socket.disconnect();
    
    socket = io({
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
    });
    
    socket.on('connect', () => {
        console.log('WebSocket подключен');
        if (currentTicketId) socket.emit('join-ticket', currentTicketId);
        if (isModeratorView) socket.emit('join-moderator');
        if (currentClientDiscordId) socket.emit('join-user', currentClientDiscordId);
    });
    
    socket.on('message-received', (data) => {
        console.log('Новое сообщение:', data);
        if (currentTicketId == data.ticketId) {
            appendMessageToChat(data);
            markMessagesAsRead(data.ticketId, isModeratorView);
        }
        setTimeout(() => {
            if (isModeratorView && document.getElementById('ticketsList')) loadAllTickets();
            else if (currentClientDiscordId && document.getElementById('userTicketsList')) loadUserTickets();
            updateUnreadBadge();
        }, 100);
    });
    
    socket.on('unread-update', (data) => {
        console.log('Обновление непрочитанных:', data);
        setTimeout(() => {
            if (isModeratorView && document.getElementById('ticketsList')) loadAllTickets();
            else if (currentClientDiscordId && document.getElementById('userTicketsList')) loadUserTickets();
            updateUnreadBadge();
        }, 100);
    });
    
    socket.on('new-ticket', (data) => {
        console.log('Новый тикет:', data);
        if (isModeratorView && document.getElementById('ticketsList')) {
            loadAllTickets();
            updateUnreadBadge();
        }
    });
    
    socket.on('ticket-closed', (data) => {
        console.log('Тикет закрыт (событие):', data);
        setTimeout(() => {
            if (isModeratorView && document.getElementById('ticketsList')) {
                loadAllTickets();
                updateUnreadBadge();
            } else if (currentClientDiscordId && document.getElementById('userTicketsList')) {
                loadUserTickets();
                updateUnreadBadge();
            }
        }, 100);
    });
    
    socket.on('ticket-deleted', (data) => {
        console.log('Тикет удален:', data);
        if (currentTicketId == data.ticketId) {
            document.getElementById('chatModal')?.remove();
            currentTicketId = null;
        }
        setTimeout(() => {
            if (isModeratorView && document.getElementById('ticketsList')) loadAllTickets();
            else if (currentClientDiscordId && document.getElementById('userTicketsList')) loadUserTickets();
            updateUnreadBadge();
        }, 100);
    });
    
    socket.on('moderator-deleted', (data) => {
        console.log('Модератор удален:', data);
        if (currentUser && currentUser.id === data.id) {
            alert('Ваш аккаунт был удален. Вы будете перенаправлены.');
            localStorage.removeItem('currentUser');
            currentUser = null;
            if (socket) socket.disconnect();
            render();
        } else if (isModeratorView && (currentUser?.role === 'owner' || currentUser?.role === 'deputy')) {
            loadModeratorsList();
        }
    });
    
    socket.on('moderators-updated', () => {
        console.log('Список модераторов обновлён');
        if (isModeratorView && (currentUser?.role === 'owner' || currentUser?.role === 'deputy')) {
            loadModeratorsList();
        }
    });
    
    socket.on('role-updated', (data) => {
        console.log('Роль обновлена:', data);
        if (currentUser && currentUser.id === data.userId) {
            currentUser.role = data.newRole;
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            render();
        }
        if (isModeratorView && (currentUser?.role === 'owner' || currentUser?.role === 'deputy')) {
            loadModeratorsList();
        }
    });
    
    socket.on('disconnect', () => console.log('WebSocket отключен'));
}

async function markMessagesAsRead(ticketId, isModerator = false) {
    await api('/api/mark-read', { ticketId, isModerator });
    
    // Принудительное обновление после отметки
    if (isModerator) {
        await loadAllTickets();
    }
    await updateUnreadBadge();
}

async function updateUnreadBadge() {
    if (isModeratorView) {
        const tickets = await apiGet('/api/all-tickets');
        if (tickets && Array.isArray(tickets)) {
            const unreadCount = tickets.filter(t => t.lastMessageFrom === 'user' && t.status === 'open').length;
            const badge = document.querySelector('.tab-btn[data-tab="tickets"] .unread-badge');
            if (badge) {
                if (unreadCount > 0) {
                    badge.textContent = unreadCount;
                    badge.style.display = 'inline-block';
                } else {
                    badge.style.display = 'none';
                }
            }
        }
    } else if (currentClientDiscordId) {
        const tickets = await api('/api/tickets/by-discord', { discordId: currentClientDiscordId });
        if (tickets && Array.isArray(tickets)) {
            const unreadCount = tickets.filter(t => t.lastMessageFrom === 'moderator' && t.status === 'open').length;
            const badge = document.querySelector('.client-tab-btn[data-view="my-tickets"] .unread-badge');
            if (badge) {
                if (unreadCount > 0) {
                    badge.textContent = unreadCount;
                    badge.style.display = 'inline-block';
                } else {
                    badge.style.display = 'none';
                }
            }
        }
    }
}

async function api(endpoint, data) {
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return await response.json();
    } catch (error) {
        return { error: 'Ошибка соединения' };
    }
}

async function apiGet(endpoint) {
    try {
        const response = await fetch(endpoint);
        return await response.json();
    } catch (error) {
        return { error: 'Ошибка соединения' };
    }
}

async function render() {
    const app = document.getElementById('app');
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser) currentUser = JSON.parse(savedUser);
    
    if (currentUser && (currentUser.role === 'moderator' || currentUser.role === 'owner' || currentUser.role === 'deputy')) {
        isModeratorView = true;
        app.innerHTML = renderModeratorPanel();
        attachModeratorEvents();
        await loadAllTickets();
        if (currentUser.role === 'owner' || currentUser.role === 'deputy') {
            await loadModeratorsList();
        }
        if (currentUser.role === 'owner') {
            await loadLogs();
        }
        if (!socket || !socket.connected) connectWebSocket();
    } else {
        isModeratorView = false;
        app.innerHTML = renderClientPanel();
        attachClientEvents();
        if (savedDiscordId) {
            currentClientDiscordId = savedDiscordId;
            await loadUserTickets();
        }
        if (!socket || !socket.connected) connectWebSocket();
        await updateUnreadBadge();
    }
    
    if (currentUser) {
        setInterval(checkRoleActual, 30000);
    }
}

function renderClientPanel() {
    return `
        <div class="client-container">
            <div class="navbar">
                <div class="logo">MONOLITH | Поддержка</div>
                <div class="user-badge">
                    <button class="moderator-login-btn" id="moderatorLoginBtn">Вход для персонала</button>
                </div>
            </div>
            <div class="client-tabs">
                <button class="client-tab-btn ${currentView === 'create' ? 'active' : ''}" data-view="create">Создать обращение</button>
                <button class="client-tab-btn ${currentView === 'my-tickets' ? 'active' : ''}" data-view="my-tickets">
                    Мои обращения
                    <span class="unread-badge" style="display:none;"></span>
                </button>
            </div>
            <div id="client-create-view" class="client-tab-content ${currentView === 'create' ? 'active' : ''}">
                <div class="card" style="max-width: 600px; margin: 20px auto;">
                    <div class="card-title">Создать обращение</div>
                    <div id="ticketForm">
                        <div class="form-group">
                            <label>Ваш Discord ID</label>
                            <input type="text" id="discordId" placeholder="username#1234" value="${escapeHtml(savedDiscordId || '')}" required>
                        </div>
                        <div class="form-group">
                            <label>Тема</label>
                            <input type="text" id="subject" placeholder="Кратко опишите проблему" required>
                        </div>
                        <div class="form-group">
                            <label>Сообщение</label>
                            <textarea id="message" rows="5" placeholder="Подробно опишите проблему..." required></textarea>
                        </div>
                        <button class="btn-primary" id="createTicketBtn">Отправить</button>
                    </div>
                    <div id="ticketResult"></div>
                </div>
            </div>
            <div id="client-my-tickets-view" class="client-tab-content ${currentView === 'my-tickets' ? 'active' : ''}">
                <div class="card" style="max-width: 800px; margin: 20px auto;">
                    <div class="card-title">Мои обращения</div>
                    <div id="userTicketsList">Загрузка...</div>
                </div>
            </div>
        </div>
        <div id="moderatorLoginModal" class="modal" style="display: none;">
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Вход для персонала</h3>
                    <button class="close-modal" id="closeModalBtn">&times;</button>
                </div>
                <form id="moderatorLoginForm">
                    <input type="text" id="modLoginUsername" placeholder="Логин" required>
                    <input type="password" id="modLoginPassword" placeholder="Пароль" required>
                    <button type="submit">Войти</button>
                </form>
                <div id="modLoginError"></div>
            </div>
        </div>
    `;
}

function renderModeratorPanel() {
    const isOwner = currentUser.role === 'owner';
    const isDeputy = currentUser.role === 'deputy';
    
    return `
        <div class="navbar">
            <div class="logo">MONOLITH | ${isOwner ? 'Панель владельца' : (isDeputy ? 'Панель заместителя' : 'Панель модератора')}</div>
            <div class="user-badge">
                <span>${escapeHtml(currentUser.username)} (${isOwner ? 'Владелец' : (isDeputy ? 'Заместитель владельца' : 'Модератор')})</span>
                <button class="logout-btn" id="logoutBtn">Выйти</button>
            </div>
        </div>
        <div class="tabs">
            <button class="tab-btn active" data-tab="tickets">Тикеты <span class="unread-badge" style="display:none;"></span></button>
            ${(isOwner || isDeputy) ? '<button class="tab-btn" data-tab="moderators">Модераторы</button>' : ''}
            ${isOwner ? '<button class="tab-btn" data-tab="logs">Логи</button>' : ''}
        </div>
        <div id="tab-tickets" class="tab-content active">
            <div class="card">
                <div id="ticketsList">Загрузка...</div>
            </div>
        </div>
        ${(isOwner || isDeputy) ? `
        <div id="tab-moderators" class="tab-content">
            <div class="card">
                <div class="card-title">Управление модераторами</div>
                <div id="moderatorsList">Загрузка...</div>
                <button class="btn-primary" id="addModeratorBtn" style="margin-top: 20px;">Добавить модератора</button>
            </div>
        </div>
        ` : ''}
        ${isOwner ? `
        <div id="tab-logs" class="tab-content">
            <div class="card">
                <div class="card-title">Логи действий</div>
                <div id="logsList">Загрузка...</div>
            </div>
        </div>
        ` : ''}
    `;
}

async function loadUserTickets() {
    if (!currentClientDiscordId) return;
    const container = document.getElementById('userTicketsList');
    if (!container) return;
    
    const tickets = await api('/api/tickets/by-discord', { discordId: currentClientDiscordId });
    if (!tickets || tickets.length === 0) {
        container.innerHTML = '<div class="empty-state">Нет обращений</div>';
        return;
    }
    
    let unreadCount = 0;
    container.innerHTML = tickets.map(ticket => {
        const hasUnread = ticket.lastMessageFrom === 'moderator' && ticket.status === 'open';
        if (hasUnread) unreadCount++;
        return `
            <div class="ticket-item" style="${hasUnread ? 'border-left: 4px solid #ef4444;' : ''}">
                <div class="ticket-header">
                    <span class="ticket-subject">${escapeHtml(ticket.subject)} ${hasUnread ? '<span class="new-badge">Новое</span>' : ''}</span>
                    <span class="ticket-date">${new Date(ticket.createdAt).toLocaleString()}</span>
                </div>
                <div class="ticket-preview">${escapeHtml(ticket.message.substring(0, 100))}...</div>
                <div class="ticket-meta">
                    <span class="status-badge ${ticket.status === 'open' ? 'status-open' : 'status-closed'}">${ticket.status === 'open' ? 'В обработке' : 'Закрыт'}</span>
                    <button class="chat-btn" data-id="${ticket.id}">Чат</button>
                </div>
            </div>
        `;
    }).join('');
    
    const badge = document.querySelector('.client-tab-btn[data-view="my-tickets"] .unread-badge');
    if (badge) {
        badge.textContent = unreadCount;
        badge.style.display = unreadCount > 0 ? 'inline-block' : 'none';
    }
    
    document.querySelectorAll('.chat-btn').forEach(btn => {
        btn.removeEventListener('click', handleUserChatClick);
        btn.addEventListener('click', handleUserChatClick);
    });
}

async function handleUserChatClick(e) {
    const btn = e.currentTarget;
    currentTicketId = parseInt(btn.dataset.id);
    await openChat(currentTicketId, false);
}

async function loadAllTickets() {
    const tickets = await apiGet('/api/all-tickets');
    const container = document.getElementById('ticketsList');
    if (!container) return;
    if (!tickets || tickets.length === 0) {
        container.innerHTML = '<div class="empty-state">Нет обращений</div>';
        return;
    }
    
    let unreadCount = 0;
    container.innerHTML = tickets.map(ticket => {
        const hasUnread = ticket.lastMessageFrom === 'user' && ticket.status === 'open';
        if (hasUnread) unreadCount++;
        return `
            <div class="ticket-item" style="${hasUnread ? 'border-left: 4px solid #ef4444;' : ''}">
                <div class="ticket-header">
                    <span class="ticket-subject">${escapeHtml(ticket.subject)} ${hasUnread ? '<span class="new-badge">Новое</span>' : ''}</span>
                    <span class="ticket-date">${new Date(ticket.createdAt).toLocaleString()}</span>
                </div>
                <div class="ticket-preview">${escapeHtml(ticket.message.substring(0, 100))}...</div>
                <div class="ticket-meta">
                    <span class="discord-tag">ID: ${escapeHtml(ticket.discordId)}</span>
                    <span class="status-badge ${ticket.status === 'open' ? 'status-open' : 'status-closed'}">${ticket.status === 'open' ? 'Открыт' : 'Закрыт'}</span>
                    <button class="chat-btn" data-id="${ticket.id}">Чат</button>
                    ${ticket.status === 'open' ? `<button class="resolve-btn close-ticket" data-id="${ticket.id}">Закрыть</button>` : ''}
                    ${currentUser?.role === 'owner' ? `<button class="delete-ticket-btn" data-id="${ticket.id}">Удалить</button>` : ''}
                </div>
            </div>
        `;
    }).join('');
    
    const badge = document.querySelector('.tab-btn[data-tab="tickets"] .unread-badge');
    if (badge) {
        badge.textContent = unreadCount;
        badge.style.display = unreadCount > 0 ? 'inline-block' : 'none';
    }
    
    // Привязываем обработчики с защитой от двойного клика
    document.querySelectorAll('.chat-btn').forEach(btn => {
        btn.removeEventListener('click', handleModeratorChatClick);
        btn.addEventListener('click', handleModeratorChatClick);
    });
    
    document.querySelectorAll('.close-ticket').forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const ticketId = newBtn.dataset.id;
            newBtn.disabled = true;
            newBtn.textContent = 'Закрывается...';
            
            if (confirm('Закрыть тикет?')) {
                const result = await api('/api/close-ticket', { 
                    ticketId: ticketId, 
                    moderatorId: currentUser.id, 
                    moderatorName: currentUser.username 
                });
                if (result.success) {
                    await loadAllTickets();
                    await updateUnreadBadge();
                } else {
                    alert('Ошибка закрытия');
                    newBtn.disabled = false;
                    newBtn.textContent = 'Закрыть';
                }
            } else {
                newBtn.disabled = false;
                newBtn.textContent = 'Закрыть';
            }
        });
    });
    
    document.querySelectorAll('.delete-ticket-btn').forEach(btn => {
        btn.removeEventListener('click', handleDeleteTicket);
        btn.addEventListener('click', handleDeleteTicket);
    });
}

async function handleModeratorChatClick(e) {
    const btn = e.currentTarget;
    currentTicketId = parseInt(btn.dataset.id);
    await openChat(currentTicketId, true);
}

async function handleDeleteTicket(e) {
    const btn = e.currentTarget;
    const ticketId = btn.dataset.id;
    if (confirm('Удалить тикет?')) {
        await api('/api/delete-ticket', { ticketId });
    }
}

async function openChat(ticketId, isModerator = false) {
    const result = await api('/api/ticket', { ticketId });
    const ticket = result;
    const isOpen = ticket.status === 'open';
    const sender = isModerator ? 'moderator' : 'user';
    const senderName = isModerator ? currentUser?.username : currentClientDiscordId;
    
    if (socket && socket.connected) socket.emit('join-ticket', ticketId);
    
    await markMessagesAsRead(ticketId, isModerator);
    
    if (isModerator) {
        await loadAllTickets();
    } else {
        await loadUserTickets();
    }
    await updateUnreadBadge();
    
    const existingModal = document.getElementById('chatModal');
    if (existingModal) existingModal.remove();
    
    const modalHtml = `
        <div class="chat-modal" id="chatModal">
            <div class="chat-container">
                <div class="chat-header">
                    <div>
                        <h3>${escapeHtml(ticket.subject)}</h3>
                        <small>Discord ID: ${escapeHtml(ticket.discordId)} | Тикет #${ticket.id} | ${ticket.status === 'open' ? 'Открыт' : 'Закрыт'}</small>
                    </div>
                    <button class="close-chat" id="closeChatBtn">&times;</button>
                </div>
                <div class="chat-messages" id="chatMessages">
                    ${ticket.messages.map(msg => `
                        <div class="message ${msg.sender === 'user' ? 'message-user' : (msg.sender === 'system' ? 'message-system' : 'message-admin')}">
                            <div>${escapeHtml(msg.text)}</div>
                            <div class="message-meta">${msg.senderName || (msg.sender === 'user' ? 'Клиент' : (msg.sender === 'system' ? 'Система' : 'Поддержка'))} • ${new Date(msg.timestamp).toLocaleString()}</div>
                        </div>
                    `).join('')}
                </div>
                <div class="chat-input-area" id="chatInputArea">
                    ${isOpen ? `
                        <input type="text" id="chatMessageInput" placeholder="Введите сообщение...">
                        <button class="send-msg-btn" id="sendMessageBtn">Отправить</button>
                    ` : '<span>Тикет закрыт</span>'}
                </div>
                ${isModerator && isOpen ? `
                    <div style="padding: 12px; text-align: right; border-top: 1px solid #333;">
                        <button class="resolve-btn" id="closeTicketFromChatBtn" data-ticket-id="${ticket.id}">Закрыть тикет</button>
                    </div>
                ` : ''}
            </div>
        </div>
    `;
    
    const div = document.createElement('div');
    div.innerHTML = modalHtml;
    document.body.appendChild(div);
    
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    
    document.getElementById('closeChatBtn').addEventListener('click', () => {
        if (socket && socket.connected && currentTicketId) socket.emit('leave-ticket', currentTicketId);
        currentTicketId = null;
        document.getElementById('chatModal')?.remove();
    });
    
    const sendBtn = document.getElementById('sendMessageBtn');
    const input = document.getElementById('chatMessageInput');
    if (sendBtn && input && isOpen) {
        const sendMessage = async () => {
            const text = input.value.trim();
            if (!text) return;
            sendBtn.disabled = true;
            const resultMsg = await api('/api/message', { ticketId, sender, senderName, text });
            if (resultMsg.error === 'Тикет закрыт, нельзя отправлять сообщения') {
                alert('Тикет закрыт, нельзя отправлять сообщения');
                const inputArea = document.getElementById('chatInputArea');
                if (inputArea) inputArea.innerHTML = '<span>Тикет закрыт</span>';
            } else {
                input.value = '';
                setTimeout(async () => {
                    await markMessagesAsRead(ticketId, isModerator);
                    if (isModerator) {
                        await loadAllTickets();
                    }
                    await updateUnreadBadge();
                }, 100);
            }
            sendBtn.disabled = false;
        };
        sendBtn.addEventListener('click', sendMessage);
        input.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
    }
    
    const closeTicketBtn = document.getElementById('closeTicketFromChatBtn');
    if (closeTicketBtn) {
        const newCloseBtn = closeTicketBtn.cloneNode(true);
        closeTicketBtn.parentNode.replaceChild(newCloseBtn, closeTicketBtn);
        
        newCloseBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            newCloseBtn.disabled = true;
            newCloseBtn.textContent = 'Закрывается...';
            
            if (confirm('Закрыть тикет?')) {
                const resultClose = await api('/api/close-ticket', { 
                    ticketId, 
                    moderatorId: currentUser?.id, 
                    moderatorName: currentUser?.username 
                });
                
                if (resultClose.success) {
                    alert('Тикет закрыт');
                    
                    const chatHeader = document.querySelector('.chat-header small');
                    if (chatHeader) {
                        chatHeader.innerHTML = chatHeader.innerHTML.replace('Открыт', 'Закрыт');
                    }
                    
                    const inputArea = document.getElementById('chatInputArea');
                    if (inputArea) inputArea.innerHTML = '<span>Тикет закрыт</span>';
                    
                    const closeBtnContainer = newCloseBtn.parentElement;
                    if (closeBtnContainer) closeBtnContainer.remove();
                    
                    if (isModerator) {
                        await loadAllTickets();
                    }
                    await updateUnreadBadge();
                    
                    if (socket && socket.connected) {
                        socket.emit('ticket-closed', { ticketId });
                    }
                } else {
                    alert('Ошибка при закрытии тикета');
                    newCloseBtn.disabled = false;
                    newCloseBtn.textContent = 'Закрыть тикет';
                }
            } else {
                newCloseBtn.disabled = false;
                newCloseBtn.textContent = 'Закрыть тикет';
            }
        });
    }
}

function appendMessageToChat(data) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    if (data.id && document.querySelector(`.message[data-msg-id="${data.id}"]`)) return;
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${data.sender === 'user' ? 'message-user' : (data.sender === 'system' ? 'message-system' : 'message-admin')}`;
    if (data.id) messageDiv.setAttribute('data-msg-id', data.id);
    messageDiv.innerHTML = `<div>${escapeHtml(data.text)}</div><div class="message-meta">${data.senderName || (data.sender === 'user' ? 'Клиент' : 'Поддержка')} • ${new Date(data.timestamp).toLocaleString()}</div>`;
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function loadModeratorsList() {
    const moderators = await apiGet('/api/moderators');
    const container = document.getElementById('moderatorsList');
    if (!container) return;
    
    if (!moderators || moderators.length === 0) {
        container.innerHTML = '<div class="empty-state">Нет модераторов</div>';
        return;
    }
    
    const isOwner = currentUser.role === 'owner';
    const isDeputy = currentUser.role === 'deputy';
    
    container.innerHTML = `
        <table class="moderators-table">
            <thead>
                <tr><th>ID</th><th>Логин</th><th>Роль</th><th>Создан</th><th>Действия</th>
            </thead>
            <tbody>
                ${moderators.map(m => {
                    let canEdit = false;
                    let canDelete = false;
                    let showRoleSelect = false;
                    let roleOptions = '';
                    let isCurrentUser = m.id === currentUser.id;
                    
                    if (isOwner) {
                        canEdit = !isCurrentUser;
                        canDelete = !isCurrentUser;
                        showRoleSelect = true;
                        roleOptions = `
                            <option value="moderator" ${m.role === 'moderator' ? 'selected' : ''}>Модератор</option>
                            <option value="deputy" ${m.role === 'deputy' ? 'selected' : ''}>Заместитель владельца</option>
                            <option value="owner" ${m.role === 'owner' ? 'selected' : ''}>Владелец</option>
                        `;
                    } else if (isDeputy) {
                        canEdit = m.role !== 'owner' && !isCurrentUser;
                        canDelete = m.role !== 'owner' && !isCurrentUser;
                        showRoleSelect = m.role === 'moderator';
                        roleOptions = `
                            <option value="moderator" ${m.role === 'moderator' ? 'selected' : ''}>Модератор</option>
                        `;
                    }
                    
                    return `
                    <tr data-id="${m.id}" class="${isCurrentUser ? 'current-user-row' : ''}">
                        <td>${m.id}</td>
                        <td><input type="text" class="edit-username" value="${escapeHtml(m.username)}" ${!canEdit ? 'disabled' : ''}></td>
                        <td>
                            ${showRoleSelect && canEdit ? `
                                <select class="edit-role">
                                    ${roleOptions}
                                </select>
                            ` : `
                                <span class="role-badge role-${m.role}">
                                    ${m.role === 'owner' ? 'Владелец' : (m.role === 'deputy' ? 'Заместитель владельца' : 'Модератор')}
                                </span>
                            `}
                            ${isCurrentUser ? ' <span class="current-user-badge">(Вы)</span>' : ''}
                        </td>
                        <td>${new Date(m.createdAt).toLocaleDateString()}</td>
                        <td>
                            ${canDelete ? `
                                <button class="save-moderator-btn" data-id="${m.id}">Сохранить</button>
                                <button class="reset-password-btn" data-id="${m.id}">Сброс пароля</button>
                                <button class="delete-moderator-btn" data-id="${m.id}" data-username="${escapeHtml(m.username)}">Удалить</button>
                            ` : (m.role === 'owner' ? '<span class="owner-badge">Владелец</span>' : '')}
                        </td>
                    </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;
    
    document.querySelectorAll('.save-moderator-btn').forEach(btn => {
        btn.removeEventListener('click', handleSaveModerator);
        btn.addEventListener('click', handleSaveModerator);
    });
    
    document.querySelectorAll('.reset-password-btn').forEach(btn => {
        btn.removeEventListener('click', handleResetPassword);
        btn.addEventListener('click', handleResetPassword);
    });
    
    document.querySelectorAll('.delete-moderator-btn').forEach(btn => {
        btn.removeEventListener('click', handleDeleteModerator);
        btn.addEventListener('click', handleDeleteModerator);
    });
}

async function handleSaveModerator(e) {
    const btn = e.currentTarget;
    const row = btn.closest('tr');
    const id = btn.dataset.id;
    const username = row.querySelector('.edit-username').value;
    const roleSelect = row.querySelector('.edit-role');
    const newRole = roleSelect ? roleSelect.value : null;
    
    const updateData = { 
        id, 
        username, 
        creatorId: currentUser.id, 
        creatorRole: currentUser.role 
    };
    if (newRole) updateData.role = newRole;
    
    const result = await api('/api/moderators/update', updateData);
    if (result.error) {
        alert(result.error);
    } else {
        alert('Модератор обновлён!');
        if (parseInt(id) === currentUser.id && newRole && newRole !== currentUser.role) {
            currentUser.role = newRole;
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            render();
        } else {
            await loadModeratorsList();
            if (parseInt(id) === currentUser.id) {
                render();
            }
        }
    }
}

async function handleResetPassword(e) {
    const btn = e.currentTarget;
    const row = btn.closest('tr');
    const id = btn.dataset.id;
    const username = row.querySelector('.edit-username').value;
    const roleSelect = row.querySelector('.edit-role');
    const role = roleSelect ? roleSelect.value : null;
    
    const newPassword = prompt('Введите новый пароль:');
    if (newPassword && newPassword.length >= 4) {
        const updateData = { 
            id, 
            username, 
            password: newPassword, 
            creatorId: currentUser.id, 
            creatorRole: currentUser.role 
        };
        if (role) updateData.role = role;
        
        const result = await api('/api/moderators/update', updateData);
        if (result.error) {
            alert(result.error);
        } else {
            alert('Пароль изменен!');
        }
    }
}

async function handleDeleteModerator(e) {
    const btn = e.currentTarget;
    const id = parseInt(btn.dataset.id);
    const username = btn.dataset.username;
    
    if (id === currentUser.id) {
        alert('Нельзя удалить самого себя!');
        return;
    }
    
    if (confirm(`Удалить модератора "${username}"?`)) {
        const result = await api('/api/moderators/delete', { 
            id, 
            currentUserId: currentUser.id, 
            currentUserRole: currentUser.role 
        });
        if (result.error) {
            alert(result.error);
        }
    }
}

async function loadLogs() {
    const logs = await apiGet('/api/logs');
    const container = document.getElementById('logsList');
    if (!container) return;
    
    if (!logs || logs.length === 0) {
        container.innerHTML = '<div class="empty-state">Нет логов</div>';
        return;
    }
    
    container.innerHTML = `
        <table class="logs-table">
            <thead>
                <tr><th>Время</th><th>Модератор</th><th>Действие</th><th>Детали</th>
            </thead>
            <tbody>
                ${logs.map(log => `
                    <tr>
                        <td>${new Date(log.timestamp).toLocaleString()}</td>
                        <td>${escapeHtml(log.moderatorName || 'Система')}</td>
                        <td>${escapeHtml(log.action)}</td>
                        <td>${escapeHtml(log.details || '')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function attachClientEvents() {
    document.querySelectorAll('.client-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentView = btn.dataset.view;
            document.querySelectorAll('.client-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.client-tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById(`client-${currentView}-view`).classList.add('active');
            if (currentView === 'my-tickets' && currentClientDiscordId) loadUserTickets();
        });
    });
    
    document.getElementById('createTicketBtn')?.addEventListener('click', async () => {
        const discordId = document.getElementById('discordId').value;
        const subject = document.getElementById('subject').value;
        const message = document.getElementById('message').value;
        const resultDiv = document.getElementById('ticketResult');
        if (!discordId || !subject || !message) {
            resultDiv.innerHTML = '<div style="background:#ef4444; padding:15px; border-radius:16px;">Заполните все поля!</div>';
            setTimeout(() => resultDiv.innerHTML = '', 3000);
            return;
        }
        const cooldown = checkCooldown(discordId);
        if (!cooldown.allowed) {
            resultDiv.innerHTML = `<div style="background:#f59e0b; padding:15px; border-radius:16px;">Подождите ${cooldown.remainingMinutes} минут</div>`;
            setTimeout(() => resultDiv.innerHTML = '', 3000);
            return;
        }
        const result = await api('/api/tickets', { discordId, subject, message });
        if (result.success) {
            savedDiscordId = discordId;
            currentClientDiscordId = discordId;
            localStorage.setItem('client_discord_id', discordId);
            setCooldown(discordId);
            resultDiv.innerHTML = `<div style="background:#10b981; padding:15px; border-radius:16px;">Тикет #${result.ticketId} создан!</div>`;
            document.getElementById('subject').value = '';
            document.getElementById('message').value = '';
            setTimeout(() => resultDiv.innerHTML = '', 5000);
        } else {
            resultDiv.innerHTML = `<div style="background:#ef4444; padding:15px; border-radius:16px;">Ошибка: ${result.error}</div>`;
            setTimeout(() => resultDiv.innerHTML = '', 3000);
        }
    });
    
    const modal = document.getElementById('moderatorLoginModal');
    document.getElementById('moderatorLoginBtn')?.addEventListener('click', () => modal.style.display = 'flex');
    document.getElementById('closeModalBtn')?.addEventListener('click', () => modal.style.display = 'none');
    window.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    
    document.getElementById('moderatorLoginForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const result = await api('/api/login', { 
            username: document.getElementById('modLoginUsername').value, 
            password: document.getElementById('modLoginPassword').value 
        });
        if (result.success) {
            currentUser = result.user;
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            modal.style.display = 'none';
            render();
        } else {
            document.getElementById('modLoginError').innerText = 'Неверный логин или пароль';
        }
    });
}

function attachModeratorEvents() {
    document.getElementById('logoutBtn')?.addEventListener('click', () => {
        localStorage.removeItem('currentUser');
        currentUser = null;
        if (socket) socket.disconnect();
        render();
    });
    
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById(`tab-${tab}`)?.classList.add('active');
            if (tab === 'moderators') loadModeratorsList();
            if (tab === 'logs') loadLogs();
            if (tab === 'tickets') loadAllTickets();
        });
    });
    
    const addBtn = document.getElementById('addModeratorBtn');
    if (addBtn && (currentUser.role === 'owner' || currentUser.role === 'deputy')) {
        const newAddBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newAddBtn, addBtn);
        
        newAddBtn.addEventListener('click', async () => {
            const username = prompt('Введите логин модератора:');
            if (!username) return;
            const password = prompt('Введите пароль модератора:');
            if (!password) return;
            
            let role = 'moderator';
            if (currentUser.role === 'owner') {
                const roleChoice = prompt('Выберите роль:\n1 - Модератор\n2 - Заместитель владельца');
                if (roleChoice === '2') {
                    role = 'deputy';
                }
            } else if (currentUser.role === 'deputy') {
                alert('Заместитель может создавать только модераторов');
            }
            
            const result = await api('/api/moderators/create', { 
                username, 
                password, 
                role,
                creatorId: currentUser.id,
                creatorRole: currentUser.role
            });
            
            if (result.error) {
                alert('Ошибка: ' + result.error);
            } else {
                alert('Модератор успешно создан!');
                await loadModeratorsList();
            }
        });
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

render();