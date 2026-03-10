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
// @connect      teajgaxzupruukjvrlql.supabase.co
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ── SHADOW DOM PATCH — closed shadow'ları open yap ki erişebilelim ────
    const _attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
        return _attachShadow.call(this, { ...init, mode: 'open' });
    };

    // ── CONFIG — değiştir ──────────────────────────────────────────────────
    const SUPABASE_URL = 'https://teajgaxzupruukjvrlql.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlYWpnYXh6dXBydXVranZybHFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NTM1MTMsImV4cCI6MjA4ODMyOTUxM30.0ssSfLJKxaNDhb8Wo9QWDfHd-4tRaK6Vu9R6FWkEn_U';
    const POLL_INTERVAL = 60 * 1000;
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
                        'Prefer': 'resolution=merge-duplicates'
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
    // Eğer tüm değerler 0 ise bozuk cache, temizle
    if (Object.keys(famMemberCounts).length > 0 && Object.values(famMemberCounts).every(v => v === 0)) {
        famMemberCounts = {};
        save('mf_fam_counts_v1', {});
        console.log('[MF] Bozuk count cache temizlendi');
    }

    // ── FAMILY PAGE FETCH — sadece değişen aileler için ───────────────────
    async function fetchFamilyPage(famId, famName, rows, seenIds, pendingEvents) {
        try {
            const res = await fetch(`/family.php?fam=${famId}`, {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const userTable = [...doc.querySelectorAll('table')].find(t => t.textContent.includes('Users:'));
            if (!userTable) return;

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
                    snapshot[id] = { name, rank, family: famName, plating: plating.label, platingColor: plating.color };
                    rows.push({ id, name, rank, family: famName, plating: plating.label, plating_color: plating.color, updated_at: now });
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

    // ── ROUND-ROBIN STATE ─────────────────────────────────────────────────
    const SLOTS_PER_TICK = 38; // dakikada 38 aile + 1 global_stats = 39 istek
    let rrIndex = 0;            // sonraki başlangıç noktası

    // ── MAIN POLL — round-robin: her tick'te 38 aile sayfası ─────────────
    async function poll() {
        dotEl.className = 'loading';
        try {
            if (!famIds.length) { dotEl.className = 'active'; return; }

            const rows = [];
            const seenIds = new Set();
            const pendingEvents = [];
            const total = famIds.length;

            // 38 slot al (wrap-around)
            const batch = [];
            for (let i = 0; i < Math.min(SLOTS_PER_TICK, total); i++) {
                batch.push(famIds[(rrIndex + i) % total]);
            }
            rrIndex = (rrIndex + SLOTS_PER_TICK) % total;

            // 5'erli gruplar halinde fetch et
            for (let i = 0; i < batch.length; i += 5) {
                const chunk = batch.slice(i, i + 5);
                await Promise.all(chunk.map(f => fetchFamilyPage(f.id, f.name, rows, seenIds, pendingEvents)));
            }

            const seen = {};
            for (const r of rows) seen[r.id] = r;
            const uniqueRows = Object.values(seen);

            if (uniqueRows.length > 0) sbUpsert('users', uniqueRows);
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
                        if (nameEl && city) {
                            const fname = nameEl.textContent.trim();
                            const fidM = nameEl.href?.match(/fam=(\d+)/);
                            familyRows.push({ name: fname, city, updated_at: new Date().toISOString() });
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
                            'Prefer': 'resolution=merge-duplicates'
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

        } catch(e) { console.warn('[MF] stats poll error:', e); }
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

    // Lackey otomatik aktifleştirme — cb-lb checkbox DOM'a eklenince hemen tıkla
    function clickCbLb() {
        document.querySelectorAll('label.cb-lb').forEach(label => {
            const cb = label.querySelector('input[type="checkbox"]');
            if (cb && !cb.checked) {
                const visual = label.querySelector('span.cb-i');
                (visual || label).click();
                console.log('[MF] Lackey checkbox tıklandı');
            }
        });
    }
    clickCbLb(); // sayfa yüklenince bir kez dene
    new MutationObserver(clickCbLb).observe(document.body, { childList: true, subtree: true });

    // İlk çalıştırma
    pollStats();
    setTimeout(schedulePoll, 2000);

})();
