const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('./voice_agent.db', (err) => {
    if (err) console.error('Database error:', err);
    else console.log('✅ Database connected');
});

// Initialize database tables
db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'student',
        daily_minutes INTEGER DEFAULT 60,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Usage tracking table
    db.run(`CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        date DATE NOT NULL,
        minutes_used REAL DEFAULT 0,
        messages_count INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(user_id, date)
    )`);

    // Settings table
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`);

    // Insert default settings
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('default_daily_minutes', '60')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('system_personality', 'Sei un assistente vocale educativo amichevole e professionale. Rispondi in modo MOLTO conciso e diretto, massimo 2-3 frasi brevi per risposta.')`);

    // Create super admin if not exists
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'admin@voiceagent.com';
    const superAdminPassword = bcrypt.hashSync(process.env.SUPER_ADMIN_PASSWORD || 'admin123', 10);
    
    db.run(`INSERT OR IGNORE INTO users (email, password, name, role, daily_minutes) 
            VALUES (?, ?, 'Super Admin', 'super_admin', 999999)`, 
            [superAdminEmail, superAdminPassword]);
});

// ============================================
// MIDDLEWARE
// ============================================

// Authentication middleware
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token mancante' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Token non valido' });
    }
};

// Admin only middleware
const requireAdmin = (req, res, next) => {
    if (!['admin', 'super_admin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Accesso negato' });
    }
    next();
};

// Super admin only middleware
const requireSuperAdmin = (req, res, next) => {
    if (req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Solo Super Admin' });
    }
    next();
};

// ============================================
// AUTH ENDPOINTS
// ============================================

// Register
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Dati mancanti' });
        }

        // Get default daily minutes
        const defaultMinutes = await new Promise((resolve, reject) => {
            db.get("SELECT value FROM settings WHERE key = 'default_daily_minutes'", (err, row) => {
                if (err) reject(err);
                else resolve(parseInt(row?.value || 60));
            });
        });

        const hashedPassword = await bcrypt.hash(password, 10);

        db.run(
            `INSERT INTO users (email, password, name, daily_minutes) VALUES (?, ?, ?, ?)`,
            [email, hashedPassword, name, defaultMinutes],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'Email già registrata' });
                    }
                    return res.status(500).json({ error: 'Errore registrazione' });
                }

                const token = jwt.sign(
                    { id: this.lastID, email, role: 'student' },
                    JWT_SECRET,
                    { expiresIn: '7d' }
                );

                res.json({
                    message: 'Registrazione completata',
                    token,
                    user: { id: this.lastID, email, name, role: 'student', daily_minutes: defaultMinutes }
                });
            }
        );
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Errore server' });
    }
});

// Login
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email e password richiesti' });
    }

    db.get(
        `SELECT * FROM users WHERE email = ? AND is_active = 1`,
        [email],
        async (err, user) => {
            if (err) return res.status(500).json({ error: 'Errore server' });
            if (!user) return res.status(401).json({ error: 'Credenziali non valide' });

            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) {
                return res.status(401).json({ error: 'Credenziali non valide' });
            }

            const token = jwt.sign(
                { id: user.id, email: user.email, role: user.role },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            res.json({
                message: 'Login effettuato',
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    daily_minutes: user.daily_minutes
                }
            });
        }
    );
});

// Get current user info
app.get('/api/auth/me', authenticate, (req, res) => {
    db.get(
        `SELECT id, email, name, role, daily_minutes, is_active FROM users WHERE id = ?`,
        [req.user.id],
        (err, user) => {
            if (err) return res.status(500).json({ error: 'Errore server' });
            if (!user) return res.status(404).json({ error: 'Utente non trovato' });
            res.json(user);
        }
    );
});

// ============================================
// CHAT ENDPOINT (con tracking)
// ============================================

