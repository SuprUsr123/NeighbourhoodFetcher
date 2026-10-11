#!/usr/bin/env node
/**
 * ReKindle Data Collector Server — Render + Neon edition (Node.js).
 *
 * The POST API is unchanged from rekindle_server.py:
 *
 *   POST /         body: [{"id": "...", "username": "..."}, ...]
 *                  resp: {"status": "ok", "users_added": N}
 *
 *   POST /avatars  body: [{"username": "...", "avatar": "data:image/png;base64,..."}, ...]
 *                  resp: {"status": "ok", "avatars_added": N}
 *
 *   - CORS is still wide open (Access-Control-Allow-Origin: *)
 *   - Users deduplicated by ID, avatars by username (first one wins)
 *   - Storage in PostgreSQL (Neon) instead of CSV files
 *
 * Additions (new endpoints, they don't affect the POST API above):
 *   GET  /                    -> avatar viewer page (viewer.html)
 *   GET  /avatars             -> JSON list of all avatars (used by the viewer)
 *   GET  /users               -> JSON list of all users
 *   GET  /export/users.csv    -> old-format CSV backup of users
 *   GET  /export/avatars.csv  -> old-format CSV backup of avatars
 *   GET  /health              -> 200 OK
 *
 * Environment variables:
 *   DATABASE_URL  (required)  Neon/PostgreSQL connection string
 *   PORT          (optional)  Render sets this automatically; defaults to 8765
 */

const path = require('path');
const express = require('express');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8765; // 8765 locally, same as before
const VIEWER_HTML = path.join(__dirname, 'index.html');

// --- CORS (same as the old server) ---
app.use((req, res, next) => {
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Secret');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end(); // preflight
    next();
});

// --- Parse raw bodies manually so we mirror the old server's exact errors ---
const rawBody = express.raw({ type: '*/*', limit: '64mb' });

function getJsonBody(req, res) {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (raw.length === 0) {
        res.status(400).json({ error: 'Empty request body' });
        return null;
    }
    try {
        return JSON.parse(raw.toString('utf8'));
    } catch {
        res.status(400).json({ error: 'Invalid JSON' });
        return null;
    }
}

// --- POST / -> add users (unchanged API) ---
app.post('/', rawBody, async (req, res) => {
    const data = getJsonBody(req, res);
    if (data === null) return;
    if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'Expected list of user objects' });
    }
    try {
        const result = await db.insertUsers(data);
        console.log(`[users] ${result.written} written, ` +
        `${result.replacedFromRtdb} replaced from RTDB, ` +
        `${result.skippedDefault} skipped (default usernames)`);
        res.json({ status: 'ok', users_added: result.written });   // <- API unchanged
    } catch (err) {
        console.error('Failed to store users:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- POST /avatars -> add avatars (unchanged API) ---
app.post('/avatars', rawBody, async (req, res) => {
    const data = getJsonBody(req, res);
    if (data === null) return;
    if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'Expected list of avatar objects' });
    }
    try {
        const added = await db.insertAvatars(data);
        res.json({ status: 'ok', avatars_added: added });
    } catch (err) {
        console.error('Failed to store avatars:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- GET / -> serve the avatar viewer ---
app.get('/', (req, res) => res.sendFile(VIEWER_HTML));

// --- Everything below is additive; the POST API above is untouched ---

// GET /avatars -> JSON list (used by the viewer's "Load from server" button)
app.get('/avatars', async (req, res) => {
    try {
        res.json(await db.listAvatars());
    } catch (err) {
        console.error('Failed to list avatars:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/users', async (req, res) => {
    try {
        res.json(await db.listUsers());
    } catch (err) {
        console.error('Failed to list users:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- POST /auth -> the scraper script supplies Firebase session tokens ---
// The userscript runs on rekindle.ink while you're logged in and forwards
// its tokens here, so the server never needs your password.
app.post('/auth', rawBody, (req, res) => {
    const secret = process.env.AUTH_SECRET;
    if (secret && req.get('X-Auth-Secret') !== secret) {
        return res.status(401).json({ error: 'Bad or missing X-Auth-Secret' });
    }
    const data = getJsonBody(req, res);
    if (data === null) return;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ error: 'Expected a token object' });
    }
    const updated = rtdb.submitTokens(data);
    console.log(`[auth] tokens from scraper: ${updated.join(', ') || 'nothing recognized'}`);
    res.json({ status: 'ok', updated, tokens: rtdb.tokenStatus() });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

// CSV exports in the exact old format (every field quoted, quotes doubled)
const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

function csvResponse(res, header, rows, filename) {
    const lines = [header.map(csvEscape).join(',')];
    for (const row of rows) lines.push(row.map(csvEscape).join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n') + '\n');
}

app.get('/export/users.csv', async (req, res) => {
    try {
        const users = await db.listUsers();
        csvResponse(res, ['Username', 'ID'],
                    users.map((u) => [u.username, u.id]),
                    'rekindle_users_backup.csv');
    } catch (err) {
        console.error('Export users failed:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/export/avatars.csv', async (req, res) => {
    try {
        const avatars = await db.listAvatars();
        csvResponse(res, ['Username', 'AvatarBase64'],
                    avatars.map((a) => [a.username, a.avatar]),
                    'rekindle_avatars_backup.csv');
    } catch (err) {
        console.error('Export avatars failed:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// Match the old server's 404 message for anything unknown
app.use((req, res) => res.status(404).json({ error: "Not found. Use '/' or '/avatars'" }));

// --- Start: create tables first, then listen ---
db.initDb()
.then(() => {
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 ReKindle Server (Node + Neon) running on http://0.0.0.0:${PORT}`);
        console.log("   📌 POST '/'        → add users (ID + username)");
        console.log("   📌 POST '/avatars' → add avatars (username + base64)");
        console.log("   🌐 GET  '/'        → avatar viewer");
        console.log(`   🔥 RTDB username sync: ${rtdb.isAvailable() ? 'enabled' : 'disabled'}`);
    });
    // Render sends SIGTERM on deploys/restarts — shut down cleanly
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
})
.catch((err) => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
});
