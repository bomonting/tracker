// ==UserScript==
// @name         MERTFLIX Tracker
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Track family & plating changes via users_online. Syncs to Supabase.
// @author       Mert
// @match        https://barafranca.com/*
// @match        https://www.barafranca.com/*
// @match        https://barafranca.nl/*
// @match        https://www.barafranca.nl/*
// @match        https://omerta.com.tr/*
// @match        https://www.omerta.com.tr/*
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      uabktvfytsabgudxjbxw.supabase.co
// ==/UserScript==

(function () {
    'use strict';

    // ── CONFIG — değiştir ──────────────────────────────────────────────────
    const SUPABASE_URL = 'https://uabktvfytsabgudxjbxw.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_IuAEcQBBiVxVKIbR5Kg6Fg_jdCUP0IY';
    const POLL_INTERVAL = 30 * 1000; // 30 saniye
    // ──────────────────────────────────────────────────────────────────────

    const KEY_SNAP = 'mf_snapshot_v1';
    const MAX_LOG  = 200;

    // ── PLATING MAP ───────────────────────────────────────────────────────
    const PLATING_MAP = {
        'rgb(51, 153, 0)'   : { label: 'Very High', color: '#339900' },
        'rgb(153, 204, 51)' : { label: 'High',      color: '#99cc33' },
        'rgb(255, 204, 0)'  : { label: 'Medium',    color: '#ffcc00' },
        'rgb(255, 153, 102)': { label: 'Low',        color: '#ff9966' },
        'rgb(204, 51, 0)'   : { label: 'Very Low',   color: '#cc3300' },
    };

    function getPlating(el) {
        if (!el) return { label: 'None', color: '#666' };
        const match = PLATING_MAP[el.style?.color?.trim()];
        return match || { label: 'None', color: '#666' };
    }

    // ── RANK TITLES ───────────────────────────────────────────────────────
    const TITLES = ['Don','Sotto','Capo','Boss','Consig','Underboss','Consigliere'];
    function stripTitle(raw) {
        for (const t of TITLES) {
            if (raw.startsWith(t + ' ')) return raw.slice(t.length + 1).trim();
        }
        return raw;
    }

    // ── STORAGE ───────────────────────────────────────────────────────────
    function load(key, def) {
        try { return JSON.parse(GM_getValue(key, JSON.stringify(def))); }
        catch { return def; }
    }
    function save(key, val) {
        try { GM_setValue(key, JSON.stringify(val)); } catch {}
    }

    let snapshot = load(KEY_SNAP, {}); // id -> { name, rank, family, plating }

    // ── SUPABASE ──────────────────────────────────────────────────────────
    async function sbUpsert(table, rows) {
        if (!rows.length) return;
        for (let i = 0; i < rows.length; i += 200) {
            const batch = rows.slice(i, i + 200);
            try {
                const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${SUPABASE_KEY}`,
                        'Prefer': 'resolution=merge-duplicates,return=minimal'
                    },
                    body: JSON.stringify(batch)
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    console.warn('[MF] upsert batch failed:', res.status, err.message || err.code);
                }
            } catch(e) { console.warn('[MF] upsert error:', e); }
            // Small delay between batches to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    async function sbInsert(table, row) {
        try {
            await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`
                },
                body: JSON.stringify(row)
            });
        } catch(e) { console.warn('[MF] insert error:', e); }
    }

    // ── PANEL UI ──────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        #mf-panel {
            position:fixed; bottom:20px; right:20px; width:320px;
            background:rgba(10,10,12,0.97); border:1px solid #2a2a35;
            border-radius:8px; font-family:'Courier New',monospace;
            font-size:12px; color:#ccc; z-index:999999;
            display:flex; flex-direction:column;
            box-shadow:0 4px 24px rgba(0,0,0,0.8); user-select:none;
            max-height:420px;
        }
        #mf-header {
            display:flex; justify-content:space-between; align-items:center;
            padding:8px 12px; background:rgba(229,9,20,0.15);
            border-radius:8px 8px 0 0; border-bottom:1px solid #2a2a35;
            cursor:grab;
        }
        #mf-header:active { cursor:grabbing; }
        #mf-title { color:#e50914; font-weight:bold; font-size:13px; letter-spacing:2px; }
        #mf-dot { width:7px; height:7px; border-radius:50%; background:#555; display:inline-block; margin-right:6px; }
        #mf-dot.active  { background:#4caf50; box-shadow:0 0 6px #4caf50; }
        #mf-dot.loading { background:#ff9800; box-shadow:0 0 6px #ff9800; }
        #mf-dot.error   { background:#e57373; box-shadow:0 0 6px #e57373; }
        .mf-btn { background:none; border:1px solid #444; color:#888; cursor:pointer;
            border-radius:3px; padding:1px 8px; font-size:11px; font-family:'Courier New',monospace; }
        .mf-btn:hover { border-color:#e50914; color:#e50914; }
        #mf-body { overflow-y:auto; padding:8px; flex:1; user-select:text; }
        #mf-body::-webkit-scrollbar { width:3px; }
        #mf-body::-webkit-scrollbar-thumb { background:#2a2a35; }
        .mf-entry { padding:5px 8px; margin-bottom:4px; border-radius:4px;
            border-left:3px solid #444; background:rgba(255,255,255,0.02); line-height:1.6; }
        .mf-entry.family  { border-color:#4fc3f7; }
        .mf-entry.plating { border-color:#ce93d8; }
        .mf-time { color:#444; font-size:10px; float:right; }
        .mf-name { color:#fff; font-weight:bold; }
        .mf-empty { color:#444; text-align:center; padding:20px 0; font-style:italic; font-size:11px; }
        #mf-footer { padding:5px 10px; border-top:1px solid #1a1a1a; color:#444;
            font-size:10px; display:flex; justify-content:space-between; }
        .mf-online-dot {
            display:inline-block; width:8px; height:8px; border-radius:50%;
            margin-right:3px; vertical-align:middle;
        }
        .mf-online-dot.online {
            background:#4caf50; box-shadow:0 0 4px #4caf50;
        }
        .mf-online-dot.offline {
            background:#555; opacity:0.4;
        }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'mf-panel';
    panel.innerHTML = `
        <div id="mf-header">
            <span id="mf-title">▶ MERTFLIX</span>
            <div style="display:flex;align-items:center;gap:6px">
                <span id="mf-dot"></span>
                <button class="mf-btn" id="mf-toggle">Hide</button>
                <button class="mf-btn" id="mf-reset" style="border-color:#e57373;color:#e57373">Reset</button>
            </div>
        </div>
        <div id="mf-body"><div class="mf-empty">Initializing...</div></div>
        <div id="mf-footer">
            <span id="mf-count">—</span>
            <span id="mf-last">Never synced</span>
        </div>
    `;
    document.body.appendChild(panel);

    const bodyEl  = document.getElementById('mf-body');
    const dotEl   = document.getElementById('mf-dot');
    const countEl = document.getElementById('mf-count');
    const lastEl  = document.getElementById('mf-last');
    const header  = document.getElementById('mf-header');

    // Drag
    let dragging = false, ox = 0, oy = 0;
    header.addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        const r = panel.getBoundingClientRect();
        ox = e.clientX - r.left; oy = e.clientY - r.top;
        panel.style.bottom = 'auto'; panel.style.right = 'auto';
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        panel.style.left = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox)) + 'px';
        panel.style.top  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy)) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    // Toggle
    let visible = true;
    document.getElementById('mf-toggle').addEventListener('click', function() {
        visible = !visible;
        bodyEl.style.display = visible ? '' : 'none';
        document.getElementById('mf-footer').style.display = visible ? '' : 'none';
        this.textContent = visible ? 'Hide' : 'Show';
    });
    document.getElementById('mf-reset').addEventListener('click', function() {
        if (confirm("Snapshot sifirlansin mi?")) {
            snapshot = {};
            save(KEY_SNAP, snapshot);
            localLog.length = 0;
            bodyEl.innerHTML = '<div class="mf-empty">Reset edildi — yeni baseline alinacak...</div>';
        }
    });

    // ── LOCAL LOG (panel only) ────────────────────────────────────────────
    const localLog = [];

    function nowStr() {
        const d = new Date();
        return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2,'0')).join(':');
    }

    function addToPanel(type, html) {
        localLog.unshift({ type, html, time: nowStr() });
        if (localLog.length > MAX_LOG) localLog.pop();
        renderPanel();
    }

    function renderPanel() {
        if (!localLog.length) {
            bodyEl.innerHTML = '<div class="mf-empty">Watching for changes...</div>';
            return;
        }
        bodyEl.innerHTML = localLog.map(e => `
            <div class="mf-entry ${e.type}">
                <span class="mf-time">${e.time}</span>
                ${e.html}
            </div>
        `).join('');
    }

    // ── EVENTS ────────────────────────────────────────────────────────────
    async function fireEvent(type, data) {
        // Panel
        let html = '';
        if (type === 'family') {
            if (data.field === 'Left')
                html = `<span class="mf-name">${data.name}</span> <span style="color:#888">left</span> <span style="color:#e57373">${data.oldVal}</span>`;
            else if (data.field === 'Joined')
                html = `<span class="mf-name">${data.name}</span> <span style="color:#888">joined</span> <span style="color:#81c784">${data.newVal}</span>`;
            else
                html = `<span class="mf-name">${data.name}</span> <span style="color:#888">left</span> <span style="color:#e57373">${data.oldVal}</span> <span style="color:#555">→</span> <span style="color:#81c784">${data.newVal}</span>`;
        } else if (type === 'plating') {
            if (data.field === 'LostPlating')
                html = `<span class="mf-name">${data.name}</span> <span style="color:#ce93d8">lost plating</span> <span style="color:#555">(${data.oldVal})</span>`;
            else
                html = `<span class="mf-name">${data.name}</span> <span style="color:#81c784">gained plating</span> <span style="color:#555">(${data.newVal})</span>`;
        }
        addToPanel(type, html);

        // Supabase
        await sbInsert('feed', {
            type,
            name:    data.name    || null,
            family:  data.family  || null,
            field:   data.field   || null,
            old_val: data.oldVal  || null,
            new_val: data.newVal  || null,
        });
    }

    let gameLoggedIn = false; // oyun sayfasından gerçek veri geliyor mu
    let famIds = load('mf_fam_ids_v1', []); // [{id, name, city}]
    let famMemberCounts = load('mf_fam_counts_v1', {});
    let casinoSnapshot = load('mf_casino_snap_v1', {}); // casino_id -> { owner, profit, max_bet }
    // Eğer tüm değerler 0 ise bozuk cache, temizle
    if (Object.keys(famMemberCounts).length > 0 && Object.values(famMemberCounts).every(v => v === 0)) {
        famMemberCounts = {};
        save('mf_fam_counts_v1', {});
        console.log('[MF] Bozuk count cache temizlendi');
    }

    // ── TRUE ONLINE DETECTION (chat autocomplete endpoint) ────────────────
    let trueOnlineSet = new Set(); // son 60dk aktif kullanıcılar
    let userRoles = {}; // name -> { family_role, capo_name }

    async function fetchTrueOnlineUsers() {
        try {
            const res = await fetch('/?module=Services.Account', {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            const data = await res.json();

            const names = new Set();
            const roles = {};
            const users = data.data?.users || [];
            for (const u of users) {
                if (u.name) {
                    const n = u.name.trim();
                    names.add(n);
                    if (u.family?.role) {
                        roles[n] = { family_role: u.family.role, capo_name: u.family.capo_name || null };
                    }
                }
            }
            console.log('[MF] True online users:', names.size);
            trueOnlineSet = names;
            userRoles = roles;
        } catch(e) {
            console.warn('[MF] Services.Account error:', e);
            // Hata durumunda eski set'i koru, temizleme
        }
    }

    // ── FAMILY PAGE FETCH ────────────────────────────────────────────────
    let familyCapos = {}; // famName -> { capoName: [memberName, ...] }

    async function fetchFamilyPage(famId, famName, rows, seenIds, pendingEvents) {
        try {
            const res = await fetch(`/family.php?fam=${famId}&ajax=true`, {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const userTable = [...doc.querySelectorAll('table')].find(t => t.textContent.includes('Users:'));
            if (!userTable) return;

            // ── CAPOREGIMES PARSE ─────────────────────────────────────
            const capoTable = [...doc.querySelectorAll('table')].find(t => {
                const hdr = t.querySelector('td.tableheader');
                return hdr && hdr.textContent.trim().includes('Caporegimes');
            });
            const capoMap = {}; // capoName -> Set of member names
            if (capoTable) {
                for (const capoLink of capoTable.querySelectorAll('td.subtableheader a.tableheader')) {
                    const capoName = capoLink.textContent.trim();
                    const memberTd = capoLink.closest('td').nextElementSibling;
                    if (!memberTd) continue;
                    const members = new Set();
                    for (const a of memberTd.querySelectorAll('a')) {
                        members.add(a.textContent.trim());
                    }
                    capoMap[capoName] = members;
                    // Capo'nun kendisi de Capo rolüne sahip
                    if (!capoMap._capoNames) capoMap._capoNames = new Set();
                    capoMap._capoNames.add(capoName);
                }
            }
            familyCapos[famName] = capoMap;

            const famSeenIds = new Set();
            for (const rankCell of userTable.querySelectorAll('td[width="145"]')) {
                const rankTxt = rankCell.querySelector('b')?.firstChild?.textContent?.trim() || '—';
                const rank = rankTxt.replace(/\s*\(.*$/, '').trim() || '—';
                const userTd = rankCell.nextElementSibling;
                if (!userTd) continue;

                for (const a of userTd.querySelectorAll('a[href*="user.php?idn="]')) {
                    const m = a.href.match(/idn=(\d+)/);
                    if (!m) continue;
                    const id = m[1];
                    if (seenIds.has(id)) continue;
                    seenIds.add(id);
                    famSeenIds.add(id);

                    const name = Array.from(a.childNodes)
                        .filter(n => n.nodeType === 3)
                        .map(n => n.textContent.trim()).join('').trim();
                    if (!name) continue;

                    const shield = a.querySelector('i.fa-shield');
                    const plating = getPlating(shield?.parentElement);
                    const now = new Date().toISOString();

                    // Online tespiti: trueOnlineSet varsa onu kullan, yoksa text-blue fallback
                    const isOnline = trueOnlineSet.size > 0
                        ? trueOnlineSet.has(name)
                        : a.classList.contains('text-blue');

                    // Rol tespiti: capoMap'ten bak
                    let family_role = null;
                    if (capoMap._capoNames?.has(name)) {
                        family_role = 'Capo';
                    }
                    // Services.Account'tan gelen rol (Don, Sottocapo, Consiglieri) online kullanıcılar için
                    const svcRole = userRoles[name];
                    if (svcRole?.family_role && svcRole.family_role !== 'Member' && svcRole.family_role !== 'Capo') {
                        family_role = svcRole.family_role;
                    }

                    const prev = snapshot[id];
                    if (prev) {
                        if (prev.family !== famName) {
                            const field = prev.family === 'Famless' ? 'Joined' : 'LeftJoined';
                            pendingEvents.push(['family', { name, field, family: famName, oldVal: prev.family, newVal: famName }]);
                        }
                        if (prev.plating === 'None' && plating.label !== 'None') {
                            pendingEvents.push(['plating', { name, family: famName, field: 'GainedPlating', oldVal: 'None', newVal: plating.label }]);
                        }
                        if (prev.plating !== 'None' && plating.label === 'None') {
                            pendingEvents.push(['plating', { name, family: famName, field: 'LostPlating', oldVal: prev.plating, newVal: 'None' }]);
                        }
                    }
                    snapshot[id] = { name, rank, family: famName, plating: plating.label, platingColor: plating.color, is_online: isOnline };
                    rows.push({ id, name, rank, family: famName, plating: plating.label, is_online: isOnline, family_role, updated_at: now });
                }
            }

            // Bu ailede snapshot'ta olup artık görünmeyenler → Left
            for (const [id, prev] of Object.entries(snapshot)) {
                if (prev.family === famName && !famSeenIds.has(id)) {
                    pendingEvents.push(['family', { name: prev.name, field: 'Left', family: famName, oldVal: famName, newVal: 'Famless' }]);
                    delete snapshot[id];
                }
            }
        } catch(e) { console.warn(`[MF] family ${famId} error:`, e); }
    }

    // ── MAIN POLL — 30dk'da bir tüm aileleri tara ─────────────────────────
    async function poll() {
        dotEl.className = 'loading';
        try {
            if (!famIds.length) { dotEl.className = 'active'; return; }

            // Önce gerçek online kullanıcıları al
            await fetchTrueOnlineUsers();

            const rows = [];
            const seenIds = new Set();
            const pendingEvents = [];

            console.log(`[MF] Tüm aileler taranıyor: ${famIds.length}`);

            // 5'erli gruplar halinde tüm aileleri fetch et
            for (let i = 0; i < famIds.length; i += 5) {
                const chunk = famIds.slice(i, i + 5);
                await Promise.all(chunk.map(f => fetchFamilyPage(f.id, f.name, rows, seenIds, pendingEvents)));
            }

            const seen = {};
            for (const r of rows) seen[r.id] = r;
            const uniqueRows = Object.values(seen);

            // Online: last_seen = şimdi | Offline: last_seen dokunma (korunsun)
            // family_role her iki grupta da var (capo bilgisi sayfadan geliyor)
            const onlineRows = uniqueRows.filter(r => r.is_online).map(r => ({ ...r, last_seen: r.updated_at }));
            const offlineRows = uniqueRows.filter(r => !r.is_online);
            if (onlineRows.length > 0) await sbUpsert('users', onlineRows);
            if (offlineRows.length > 0) await sbUpsert('users', offlineRows);

            // Yeni eklenen offline kullanıcıların last_seen'i null olur — otomatik doldur
            try {
                await fetch(`${SUPABASE_URL}/rest/v1/users?last_seen=is.null&id=neq._heartbeat`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${SUPABASE_KEY}`,
                        'Prefer': 'return=minimal'
                    },
                    body: JSON.stringify({ last_seen: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
                });
            } catch(e) { console.warn('[MF] last_seen backfill error:', e); }
            if (pendingEvents.length > 0) {
                save(KEY_SNAP, snapshot);
                await Promise.all(pendingEvents.map(([type, data]) => fireEvent(type, data)));
            }
            if (gameLoggedIn) {
                sbUpsert('users', [{ id: '_heartbeat', name: '_heartbeat', updated_at: new Date().toISOString() }]);
            }

            dotEl.className     = 'active';
            countEl.textContent = Object.keys(snapshot).length + ' users tracked';
            lastEl.textContent  = 'Synced ' + nowStr();

            if (localLog.length === 0) {
                bodyEl.innerHTML = '<div class="mf-empty">Baseline saved — watching for changes...</div>';
            }

        } catch(e) {
            dotEl.className    = 'error';
            lastEl.textContent = 'Error: ' + e.message.slice(0,30);
            console.warn('[MF] poll error:', e);
        }
    }

    // ── STATS POLL (global_stats — aileler, yıkılanlar, yeni kurulanlar) ──────
    let knownDeadFams = new Set(load('mf_dead_fams_v1', []));
    let knownFamNames = new Set(load('mf_fam_names_v1', []));

    async function pollStats() {
        try {
            const dRes  = await fetch('/?module=Statistics&action=global_stats', { credentials: 'include' });
            const dHtml = await dRes.text();
            const dDoc  = new DOMParser().parseFromString(dHtml, 'text/html');

            // ── FAMILY LIST PARSE (ID, name, city) ────────────────────────
            try {
                const familyRows = [];
                const newFamIds = [];
                const currentFamNames = new Set();

                dDoc.querySelectorAll('table').forEach(table => {
                    if (!table.textContent.includes('All Families')) return;
                    table.querySelectorAll('tr').forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length < 10) return;
                        const nameEl = cells[2]?.querySelector('a');
                        const city   = cells[11]?.textContent.trim();
                        const boss   = cells[8]?.textContent.trim() || null;
                        const sotto  = cells[9]?.textContent.trim() || null;
                        const consig = cells[10]?.textContent.trim() || null;
                        if (nameEl && city) {
                            const fname = nameEl.textContent.trim();
                            const fidM = nameEl.href?.match(/fam=(\d+)/);
                            familyRows.push({ name: fname, city, boss, sotto, consig, updated_at: new Date().toISOString() });
                            currentFamNames.add(fname);
                            if (fidM && !newFamIds.find(f => f.id === fidM[1])) {
                                newFamIds.push({ id: fidM[1], name: fname, city });
                            }
                        }
                    });
                });

                if (newFamIds.length > 0) {
                    gameLoggedIn = true;
                    famIds = newFamIds;
                    save('mf_fam_ids_v1', famIds);
                    console.log('[MF] Aile IDs güncellendi:', famIds.length);
                } else {
                    gameLoggedIn = false; // aile listesi gelmedi = logout ya da login sayfası
                    console.log('[MF] Aile listesi boş — logout algılandı, heartbeat gönderilmeyecek');
                }

                // Yeni kurulan aileler
                if (knownFamNames.size > 0) {
                    for (const fam of newFamIds) {
                        if (!knownFamNames.has(fam.name)) {
                            await fireEvent('family', {
                                name: fam.name,
                                field: 'FamilyCreated',
                                family: fam.name,
                                oldVal: fam.city,
                                newVal: 'Created'
                            });
                            console.log('[MF] New family:', fam.name, fam.city);
                        }
                    }
                }
                knownFamNames = currentFamNames;
                save('mf_fam_names_v1', [...currentFamNames]);

                if (familyRows.length > 0) {
                    await fetch(`${SUPABASE_URL}/rest/v1/families`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'apikey': SUPABASE_KEY,
                            'Authorization': `Bearer ${SUPABASE_KEY}`,
                            'Prefer': 'resolution=merge-duplicates,return=minimal'
                        },
                        body: JSON.stringify(familyRows)
                    });
                    console.log('[MF] Family cities synced:', familyRows.length);
                }
            } catch(e) { console.warn('[MF] family city error:', e); }

            // ── DEAD FAMILY PARSE ─────────────────────────────────────────
            try {
                const deadFamilies = [];
                let foundDeadFamTable = false;
                dDoc.querySelectorAll('table').forEach(table => {
                    if (foundDeadFamTable) return;
                    const text = table.textContent;
                    if (!text.includes('Last 20 Dead Families')) return;
                    if (text.includes('Last Deaths (Local Chief+)')) return;
                    foundDeadFamTable = true;
                    const now = Date.now();
                    table.querySelectorAll('tr').forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length < 2) return;
                        const name = cells[0]?.textContent.trim();
                        const dateStr = cells[1]?.textContent.trim();
                        if (!name || name === 'Name:' || name === 'Last 20 Dead Families') return;
                        const m = dateStr.match(/(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
                        if (!m) return;
                        const downedAt = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}`).getTime();
                        if (now - downedAt > 24 * 60 * 60 * 1000) return;
                        deadFamilies.push(name);
                    });
                });

                for (const fname of deadFamilies.reverse()) {
                    // Baseline'da varsa atla
                    if (knownDeadFams.has(fname)) continue;
                    knownDeadFams.add(fname);
                    save('mf_dead_fams_v1', [...knownDeadFams]);

                    const chk = await fetch(`${SUPABASE_URL}/rest/v1/feed?name=eq.${encodeURIComponent(fname)}&field=eq.FamilyDowned&select=id&limit=1`, {
                        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
                    });
                    const existing = await chk.json();
                    if (existing && existing.length > 0) continue;
                    await fetch(`${SUPABASE_URL}/rest/v1/feed`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
                        body: JSON.stringify({ type: 'family', name: fname, field: 'FamilyDowned', old_val: fname, new_val: 'Downed' })
                    });
                    console.log('[MF] Family downed:', fname);
                }
            } catch(e) { console.warn('[MF] dead family error:', e); }

            // ── CASINO PARSE ──────────────────────────────────────────────
            try {
                const TYPE_MAP = {
                    'Blackjack Tables':   'blackjack',
                    'Number Games':       'number',
                    'Punto Banco Tables': 'punto_banco',
                    'Roulette Tables':    'roulette',
                    'Slotmachines':       'slots'
                };
                const casinoRows = [];
                const casinoLogEntries = [];
                const now = new Date().toISOString();

                for (const [typeName, typeSlug] of Object.entries(TYPE_MAP)) {
                    // Find the header element for this section
                    let headerEl = null;
                    for (const el of dDoc.querySelectorAll('b, strong')) {
                        if (el.textContent.trim() === typeName) { headerEl = el; break; }
                    }
                    if (!headerEl) {
                        for (const el of dDoc.querySelectorAll('th, td')) {
                            if (el.textContent.trim() === typeName) { headerEl = el; break; }
                        }
                    }
                    if (!headerEl) continue;

                    // Get the table — either the one containing the header, or the next one after it
                    let tbl = headerEl.closest('table');
                    if (!tbl) {
                        let s = headerEl.parentElement;
                        while (s && s.tagName !== 'BODY') {
                            s = s.nextElementSibling;
                            if (!s) break;
                            if (s.tagName === 'TABLE') { tbl = s; break; }
                            const inner = s.querySelector('table');
                            if (inner) { tbl = inner; break; }
                        }
                    }
                    if (!tbl) continue;

                    tbl.querySelectorAll('tr').forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length < 4) return;
                        const location = cells[0].textContent.trim();
                        const owner    = cells[1].textContent.trim();
                        const maxBet   = cells[2].textContent.trim();
                        // Column layout: City | Owner | Max Bet | Min Bet | Profit | [Raid]
                        const profit   = (cells[4] || cells[3]).textContent.trim();
                        if (!location || location === 'City:' || owner === 'Owner:' || owner === 'Maximum Bet:') return;

                        const id = `${typeSlug}_${location.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'')}`;
                        const cName = `${location} (${typeName})`;
                        const prev = casinoSnapshot[id];
                        if (prev) {
                            if (prev.owner   !== owner   && owner   && prev.owner)   casinoLogEntries.push({ casino_id: id, casino_name: cName, field: 'owner',   old_val: prev.owner,   new_val: owner });
                            if (prev.profit  !== profit  && profit  && prev.profit)  casinoLogEntries.push({ casino_id: id, casino_name: cName, field: 'profit',  old_val: prev.profit,  new_val: profit });
                            if (prev.max_bet !== maxBet  && maxBet  && prev.max_bet) casinoLogEntries.push({ casino_id: id, casino_name: cName, field: 'max_bet', old_val: prev.max_bet, new_val: maxBet });
                        }
                        casinoSnapshot[id] = { owner, profit, max_bet: maxBet };
                        casinoRows.push({ id, name: cName, owner, profit, max_bet: maxBet, updated_at: now });
                    });
                }

                if (casinoRows.length > 0) {
                    save('mf_casino_snap_v1', casinoSnapshot);
                    sbUpsert('casinos', casinoRows);
                    for (const log of casinoLogEntries) {
                        await sbInsert('casino_logs', log);
                        console.log(`[MF Casino] ${log.casino_name}: ${log.field} ${log.old_val} → ${log.new_val}`);
                    }
                    console.log('[MF Casino] Synced', casinoRows.length, 'tables');
                }
            } catch(e) { console.warn('[MF] casino parse error:', e); }

        } catch(e) { console.warn('[MF] stats poll error:', e); }
    }

    // ── ONLINE/OFFLINE INDICATORS ON FAMILY PAGES ─────────────────────────
    function injectOnlineDots() {
        // Users: tablosunu bul
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
            if (!table.textContent.includes('Users:')) continue;
            // Zaten işlenmiş mi?
            if (table.dataset.mfDots) continue;
            table.dataset.mfDots = '1';

            for (const a of table.querySelectorAll('a[href*="user.php?idn="]')) {
                // Zaten dot eklenmişse atla
                if (a.querySelector('.mf-online-dot')) continue;
                const isOnline = a.classList.contains('text-blue');
                const dot = document.createElement('span');
                dot.className = 'mf-online-dot ' + (isOnline ? 'online' : 'offline');
                dot.title = isOnline ? 'Online' : 'Offline';
                a.insertBefore(dot, a.firstChild);
            }
        }
    }

    // Sayfa her yüklendiğinde ve periyodik olarak çalıştır
    function scheduleOnlineDots() {
        injectOnlineDots();
        // MutationObserver ile dinamik değişiklikleri yakala
        const observer = new MutationObserver(() => injectOnlineDots());
        observer.observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scheduleOnlineDots);
    } else {
        scheduleOnlineDots();
    }

    // ── START ─────────────────────────────────────────────────────────────
    async function schedulePoll() {
        // Her tick'te round-robin poll (38 aile) + pollStats (1 global_stats) = 39 istek
        await Promise.all([poll(), pollStats()]);
        setTimeout(schedulePoll, POLL_INTERVAL); // 60sn
    }

    // Sekme tekrar görünür olunca hemen poll yap
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { poll(); pollStats(); }
    });

    // İlk çalıştırma
    pollStats();
    setTimeout(schedulePoll, 2000);

})();
