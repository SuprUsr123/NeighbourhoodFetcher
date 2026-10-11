/**
 * Postgres (Neon) layer.
 *
 * Tables (created automatically):
 *   rekindle_users   (user_id PK, username, created_at)
 *   rekindle_avatars (username PK, avatar, created_at)
 *
 * Users are keyed by UID. Stored usernames get REPLACED when better data
 * arrives (RTDB wins, then fresh custom names); usernames containing the
 * first 8 chars of the UID (auto-generated defaults) are never stored.
 * When a username changes, the matching avatar row is renamed along with it.
 */

const { Pool } = require('pg');
const rtdb = require('./rtdb');

const USERS_CHUNK = 500;   // rows per INSERT statement
const AVATARS_CHUNK = 100; // avatars are big (base64), keep batches smaller

let pool = null;

function sslFor(url) {
    if (/sslmode=disable/i.test(url)) return false;
    if (!/sslmode=require/i.test(url) && /(^|@)(localhost|127\.0\.0\.1)(:|$)/.test(url)) return false;
    return { rejectUnauthorized: false };
}

function getPool() {
    if (pool) return pool;
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error(
            'DATABASE_URL is not set. Add your Neon connection string ' +
            '(postgresql://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require).'
        );
    }
    pool = new Pool({
        connectionString: url,
        ssl: sslFor(url),
                    max: 10,
                    connectionTimeoutMillis: 10000,
                    idleTimeoutMillis: 60000, // stay under Neon's 5-minute auto-suspend window
    });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
    return pool;
}

function isConnectionError(err) {
    if (!err) return false;
    const codes = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', '57P01', '57P02', '57P03'];
    if (err.code && codes.includes(err.code)) return true;
    const msg = String(err.message || '');
    return /connection terminated|connection ended|socket has ended|server closed|terminating connection/i.test(msg);
}

async function withRetry(fn, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isConnectionError(err)) throw err;
            await new Promise((r) => setTimeout(r, 250 * (i + 1)));
        }
    }
    throw lastErr;
}

async function initDb() {
    const p = getPool();
    await withRetry(() => p.query(`
    CREATE TABLE IF NOT EXISTS rekindle_users (
        user_id    TEXT PRIMARY KEY,
        username   TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`));
    await withRetry(() => p.query(`
    CREATE TABLE IF NOT EXISTS rekindle_avatars (
        username   TEXT PRIMARY KEY,
        avatar     TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`));
}

// --- avatars (dedupe by username, first one wins) ---

function buildInsert(table, columns, conflictColumn, rows) {
    const values = [];
    const tuples = rows.map((row) => {
        const start = values.length;
        row.forEach((v) => values.push(v));
        return `(${columns.map((_, i) => `$${start + i + 1}`).join(',')})`;
    }).join(',');
    const sql =
    `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples} ` +
    `ON CONFLICT (${conflictColumn}) DO NOTHING`;
    return { sql, values };
}

async function insertMany(table, columns, conflictColumn, rows, chunkSize) {
    if (rows.length === 0) return 0;
    return withRetry(async () => {
        const client = await getPool().connect();
        let inserted = 0;
        try {
            await client.query('BEGIN');
            for (let i = 0; i < rows.length; i += chunkSize) {
                const chunk = rows.slice(i, i + chunkSize);
                const { sql, values } = buildInsert(table, columns, conflictColumn, chunk);
                const res = await client.query(sql, values);
                inserted += res.rowCount ?? 0;
            }
            await client.query('COMMIT');
            return inserted;
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            throw err;
        } finally {
            client.release();
        }
    });
}

async function insertAvatars(rows) {
    const clean = new Map(); // first one wins
    for (const row of rows) {
        const username = String(row?.username ?? '').trim();
        const avatar = String(row?.avatar ?? '').trim();
        if (username && avatar && !clean.has(username)) clean.set(username, [username, avatar]);
    }
    return insertMany('rekindle_avatars', ['username', 'avatar'], 'username',
                      [...clean.values()], AVATARS_CHUNK);
}

// --- users (RTDB replacement + default-name filtering) ---

function buildUserUpsert(rows) {
    const values = [];
    const tuples = rows.map(([uid, name]) => {
        values.push(uid, name);
        const b = values.length;
        return `($${b - 1},$${b})`;
    }).join(',');
    const sql =
    `INSERT INTO rekindle_users (user_id, username) VALUES ${tuples} ` +
    `ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username`;
    return { sql, values };
}

/**
 * rows: array of objects with 'id'/'user_id' and 'username'.
 * Returns { written, skippedDefault, replacedFromRtdb }.
 */
