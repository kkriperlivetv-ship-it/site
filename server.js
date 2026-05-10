const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e6,
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// База данных
const dbPath = path.join(__dirname, 'monolith.db');
const db = new sqlite3.Database(dbPath);

// Создание таблиц с полной структурой
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS moderators (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'moderator',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discordId TEXT,
        subject TEXT,
        message TEXT,
        status TEXT DEFAULT 'open',
        lastMessageTime DATETIME DEFAULT CURRENT_TIMESTAMP,
        lastMessageFrom TEXT DEFAULT 'user',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolvedAt DATETIME
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticketId INTEGER,
        sender TEXT,
        senderName TEXT,
        text TEXT,
        isRead INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        moderatorId INTEGER,
        moderatorName TEXT,
        action TEXT,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Создание владельца (owner)
    db.get("SELECT * FROM moderators WHERE role = 'owner'", (err, row) => {
        if (!row && !err) {
            db.run("INSERT INTO moderators (username, password, role) VALUES (?, ?, ?)", 
                ['owner', 'owner123', 'owner']);
            console.log('✅ Владелец создан: owner / owner123');
        }
    });
});

console.log('✅ База данных инициализирована');

function addLog(moderatorId, moderatorName, action, details) {
    db.run("INSERT INTO logs (moderatorId, moderatorName, action, details) VALUES (?, ?, ?, ?)", 
        [moderatorId, moderatorName, action, details]);
}

function canManageModerator(actorRole, targetRole, targetId, actorId) {
    if (actorRole === 'owner') return true;
    if (actorRole === 'deputy') {
        if (targetRole === 'owner') return false;
        if (targetId === actorId) return false;
        return true;
    }
    return false;
}

// ============ АВТОРИЗАЦИЯ ============
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM moderators WHERE username = ? AND password = ?", [username, password], (err, moderator) => {
        if (err || !moderator) return res.status(401).json({ error: 'Неверный логин или пароль' });
        res.json({ success: true, user: { id: moderator.id, username: moderator.username, role: moderator.role, isModerator: true } });
    });
});

app.post('/api/get-user', (req, res) => {
    const { userId } = req.body;
    db.get("SELECT id, username, role FROM moderators WHERE id = ?", [userId], (err, user) => {
        res.json(user || null);
    });
});

// ============ УПРАВЛЕНИЕ МОДЕРАТОРАМИ ============
app.get('/api/moderators', (req, res) => {
    db.all("SELECT id, username, role, createdAt FROM moderators ORDER BY id", [], (err, moderators) => {
        res.json(moderators || []);
    });
});

app.post('/api/moderators/create', (req, res) => {
    const { username, password, role, creatorId, creatorRole } = req.body;
    
    if (creatorRole !== 'owner' && creatorRole !== 'deputy') {
        return res.status(403).json({ error: 'Недостаточно прав' });
    }
    if (creatorRole === 'deputy' && role === 'owner') {
        return res.status(403).json({ error: 'Заместитель не может создать владельца' });
    }
    
    db.run("INSERT INTO moderators (username, password, role) VALUES (?, ?, ?)", 
        [username, password, role || 'moderator'], function(err) {
        if (err) return res.status(400).json({ error: 'Имя уже занято' });
        addLog(creatorId, username, 'create_moderator', `Создан модератор ${username} с ролью ${role || 'moderator'}`);
        io.emit('moderators-updated');
        res.json({ success: true, id: this.lastID });
    });
});

