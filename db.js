/**
 * Postgres (Neon) layer.
 *
 * Tables (created automatically):
 *   rekindle_users       (user_id PK, username, created_at)
 *   rekindle_avatars     (username PK, avatar, created_at)
 *   avatar_submissions   (community-drawn 16x16 pfps: pending -> published)
 *   avatar_votes         (one vote per (submission, voter))
 *
 * Users are keyed by UID; RTDB usernames replace stored ones; UID-prefix
 * default names are never stored; avatar rows follow username renames.
 * When a submission reaches the vote threshold, voteOnSubmission() promotes
 * it into rekindle_avatars inside the same transaction.
 */

const { Pool } = require('pg');
const rtdb = require('./rtdb');

const USERS_CHUNK = 500;
const AVATARS_CHUNK = 100;

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
    idleTimeoutMillis: 60000,
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
  // NEW: community-drawn avatar submissions + votes
  await withRetry(() => p.query(`
    CREATE TABLE IF NOT EXISTS avatar_submissions (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,          -- snapshot at submit time
      image       TEXT NOT NULL,          -- data:image/png;base64 (16x16)
      grid        JSONB NOT NULL,         -- 256 hex colors, for provenance
      artist      TEXT NOT NULL DEFAULT '',
      submitter   TEXT NOT NULL DEFAULT '',  -- voter id of the artist
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending | published
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`));
  await withRetry(() => p.query(`
    CREATE TABLE IF NOT EXISTS avatar_votes (
      submission_id INTEGER NOT NULL
        REFERENCES avatar_submissions(id) ON DELETE CASCADE,
      voter        TEXT NOT NULL,
      voted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (submission_id, voter)
    )`));
}

// ---------------------------------------------------------------------------
// Users (RTDB replacement + default-name filtering)
// ---------------------------------------------------------------------------

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