app.post('/api/chat', authenticate, async (req, res) => {
    try {
        const { messages } = req.body;
        const userId = req.user.id;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Messages array is required' });
        }

        // Get today's date
        const today = new Date().toISOString().split('T')[0];

        // Get user's daily limit and today's usage
        const userStats = await new Promise((resolve, reject) => {
            db.get(`
                SELECT u.daily_minutes, COALESCE(us.minutes_used, 0) as used_today
                FROM users u
                LEFT JOIN usage us ON u.id = us.user_id AND us.date = ?
                WHERE u.id = ?
            `, [today, userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        // Check if user has exceeded daily limit
        if (userStats.used_today >= userStats.daily_minutes) {
            return res.status(429).json({ 
                error: 'Quota giornaliera esaurita',
                daily_limit: userStats.daily_minutes,
                used_today: userStats.used_today,
                remaining: 0
            });
        }

        // Get system personality
        const personality = await new Promise((resolve, reject) => {
            db.get("SELECT value FROM settings WHERE key = 'system_personality'", (err, row) => {
                if (err) reject(err);
                else resolve(row?.value || 'Sei un assistente amichevole.');
            });
        });

        // Call Claude API
        const startTime = Date.now();
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-3-5-haiku-20241022',
                max_tokens: 500,
                system: personality,
                messages: messages
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Anthropic API Error:', errorData);
            return res.status(response.status).json({
                error: errorData.error?.message || 'API request failed'
            });
        }

        const data = await response.json();
        const endTime = Date.now();
        
        // Estimate minutes used (based on response time and token count)
        // Rough estimate: 1 minute per 200 words spoken/read
        const tokensUsed = data.usage?.input_tokens + data.usage?.output_tokens || 0;
        const wordsEstimate = tokensUsed / 1.3; // ~1.3 tokens per word
        const minutesUsed = Math.max(0.1, wordsEstimate / 200); // Minimum 0.1 min per request

        // Update usage
        db.run(`
            INSERT INTO usage (user_id, date, minutes_used, messages_count)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(user_id, date) 
            DO UPDATE SET 
                minutes_used = minutes_used + ?,
                messages_count = messages_count + 1
        `, [userId, today, minutesUsed, minutesUsed]);

        // Return response with usage info
        res.json({
            ...data,
            usage_info: {
                minutes_used_now: minutesUsed,
                total_used_today: userStats.used_today + minutesUsed,
                daily_limit: userStats.daily_minutes,
                remaining: userStats.daily_minutes - (userStats.used_today + minutesUsed)
            }
        });

    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
});

// Get user's usage stats
app.get('/api/usage/me', authenticate, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const firstDayOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
        .toISOString().split('T')[0];

    db.all(`
        SELECT 
            date,
            minutes_used,
            messages_count
        FROM usage
        WHERE user_id = ? AND date >= ?
        ORDER BY date DESC
    `, [req.user.id, firstDayOfMonth], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Errore server' });

        const todayUsage = rows.find(r => r.date === today) || { minutes_used: 0, messages_count: 0 };
        const monthlyTotal = rows.reduce((sum, r) => sum + r.minutes_used, 0);

        db.get('SELECT daily_minutes FROM users WHERE id = ?', [req.user.id], (err, user) => {
            if (err) return res.status(500).json({ error: 'Errore server' });

            res.json({
                today: todayUsage,
                monthly_total: monthlyTotal,
                daily_limit: user.daily_minutes,
                remaining_today: Math.max(0, user.daily_minutes - todayUsage.minutes_used),
                history: rows
            });
        });
    });
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Get all users (admin)
app.get('/api/admin/users', authenticate, requireAdmin, (req, res) => {
    const today = new Date().toISOString().split('T')[0];

    db.all(`
        SELECT 
            u.id,
            u.email,
            u.name,
            u.role,
            u.daily_minutes,
            u.is_active,
            u.created_at,
            COALESCE(us.minutes_used, 0) as used_today,
            COALESCE(us.messages_count, 0) as messages_today
        FROM users u
        LEFT JOIN usage us ON u.id = us.user_id AND us.date = ?
        ORDER BY u.created_at DESC
    `, [today], (err, users) => {
        if (err) return res.status(500).json({ error: 'Errore server' });
        res.json(users);
    });
});

// Get user details (admin)
app.get('/api/admin/users/:id', authenticate, requireAdmin, (req, res) => {
    const userId = req.params.id;
    const firstDayOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
        .toISOString().split('T')[0];

    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err) return res.status(500).json({ error: 'Errore server' });
        if (!user) return res.status(404).json({ error: 'Utente non trovato' });

        db.all(`
            SELECT date, minutes_used, messages_count
            FROM usage
            WHERE user_id = ? AND date >= ?
            ORDER BY date DESC
        `, [userId, firstDayOfMonth], (err, usage) => {
            if (err) return res.status(500).json({ error: 'Errore server' });

            delete user.password;
            res.json({
                user,
                usage,
                monthly_total: usage.reduce((sum, u) => sum + u.minutes_used, 0)
            });
        });
    });
});

// Create user (admin)
app.post('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
    try {
        const { email, password, name, role, daily_minutes } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Dati mancanti' });
        }

        // Only super admin can create admin users
        if (role && ['admin', 'super_admin'].includes(role) && req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Solo Super Admin può creare admin' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role || 'student';
        const minutes = daily_minutes || 60;

        db.run(
            `INSERT INTO users (email, password, name, role, daily_minutes) VALUES (?, ?, ?, ?, ?)`,
            [email, hashedPassword, name, userRole, minutes],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'Email già registrata' });
                    }
                    return res.status(500).json({ error: 'Errore creazione utente' });
                }

                res.json({
                    message: 'Utente creato',
                    user: { id: this.lastID, email, name, role: userRole, daily_minutes: minutes }
                });
            }
        );
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({ error: 'Errore server' });
    }
});

