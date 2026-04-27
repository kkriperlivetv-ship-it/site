const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e6,
    pingTimeout: 60000,
    pingInterval: 25000});

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// ============ DDoS ЗАЩИТА ============
class DDoSProtection {
    constructor() {
        this.ipRequests = new Map();
        this.config = {
            ipRateLimit: 30,
            ipRateLimitPerSecond: 5,
            banDuration: 30 * 60 * 1000,
            tempBanDuration: 5 * 60 * 1000,
            endpoints: {
                '/api/login': { limit: 5, perMinutes: 5, banOnExceed: true },
                '/api/register': { limit: 3, perMinutes: 10, banOnExceed: true },
                '/api/tickets': { limit: 10, perMinutes: 5, banOnExceed: false },
                '/api/message': { limit: 20, perMinutes: 2, banOnExceed: false },
                '/api/all-tickets': { limit: 60, perMinutes: 1, banOnExceed: false },
                '/api/my-tickets': { limit: 60, perMinutes: 1, banOnExceed: false }
            }
        };
        
        setInterval(() => this.cleanup(), 5 * 60 * 1000);
    }
    
    cleanup() {
        const now = Date.now();
        for (const [ip, data] of this.ipRequests.entries()) {
            if (now - data.lastRequest > 10 * 60 * 1000) {
                this.ipRequests.delete(ip);
            }
        }
    }
    
    isBlocked(ip) {
        const data = this.ipRequests.get(ip);
        if (data && data.blockedUntil && Date.now() < data.blockedUntil) {
            return { blocked: true, reason: 'IP заблокирован', until: data.blockedUntil };
        }
        return { blocked: false };
    }
    
    checkRateLimit(ip, endpoint) {
        const now = Date.now();
        const blocked = this.isBlocked(ip);
        if (blocked.blocked) return blocked;
        
        let ipData = this.ipRequests.get(ip);
        if (!ipData) {
            ipData = {
                lastRequest: now,
                requestTimes: [],
                endpointCounts: new Map()
            };
            this.ipRequests.set(ip, ipData);
        }
        
        ipData.requestTimes = ipData.requestTimes.filter(t => now - t < 60000);
        ipData.requestTimes.push(now);
        
        if (ipData.requestTimes.length > this.config.ipRateLimit) {
            return this.banIP(ip, `Превышен лимит: ${ipData.requestTimes.length}/${this.config.ipRateLimit} в минуту`);
        }
        
        const lastSecond = ipData.requestTimes.filter(t => now - t < 1000);
        if (lastSecond.length > this.config.ipRateLimitPerSecond) {
            return this.tempBanIP(ip, `Превышен лимит: ${lastSecond.length} запросов/сек`);
        }
        
        if (this.config.endpoints[endpoint]) {
            const endpointLimit = this.config.endpoints[endpoint];
            let endpointData = ipData.endpointCounts.get(endpoint) || { count: 0, resetTime: now + (endpointLimit.perMinutes * 60 * 1000) };
            
            if (now > endpointData.resetTime) {
                endpointData = { count: 0, resetTime: now + (endpointLimit.perMinutes * 60 * 1000) };
            }
            
            endpointData.count++;
            ipData.endpointCounts.set(endpoint, endpointData);
            
            if (endpointData.count > endpointLimit.limit) {
                if (endpointLimit.banOnExceed) {
                    return this.banIP(ip, `Превышен лимит для ${endpoint}`);
                }
                return { allowed: false, reason: `Слишком много попыток. Подождите ${endpointLimit.perMinutes} минуты.`, retryAfter: endpointLimit.perMinutes * 60 };
            }
        }
        
        return { allowed: true };
    }
    
    banIP(ip, reason) {
        let ipData = this.ipRequests.get(ip);
        if (!ipData) {
            ipData = {};
            this.ipRequests.set(ip, ipData);
        }
        ipData.blockedUntil = Date.now() + this.config.banDuration;
        console.warn(`🚫 IP ${ip} ЗАБЛОКИРОВАН: ${reason}`);
        return { allowed: false, reason: 'IP заблокирован за нарушение правил', blocked: true };
    }
    
    tempBanIP(ip, reason) {
        let ipData = this.ipRequests.get(ip);
        if (!ipData) {
            ipData = {};
            this.ipRequests.set(ip, ipData);
        }
        ipData.blockedUntil = Date.now() + this.config.tempBanDuration;
        console.warn(`⚠️ IP ${ip} ВРЕМЕННО ЗАБЛОКИРОВАН: ${reason}`);
        return { allowed: false, reason: 'Слишком много запросов. Подождите 5 минут.', blocked: true, temporary: true };
    }
}

