const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Database = require('node:sqlite').Database;
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static('public'));

// ============ ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ ============
let db;

async function initDatabase() {
    try {
        db = await Database.open('./monolith.db');
        
        // Создание таблиц
        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                password TEXT,
                role TEXT DEFAULT 'user',
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await db.exec(`
            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId INTEGER,
                discordId TEXT,
                subject TEXT,
                message TEXT,
                status TEXT DEFAULT 'open',
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                lastActivity DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticketId INTEGER,
                sender TEXT,
                text TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Создание админа
        const adminCheck = await db.get("SELECT * FROM users WHERE username = 'admin'");
        if (!adminCheck) {
            await db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", 
                ['admin', 'admin123', 'admin']);
            console.log('✅ Админ создан: admin / admin123');
        }
        
        console.log('✅ База данных инициализирована');
        return true;
    } catch (error) {
        console.error('Ошибка базы данных:', error);
        return false;
    }
}

// ============ API МАРШРУТЫ ============

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);
        if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", 
            [username, password, 'user']);
        res.json({ success: true, user: { id: result.lastID, username, role: 'user' } });
    } catch (err) {
        res.status(400).json({ error: 'Имя пользователя уже занято' });
    }
});

app.post('/api/tickets', async (req, res) => {
    const { userId, discordId, subject, message } = req.body;
    try {
        const result = await db.run("INSERT INTO tickets (userId, discordId, subject, message) VALUES (?, ?, ?, ?)",
            [userId, discordId, subject, message]);
        res.json({ success: true, ticketId: result.lastID });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка создания тикета' });
    }
});

app.post('/api/my-tickets', async (req, res) => {
    const { userId } = req.body;
    try {
        const tickets = await db.all("SELECT * FROM tickets WHERE userId = ? ORDER BY createdAt DESC", [userId]);
        res.json(tickets || []);
    } catch (err) {
        res.json([]);
    }
});

app.get('/api/all-tickets', async (req, res) => {
    try {
        const tickets = await db.all("SELECT t.*, u.username FROM tickets t LEFT JOIN users u ON t.userId = u.id ORDER BY t.createdAt DESC");
        res.json(tickets || []);
    } catch (err) {
        res.json([]);
    }
});

app.post('/api/ticket', async (req, res) => {
    const { ticketId } = req.body;
    try {
        const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
        if (!ticket) return res.status(404).json({ error: 'Тикет не найден' });
        const messages = await db.all("SELECT * FROM messages WHERE ticketId = ? ORDER BY timestamp ASC", [ticketId]);
        res.json({ ...ticket, messages: messages || [] });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

app.post('/api/message', async (req, res) => {
    const { ticketId, sender, text } = req.body;
    try {
        await db.run("UPDATE tickets SET lastActivity = CURRENT_TIMESTAMP WHERE id = ?", [ticketId]);
        const result = await db.run("INSERT INTO messages (ticketId, sender, text) VALUES (?, ?, ?)",
            [ticketId, sender, text]);
        
        if (io) {
            io.to(`ticket_${ticketId}`).emit('message-received', {
                id: result.lastID,
                ticketId: ticketId,
                sender: sender,
                text: text,
                timestamp: new Date().toISOString()
            });
        }
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

app.post('/api/close-ticket', async (req, res) => {
    const { ticketId } = req.body;
    try {
        await db.run("UPDATE tickets SET status = 'closed' WHERE id = ?", [ticketId]);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

// ============ WEBSOCKET ============
io.on('connection', (socket) => {
    console.log('🔌 WebSocket подключен');
    
    socket.on('join-ticket', (ticketId) => {
        socket.join(`ticket_${ticketId}`);
        console.log(`📌 Присоединился к тикету ${ticketId}`);
    });
    
    socket.on('leave-ticket', (ticketId) => {
        socket.leave(`ticket_${ticketId}`);
    });
    
    socket.on('disconnect', () => {
        console.log('❌ WebSocket отключен');
    });
});

// ============ ЗАПУСК ============
const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`\n========================================`);
        console.log(`🚀 СЕРВЕР ЗАПУЩЕН`);
        console.log(`========================================`);
        console.log(`📱 http://localhost:${PORT}`);
        console.log(`👑 Админ: admin / admin123`);
        console.log(`💬 WebSocket чат активен`);
        console.log(`========================================\n`);
    });
}).catch(err => {
    console.error('Ошибка инициализации БД:', err);
    process.exit(1);
});