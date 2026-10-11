#!/usr/bin/env node
/**
 * Import your old ReKindle CSV backups into the Neon/PostgreSQL database.
 *
 * Usage (run from the project folder):
 *
 *   export DATABASE_URL="postgresql://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require"
 *   node import-csv.js --users   ~/Downloads/rekindle_users_backup.csv
 *   node import-csv.js --avatars ~/Downloads/rekindle_avatars_backup.csv
 *
 * Or both at once. Pass --db <url> instead of the env var if you prefer.
 *
 * Safe to re-run: rows that already exist (same user ID / same avatar
 * username) are skipped, exactly like the old server did when appending
 * to the CSVs.
 */

const fs = require('fs');
const { parseArgs } = require('util');
const db = require('./db');

// Minimal RFC-4180-style CSV parser: handles quoted fields, doubled quotes,
// and commas/newlines inside quotes.
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    const endRow = () => {
        row.push(field);
        field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row); // skip blank lines
        row = [];
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote ("")
                else inQuotes = false;
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            row.push(field);
            field = '';
        } else if (ch === '\n') {
            endRow();
        } else if (ch !== '\r') {
            field += ch;
        }
    }
    if (field !== '' || row.length > 0) endRow(); // file without trailing newline
    return rows;
}

function looksLikeHeader(row) {
    return row.length > 0 && row[0].trim().toLowerCase() === 'username';
}

function readUsersCsv(file) {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); // strip BOM
    const rows = [];
    parseCsv(text).forEach((row, i) => {
        if (i === 0 && looksLikeHeader(row)) return;
        if (row.length < 2) return;
        const username = row[0].trim();
        const userId = row[row.length - 1].trim(); // ID is the last column (same rule as before)
    if (username && userId) rows.push({ user_id: userId, username });
    });
    return rows;
}

function readAvatarsCsv(file) {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const rows = [];
    parseCsv(text).forEach((row, i) => {
        if (i === 0 && looksLikeHeader(row)) return;
        if (row.length < 2) return;
        const username = row[0].trim();
        // base64 avatars contain commas; rejoin everything after column 1
        const avatar = row.slice(1).map((part) => part.trim()).join(',');
        if (username && avatar) rows.push({ username, avatar });
    });
    return rows;
}

async function main() {
    const { values: args } = parseArgs({
        options: {
            users: { type: 'string' },
            avatars: { type: 'string' },
            db: { type: 'string' },
        },
    });

    if (args.db) process.env.DATABASE_URL = args.db;

    if (!args.users && !args.avatars) {
        console.error('nothing to do — pass --users and/or --avatars');
        process.exitCode = 1;
        return;
    }

    await db.initDb();

    if (args.users) {
        const rows = readUsersCsv(args.users);
        const result = await db.insertUsers(rows);
        console.log(`👥 users   : ${rows.length} read, ${result.written} stored/updated, ` +
        `${result.replacedFromRtdb} replaced from RTDB, ` +
        `${result.skippedDefault} skipped (default usernames)`);
    }

    if (args.avatars) {
        const rows = readAvatarsCsv(args.avatars);
        const added = await db.insertAvatars(rows);
        console.log(`🖼️  avatars: ${rows.length} read, ${added} inserted, ` +
        `${rows.length - added} duplicates skipped`);
    }

    console.log('✅ done');
}

main()
.catch((err) => {
    console.error('❌ import failed:', err.message);
    process.exitCode = 1;
})
.finally(() => db.end());