async function insertUsers(rows) {
    // normalize + last-one-wins within a batch
    const incoming = new Map();
    for (const row of rows) {
        const uid = String(row?.user_id ?? row?.id ?? '').trim();
        const name = String(row?.username ?? '').trim();
        if (uid && name) incoming.set(uid, name);
    }
    if (incoming.size === 0) {
        return { written: 0, skippedDefault: 0, replacedFromRtdb: 0 };
    }

    // RTDB index (null if unavailable); failure must not break the POST
    let rtdbMap = null;
    try {
        rtdbMap = await rtdb.getUsernames();
    } catch (err) {
        console.error('[rtdb] lookup failed, continuing without it:', err.message);
    }

    const toStore = new Map();
    let skippedDefault = 0;
    let replacedFromRtdb = 0;

    for (const [uid, name] of incoming) {
        const rtdbName = rtdbMap ? rtdbMap.get(uid) : undefined;
        if (typeof rtdbName === 'string' && !rtdb.looksLikeDefaultName(uid, rtdbName)) {
            if (rtdbName !== name) replacedFromRtdb++;
            toStore.set(uid, rtdbName);
        } else if (!rtdb.looksLikeDefaultName(uid, name)) {
            toStore.set(uid, name);
        } else {
            skippedDefault++; // default-looking name, nothing better — never store it
        }
    }

    if (toStore.size === 0) {
        return { written: 0, skippedDefault, replacedFromRtdb };
    }
    const batch = [...toStore.entries()];

    return withRetry(async () => {
        const client = await getPool().connect();
        let written = 0;
        try {
            await client.query('BEGIN');

            // current usernames, so avatar rows can follow renames
            const uidList = batch.map(([uid]) => uid);
            const oldRows = await client.query(
                'SELECT user_id, username FROM rekindle_users WHERE user_id = ANY($1)', [uidList]);
            const oldNames = new Map(oldRows.rows.map((r) => [r.user_id, r.username]));

            // upsert: on conflict REPLACE the stored username
            for (let i = 0; i < batch.length; i += USERS_CHUNK) {
                const chunk = batch.slice(i, i + USERS_CHUNK);
                const { sql, values } = buildUserUpsert(chunk);
                const res = await client.query(sql, values);
                written += res.rowCount ?? 0;
            }

            // rename avatar rows to follow username changes (skip if the new name
            // already has an avatar, to avoid PK collisions)
            for (const [uid, name] of batch) {
                const old = oldNames.get(uid);
                if (old && old !== name) {
                    await client.query(
                        `UPDATE rekindle_avatars SET username = $1
                        WHERE username = $2
                        AND NOT EXISTS (SELECT 1 FROM rekindle_avatars WHERE username = $1)`,
                                       [name, old]);
                }
            }

            await client.query('COMMIT');
            return { written, skippedDefault, replacedFromRtdb };
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            throw err;
        } finally {
            client.release();
        }
    });
}

async function deleteUsers(uidList) {
    if (!uidList || uidList.length === 0) return 0;
    const res = await withRetry(() =>
    getPool().query('DELETE FROM rekindle_users WHERE user_id = ANY($1)', [uidList]));
    return res.rowCount ?? 0;
}

/**
 * Full-database sweep: RTDB -> Postgres. Fixes default-named users where
 * the RTDB has a real name, and refreshes every other username from the
 * RTDB (catches renames). NEVER deletes anything — pruning stays a manual
 * decision (repair-usernames.js --prune). Returns { users, updated, stillDefault }.
 */
async function syncUsernames() {
  const users = await listUsers();
  const rtdbMap = await rtdb.getUsernames(true); // fresh fetch, no cache
  if (!rtdbMap) throw new Error('RTDB auth not available');

  const targets = [];
  let stillDefault = 0;
  for (const u of users) {
    const name = rtdbMap.get(u.id);
    const fixable = typeof name === 'string' && !rtdb.looksLikeDefaultName(u.id, name);
    const isJunk = rtdb.looksLikeDefaultName(u.id, u.username);
    if (isJunk && !fixable) stillDefault++;          // no real name exists anywhere
    if (fixable && name !== u.username) {
      targets.push({ id: u.id, username: name });    // avatar rows follow renames
    }
  }

  const result = targets.length ? await insertUsers(targets) : { written: 0 };
  return { users: users.length, updated: result.written, stillDefault };
}

async function listUsers() {
    const { rows } = await withRetry(() =>
    getPool().query('SELECT username, user_id AS id FROM rekindle_users ORDER BY username'));
    return rows;
}

async function listAvatars() {
    const { rows } = await withRetry(() =>
    getPool().query('SELECT username, avatar FROM rekindle_avatars ORDER BY username'));
    return rows;
}

async function end() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

module.exports = {
  initDb, insertUsers, insertAvatars, deleteUsers, syncUsernames,
  listUsers, listAvatars, end, getPool,
};