async function insertUsers(rows) {
  const incoming = new Map(); // last-one-wins within a batch
  for (const row of rows) {
    const uid = String(row?.user_id ?? row?.id ?? '').trim();
    const name = String(row?.username ?? '').trim();
    if (uid && name) incoming.set(uid, name);
  }
  if (incoming.size === 0) {
    return { written: 0, skippedDefault: 0, replacedFromRtdb: 0 };
  }

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
      skippedDefault++;
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
      const uidList = batch.map(([uid]) => uid);
      const oldRows = await client.query(
        'SELECT user_id, username FROM rekindle_users WHERE user_id = ANY($1)', [uidList]);
      const oldNames = new Map(oldRows.rows.map((r) => [r.user_id, r.username]));

      for (let i = 0; i < batch.length; i += USERS_CHUNK) {
        const chunk = batch.slice(i, i + USERS_CHUNK);
        const { sql, values } = buildUserUpsert(chunk);
        const res = await client.query(sql, values);
        written += res.rowCount ?? 0;
      }

      // avatar rows follow username renames (skip if new name already has one)
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

async function listUsers() {
  const { rows } = await withRetry(() =>
    getPool().query('SELECT username, user_id AS id FROM rekindle_users ORDER BY username'));
  return rows;
}

// ---------------------------------------------------------------------------
// Avatars (scraped: dedupe by username, first one wins)
// ---------------------------------------------------------------------------

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

async function listAvatars() {
  const { rows } = await withRetry(() =>
    getPool().query('SELECT username, avatar FROM rekindle_avatars ORDER BY username'));
  return rows;
}

// ---------------------------------------------------------------------------
// Background sync (RTDB -> DB), used by the scheduler and POST /admin/sync
// ---------------------------------------------------------------------------

async function syncUsernames() {
  const users = await listUsers();
  const rtdbMap = await rtdb.getUsernames(true); // fresh fetch
  if (!rtdbMap) throw new Error('RTDB auth not available');

  const targets = [];
  let stillDefault = 0;
  for (const u of users) {
    const name = rtdbMap.get(u.id);
    const fixable = typeof name === 'string' && !rtdb.looksLikeDefaultName(u.id, name);
    const isJunk = rtdb.looksLikeDefaultName(u.id, u.username);
    if (isJunk && !fixable) stillDefault++;
    if (fixable && name !== u.username) {
      targets.push({ id: u.id, username: name });
    }
  }
  const result = targets.length ? await insertUsers(targets) : { written: 0 };
  return { users: users.length, updated: result.written, stillDefault };
}

// ---------------------------------------------------------------------------
// NEW: community avatar submissions (HELP WANTED)
// ---------------------------------------------------------------------------

/** Users that have no pfp, with their pending submission count. */
async function listMissingAvatarUsers() {
  const { rows } = await withRetry(() => getPool().query(`
    SELECT u.user_id AS id, u.username, COALESCE(p.pending, 0) AS pending
    FROM rekindle_users u
    LEFT JOIN rekindle_avatars a ON a.username = u.username
    LEFT JOIN (SELECT user_id, COUNT(*) AS pending
               FROM avatar_submissions
               WHERE status = 'pending'
               GROUP BY user_id) p ON p.user_id = u.user_id
    WHERE a.username IS NULL
    ORDER BY u.username`));
  return rows.map((r) => Object.assign(r, { pending: parseInt(r.pending, 10) }));
}

/** Pending submissions, annotated for one voter (voted / own). */
async function listSubmissions(voter) {
  const { rows } = await withRetry(() => getPool().query(
    `SELECT s.id, s.user_id AS "userId", s.username, s.image, s.artist, s.status,
            (SELECT COUNT(*) FROM avatar_votes v WHERE v.submission_id = s.id) AS votes,
            EXISTS (SELECT 1 FROM avatar_votes v
                    WHERE v.submission_id = s.id AND v.voter = $1) AS voted,
            (s.submitter = $1 AND s.submitter <> '') AS own
     FROM avatar_submissions s
     WHERE s.status = 'pending'
     ORDER BY s.created_at DESC
     LIMIT 200`, [String(voter || '')]));
  return rows.map((r) => Object.assign(r, { votes: parseInt(r.votes, 10) }));
}

/**
 * Create a pending submission. Returns null when the target user does not
 * exist in the database ("the database has it" rule).
 */
async function createSubmission(userId, image, grid, artist, submitter) {
  const user = await withRetry(() =>
    getPool().query('SELECT username FROM rekindle_users WHERE user_id = $1', [userId]));
  if (!user.rowCount) return null;
  const username = user.rows[0].username;
  const res = await withRetry(() => getPool().query(
    `INSERT INTO avatar_submissions (user_id, username, image, grid, artist, submitter)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING id, username`,
    [userId, username, image, JSON.stringify(grid), artist, submitter]));
  return res.rows[0];
}

/**
 * Cast a vote; when the threshold is reached, promote the drawing into
 * rekindle_avatars (making it the user's live pfp) in the same transaction.
 */
async function voteOnSubmission(id, voter, threshold) {
  if (!id || !voter) return { ok: false, message: 'missing id or voter' };
  return withRetry(async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const sub = await client.query(
        `SELECT id, username, image, status, submitter
           FROM avatar_submissions WHERE id = $1 FOR UPDATE`, [id]);
      if (sub.rowCount === 0) {
        await client.query('ROLLBACK');
        return { ok: false, code: 404, message: 'Submission not found' };
      }
      const row = sub.rows[0];
      if (row.status !== 'pending') {
        await client.query('ROLLBACK');
        return { ok: false, message: 'This submission is already published' };
      }
      if (row.submitter && row.submitter === voter) {
        await client.query('ROLLBACK');
        return { ok: false, message: 'You cannot vote for your own submission' };
      }
      const ins = await client.query(
        `INSERT INTO avatar_votes (submission_id, voter) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`, [id, voter]);
      const cnt = await client.query(
        `SELECT COUNT(*) AS c FROM avatar_votes WHERE submission_id = $1`, [id]);
      const votes = parseInt(cnt.rows[0].c, 10);
      if ((ins.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return { ok: true, votes: votes, changed: false, published: false,
                 message: 'You already voted for this one' };
      }

      let published = false;
      if (votes >= threshold) {
        // PUBLISH: the voted drawing becomes the user's pfp in the database
        await client.query(
          `INSERT INTO rekindle_avatars (username, avatar) VALUES ($1, $2)
           ON CONFLICT (username) DO UPDATE SET avatar = EXCLUDED.avatar`,
          [row.username, row.image]);
        await client.query(
          `UPDATE avatar_submissions SET status = 'published' WHERE id = $1`, [id]);
        published = true;
      }

      await client.query('COMMIT');
      return { ok: true, votes: votes, changed: true, published: published };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  });
}

async function end() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initDb, insertUsers, insertAvatars, deleteUsers, syncUsernames,
  listMissingAvatarUsers, listSubmissions, createSubmission, voteOnSubmission,
  listUsers, listAvatars, end, getPool,
};
