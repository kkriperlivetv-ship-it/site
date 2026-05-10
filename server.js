const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static('public'));

// База данных
const db = new sqlite3.Database('monolith.db');

// Создание таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'user',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        discordId TEXT,
        subject TEXT,
        message TEXT,
        status TEXT DEFAULT 'open',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        lastActivity DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticketId INTEGER,
        sender TEXT,
        text TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Создание админа
    db.get("SELECT * FROM users WHERE username = 'admin'", (err, row) => {
        if (!row && !err) {
            db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", 
                ['admin', 'admin123', 'admin']);
            console.log('✅ Админ создан: admin / admin123');
        }
    });
});

// API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Неверный логин или пароль' });
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    });
});

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", 
        [username, password, 'user'], function(err) {
        if (err) return res.status(400).json({ error: 'Имя занято' });
        res.json({ success: true, user: { id: this.lastID, username, role: 'user' } });
    });
});

app.post('/api/tickets', (req, res) => {
    const { userId, discordId, subject, message } = req.body;
    db.run("INSERT INTO tickets (userId, discordId, subject, message) VALUES (?, ?, ?, ?)",
        [userId, discordId, subject, message], function(err) {
        if (err) return res.status(500).json({ error: 'Ошибка' });
        res.json({ success: true, ticketId: this.lastID });
    });
});

app.post('/api/my-tickets', (req, res) => {
    const { userId } = req.body;
    db.all("SELECT * FROM tickets WHERE userId = ? ORDER BY createdAt DESC", [userId], (err, tickets) => {
        res.json(tickets || []);
    });
});

app.get('/api/all-tickets', (req, res) => {
    db.all("SELECT t.*, u.username FROM tickets t LEFT JOIN users u ON t.userId = u.id ORDER BY t.createdAt DESC", [], (err, tickets) => {
        res.json(tickets || []);
    });
});

app.post('/api/ticket', (req, res) => {
    const { ticketId } = req.body;
    db.get("SELECT * FROM tickets WHERE id = ?", [ticketId], (err, ticket) => {
        if (!ticket) return res.status(404).json({ error: 'Не найден' });
        db.all("SELECT * FROM messages WHERE ticketId = ? ORDER BY timestamp ASC", [ticketId], (err2, messages) => {
            res.json({ ...ticket, messages: messages || [] });
        });
    });
});

app.post('/api/message', (req, res) => {
    const { ticketId, sender, text } = req.body;
    db.run("UPDATE tickets SET lastActivity = CURRENT_TIMESTAMP WHERE id = ?", [ticketId]);
    db.run("INSERT INTO messages (ticketId, sender, text) VALUES (?, ?, ?)",
        [ticketId, sender, text], function(err) {
            if (!err && io) {
                io.to(`ticket_${ticketId}`).emit('message-received', {
                    id: this.lastID,
                    ticketId: ticketId,
                    sender: sender,
                    text: text,
                    timestamp: new Date().toISOString()
                });
            }
            res.json({ success: !err });
        });
});

app.post('/api/close-ticket', (req, res) => {
    const { ticketId } = req.body;
    db.run("UPDATE tickets SET status = 'closed' WHERE id = ?", [ticketId]);
    res.json({ success: true });
});

// WebSocket
io.on('connection', (socket) => {
    console.log('🔌 WebSocket подключен');
    
    socket.on('join-ticket', (ticketId) => {
        socket.join(`ticket_${ticketId}`);
    });
    
    socket.on('leave-ticket', (ticketId) => {
        socket.leave(`ticket_${ticketId}`);
    });
    
    socket.on('disconnect', () => {
        console.log('❌ WebSocket отключен');
    });
});

// Запуск
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`🚀 СЕРВЕР ЗАПУЩЕН`);
    console.log(`========================================`);
    console.log(`📱 http://localhost:${PORT}`);
    console.log(`👑 Админ: admin / admin123`);
    console.log(`========================================\n`);
});