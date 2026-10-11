/**
 * Firebase RTDB integration — source of truth for real usernames.
 *
 * AUTH, in order of preference:
 *   1. ID tokens submitted by the scraper (POST /auth) — valid ~1h
 *   2. Refresh tokens (from the scraper's localStorage entries, or env
 *      REKINDLE_MAIN_REFRESH) -> securetoken.googleapis.com
 *   3. Standing account: REKINDLE_EMAIL + REKINDLE_PASSWORD env vars
 *      (ilovekindle@rekindle.ink, the public service account)
 * A MAIN token alone is enough — the SOCIAL token gets minted via the
 * getSocialToken callable (same flow as the C++ client).
 *
 * All requests are spoofed as rekindle.ink (Origin/Referer/UA) — the API
 * key is referrer-restricted to rekindle.ink, so the Referer header is
 * mandatory for identitytoolkit calls.
 *
 * RTDB reads append ?auth=<token>: user_cards with the MAIN token,
 * users_public with the SOCIAL token. user_cards wins on conflicts,
 * mirroring rk::Client::username().
 *
 * Env vars: REKINDLE_EMAIL, REKINDLE_PASSWORD, REKINDLE_MAIN_REFRESH,
 * REKINDLE_SOCIAL_REFRESH, REKINDLE_CONFIG, RTDB_ORIGIN, RTDB_DISABLE,
 * RTDB_CARDS_PATH, RTDB_PUBLIC_PATH, RTDB_USERNAME_FIELD.
 */

const fs = require('fs');
const path = require('path');

const trimSlash = (s) => String(s || '').replace(/^\/+|\/+$/g, '');

// ---------------------------------------------------------------------------
// Configuration: rekindle-config.json, with built-in fallbacks
// ---------------------------------------------------------------------------

const CFG = {
    mainApiBase: 'https://us-central1-rekindle-dd1fa.cloudfunctions.net',
    mainRtdb: 'https://rekindle-dd1fa-default-rtdb.firebaseio.com',
    socialRtdb: 'https://rekindle-socials-default-rtdb.firebaseio.com',
    mainApiKey: '',
    socialApiKey: '',
};
let CONFIG_SOURCE = 'built-in defaults';

