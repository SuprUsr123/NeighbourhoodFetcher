// ==UserScript==
// @name         ReKindle Auto-Scraper & Auto-Scroll (Minimizable UI)
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  Minimizable, draggable UI, persistent stats, targeted scrolling, payload deduplication, and RTDB token authentication for the collector server.
// @match        *://rekindle.ink/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      neighbourhoodfetcher.onrender.com
// ==/UserScript==

(function() {
    'use strict';

    const SERVER_URL = 'https://neighbourhoodfetcher.onrender.com';
    const AUTH_SECRET = '';                 // must match AUTH_SECRET on Render ('' if unset)
const AUTH_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const SCRAPE_INTERVAL_MS = 3000;

const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

let autoInterval = null;
let autoScrollEnabled = false;

function getStoredUserMap() {
    try { return new Map(JSON.parse(GM_getValue('rk_sent_user_map', '[]'))); } catch (e) { return new Map(); }
}
function saveStoredUserMap(map) { GM_setValue('rk_sent_user_map', JSON.stringify(Array.from(map.entries()))); }
function getStoredAvatarSet() {
    try { return new Set(JSON.parse(GM_getValue('rk_sent_avatar_set', '[]'))); } catch (e) { return new Set(); }
}
function saveStoredAvatarSet(set) { GM_setValue('rk_sent_avatar_set', JSON.stringify(Array.from(set))); }

const persistentUserMap = getStoredUserMap();
const persistentAvatarSet = getStoredAvatarSet();

function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
}

function postJSON(url, body, extraHeaders) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
    return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: headers,
                data: JSON.stringify(body),
                              timeout: 10000, // Render cold starts can be slow
                              onload: (res) => (res.status >= 200 && res.status < 300) ? resolve(safeParse(res.responseText)) : reject(new Error(`HTTP ${res.status}`)),
                              onerror: (err) => reject(err),
                              ontimeout: () => reject(new Error('Timeout'))
            });
        } else {
            fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) })
            .then(res => res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`)))
            .then(t => resolve(safeParse(t)))
            .catch(reject);
        }
    });
}

function isPlaceholder(username, uid) {
    if (!username || !uid || uid.length < 8) return false;
    return username.toLowerCase().includes(uid.substring(0, 8).toLowerCase());
}

// Collect auth tokens from this browser session:
// 1. ID tokens from the page's Firebase (compat) apps, matched by projectId
// 2. firebase:authUser:* localStorage entries (long-lived refresh tokens)
async function collectAuthTokens() {
    const out = { mainToken: null, socialToken: null, authEntries: [] };

    try {
        const fb = pageWindow.firebase;
        if (fb && Array.isArray(fb.apps)) {
            for (const app of fb.apps) {
                try {
                    const opts = app.options || app.options_ || {};
                    const projectId = opts.projectId || '';
                    if (projectId !== 'rekindle-dd1fa' && projectId !== 'rekindle-socials') continue;
                    if (typeof app.auth !== 'function') continue;
                    const user = app.auth().currentUser;
                    if (!user) continue;
                    const token = await user.getIdToken();
                    if (projectId === 'rekindle-dd1fa') out.mainToken = token;
                    else if (projectId === 'rekindle-socials') out.socialToken = token;
                } catch (e) {}
            }
        }
    } catch (e) {}

    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.indexOf('firebase:authUser:') === 0) {
                out.authEntries.push({ key: key, value: localStorage.getItem(key) });
            }
        }
    } catch (e) {}

    return out;
}

function cleanUsername(rawName) {
    if (!rawName) return '';
    return rawName.replace(/^DEV\s*/i, '').replace(/\bYou\b/g, '').trim();
}

function extractUid(onclickStr) {
    if (!onclickStr) return null;
    const match = onclickStr.match(/openUserProfile\s*\(\s*['"]([^'"]+)['"]/);
    return match ? match[1] : null;
}

function addUserToMap(map, uid, username) {
    if (!uid || !username) return;
    const cleanName = cleanUsername(username);
    if (!cleanName) return;
    const existingName = map.get(uid);
    if (!existingName) {
        map.set(uid, cleanName);
    } else if (isPlaceholder(existingName, uid) && !isPlaceholder(cleanName, uid)) {
        map.set(uid, cleanName);
    }
}

function getScrollDirection() {
    const url = window.location.href.toLowerCase();
    if (url.includes('kindlechat') || url.includes('topics')) return 'UP';
    if (url.includes('neighbourhood')) return 'DOWN';
    if (document.querySelector('.msg-row, b.author-name-field, .author-name-field')) return 'UP';
    return 'DOWN';
}

function dispatchScrollEvents(element) {
    try {
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
        element.dispatchEvent(new Event('wheel', { bubbles: true }));
    } catch (e) {}
}

function performAutoScroll(direction) {
    if (!autoScrollEnabled) return;
    const ignoreSelector = 'nav, aside, .sidebar, .topic-list, .topics-list, .topic-selector, .channel-list, .menu, [class*="sidebar"], [class*="topic"]';
    const scrollables = Array.from(document.querySelectorAll('div, section, main, ul, body, html'))
    .filter(el => {
        if (el.matches(ignoreSelector) || el.closest(ignoreSelector)) return false;
        if (el.scrollHeight <= el.clientHeight) return false;
        const style = window.getComputedStyle(el);
        return style.overflowY === 'scroll' || style.overflowY === 'auto';
    });
    if (direction === 'UP') {
        window.scrollTo({ top: 0, behavior: 'auto' });
        dispatchScrollEvents(window);
        scrollables.forEach(el => { el.scrollTop = 0; dispatchScrollEvents(el); });
    } else {
        const bottom = document.documentElement.scrollHeight || document.body.scrollHeight;
        window.scrollTo({ top: bottom, behavior: 'auto' });
        dispatchScrollEvents(window);
        scrollables.forEach(el => { el.scrollTop = el.scrollHeight; dispatchScrollEvents(el); });
    }
}

const style = document.createElement('style');
style.textContent = `
#rk-archiver-ui { position: fixed !important; width: 260px !important;
background: #181818 !important; color: #ffffff !important;
font-family: monospace, monospace !important; font-size: 11px !important;
border: 2px solid #4CAF50 !important; border-radius: 8px !important;
padding: 10px 12px !important; z-index: 2147483647 !important;
box-shadow: 0 4px 20px rgba(0,0,0,0.9) !important; transition: width 0.2s;
user-select: none !important; }
#rk-header { display: flex !important; justify-content: space-between !important;
align-items: center !important; border-bottom: 1px solid #333 !important;
padding-bottom: 4px !important; margin-bottom: 6px !important; cursor: move !important; }
#rk-archiver-ui.minimized { width: auto !important; padding: 6px 10px !important; }
#rk-archiver-ui.minimized #rk-header { border-bottom: none !important;
padding-bottom: 0 !important; margin-bottom: 0 !important; }
#rk-archiver-ui h3 { margin: 0 !important; font-size: 13px !important;
color: #4CAF50 !important; border: none !important; padding: 0 !important;
margin-right: 15px !important; pointer-events: none !important; }
#rk-toggle-ui { cursor: pointer !important; color: #aaa !important;
font-weight: bold !important; font-size: 14px !important; }
#rk-toggle-ui:hover { color: #fff !important; }
#rk-body p { margin: 3px 0 !important; color: #ccc !important; }
.rk-status { font-weight: bold !important; color: #FFA500 !important; }
.rk-dir { font-weight: bold !important; color: #00BCD4 !important; }
.rk-btn { width: 100% !important; background: #2a2a2a !important; color: #fff !important;
    border: 1px solid #444 !important; padding: 5px !important; margin-top: 5px !important;
    cursor: pointer !important; border-radius: 4px !important; font-family: monospace !important; }
    .rk-btn:hover { background: #3a3a3a !important; }
    .rk-btn-active { background: #4CAF50 !important; color: #000 !important; font-weight: bold !important; }
    .rk-btn-reset { background: #5a1a1a !important; border-color: #882222 !important; margin-top: 10px !important; }
    .rk-btn-reset:hover { background: #7a2a2a !important; }
    `;
    (document.head || document.documentElement).appendChild(style);

    function initUI() {
        if (document.getElementById('rk-archiver-ui')) return;

        const direction = getScrollDirection();
        let isMinimized = GM_getValue('rk_ui_minimized', false);
        const savedPos = GM_getValue('rk_ui_pos', null);

        const ui = document.createElement('div');
        ui.id = 'rk-archiver-ui';
        if (isMinimized) ui.classList.add('minimized');
        if (savedPos) {
            ui.style.top = savedPos.top + 'px';
            ui.style.left = savedPos.left + 'px';
        } else {
            ui.style.bottom = '20px';
            ui.style.right = '20px';
        }

        ui.innerHTML = `
        <div id="rk-header">
        <h3>ReKindle Archiver</h3>
        <span id="rk-toggle-ui" title="Toggle UI">${isMinimized ? '[ + ]' : '[ - ]'}</span>
        </div>
        <div id="rk-body" style="display: ${isMinimized ? 'none' : 'block'};">
        <p>Status: <span id="rk-status" class="rk-status">Initializing</span></p>
        <p>Direction: <span id="rk-dir" class="rk-dir">${direction}</span></p>
        <p>DOM Found: <span id="rk-found-count" style="color:#FFF;">0 U / 0 A</span></p>
        <p>Unique Sent: <span id="rk-sent-count" style="color:#4CAF50;">${persistentUserMap.size} U / ${persistentAvatarSet.size} A</span></p>
        <p>RTDB Auth: <span id="rk-auth-status" style="color:#FFA500;">Waiting&hellip;</span></p>
        <button id="rk-btn-scroll" class="rk-btn rk-btn-active">Auto-Scroll: ON</button>
        <button id="rk-btn-toggle" class="rk-btn rk-btn-active">Auto-Scrape: ON</button>
        <button id="rk-btn-reset" class="rk-btn rk-btn-reset">Reset Stats</button>
        </div>
        `;

        (document.body || document.documentElement).appendChild(ui);

        const headerEl = document.getElementById('rk-header');
        const statusEl = document.getElementById('rk-status');
        const foundCountEl = document.getElementById('rk-found-count');
        const sentCountEl = document.getElementById('rk-sent-count');
        const btnScroll = document.getElementById('rk-btn-scroll');
        const btnToggle = document.getElementById('rk-btn-toggle');
        const btnReset = document.getElementById('rk-btn-reset');
        const btnToggleUI = document.getElementById('rk-toggle-ui');
        const bodyUI = document.getElementById('rk-body');

        let isDragging = false;
        let startX = 0, startY = 0;
        let initialTop = 0, initialLeft = 0;

        headerEl.addEventListener('mousedown', (e) => {
            if (e.target === btnToggleUI) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = ui.getBoundingClientRect();
            initialTop = rect.top;
            initialLeft = rect.left;
            ui.style.bottom = 'auto';
            ui.style.right = 'auto';
            ui.style.top = `${initialTop}px`;
            ui.style.left = `${initialLeft}px`;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        function onMouseMove(e) {
            if (!isDragging) return;
            ui.style.top = `${initialTop + (e.clientY - startY)}px`;
            ui.style.left = `${initialLeft + (e.clientX - startX)}px`;
        }

        function onMouseUp() {
            if (!isDragging) return;
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            const rect = ui.getBoundingClientRect();
            GM_setValue('rk_ui_pos', { top: rect.top, left: rect.left });
        }

        btnToggleUI.addEventListener('click', () => {
            isMinimized = !isMinimized;
            GM_setValue('rk_ui_minimized', isMinimized);
            if (isMinimized) {
                ui.classList.add('minimized');
                bodyUI.style.display = 'none';
                btnToggleUI.textContent = '[ + ]';
            } else {
                ui.classList.remove('minimized');
                bodyUI.style.display = 'block';
                btnToggleUI.textContent = '[ - ]';
            }
        });

        function setStatus(text, color) {
            statusEl.textContent = text;
            statusEl.style.color = color;
        }

        async function scrapeAndSync() {
            const currentDir = getScrollDirection();
            document.getElementById('rk-dir').textContent = currentDir;

            performAutoScroll(currentDir);
            await new Promise(resolve => setTimeout(resolve, 600));

            setStatus('Scraping...', '#FFA500');

            const usersMap = new Map();
            const avatarsMap = new Map();

            if (pageWindow.rekindleCardCache) {
                Object.entries(pageWindow.rekindleCardCache).forEach(([uid, item]) => {
                    if (item?.card?.username) addUserToMap(usersMap, uid, item.card.username);
                });
            }

            document.querySelectorAll('[onclick*="openUserProfile"]').forEach(el => {
                const uid = extractUid(el.getAttribute('onclick'));
                if (!uid) return;
                const nameNode = el.querySelector('strong, b, span') || el;
                addUserToMap(usersMap, uid, nameNode.textContent);
            });

            document.querySelectorAll('.post-card, .user-card, .msg-row, .msg, .gallery-item, body, tr, div').forEach(container => {
                const canvas = container.querySelector('canvas.avatar-canvas, canvas.msg-avatar, canvas');
                if (!canvas || canvas.dataset.rkProcessed === 'true') return;
                const userEl = container.querySelector('[onclick*="openUserProfile"]');
                let username = null;
                let uid = null;
                if (userEl) {
                    uid = extractUid(userEl.getAttribute('onclick'));
                    if (uid && usersMap.has(uid)) {
                        username = usersMap.get(uid);
                    } else {
                        const nameNode = userEl.querySelector('strong, b, span') || userEl;
                        username = cleanUsername(nameNode.textContent);
                    }
                }
                if (username && (!uid || !isPlaceholder(username, uid))) {
                    try {
                        const dataUrl = canvas.toDataURL('image/png');
                        if (dataUrl && dataUrl.startsWith('data:image/png')) {
                            avatarsMap.set(username, dataUrl);
                            canvas.dataset.rkProcessed = 'true';
                        }
                    } catch (err) {}
                }
            });

            const userPayload = [];
            usersMap.forEach((username, id) => {
                const prevSentName = persistentUserMap.get(id);
                if (!prevSentName || (isPlaceholder(prevSentName, id) && !isPlaceholder(username, id))) {
                    userPayload.push({ id, username });
                }
            });

            const avatarPayload = [];
            avatarsMap.forEach((avatar, username) => {
                if (!persistentAvatarSet.has(username)) {
                    avatarPayload.push({ username, avatar });
                }
            });

            foundCountEl.textContent = `${usersMap.size} U / ${avatarsMap.size} A`;

            let hasError = false;

            if (userPayload.length > 0) {
                try {
                    await postJSON(`${SERVER_URL}/`, userPayload);
                    userPayload.forEach(u => persistentUserMap.set(u.id, u.username));
                    saveStoredUserMap(persistentUserMap);
                } catch (err) { hasError = true; }
            }

            if (avatarPayload.length > 0) {
                try {
                    await postJSON(`${SERVER_URL}/avatars`, avatarPayload);
                    avatarPayload.forEach(a => persistentAvatarSet.add(a.username));
                    saveStoredAvatarSet(persistentAvatarSet);
                } catch (err) { hasError = true; }
            }

            sentCountEl.textContent = `${persistentUserMap.size} U / ${persistentAvatarSet.size} A`;

            if (hasError) {
                setStatus('Server Conn Fail', '#F44336');
            } else if (userPayload.length === 0 && avatarPayload.length === 0) {
                setStatus('Active (Idle)', '#4CAF50');
            } else {
                setStatus('Active (Synced)', '#4CAF50');
            }
        }

        // Forward this session's Firebase tokens to the server, so it can
        // read the RTDB as you (the ilovekindle env account is the fallback).
        let authOk = false;
        async function syncAuth() {
            const el = document.getElementById('rk-auth-status');
            if (el) { el.textContent = 'Syncing\u2026'; el.style.color = '#FFA500'; }
            try {
                const tokens = await collectAuthTokens();
                const headers = {};
                if (AUTH_SECRET) headers['X-Auth-Secret'] = AUTH_SECRET;
                const body = await postJSON(`${SERVER_URL}/auth`, tokens, headers);
                const t = (body && body.tokens) || {};
                const mainOk = Boolean(t.main || t.mainRefresh);
                const socialOk = Boolean(t.social || t.socialRefresh || mainOk);
                authOk = mainOk;
                if (el) {
                    if (mainOk) {
                        el.textContent = `Active${socialOk ? ' (main+social)' : ' (main)'}`;
                        el.style.color = '#4CAF50';
                    } else {
                        el.textContent = 'No session (log in on rekindle.ink)';
                        el.style.color = '#FFA500';
                    }
                }
            } catch (err) {
                authOk = false;
                if (el) { el.textContent = 'Server Conn Fail'; el.style.color = '#F44336'; }
            }
        }
        function scheduleAuthSync() {
            syncAuth().finally(() => {
                setTimeout(scheduleAuthSync, authOk ? AUTH_SYNC_INTERVAL_MS : 60 * 1000);
            });
        }

        btnScroll.addEventListener('click', () => {
            autoScrollEnabled = !autoScrollEnabled;
            btnScroll.textContent = `Auto-Scroll: ${autoScrollEnabled ? 'ON' : 'OFF'}`;
            btnScroll.classList.toggle('rk-btn-active', autoScrollEnabled);
        });

        btnToggle.addEventListener('click', () => {
            if (autoInterval) {
                clearInterval(autoInterval);
                autoInterval = null;
                btnToggle.textContent = 'Auto-Scrape: OFF';
                btnToggle.classList.remove('rk-btn-active');
                setStatus('Paused', '#FFA500');
            } else {
                scrapeAndSync();
                autoInterval = setInterval(scrapeAndSync, SCRAPE_INTERVAL_MS);
                btnToggle.textContent = 'Auto-Scrape: ON';
                btnToggle.classList.add('rk-btn-active');
                setStatus('Active', '#4CAF50');
            }
        });

        btnReset.addEventListener('click', () => {
            if (confirm('Reset stored archiver stats?')) {
                persistentUserMap.clear();
                persistentAvatarSet.clear();
                saveStoredUserMap(persistentUserMap);
                saveStoredAvatarSet(persistentAvatarSet);
                sentCountEl.textContent = `0 U / 0 A`;
                setStatus('Stats Reset', '#FFA500');
            }
        });

        scheduleAuthSync();
        scrapeAndSync();
        autoInterval = setInterval(scrapeAndSync, SCRAPE_INTERVAL_MS);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initUI();
    } else {
        document.addEventListener('DOMContentLoaded', initUI);
    }
})();