app.post('/api/moderators/update', (req, res) => {
    const { id, username, password, role, creatorId, creatorRole } = req.body;
    
    db.get("SELECT role FROM moderators WHERE id = ?", [id], (err, target) => {
        if (err || !target) return res.status(404).json({ error: 'Модератор не найден' });
        
        if (!canManageModerator(creatorRole, target.role, id, creatorId)) {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }
        if (creatorRole === 'deputy' && role === 'owner') {
            return res.status(403).json({ error: 'Заместитель не может назначить владельца' });
        }
        
        if (password) {
            db.run("UPDATE moderators SET username = ?, password = ?, role = ? WHERE id = ?", 
                [username, password, role, id]);
        } else {
            db.run("UPDATE moderators SET username = ?, role = ? WHERE id = ?", 
                [username, role, id]);
        }
        
        addLog(creatorId, username, 'update_moderator', `Обновлён модератор ${username} (роль: ${role})`);
        io.emit('moderators-updated');
        
        if (parseInt(id) === creatorId) {
            io.emit('role-updated', { userId: id, newRole: role });
        }
        
        res.json({ success: true });
    });
});

app.post('/api/moderators/delete', (req, res) => {
    const { id, currentUserId, currentUserRole } = req.body;
    
    db.get("SELECT username, role FROM moderators WHERE id = ?", [id], (err, target) => {
        if (err || !target) return res.status(404).json({ error: 'Модератор не найден' });
        
        if (parseInt(id) === parseInt(currentUserId)) {
            return res.status(400).json({ error: 'Нельзя удалить самого себя' });
        }
        if (!canManageModerator(currentUserRole, target.role, id, currentUserId)) {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }
        
        db.run("DELETE FROM moderators WHERE id = ?", [id], function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка удаления' });
            addLog(currentUserId, target.username, 'delete_moderator', `Удалён модератор ${target.username}`);
            io.emit('moderators-updated');
            res.json({ success: true });
        });
    });
});

// ============ ТИКЕТЫ ============
app.post('/api/tickets', (req, res) => {
    const { discordId, subject, message } = req.body;
    const cleanDiscordId = (discordId || '').replace(/[<>]/g, '').substring(0, 50);
    const cleanSubject = (subject || '').replace(/[<>]/g, '').substring(0, 200);
    const cleanMessage = (message || '').replace(/[<>]/g, '').substring(0, 2000);
    
    db.run(`INSERT INTO tickets (discordId, subject, message, status, lastMessageTime, lastMessageFrom) 
        VALUES (?, ?, ?, ?, ?, ?)`,
        [cleanDiscordId, cleanSubject, cleanMessage, 'open', new Date().toISOString(), 'user'],
        function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка создания тикета' });
            const ticketId = this.lastID;
            db.run("INSERT INTO messages (ticketId, sender, senderName, text, isRead) VALUES (?, ?, ?, ?, ?)",
                [ticketId, 'user', cleanDiscordId, cleanMessage, 0]);
            io.emit('new-ticket', { ticketId, discordId: cleanDiscordId, subject: cleanSubject });
            io.emit('unread-update');
            res.json({ success: true, ticketId });
        });
});

app.post('/api/tickets/by-discord', (req, res) => {
    const { discordId } = req.body;
    db.all("SELECT * FROM tickets WHERE discordId = ? ORDER BY createdAt DESC", [discordId], (err, tickets) => {
        res.json(tickets || []);
    });
});

app.post('/api/ticket', (req, res) => {
    const { ticketId } = req.body;
    db.get("SELECT * FROM tickets WHERE id = ?", [ticketId], (err, ticket) => {
        if (!ticket) return res.status(404).json({ error: 'Тикет не найден' });
        db.all("SELECT * FROM messages WHERE ticketId = ? ORDER BY timestamp ASC", [ticketId], (err2, messages) => {
            res.json({ ...ticket, messages: messages || [] });
        });
    });
});

app.get('/api/all-tickets', (req, res) => {
    db.all("SELECT * FROM tickets ORDER BY lastMessageTime DESC", [], (err, tickets) => {
        res.json(tickets || []);
    });
});

