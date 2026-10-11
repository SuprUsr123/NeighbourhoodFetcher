#!/usr/bin/env node
/**
 * One-off repair: finds stored users whose username contains the first 8
 * chars of their UID (auto-generated default names) and replaces them with
 * the real username from the Firebase RTDB.
 *
 *   node repair-usernames.js             # fix default-named users only
 *   node repair-usernames.js --resync    # also refresh EVERY username from the RTDB
 *   node repair-usernames.js --prune     # also delete default-named users
 *                                        # that have no RTDB entry
 */

const { parseArgs } = require('util');   // (yes, with the `values` destructure this time)
const db = require('./db');
const rtdb = require('./rtdb');

async function main() {
    const { values: args } = parseArgs({
        options: {
            resync: { type: 'boolean' },
            prune: { type: 'boolean' },
        },
    });

    if (!rtdb.isAvailable()) {
        console.error('RTDB not configured — set FIREBASE_DATABASE_URL and ' +
        'FIREBASE_SERVICE_ACCOUNT (or FIREBASE_SERVICE_ACCOUNT_PATH).');
        process.exitCode = 1;
        return;
    }

    await db.initDb();
    const users = await db.listUsers();
    const current = new Map(users.map((u) => [u.id, u.username]));
    const rtdbMap = await rtdb.getUsernames(true); // fresh fetch

    const junk = users.filter((u) => rtdb.looksLikeDefaultName(u.id, u.username));
    console.log(`Found ${junk.length} default-named user(s) out of ${users.length}.`);

    const fixable = junk.filter((u) => {
        const name = rtdbMap.get(u.id);
        return typeof name === 'string' && !rtdb.looksLikeDefaultName(u.id, name);
    });
    const fixableIds = new Set(fixable.map((u) => u.id));
    const unfixable = junk.filter((u) => !fixableIds.has(u.id));

    let targets = fixable.map((u) => ({ id: u.id, username: rtdbMap.get(u.id) }));

    if (args.resync) {
        const renamed = users
        .filter((u) => !rtdb.looksLikeDefaultName(u.id, u.username))
        .filter((u) => {
            const name = rtdbMap.get(u.id);
            return typeof name === 'string' && name !== current.get(u.id) &&
            !rtdb.looksLikeDefaultName(u.id, name);
        })
        .map((u) => ({ id: u.id, username: rtdbMap.get(u.id) }));
        targets = targets.concat(renamed);
    }

    if (targets.length) {
        const result = await db.insertUsers(targets);
        console.log(`🔧 replaced ${result.written} username(s) from the RTDB`);
    } else {
        console.log('Nothing to replace.');
    }

    if (args.prune && unfixable.length) {
        const deleted = await db.deleteUsers(unfixable.map((u) => u.id));
        console.log(`🧹 pruned ${deleted} user(s) with no real username in the RTDB`);
    } else if (unfixable.length) {
        console.log(`${unfixable.length} default-named user(s) have no RTDB entry — ` +
        `left untouched (use --prune to delete them).`);
    }

    await db.end();
}

main().catch((err) => { console.error('❌', err.message); process.exitCode = 1; });