const ddosProtection = new DDoSProtection();

// Middleware для защиты
const rateLimitMiddleware = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
    const result = ddosProtection.checkRateLimit(ip, req.path);
    
    if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter || 300);
        return res.status(result.blocked ? 403 : 429).json({ 
            error: result.reason,
            blocked: result.blocked || false
        });
    }
    
    next();
};

app.use('/api/', rateLimitMiddleware);

// ============ ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ ============
const db = new sqlite3.Database('monolith.db');

// Создание таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'user',
        isBanned INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
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
        text TEXT,
        isRead INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        isSystem INTEGER DEFAULT 0
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        username TEXT,
        action TEXT,
        details TEXT,
        ip TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Добавление колонки ip в logs если её нет
    db.run(`ALTER TABLE logs ADD COLUMN ip TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            // колонка уже существует
        }
    });
    
    // Создание владельца
    db.get("SELECT * FROM users WHERE role = 'owner'", (err, row) => {
        if (!row && !err) {
            db.run(`INSERT INTO users (username, password, role, isBanned) VALUES (?, ?, ?, ?)`, 
                ['owner', 'owner123', 'owner', 0], (err2) => {
                if (!err2) console.log('✅ Владелец создан: owner / owner123');
            });
        }
    });
    
    console.log('✅ База данных инициализирована');
});

function addLog(userId, username, action, details, ip = null) {
    db.run('INSERT INTO logs (userId, username, action, details, ip) VALUES (?, ?, ?, ?, ?)', 
        [userId || null, username || null, action, details || null, ip], (err) => {
        if (err) console.error('Ошибка записи лога:', err.message);
    });
}

// ============ API МАРШРУТЫ ============

app.post('/api/register', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const { username, password } = req.body;
    
    if (!username || username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: 'Имя от 3 до 20 символов' });
    }
    if (!password || password.length < 4) {
        return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    }
    
    const safeUsername = username.replace(/[^\w\u0400-\u04FF]/g, '');
    
    db.run('INSERT INTO users (username, password, role, isBanned) VALUES (?, ?, ?, ?)', 
        [safeUsername, password, 'user', 0], function(err) {
        if (err) {
            addLog(null, safeUsername, 'register_failed', 'Имя занято', ip);
            return res.status(400).json({ error: 'Имя пользователя уже занято' });
        }
        addLog(this.lastID, safeUsername, 'register', 'Регистрация', ip);
        res.json({ success: true, user: { id: this.lastID, username: safeUsername, role: 'user', isBanned: 0 } });
    });
});

app.post('/api/login', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const { username, password } = req.body;
    
    const safeUsername = username ? username.replace(/[^\w\u0400-\u04FF]/g, '') : '';
    
    db.get('SELECT * FROM users WHERE username = ? AND password = ?', [safeUsername, password], (err, user) => {
        if (err || !user) {
            addLog(null, safeUsername, 'failed_login', 'Неверные данные', ip);
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }
        if (user.isBanned === 1) {
            addLog(user.id, user.username, 'blocked_login', 'Попытка входа в забаненный аккаунт', ip);
            return res.status(403).json({ error: 'banned' });
        }
        
        addLog(user.id, user.username, 'login', 'Успешный вход', ip);
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role, isBanned: user.isBanned } });
    });
});

app.post('/api/tickets', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const { userId, discordId, subject, message } = req.body;
    
    if (!discordId || discordId.trim() === '') {
        return res.status(400).json({ error: 'Discord ID обязателен' });
    }
    
    const cleanSubject = (subject || '').replace(/[<>]/g, '').substring(0, 200);
    const cleanMessage = (message || '').replace(/[<>]/g, '').substring(0, 2000);
    const cleanDiscordId = (discordId || '').replace(/[<>]/g, '').substring(0, 50);
    
    db.run('INSERT INTO tickets (userId, discordId, subject, message, status, lastMessageTime, lastMessageFrom) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, cleanDiscordId, cleanSubject, cleanMessage, 'open', new Date().toISOString(), 'user'],
        function(err) {
            if (err) {
                addLog(userId, null, 'create_ticket_failed', err.message, ip);
                return res.status(500).json({ error: 'Ошибка создания тикета' });
            }
            
            const ticketId = this.lastID;
            db.run('INSERT INTO messages (ticketId, sender, text, isRead) VALUES (?, ?, ?, ?)', [ticketId, 'user', cleanMessage, 0]);
            addLog(userId, null, 'create_ticket', `Тикет #${ticketId} создан`, ip);
            res.json({ success: true, ticketId: ticketId });
        }
    );
});