// Update user (admin)
app.put('/api/admin/users/:id', authenticate, requireAdmin, (req, res) => {
    const userId = req.params.id;
    const { name, daily_minutes, is_active, role } = req.body;

    // Only super admin can change roles
    if (role && req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Solo Super Admin può modificare ruoli' });
    }

    const updates = [];
    const values = [];

    if (name !== undefined) {
        updates.push('name = ?');
        values.push(name);
    }
    if (daily_minutes !== undefined) {
        updates.push('daily_minutes = ?');
        values.push(daily_minutes);
    }
    if (is_active !== undefined) {
        updates.push('is_active = ?');
        values.push(is_active ? 1 : 0);
    }
    if (role !== undefined && req.user.role === 'super_admin') {
        updates.push('role = ?');
        values.push(role);
    }

    if (updates.length === 0) {
        return res.status(400).json({ error: 'Nessun aggiornamento specificato' });
    }

    values.push(userId);

    db.run(
        `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
        values,
        function(err) {
            if (err) return res.status(500).json({ error: 'Errore aggiornamento' });
            if (this.changes === 0) return res.status(404).json({ error: 'Utente non trovato' });
            res.json({ message: 'Utente aggiornato' });
        }
    );
});

// Delete user (super admin only)
app.delete('/api/admin/users/:id', authenticate, requireSuperAdmin, (req, res) => {
    const userId = req.params.id;

    // Prevent deleting yourself
    if (userId == req.user.id) {
        return res.status(400).json({ error: 'Non puoi eliminare te stesso' });
    }

    db.run(`DELETE FROM users WHERE id = ?`, [userId], function(err) {
        if (err) return res.status(500).json({ error: 'Errore eliminazione' });
        if (this.changes === 0) return res.status(404).json({ error: 'Utente non trovato' });
        
        // Delete usage history
        db.run(`DELETE FROM usage WHERE user_id = ?`, [userId]);
        
        res.json({ message: 'Utente eliminato' });
    });
});

// Get system settings (admin)
app.get('/api/admin/settings', authenticate, requireAdmin, (req, res) => {
    db.all(`SELECT * FROM settings`, (err, settings) => {
        if (err) return res.status(500).json({ error: 'Errore server' });
        
        const settingsObj = {};
        settings.forEach(s => {
            settingsObj[s.key] = s.value;
        });
        
        res.json(settingsObj);
    });
});

// Update system settings (admin)
app.put('/api/admin/settings', authenticate, requireAdmin, (req, res) => {
    const { default_daily_minutes, system_personality } = req.body;

    const updates = [];
    if (default_daily_minutes !== undefined) {
        updates.push(
            new Promise((resolve, reject) => {
                db.run(
                    `UPDATE settings SET value = ? WHERE key = 'default_daily_minutes'`,
                    [default_daily_minutes],
                    err => err ? reject(err) : resolve()
                );
            })
        );
    }

    if (system_personality !== undefined) {
        updates.push(
            new Promise((resolve, reject) => {
                db.run(
                    `UPDATE settings SET value = ? WHERE key = 'system_personality'`,
                    [system_personality],
                    err => err ? reject(err) : resolve()
                );
            })
        );
    }

    Promise.all(updates)
        .then(() => res.json({ message: 'Impostazioni aggiornate' }))
        .catch(err => res.status(500).json({ error: 'Errore aggiornamento' }));
});

// Get statistics (admin)
app.get('/api/admin/stats', authenticate, requireAdmin, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const firstDayOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
        .toISOString().split('T')[0];

    Promise.all([
        // Total users
        new Promise((resolve, reject) => {
            db.get(`SELECT COUNT(*) as count FROM users WHERE role = 'student'`, (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        }),
        // Active today
        new Promise((resolve, reject) => {
            db.get(`SELECT COUNT(DISTINCT user_id) as count FROM usage WHERE date = ?`, [today], (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        }),
        // Total minutes today
        new Promise((resolve, reject) => {
            db.get(`SELECT SUM(minutes_used) as total FROM usage WHERE date = ?`, [today], (err, row) => {
                if (err) reject(err);
                else resolve(row.total || 0);
            });
        }),
        // Total minutes this month
        new Promise((resolve, reject) => {
            db.get(`SELECT SUM(minutes_used) as total FROM usage WHERE date >= ?`, [firstDayOfMonth], (err, row) => {
                if (err) reject(err);
                else resolve(row.total || 0);
            });
        })
    ])
    .then(([totalUsers, activeToday, minutesToday, minutesMonth]) => {
        res.json({
            total_users: totalUsers,
            active_today: activeToday,
            minutes_today: Math.round(minutesToday * 100) / 100,
            minutes_month: Math.round(minutesMonth * 100) / 100
        });
    })
    .catch(err => res.status(500).json({ error: 'Errore server' }));
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Voice Agent API with Auth is running',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 API endpoint: http://localhost:${PORT}/api/chat`);
    console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
    console.log(`👤 Super Admin: ${process.env.SUPER_ADMIN_EMAIL || 'admin@voiceagent.com'}`);
});