app.post('/api/message', (req, res) => {
    const { ticketId, sender, senderName, text } = req.body;
    
    db.get("SELECT status FROM tickets WHERE id = ?", [ticketId], (err, ticket) => {
        if (err || !ticket) return res.status(404).json({ error: 'Тикет не найден' });
        if (ticket.status === 'closed' && sender !== 'system') {
            return res.status(403).json({ error: 'Тикет закрыт' });
        }
        
        db.run("UPDATE tickets SET lastMessageTime = ?, lastMessageFrom = ? WHERE id = ?",
            [new Date().toISOString(), sender, ticketId]);
        
        db.run("INSERT INTO messages (ticketId, sender, senderName, text, isRead) VALUES (?, ?, ?, ?, ?)",
            [ticketId, sender, senderName, text, 0], function(err) {
                if (!err && io) {
                    io.to(`ticket_${ticketId}`).emit('message-received', {
                        id: this.lastID,
                        ticketId,
                        sender,
                        senderName,
                        text,
                        timestamp: new Date().toISOString()
                    });
                    io.emit('unread-update');
                }
                res.json({ success: !err });
            });
    });
});

app.post('/api/close-ticket', (req, res) => {
    const { ticketId, moderatorId, moderatorName } = req.body;
    
    db.run("UPDATE tickets SET status = 'closed', resolvedAt = CURRENT_TIMESTAMP WHERE id = ?", [ticketId]);
    db.run("INSERT INTO messages (ticketId, sender, senderName, text, isRead) VALUES (?, ?, ?, ?, ?)",
        [ticketId, 'system', 'Система', 'Тикет закрыт', 1]);
    addLog(moderatorId, moderatorName, 'close_ticket', `Закрыт тикет #${ticketId}`);
    io.to(`ticket_${ticketId}`).emit('ticket-closed', { ticketId });
    io.emit('unread-update');
    io.emit('tickets-updated');
    
    res.json({ success: true });
});

app.post('/api/delete-ticket', (req, res) => {
    const { ticketId } = req.body;
    
    db.run("DELETE FROM messages WHERE ticketId = ?", [ticketId]);
    db.run("DELETE FROM tickets WHERE id = ?", [ticketId]);
    io.emit('ticket-deleted', { ticketId });
    io.emit('unread-update');
    io.emit('tickets-updated');
    
    res.json({ success: true });
});

app.post('/api/mark-read', (req, res) => {
    const { ticketId, isModerator } = req.body;
    if (isModerator) {
        db.run("UPDATE messages SET isRead = 1 WHERE ticketId = ? AND sender = 'user'", [ticketId]);
    } else {
        db.run("UPDATE messages SET isRead = 1 WHERE ticketId = ? AND sender = 'moderator'", [ticketId]);
    }
    res.json({ success: true });
});

app.get('/api/logs', (req, res) => {
    db.all("SELECT * FROM logs ORDER BY timestamp DESC LIMIT 100", [], (err, logs) => {
        res.json(logs || []);
    });
});

// ============ WEBSOCKET ============
io.on('connection', (socket) => {
    console.log('🔌 WebSocket подключен');
    
    socket.on('join-ticket', (ticketId) => {
        socket.join(`ticket_${ticketId}`);
        console.log(`📌 Присоединился к тикету #${ticketId}`);
    });
    
    socket.on('leave-ticket', (ticketId) => {
        socket.leave(`ticket_${ticketId}`);
    });
    
    socket.on('join-moderator', () => {
        socket.join('moderators');
        console.log('👮 Модератор присоединился');
    });
    
    socket.on('join-user', (discordId) => {
        socket.join(`user-${discordId}`);
        console.log(`👤 Пользователь ${discordId} присоединился`);
    });
    
    socket.on('disconnect', () => {
        console.log('❌ WebSocket отключен');
    });
});

// ============ ЗАПУСК ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`🚀 СЕРВЕР ЗАПУЩЕН`);
    console.log(`========================================`);
    console.log(`📱 http://localhost:${PORT}`);
    console.log(`👑 Владелец: owner / owner123`);
    console.log(`👥 Роли: owner, deputy, moderator`);
    console.log(`💬 WebSocket чат активен`);
    console.log(`========================================\n`);
});