app.post('/api/my-tickets', (req, res) => {
    const { userId } = req.body;
    db.all(`SELECT t.*, (SELECT COUNT(*) FROM messages WHERE ticketId = t.id AND sender != 'user' AND isRead = 0) as unreadCount FROM tickets t WHERE t.userId = ? ORDER BY t.lastMessageTime DESC`, [userId], (err, tickets) => {
        res.json(tickets || []);
    });
});

app.get('/api/all-tickets', (req, res) => {
    db.all(`SELECT t.*, u.username, (SELECT COUNT(*) FROM messages WHERE ticketId = t.id AND sender = 'user' AND isRead = 0) as unreadCount FROM tickets t LEFT JOIN users u ON t.userId = u.id ORDER BY t.lastMessageTime DESC`, [], (err, tickets) => {
        res.json(tickets || []);
    });
});

app.get('/api/all-users', (req, res) => {
    db.all(`SELECT id, username, role, isBanned, createdAt FROM users ORDER BY id`, [], (err, users) => {
        res.json(users || []);
    });
});

app.get('/api/all-logs', (req, res) => {
    db.all(`SELECT * FROM logs ORDER BY timestamp DESC LIMIT 200`, [], (err, logs) => {
        res.json(logs || []);
    });
});

app.post('/api/get-user', (req, res) => {
    const { userId } = req.body;
    db.get('SELECT id, username, role, isBanned FROM users WHERE id = ?', [userId], (err, user) => {
        res.json(user);
    });
});

app.post('/api/search-user', (req, res) => {
    const { username } = req.body;
    db.all(`SELECT id, username, role, isBanned, createdAt FROM users WHERE username LIKE ? ORDER BY id`, [`%${username}%`], (err, users) => {
        res.json(users || []);
    });
});

app.post('/api/change-role', (req, res) => {
    const { userId, newRole, ownerId, ownerName } = req.body;
    
    if (!['user', 'admin'].includes(newRole)) {
        return res.status(400).json({ error: 'Недопустимая роль' });
    }
    
    db.run('UPDATE users SET role = ? WHERE id = ?', [newRole, userId], function(err) {
        if (!err) addLog(ownerId, ownerName, 'change_role', `Пользователь ${userId} получил роль ${newRole}`);
        res.json({ success: !err });
    });
});

app.post('/api/ban-user', (req, res) => {
    const { userId, moderatorId, moderatorName, moderatorRole } = req.body;
    
    db.get('SELECT role FROM users WHERE id = ?', [userId], (err, targetUser) => {
        if (err) return res.status(500).json({ error: 'Ошибка сервера' });
        if (!targetUser) return res.status(404).json({ error: 'Пользователь не найден' });
        if (targetUser.role === 'owner') return res.status(403).json({ error: 'Нельзя заблокировать владельца' });
        if (moderatorRole === 'admin' && targetUser.role === 'admin') {
            return res.status(403).json({ error: 'Модератор не может блокировать другого модератора' });
        }
        
        db.run('UPDATE users SET isBanned = 1 WHERE id = ?', [userId], function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка блокировки' });
            addLog(moderatorId, moderatorName, 'ban_user', `Заблокирован пользователь ${userId}`);
            res.json({ success: true });
        });
    });
});

app.post('/api/unban-user', (req, res) => {
    const { userId, moderatorId, moderatorName, moderatorRole } = req.body;
    
    db.get('SELECT role FROM users WHERE id = ?', [userId], (err, targetUser) => {
        if (err) return res.status(500).json({ error: 'Ошибка сервера' });
        if (!targetUser) return res.status(404).json({ error: 'Пользователь не найден' });
        if (targetUser.role === 'owner') return res.status(403).json({ error: 'Нельзя разблокировать владельца' });
        
        db.run('UPDATE users SET isBanned = 0 WHERE id = ?', [userId], function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка разблокировки' });
            addLog(moderatorId, moderatorName, 'unban_user', `Разблокирован пользователь ${userId}`);
            res.json({ success: true });
        });
    });
});

