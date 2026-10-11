#!/usr/bin/env node
/**
 * ReKindle Data Collector Server — Render + Neon edition (Node.js).
 *
 * Collector API (unchanged):
 *   POST /         -> add users        {"users_added": N}
 *   POST /avatars  -> add avatars      {"avatars_added": N} (new or CHANGED only)
 *
 * App + data endpoints:
 *   GET  /                     -> combined app (Directory / Gallery / Help Wanted)
 *   GET  /browse               -> redirects to /
 *   GET  /users                -> JSON list
 *   GET  /avatars              -> current pfps, JSON list
 *   GET  /avatars?asof=DATE    -> pfps as archived by end of that day (NEW)
 *   GET  /avatar-dates         -> capture days + counts, for the dropdown (NEW)
 *   GET  /missing-avatars      -> users without pfps
 *   GET/POST /submissions...   -> community drawings + voting
 *   POST /auth, /admin/sync    -> scraper tokens / forced RTDB sync
 *   GET  /export/*.csv         -> old-format backups (current pfps)
 *   GET  /health               -> 200 OK
 */

const path = require('path');
const express = require('express');
const db = require('./db');
const rtdb = require('./rtdb');

const app = express();
const PORT = process.env.PORT || 8765;
const INDEX_HTML = path.join(__dirname, 'index.html');
const VOTE_THRESHOLD = Math.max(1, parseInt(process.env.AVATAR_VOTE_THRESHOLD, 10) || 3);

app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Secret');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

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

// --- Collector API (unchanged) ---

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
        res.json({ status: 'ok', users_added: result.written });
    } catch (err) {
        console.error('Failed to store users:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

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

// --- App + reads ---

app.get('/', (req, res) => res.sendFile(INDEX_HTML));
app.get('/browse', (req, res) => res.redirect(302, '/'));

// CHANGED: optional ?asof=YYYY-MM-DD for the archive view
app.get('/avatars', async (req, res) => {
    try {
        const asof = String(req.query.asof || '');
        if (asof) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(asof)) {
                return res.status(400).json({ error: 'asof must be YYYY-MM-DD' });
            }
            return res.json(await db.listAvatarsAsOf(asof));
        }
        res.json(await db.listAvatars());
    } catch (err) {
        console.error('Failed to list avatars:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// NEW: capture days for the gallery dropdown
app.get('/avatar-dates', async (req, res) => {
    try {
        res.json(await db.listAvatarDates());
    } catch (err) {
        console.error('Failed to list avatar dates:', err.message);
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

// --- POST /auth -> scraper tokens ---

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

// --- Background + on-demand username sync ---

const SYNC_HOURS_RAW = parseFloat(process.env.RTDB_SYNC_HOURS);
const SYNC_HOURS = Number.isFinite(SYNC_HOURS_RAW) ? SYNC_HOURS_RAW : 6;
let syncInFlight = false;

async function runUserSync(trigger) {
    if (syncInFlight) return { skipped: 'already running' };
    if (!rtdb.isAvailable()) return { skipped: 'RTDB auth not available yet' };
    syncInFlight = true;
    try {
        const stats = await db.syncUsernames();
        console.log(`[sync:${trigger}] ${stats.users} user(s) checked — ` +
            `${stats.updated} username(s) updated, ${stats.stillDefault} still default-named`);
        return stats;
    } catch (err) {
        console.error(`[sync:${trigger}] failed:`, err.message);
        return { error: err.message };
    } finally {
        syncInFlight = false;
    }
}

app.post('/admin/sync', async (req, res) => {
    const secret = process.env.AUTH_SECRET;
    if (secret && req.get('X-Auth-Secret') !== secret) {
        return res.status(401).json({ error: 'Bad or missing X-Auth-Secret' });
    }
    res.json({ status: 'ok', trigger: 'manual', ...(await runUserSync('manual')) });
});

// --- Community avatar drawings ---

app.get('/missing-avatars', async (req, res) => {
    try {
        res.json(await db.listMissingAvatarUsers());
    } catch (err) {
        console.error('Failed to list missing avatars:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/submissions', async (req, res) => {
    try {
        const voter = String(req.query.voter || '').substring(0, 64);
        res.json({ status: 'ok', threshold: VOTE_THRESHOLD,
                   submissions: await db.listSubmissions(voter) });
    } catch (err) {
        console.error('Failed to list submissions:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/submissions', rawBody, async (req, res) => {
    const data = getJsonBody(req, res);
    if (data === null) return;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ error: 'Expected a submission object' });
    }
    const userId = String(data.user_id || '').trim();
    const image = String(data.image || '');
    const grid = Array.isArray(data.grid) ? data.grid : null;
    const artist = String(data.artist || '').trim().substring(0, 30);
    const voter = String(data.voter || '').trim().substring(0, 64);

    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    if (!image.startsWith('data:image/png;base64,') || image.length > 20000) {
        return res.status(400).json({ error: 'image must be a small PNG data URI' });
    }
    if (!grid || grid.length !== 256 ||
        !grid.every((c) => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c))) {
        return res.status(400).json({ error: 'grid must be an array of 256 hex colors' });
    }
    try {
        const created = await db.createSubmission(userId, image, grid, artist, voter);
        if (created === null) {
            return res.status(400).json({ error: 'User not found in the database' });
        }
        console.log(`[avatars] submission ${created.id} for ${created.username}` +
                    (artist ? ` by ${artist}` : ''));
        res.json({ status: 'ok', id: created.id, threshold: VOTE_THRESHOLD });
    } catch (err) {
        console.error('Failed to store submission:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/submissions/:id/vote', rawBody, async (req, res) => {
    const data = getJsonBody(req, res);
    if (data === null) return;
    const id = parseInt(req.params.id, 10);
    const voter = String((data && data.voter) || '').trim().substring(0, 64);
    if (!id || !voter) {
        return res.status(400).json({ error: 'voter is required' });
    }
    try {
        const r = await db.voteOnSubmission(id, voter, VOTE_THRESHOLD);
        if (!r.ok) {
            return res.status(r.code === 404 ? 404 : 400).json({ error: r.message });
        }
        if (r.published) {
            console.log(`[avatars] submission ${id} published (${r.votes} votes)`);
        }
        res.json({ status: 'ok', votes: r.votes, published: r.published,
                   message: r.message || null });
    } catch (err) {
        console.error('Failed to record vote:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- Exports, health, 404 ---

app.get('/health', (req, res) => res.status(200).send('OK'));

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

app.use((req, res) => res.status(404).json({ error: "Not found. Use '/' or '/avatars'" }));

// --- Start ---

db.initDb()
.then(() => {
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 ReKindle Server (Node + Neon) running on http://0.0.0.0:${PORT}`);
        console.log(`   📌 POST '/' and '/avatars'      → collector API (unchanged)`);
        console.log(`   🌐 GET  '/'                      → directory / gallery / help wanted`);
        console.log(`   🖼  Avatar archive: GET /avatar-dates, GET /avatars?asof=YYYY-MM-DD`);
        console.log(`   🎨 HELP WANTED: threshold ${VOTE_THRESHOLD} vote(s) to publish`);
        console.log(`   🔥 RTDB username sync: ${rtdb.isAvailable() ? 'enabled' : 'awaiting scraper tokens'}`);
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));

    if (SYNC_HOURS > 0) {
        setTimeout(() => runUserSync('startup'), 2 * 60 * 1000);
        setInterval(() => runUserSync('interval'), SYNC_HOURS * 3600 * 1000);
        console.log(`   🔄 Auto username sync: every ${SYNC_HOURS}h (POST /admin/sync to force)`);
    }
})
.catch((err) => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
});