for (const p of [
    process.env.REKINDLE_CONFIG,
     path.join(__dirname, 'rekindle-config.json'),
     path.join(__dirname, '..', 'rekindle-config.json'),
].filter(Boolean)) {
    try {
        if (!fs.existsSync(p)) continue;
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (c.mainApiBase) CFG.mainApiBase = trimSlash(c.mainApiBase);
        if (c.firebase?.main?.databaseUrl) CFG.mainRtdb = trimSlash(c.firebase.main.databaseUrl);
        if (c.rtdbBase || c.firebase?.social?.databaseUrl) {
            CFG.socialRtdb = trimSlash(c.rtdbBase || c.firebase.social.databaseUrl);
        }
        if (c.firebase?.main?.apiKey) CFG.mainApiKey = c.firebase.main.apiKey;
        if (c.firebase?.social?.apiKey) CFG.socialApiKey = c.firebase.social.apiKey;
        CONFIG_SOURCE = p;
        break;
    } catch (err) {
        console.error(`[rtdb] could not parse ${p}:`, err.message);
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const EMAIL = process.env.REKINDLE_EMAIL || '';
const PASSWORD = process.env.REKINDLE_PASSWORD || '';
const ORIGIN = process.env.RTDB_ORIGIN || 'https://rekindle.ink';
const DISABLED = /^(1|true|yes)$/i.test(process.env.RTDB_DISABLE || '');
const CARDS_PATH = trimSlash(process.env.RTDB_CARDS_PATH || 'user_cards');
const PUBLIC_PATH = trimSlash(process.env.RTDB_PUBLIC_PATH || 'users_public');
const USERNAME_FIELD = process.env.RTDB_USERNAME_FIELD || 'username';

const CACHE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;
const AUTH_FAILURE_BACKOFF_MS = 30 * 1000;

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts:';
const SECURE_TOKEN = 'https://securetoken.googleapis.com/v1/token?key=';

const SPOOFED_HEADERS = {
    'Origin': ORIGIN,
    'Referer': `${ORIGIN}/`,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
};

const auth = {
    mainToken: null,
    mainRefresh: process.env.REKINDLE_MAIN_REFRESH || null,
    mainExp: 0,
    socialToken: null,
    socialRefresh: process.env.REKINDLE_SOCIAL_REFRESH || null,
    socialExp: 0,
    signingIn: null, // single-flight guard
};
let lastAuthFailure = { at: 0, err: null };
let cache = null;    // { map: Map<uid, username>, fetchedAt }
let announced = false;

// ---------------------------------------------------------------------------
// Token intake (called by the POST /auth route in server.js)
// ---------------------------------------------------------------------------

function jwtExp(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
        return (payload.exp || 0) * 1000;
    } catch {
        return 0;
    }
}

/**
 * Accepts { mainToken?, socialToken?, mainRefresh?, socialRefresh?,
 * authEntries?: [{ key, value }] } — the shape the userscript sends.
 * Returns the list of things it recognized.
 */
function submitTokens(p = {}) {
    const updated = [];

    if (typeof p.mainToken === 'string' && p.mainToken.length > 50) {
        auth.mainToken = p.mainToken;
        auth.mainExp = jwtExp(p.mainToken) || Date.now() + 55 * 60 * 1000;
        updated.push('main');
    }
    if (typeof p.socialToken === 'string' && p.socialToken.length > 50) {
        auth.socialToken = p.socialToken;
        auth.socialExp = jwtExp(p.socialToken) || Date.now() + 55 * 60 * 1000;
        updated.push('social');
    }

    const explicitMain = typeof p.mainRefresh === 'string' && p.mainRefresh.length > 20;
    const explicitSocial = typeof p.socialRefresh === 'string' && p.socialRefresh.length > 20;
    if (explicitMain) { auth.mainRefresh = p.mainRefresh; updated.push('main-refresh'); }
    if (explicitSocial) { auth.socialRefresh = p.socialRefresh; updated.push('social-refresh'); }

    // localStorage entries: firebase:authUser:<apiKey>:[...] -> { stsRefreshToken, ... }
    if (Array.isArray(p.authEntries)) {
        for (const e of p.authEntries) {
            try {
                const data = JSON.parse(e && e.value);
                const rt = data && data.stsRefreshToken;
                if (!rt || !e.key) continue;
                if (!explicitMain && CFG.mainApiKey && e.key.includes(CFG.mainApiKey)) {
                    auth.mainRefresh = rt;
                    updated.push('main-refresh');
                } else if (!explicitSocial && CFG.socialApiKey && e.key.includes(CFG.socialApiKey)) {
                    auth.socialRefresh = rt;
                    updated.push('social-refresh');
                }
            } catch (_) { /* skip malformed entry */ }
        }
    }

    lastAuthFailure = { at: 0, err: null }; // fresh tokens reset the backoff
    return updated;
}

function tokenStatus() {
    const now = Date.now();
    return {
        main: Boolean(auth.mainToken && now < auth.mainExp),
        social: Boolean(auth.socialToken && now < auth.socialExp),
        mainRefresh: Boolean(auth.mainRefresh),
        socialRefresh: Boolean(auth.socialRefresh),
    };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

function hasAuthSource() {
    return Boolean(
        (auth.mainToken && Date.now() < auth.mainExp) ||
        auth.mainRefresh ||
        (EMAIL && PASSWORD)
    );
}

function isAvailable() {
    const ok = !DISABLED && CFG.mainApiKey && CFG.socialApiKey && hasAuthSource();
    if (!announced) {
        announced = true;
        if (DISABLED) console.log('[rtdb] disabled via RTDB_DISABLE');
        else if (!CFG.mainApiKey || !CFG.socialApiKey) {
            console.log(`[rtdb] disabled — firebase apiKeys missing (${CONFIG_SOURCE})`);
        } else {
            console.log(`[rtdb] config from ${CONFIG_SOURCE}; ` +
            `${hasAuthSource() ? 'auth ready' : 'waiting for scraper tokens (POST /auth)'}`);
        }
    }
    return ok;
}

// ---------------------------------------------------------------------------
// Auth plumbing
// ---------------------------------------------------------------------------

async function postJson(url, body, extraHeaders = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Referer': `${ORIGIN}/`, ...extraHeaders },
        body: JSON.stringify(body),
                            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
        const msg = parsed?.error?.message || parsed?.message || `HTTP ${res.status}`;
        const err = new Error(`${url.split('?')[0]} -> ${msg}`);
        err.status = res.status;
        throw err;
    }
    return parsed;
}

function expiry(seconds) {
    const s = parseInt(seconds, 10) || 3600;
    return Date.now() + Math.max(60, s - 120) * 1000;
}

async function signInMain() {
    if (!CFG.mainApiKey) throw new Error('main apiKey missing in rekindle-config.json');
    if (!EMAIL || !PASSWORD) {
        throw new Error('REKINDLE_EMAIL / REKINDLE_PASSWORD not set');
    }
    const r = await postJson(`${IDENTITY}signInWithPassword?key=${CFG.mainApiKey}`, {
        email: EMAIL, password: PASSWORD, returnSecureToken: true,
    });
    auth.mainToken = r.idToken;
    if (r.refreshToken) auth.mainRefresh = r.refreshToken;
    auth.mainExp = expiry(r.expiresIn);
    console.log('[rtdb] signed in to the main project (env credentials)');
}

async function refreshMain() {
    const r = await postJson(`${SECURE_TOKEN}${CFG.mainApiKey}`, {
        grant_type: 'refresh_token', refresh_token: auth.mainRefresh,
    });
    auth.mainToken = r.id_token;
    if (r.refresh_token) auth.mainRefresh = r.refresh_token;
    auth.mainExp = expiry(r.expires_in);
}

async function signInSocial() {
    if (!CFG.socialApiKey) throw new Error('social apiKey missing in rekindle-config.json');
    if (!auth.mainToken) throw new Error('need a valid main token before social sign-in');
    // callable getSocialToken — same request shape the C++ client sends
    const res = await postJson(`${CFG.mainApiBase}/getSocialToken`, { data: {} }, {
        Authorization: `Bearer ${auth.mainToken}`,
    });
    const custom = res?.result?.token ?? res?.token;
    if (!custom) throw new Error('getSocialToken returned no token');
    const r = await postJson(`${IDENTITY}signInWithCustomToken?key=${CFG.socialApiKey}`, {
        token: custom, returnSecureToken: true,
    });
    auth.socialToken = r.idToken;
    if (r.refreshToken) auth.socialRefresh = r.refreshToken;
    auth.socialExp = expiry(r.expiresIn);
    console.log('[rtdb] minted the social token via getSocialToken');
}

async function refreshSocial() {
    const r = await postJson(`${SECURE_TOKEN}${CFG.socialApiKey}`, {
        grant_type: 'refresh_token', refresh_token: auth.socialRefresh,
    });
    auth.socialToken = r.id_token;
    if (r.refresh_token) auth.socialRefresh = r.refresh_token;
    auth.socialExp = expiry(r.expires_in);
}

async function ensureAuth(force = false) {
    if (!force && auth.mainToken && Date.now() < auth.mainExp &&
        auth.socialToken && Date.now() < auth.socialExp) {
        return;
        }
        if (auth.signingIn) return auth.signingIn; // one sign-in at a time
        if (lastAuthFailure.err &&
            Date.now() - lastAuthFailure.at < AUTH_FAILURE_BACKOFF_MS) {
            throw lastAuthFailure.err; // creds are bad — back off
            }

            if (force) { auth.mainToken = null; auth.socialToken = null; }

            auth.signingIn = (async () => {
                try {
                    // 1. MAIN token: submitted token > refresh > env password
                    if (!auth.mainToken || Date.now() >= auth.mainExp) {
                        if (auth.mainRefresh) {
                            try { await refreshMain(); } catch (err) {
                                console.error('[rtdb] main token refresh failed:', err.message);
                                auth.mainRefresh = null;
                            }
                        }
                        if ((!auth.mainToken || Date.now() >= auth.mainExp) && EMAIL && PASSWORD) {
                            await signInMain();
                        }
                        if (!auth.mainToken || Date.now() >= auth.mainExp) {
                            throw new Error('no valid main token — waiting for scraper tokens ' +
                            '(POST /auth) or REKINDLE_EMAIL/PASSWORD');
                        }
                    }
                    // 2. SOCIAL token: submitted/refreshed > custom-token flow via callable
                    if (!auth.socialToken || Date.now() >= auth.socialExp) {
                        if (auth.socialRefresh) {
                            try { await refreshSocial(); } catch (err) {
                                console.error('[rtdb] social token refresh failed:', err.message);
                                auth.socialRefresh = null;
                            }
                        }
                        if (!auth.socialToken || Date.now() >= auth.socialExp) {
                            await signInSocial();
                        }
                    }
                    lastAuthFailure = { at: 0, err: null };
                } catch (err) {
                    lastAuthFailure = { at: Date.now(), err };
                    throw err;
                } finally {
                    auth.signingIn = null;
                }
            })();
            return auth.signingIn;
}

// ---------------------------------------------------------------------------
// RTDB reads
// ---------------------------------------------------------------------------

async function fetchNode(baseUrl, nodePath, token) {
    const url = `${baseUrl}/${nodePath}.json?auth=${encodeURIComponent(token)}`;
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await fetch(url, {
                headers: SPOOFED_HEADERS,
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (res.status === 404) return {}; // node doesn't exist (yet)
            if (!res.ok) {
                const err = new Error(`${nodePath} -> HTTP ${res.status}`);
                err.status = res.status;
                throw err;
            }
            return (await res.json()) || {};
        } catch (err) {
            lastErr = err;
            if (err.status === 401 || err.status === 403) break; // re-auth, don't retry
            if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
        }
    }
    throw lastErr;
}

async function fetchNodeWithAuth(baseUrl, nodePath, which) {
    await ensureAuth();
    const pick = () => (which === 'main' ? auth.mainToken : auth.socialToken);
    try {
        return await fetchNode(baseUrl, nodePath, pick());
    } catch (err) {
        if (err.status === 401 || err.status === 403) {
            await ensureAuth(true); // token expired/revoked mid-flight — retry once
            return fetchNode(baseUrl, nodePath, pick());
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Username index (user_cards beats users_public, like the C++ client)
// ---------------------------------------------------------------------------

function extractUsernames(node) {
    const map = new Map();
    for (const [uid, value] of Object.entries(node || {})) {
        const name = typeof value === 'string' ? value : value?.[USERNAME_FIELD];
        if (typeof name === 'string' && name.trim()) map.set(uid, name.trim());
    }
    return map;
}

async function getUsernames(force = false) {
    if (!isAvailable()) return null;
    if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
        return cache.map;
    }

    const [cards, pub] = await Promise.allSettled([
        fetchNodeWithAuth(CFG.mainRtdb, CARDS_PATH, 'main'),
                                                  fetchNodeWithAuth(CFG.socialRtdb, PUBLIC_PATH, 'social'),
    ]);

    const cardsMap = cards.status === 'fulfilled' ? extractUsernames(cards.value) : null;
    const pubMap = pub.status === 'fulfilled' ? extractUsernames(pub.value) : null;

    if (!cardsMap && !pubMap) {
        const reason = cards.reason || pub.reason;
        throw reason instanceof Error ? reason : new Error(String(reason));
    }
    if (!cardsMap) console.error('[rtdb] user_cards fetch failed:',
        String(cards.reason?.message || cards.reason));
    if (!pubMap) console.error('[rtdb] users_public fetch failed:',
        String(pub.reason?.message || pub.reason));

    const map = new Map(pubMap || []);
    for (const [uid, name] of cardsMap || []) map.set(uid, name);

    console.log(`[rtdb] indexed ${map.size} username(s) ` +
    `(user_cards: ${cardsMap?.size ?? 0}, users_public: ${pubMap?.size ?? 0})`);

    cache = { map, fetchedAt: Date.now() };
    return map;
}

/** True when the username contains the first 8 characters of the UID —
 *  the exact fallback the C++ client uses (id.substr(0, 8)). */
function looksLikeDefaultName(uid, username) {
    const prefix = String(uid || '').slice(0, 8).toLowerCase();
    if (!prefix) return false;
    return String(username || '').toLowerCase().includes(prefix);
}

module.exports = {
    getUsernames, looksLikeDefaultName, isAvailable, submitTokens, tokenStatus,
};