app.post('/api/delete-ticket', (req, res) => {
    const { ticketId, ownerId, ownerName } = req.body;
    
    db.run('DELETE FROM messages WHERE ticketId = ?', [ticketId]);
    db.run('DELETE FROM tickets WHERE id = ?', [ticketId], function(err) {
        if (!err) addLog(ownerId, ownerName, 'delete_ticket', `Удален тикет ${ticketId}`);
        res.json({ success: !err });
    });
});

app.post('/api/delete-user', (req, res) => {
    const { userId, ownerId, ownerName } = req.body;
    
    db.get('SELECT role FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) return res.status(500).json({ error: 'Ошибка сервера' });
        if (user && user.role === 'owner') return res.status(403).json({ error: 'Нельзя удалить владельца' });
        
        db.run('DELETE FROM messages WHERE ticketId IN (SELECT id FROM tickets WHERE userId = ?)', [userId]);
        db.run('DELETE FROM tickets WHERE userId = ?', [userId]);
        db.run('DELETE FROM users WHERE id = ?', [userId], function(err) {
            if (!err) addLog(ownerId, ownerName, 'delete_user', `Удален пользователь ${userId}`);
            res.json({ success: !err });
        });
    });
});

app.post('/api/ticket', (req, res) => {
    const { ticketId } = req.body;
    db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, ticket) => {
        if (!ticket) return res.status(404).json({ error: 'Тикет не найден' });
        db.all('SELECT * FROM messages WHERE ticketId = ? ORDER BY timestamp ASC', [ticketId], (err2, messages) => {
            res.json({ ...ticket, messages: messages || [] });
        });
    });
});

app.post('/api/mark-read', (req, res) => {
    const { ticketId, readerRole } = req.body;
    const updateQuery = readerRole === 'admin' 
        ? 'UPDATE messages SET isRead = 1 WHERE ticketId = ? AND sender = "user"'
        : 'UPDATE messages SET isRead = 1 WHERE ticketId = ? AND sender = "admin"';
    db.run(updateQuery, [ticketId], () => res.json({ success: true }));
});

app.post('/api/close-ticket', (req, res) => {
    const { ticketId } = req.body;
    db.run('UPDATE tickets SET status = "closed", resolvedAt = CURRENT_TIMESTAMP WHERE id = ?', [ticketId]);
    db.run('INSERT INTO messages (ticketId, sender, text, isSystem, isRead) VALUES (?, ?, ?, ?, ?)', [ticketId, 'system', 'Тикет закрыт', 1, 1]);
    res.json({ success: true });
});

app.post('/api/message', (req, res) => {
    const { ticketId, sender, text } = req.body;
    
    db.run('UPDATE tickets SET lastMessageTime = ?, lastMessageFrom = ? WHERE id = ?', [new Date().toISOString(), sender, ticketId]);
    db.run('INSERT INTO messages (ticketId, sender, text, isRead) VALUES (?, ?, ?, ?)', [ticketId, sender, text, 0], function(err) {
        if (!err && io) {
            io.to(`ticket_${ticketId}`).emit('message-received', {
                id: this.lastID,
                ticketId: ticketId,
                sender: sender,
                text: text,
                timestamp: new Date().toISOString()
            });
            io.emit('unread-update', { ticketId, sender });
        }
        res.json({ success: !err });
    });
});

app.get('/api/security-status', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const isBlocked = ddosProtection.isBlocked(ip);
    res.json({
        blocked: isBlocked.blocked || false,
        message: isBlocked.reason || 'OK'
    });
});

// ============ WEBSOCKET ============
io.on('connection', (socket) => {
    console.log(`🔌 Новое подключение: ${socket.id}`);
    
    socket.on('user-connected', (userData) => {
        console.log(`👤 Пользователь ${userData?.username} онлайн`);
    });
    
    socket.on('join-ticket', (ticketId) => {
        socket.join(`ticket_${ticketId}`);
    });
    
    socket.on('leave-ticket', (ticketId) => {
        socket.leave(`ticket_${ticketId}`);
    });
    
    socket.on('disconnect', () => {
        console.log(`👋 Отключен: ${socket.id}`);
    });
});

// ============ ЗАПУСК СЕРВЕРА ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`🛡️ СЕРВЕР ЗАПУЩЕН С АНТИ-DDoS ЗАЩИТОЙ`);
    console.log(`========================================`);
    console.log(`📱 http://localhost:${PORT}`);
    console.log(`👑 Владелец: owner / owner123`);
    console.log(`========================================\n`);
});