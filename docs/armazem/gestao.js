/* ============================================================
   TerraVia Armazém — GESTÃO (notebook). Segue o "Sistema de design":
   Visão geral · Mapa do galpão · Endereços · Itens · Campanhas ·
   Divergências · Perdas e Acuracidade · Etiquetas · Auditoria.
   Quem pode o quê é decidido pelo BANCO (RLS). Aqui, `ctx.canWrite` só
   desabilita os botões de escrita pra quem não tem permissão (Gestor Vale).
   ============================================================ */
(function () {
    'use strict';
    const { sb, esc, fmt, toast, openModal, closeModal, fetchAll, uuid, norm, store, isNetErr, qrPayload, qrGrid, qrMatrix, ruaColor } = TV;

    const KIND_LABEL = { ARMAZEM: 'Armazém', RUA: 'Rua', PRATELEIRA: 'Prateleira', NIVEL: 'Nível', POSICAO: 'Posição' };
    const KIND_PLURAL = { ARMAZEM: 'Armazéns', RUA: 'Ruas', PRATELEIRA: 'Prateleiras', NIVEL: 'Níveis', POSICAO: 'Posições' };
    const KIND_ORDER = ['ARMAZEM', 'RUA', 'PRATELEIRA', 'NIVEL', 'POSICAO'];
    // [rótulo, estágio do ciclo, cor]
    const CAMP = { RASCUNHO: ['Rascunho', 0, '#5b6b82'], ATIVA: ['Ativa', 1, '#10b981'], FECHADA: ['Fechada', 2, '#3b82f6'], CANCELADA: ['Cancelada', -1, '#ef4444'] };
    // status de linha de contagem: [classe, ícone, rótulo]  (ícone + texto, nunca só cor)
    const ST = {
        APROVADO: ['st-info', '✓', 'Aprovado'], CONFERE: ['st-ok', '✓', 'Confere'], CONTADO: ['', '●', 'Contado'],
        DIVERGENTE: ['st-err', '!', 'Divergente'], RECONTAGEM: ['st-warn', '↻', 'Recontagem'], PENDENTE_2A_CONTAGEM: ['st-seal', '◆', 'Falta 2ª conferência']
    };
    const CRIT = { NORMAL: ['Normal', ''], ALTO_VALOR: ['Alto valor', 'st-warn'], CRITICO: ['Crítico', 'st-err'] };
    const NAV = [
        ['visao', 'Visão geral', 'M3 3h7v8H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 15h7v6H3z'],
        ['mapa', 'Mapa do galpão', 'M3 4h18v16H3zM3 9.5h18M3 14.5h18M8 4v16'],
        ['enderecos', 'Endereços', 'M4 4h6v6H4zM14 14h6v6h-6zM7 10v7h7'],
        ['itens', 'Itens', 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10'],
        ['campanhas', 'Campanhas', 'M5 21V4h12l-2.5 4 2.5 4H5'],
        ['divergencias', 'Divergências', 'M12 3l10 18H2zM12 10v5M12 18v.5'],
        ['perdas', 'Perdas e Acuracidade', 'M5 20V11M11 20V5M17 20v-6M3 20h18'],
        ['etiquetas', 'Etiquetas', 'M3 3h9l9 9-9 9-9-9zM8 8h.5'],
        ['auditoria', 'Auditoria', 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5']
    ];
    const MOD = {
        a4x10: { l: 'A4 · 2 × 5', s: '10 por folha · 99 × 57 mm', per: 10, size: '99 × 57 mm', cols: 2, rows: 5, w: 99, h: 57 },
        a4x8: { l: 'A4 · 2 × 4', s: '8 por folha · 99 × 67 mm', per: 8, size: '99 × 67 mm', cols: 2, rows: 4, w: 99, h: 67 },
        term: { l: 'Térmica 100 × 50', s: 'rolo contínuo · 1 por etiqueta', per: 1, size: '100 × 50 mm', cols: 1, rows: 1, w: 100, h: 50 }
    };

    const S = {
        ctx: null, site: null, tab: 'visao', side: window.innerWidth >= 1366, timer: null, offline: false, offlineAt: null,
        locs: [], byId: new Map(), byFull: new Map(), byToken: new Map(), kids: new Map(), ruas: [], under: new Map(),
        items: [], itemById: new Map(), costs: new Map(), where: [], whereByItem: new Map(),
        teams: [], members: [], people: [],
        campaigns: [], assignments: [], progress: [], campId: null,
        cd: { closures: [], cons: [], expected: new Map(), tasks: [], events: [], loadedFor: null },
        selRua: null, layer: 'pct', selLoc: null, expanded: new Set(), treeQ: '',
        itemQ: '', crit: 'todos', contStatus: '', contQ: '', q: '',
        etq: { ruas: new Set(), de: 1, ate: 99, modelo: 'a4x10' }, audFilter: 'todos', aud: null
    };

    const $ = id => document.getElementById(id);
    let handlers = {};
    const stop = () => { if (S.timer) { clearInterval(S.timer); S.timer = null; } };
    async function guarded(fn) { try { return await fn(); } catch (e) { toast(e && e.message ? e.message : String(e), 'err'); } }
    const campaign = () => S.campaigns.find(c => c.id === S.campId) || null;
    function setCamp(id) { S.campId = id; store.set('tv_arm_camp_' + S.site, id); S.cd.loadedFor = null; }
    const stBadge = s => { const [c, i, l] = ST[s] || ['', '', s]; return `<span class="st ${c}">${i} ${esc(l)}</span>`; };
    const critBadge = c => c === 'NORMAL' ? '<span class="muted">Normal</span>' : `<span class="st ${CRIT[c][1]}">${CRIT[c][0]}</span>`;
    const seal = '<span class="st st-seal">◆ Dupla conferência</span>';
    const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
    const pgHead = (eyebrow, title, right) => `<div class="pg-head"><div><div class="eyebrow">${eyebrow}</div><h1 class="h1">${esc(title)}</h1></div>${right ? `<div class="actions">${right}</div>` : ''}</div>`;
    const panel = (title, body, headRight, noPad) => `<section class="panel"><div class="panel-h"><span>${title}</span>${headRight || ''}</div>${noPad ? body : `<div class="panel-b">${body}</div>`}</section>`;
    const sameTol = (a, b, camp) => Math.abs(a - b) <= Math.max(Number(camp.tolerance_qty) || 0, (Number(camp.tolerance_pct) || 0) / 100 * Math.max(a, b));
    const nat = (a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true });

    // ============================================================
    // CARREGAMENTO
    // ============================================================
    function indexLocs() {
        S.byId = new Map(); S.byFull = new Map(); S.byToken = new Map(); S.kids = new Map(); S.under = new Map();
        for (const l of S.locs) {
            S.byId.set(l.id, l); S.byFull.set(l.full_code, l); S.byToken.set(l.qr_token, l);
            const k = l.parent_id || 'root';
            if (!S.kids.has(k)) S.kids.set(k, []);
            S.kids.get(k).push(l);
        }
        for (const arr of S.kids.values()) arr.sort((a, b) => nat(a.code, b.code));
        S.ruas = S.locs.filter(l => l.kind === 'RUA' && l.active).sort((a, b) => nat(a.code, b.code));
        for (const l of S.locs) {
            if (!(l.is_countable && l.active)) continue;
            for (const p of (l.path || [])) { if (!S.under.has(p)) S.under.set(p, []); S.under.get(p).push(l); }
        }
    }
    async function loadLocs() {
        S.locs = await fetchAll((f, t) => sb.from('wh_locations')
            .select('id, parent_id, kind, code, full_code, qr_token, path, is_countable, active')
            .eq('site_key', S.site).order('full_code').range(f, t));
        indexLocs();
        if (!S.etq.ruas.size && S.ruas.length) S.etq.ruas.add(S.ruas[0].id);
    }
    async function loadItems() {
        const [items, where] = await Promise.all([
            fetchAll((f, t) => sb.from('wh_items').select('id, code, vale_material_code, description, uom, criticality, criticality_source, abc_class, active').eq('site_key', S.site).order('code').range(f, t)),
            fetchAll((f, t) => sb.from('v_wh_item_whereabouts').select('item_id, location_id, location_code, final_qty').eq('site_key', S.site).range(f, t)).catch(() => [])
        ]);
        S.items = items; S.itemById = new Map(items.map(i => [i.id, i]));
        S.where = where; S.whereByItem = new Map();
        for (const w of where) { if (!S.whereByItem.has(w.item_id)) S.whereByItem.set(w.item_id, []); S.whereByItem.get(w.item_id).push(w); }
        S.costs = new Map();
        try { const cs = await fetchAll((f, t) => sb.from('wh_item_costs').select('item_id, unit_cost').eq('site_key', S.site).range(f, t)); for (const c of cs) S.costs.set(c.item_id, Number(c.unit_cost)); } catch (e) { /* sem permissão */ }
    }
    async function loadTeams() {
        const [t, m, p] = await Promise.all([
            sb.from('wh_teams').select('id, name').eq('site_key', S.site).order('name'),
            sb.from('wh_team_members').select('team_id, profile_id').eq('site_key', S.site),
            sb.rpc('wh_site_people', { p_site: S.site })       // a tabela profiles não é legível pelo supervisor
        ]);
        if (t.error) throw t.error;
        S.teams = t.data || []; S.members = m.data || []; S.people = p.data || [];
    }
    async function loadCampaigns() {
        const [c, a, p] = await Promise.all([
            sb.from('wh_campaigns').select('*').eq('site_key', S.site).order('created_at', { ascending: false }),
            sb.from('wh_campaign_assignments').select('*').eq('site_key', S.site),
            sb.from('v_wh_campaign_progress').select('*').eq('site_key', S.site)
        ]);
        if (c.error) throw c.error;
        S.campaigns = c.data || []; S.assignments = a.data || []; S.progress = p.data || [];
        const saved = store.get('tv_arm_camp_' + S.site, null);
        if (!S.campaigns.find(x => x.id === S.campId)) {
            S.campId = (S.campaigns.find(x => x.id === saved) || S.campaigns.find(x => x.status === 'ATIVA') || S.campaigns[0] || {}).id || null;
        }
    }
    // dados da campanha selecionada (alimentam visão geral, mapa, endereços e divergências)
    async function loadCD() {
        const camp = campaign();
        if (!camp) { S.cd = { closures: [], cons: [], expected: new Map(), tasks: [], events: [], loadedFor: null }; return; }
        const [closures, cons, expected, tasks, events, prog] = await Promise.all([
            fetchAll((f, t) => sb.from('wh_count_closures').select('location_id, round, counted_by, counted_by_label, finished_at').eq('campaign_id', camp.id).range(f, t)),
            fetchAll((f, t) => sb.from('v_wh_count_consolidated').select('*').eq('campaign_id', camp.id).order('location_code').range(f, t)),
            fetchAll((f, t) => sb.from('wh_expected_stock').select('location_id, item_id, qty_expected').eq('campaign_id', camp.id).range(f, t)).catch(() => []),
            sb.from('wh_recount_tasks').select('id, location_id, round, created_at').eq('campaign_id', camp.id).eq('status', 'ABERTA'),
            sb.from('wh_count_events').select('id, location_id, item_id, qty, round, counted_by_label, counted_at').eq('campaign_id', camp.id).order('counted_at', { ascending: false }).limit(12),
            sb.from('v_wh_campaign_progress').select('*').eq('site_key', S.site)
        ]);
        S.cd = {
            closures, cons, tasks: tasks.data || [], events: events.data || [], loadedFor: camp.id,
            expected: new Map(expected.map(e => [e.location_id + ':' + e.item_id, Number(e.qty_expected)]))
        };
        if (!prog.error) S.progress = prog.data || [];
    }
    // carrega mantendo a última versão se a rede cair (banner "Sem conexão")
    async function safeLoadCD() {
        try { await loadCD(); S.offline = false; S.offlineAt = null; }
        catch (e) { if (!isNetErr(e)) throw e; S.offline = true; S.offlineAt = S.offlineAt || new Date(); if (S.cd.loadedFor == null) throw e; }
        renderBanners();
    }
    async function reloadAll() {
        await Promise.all([loadLocs(), loadItems(), loadTeams(), loadCampaigns()]);
        await safeLoadCD();
    }

    // ============================================================
    // MÉTRICAS (calculadas no navegador a partir do que já foi carregado)
    // ============================================================
    function metrics() {
        const camp = campaign() || {};
        const cd = S.cd;
        const leaves = S.locs.filter(l => l.is_countable && l.active);
        const closed1 = new Set(cd.closures.filter(c => c.round === 1).map(c => c.location_id));
        const divLoc = new Map();
        for (const r of cd.cons) if (r.status === 'DIVERGENTE') divLoc.set(r.location_id, (divLoc.get(r.location_id) || 0) + 1);
        const pr = S.progress.filter(p => p.campaign_id === S.campId && p.round === 1);
        const total = pr.length ? pr.reduce((s, p) => s + Number(p.total_addresses || 0), 0) : leaves.length;
        const done = pr.length ? pr.reduce((s, p) => s + Number(p.counted_addresses || 0), 0) : leaves.filter(l => closed1.has(l.id)).length;
        const pct = total ? 100 * done / total : 0;
        const now = Date.now();
        const lastHour = cd.closures.filter(c => c.round === 1 && now - new Date(c.finished_at).getTime() < 3600000).length;
        const eta = lastHour > 0 && total > done ? new Date(now + (total - done) / lastHour * 3600000) : null;
        // acuracidade: das linhas que já têm 2ª contagem, quantas bateram com a 1ª
        const two = cd.cons.filter(r => r.r2 != null);
        const hit = two.filter(r => sameTol(Number(r.r1) || 0, Number(r.r2) || 0, camp)).length;
        const acc = two.length ? 100 * hit / two.length : null;
        const cnt = st => cd.cons.filter(r => r.status === st).length;
        const divCrit = cd.cons.filter(r => r.status === 'DIVERGENTE' && r.criticality !== 'NORMAL').length;
        // produtividade por equipe (hoje)
        const teamOf = new Map(S.members.map(m => [m.profile_id, m.team_id]));
        const day0 = new Date(); day0.setHours(0, 0, 0, 0);
        const todays = cd.closures.filter(c => new Date(c.finished_at) >= day0);
        const byTeam = new Map();
        for (const c of todays) {
            const tid = teamOf.get(c.counted_by) || '_';
            if (!byTeam.has(tid)) byTeam.set(tid, []);
            byTeam.get(tid).push(c);
        }
        const hNow = new Date().getHours(), h0 = Math.max(0, Math.min(7, hNow));
        const teams = [...byTeam.entries()].map(([tid, arr]) => {
            const t = S.teams.find(x => x.id === tid);
            const hours = [];
            for (let h = h0; h <= Math.max(hNow, h0); h++) hours.push([h, arr.filter(c => new Date(c.finished_at).getHours() === h).length]);
            const spanH = Math.max(1, (now - Math.min(...arr.map(c => new Date(c.finished_at).getTime()))) / 3600000);
            const ruas = S.assignments.filter(a => a.campaign_id === S.campId && a.team_id === tid && a.round === 1).map(a => (S.byId.get(a.location_id) || {}).code).filter(Boolean);
            return { name: t ? t.name : 'Sem equipe', n: t ? S.members.filter(m => m.team_id === tid).length : 0, tot: arr.length, rate: arr.length / spanH, hours, ruas };
        }).sort((a, b) => b.tot - a.tot);
        return { camp, leaves, closed1, divLoc, total, done, pct, lastHour, eta, acc, twoCount: two.length, cnt, divCrit, teams, linhas: cd.cons.length };
    }
    function alertsList(m) {
        const out = [];
        const crit = S.cd.cons.find(r => r.status === 'DIVERGENTE' && r.criticality !== 'NORMAL');
        if (crit) out.push({ cls: 'err', i: '!', t: 'Divergência em item crítico', d: `${crit.location_code} · ${crit.item_description} · ${fmt.num(crit.r1)} × ${fmt.num(crit.r2)}`, cta: 'Revisar', go: () => { S.contStatus = 'DIVERGENTE'; go('divergencias'); } });
        else if (m.cnt('DIVERGENTE')) out.push({ cls: 'err', i: '!', t: `${m.cnt('DIVERGENTE')} divergências abertas`, d: 'Contagens diferentes aguardando decisão da supervisão.', cta: 'Revisar', go: () => { S.contStatus = 'DIVERGENTE'; go('divergencias'); } });
        if (S.cd.tasks.length) {
            const oldest = Math.min(...S.cd.tasks.map(t => new Date(t.created_at).getTime()));
            const h = Math.max(1, Math.round((Date.now() - oldest) / 3600000));
            const l = S.byId.get(S.cd.tasks[0].location_id);
            out.push({ cls: 'warn', i: '↻', t: `${S.cd.tasks.length} recontagem${S.cd.tasks.length > 1 ? 'ões' : ''} pendente${S.cd.tasks.length > 1 ? 's' : ''}`, d: `${l ? l.full_code + ' · ' : ''}mais antiga há ${h} h`, cta: 'Ver', go: () => { S.contStatus = 'RECONTAGEM'; go('divergencias'); } });
        }
        const falta2 = m.cnt('PENDENTE_2A_CONTAGEM');
        if (falta2) out.push({ cls: 'warn', i: '◆', t: `${falta2} item${falta2 > 1 ? 's' : ''} aguardando dupla conferência`, d: 'Itens críticos/alto valor precisam de duas pessoas contando.', cta: 'Ver', go: () => { S.contStatus = 'PENDENTE_2A_CONTAGEM'; go('divergencias'); } });
        const pr = S.progress.filter(p => p.campaign_id === S.campId && p.round === 1 && Number(p.total_addresses) > 0);
        if (pr.length > 1) {
            const mx = Math.max(...pr.map(p => Number(p.pct_done) || 0));
            const low = pr.filter(p => mx - (Number(p.pct_done) || 0) >= 25).sort((a, b) => a.pct_done - b.pct_done)[0];
            if (low) out.push({ cls: 'warn', i: '▼', t: `Rua ${(S.byId.get(low.assigned_location_id) || {}).code || ''} abaixo do ritmo`, d: `${fmt.pct(low.pct_done)} concluída · a mais adiantada está em ${fmt.pct(mx)}`, cta: 'Ver rua', go: () => { S.selRua = low.assigned_location_id; go('mapa'); } });
        }
        return out;
    }

    // ============================================================
    // CASCA: menu, topo, faixas de aviso, busca global
    // ============================================================
    function initials(n) { return String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase(); }
    function renderShell() {
        const c = S.ctx, camp = campaign();
        const m = camp ? metrics() : null;
        const divN = camp ? S.cd.cons.filter(r => r.status === 'DIVERGENTE').length : 0;
        $('app').innerHTML = `
        <aside class="sb ${S.side ? 'pinned' : 'collapsed'}" id="sb">
            <div class="sb-head"><div class="logo">TV</div><div><div class="sb-title">TerraVia Ops</div><div class="sb-sub">Sodexo × Vale</div></div></div>
            <nav class="sb-nav" aria-label="Módulo Armazém"><div class="sb-sec">Armazém</div>
                ${NAV.map(([k, l, d]) => `<button class="nav-btn ${S.tab === k ? 'on' : ''}" data-tab="${k}" title="${l}" ${S.tab === k ? 'aria-current="page"' : ''}>${svg(d)}<span class="lbl">${l}</span>${k === 'divergencias' && divN ? `<span class="nav-badge">${divN}</span>` : ''}</button>`).join('')}
            </nav>
            <div class="sb-foot">
                ${c.role === 'ARM_SUPERVISOR' ? '<a href="index.html?ir=campo">Modo campo (celular) ↗</a>' : ''}
                ${c.role === 'ADMIN' ? '<a href="../index.html">Usuários (app principal) ↗</a>' : ''}
                <button id="btn-side"><span style="width:20px;text-align:center;font-size:16px">${S.side ? '«' : '»'}</span><span class="txt">Recolher menu</span></button>
                <button id="btn-logout"><span style="width:20px;text-align:center">⎋</span><span class="txt">Sair</span></button>
            </div>
        </aside>
        <div class="main-col">
            <header class="top">
                <div class="site-btn"><small>Site</small>${c.sites.length > 1 ? `<select id="site-sel">${c.sites.map(s => `<option value="${esc(s.key)}" ${s.key === S.site ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>` : `<b>${esc((c.sites[0] || {}).label || '')}</b>`}</div>
                ${camp ? `<div class="camp-pill ${camp.status === 'ATIVA' ? '' : 'off'}" data-tab="campanhas" title="Campanhas"><span class="dot" style="${camp.status === 'ATIVA' ? '' : 'background:' + CAMP[camp.status][2]}"></span><b>${esc(camp.name)}</b><small>${CAMP[camp.status][0]}${camp.status === 'ATIVA' ? ' · ' + fmt.pct(Math.round(m.pct)) : ''}</small></div>` : ''}
                <div class="gsearch"><input id="gs-in" placeholder="Onde está o item? Código, material Vale ou descrição" aria-label="Busca global" autocomplete="off" value="${esc(S.q)}">
                    <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><div id="gs-res"></div></div>
                <div class="user-chip"><span class="avatar">${esc(initials(c.profile.name))}</span><span class="who"><b>${esc(c.profile.name)}</b><small>${esc(TV.ROLE_LABEL[c.role] || c.role)}</small></span></div>
            </header>
            <div id="banners"></div>
            <main class="page" id="page"></main>
        </div>`;
        document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
        $('btn-logout').addEventListener('click', () => TV.signOut());
        $('btn-side').addEventListener('click', () => { S.side = !S.side; $('sb').className = 'sb ' + (S.side ? 'pinned' : 'collapsed'); $('btn-side').firstChild.textContent = S.side ? '«' : '»'; });
        const ss = $('site-sel');
        if (ss) ss.addEventListener('change', async () => { S.site = ss.value; store.set('tv_arm_site', S.site); S.campId = null; await guarded(reloadAll); go(S.tab); });
        const gi = $('gs-in');
        gi.addEventListener('input', () => { S.q = gi.value; paintSearch(); });
        gi.addEventListener('focus', paintSearch);
        renderBanners();
    }
    // fecha a lista da busca global ao clicar fora (um único ouvinte, criado uma vez)
    document.addEventListener('mousedown', e => { const r = document.getElementById('gs-res'); if (r && !(e.target.closest && e.target.closest('.gsearch'))) r.innerHTML = ''; });
    function renderBanners() {
        const b = $('banners'); if (!b) return;
        let h = '';
        if (S.offline) h += `<div class="banner warn" role="status"><b>⚠ Sem conexão com o servidor.</b><span>Exibindo dados de ${fmt.time(S.offlineAt)}. As contagens dos operadores ficam salvas nos celulares e são enviadas quando o sinal voltar. Reconectando…</span></div>`;
        if (!S.ctx.canWrite) h += '<div class="banner ro"><span class="tag">Somente leitura</span>Perfil Gestor Vale: você acompanha tudo, mas aprovações e edições ficam com a supervisão Sodexo.</div>';
        b.innerHTML = h;
    }
    function paintSearch() {
        const box = $('gs-res'); if (!box) return;
        const q = norm(S.q.trim());
        if (q.length < 2) { box.innerHTML = ''; return; }
        const res = S.items.filter(i => norm(`${i.code} ${i.vale_material_code || ''} ${i.description}`).includes(q)).slice(0, 5);
        box.innerHTML = `<div class="gs-results"><div class="gs-h">${res.length ? 'Itens encontrados' : 'Resultado'}</div>
            ${res.map(i => { const w = S.whereByItem.get(i.id) || []; return `<button class="gs-item" data-gs="${i.id}"><span><span class="id">${esc(i.code)}</span><b>${esc(i.description)}</b></span><span class="where">Está em: ${w.length ? w.map(x => `<b>${esc(x.location_code)}</b> (${fmt.num(x.final_qty)} ${esc(i.uom)})`).join(' · ') : 'sem contagem aprovada ainda'}</span></button>`; }).join('')}
            ${res.length ? '' : `<div style="padding:16px 14px" class="muted">Nenhum item encontrado para “${esc(S.q)}”.</div>`}</div>`;
        box.querySelectorAll('[data-gs]').forEach(b => b.addEventListener('mousedown', () => {
            const id = b.dataset.gs, w = S.whereByItem.get(id) || [];
            S.q = ''; $('gs-in').value = ''; box.innerHTML = '';
            if (w.length) { S.selLoc = w[0].location_id; expandTo(S.selLoc); go('enderecos'); }
            else { S.itemQ = (S.itemById.get(id) || {}).code || ''; go('itens'); }
        }));
    }
    function expandTo(locId) { let l = S.byId.get(locId); while (l && l.parent_id) { S.expanded.add(l.parent_id); l = S.byId.get(l.parent_id); } }

    function skeleton() {
        return `<div aria-busy="true" style="display:flex;flex-direction:column;gap:20px"><div class="skel" style="width:240px;height:30px;border-radius:6px"></div>
            <div style="display:flex;gap:16px;flex-wrap:wrap">${[1, 2, 3, 4, 5].map(() => '<div class="skel" style="flex:1 1 180px;height:116px"></div>').join('')}</div>
            <div class="grid-auto"><div class="skel" style="height:300px"></div><div class="skel" style="height:300px"></div></div></div>`;
    }
    function statePanel(kind, tela, title, text, cta, action) {
        const k = { vazio: ['+', 'rgba(37,99,235,.14)', 'rgba(96,165,250,.5)', '#93c5fd'], erro: ['!', 'rgba(239,68,68,.12)', 'rgba(239,68,68,.5)', '#fca5a5'] }[kind];
        return `<div class="state-panel"><div class="in"><div class="ic" style="background:${k[1]};border-color:${k[2]};color:${k[3]}">${k[0]}</div>
            <div class="eyebrow">${esc(tela)}</div><h2>${esc(title)}</h2><p>${text}</p>
            ${cta ? `<div class="actions"><button class="btn btn-primary" data-act="${action || 'retry'}">${esc(cta)}</button></div>` : ''}</div></div>`;
    }
    function bindView(map) {
        handlers = map || {};
        $('page').onclick = ev => {
            const b = ev.target.closest('[data-act]');
            if (!b) return;
            const fn = handlers[b.dataset.act] || (b.dataset.act === 'retry' ? () => go(S.tab) : null);
            if (fn) guarded(() => fn(b.dataset, b, ev));
        };
    }
    function paint(html, map) { $('page').innerHTML = html; bindView(map); }
    const ctaRO = () => S.ctx.canWrite ? '' : 'disabled';
    const VIEWS = () => ({ visao: viewVisao, mapa: viewMapa, enderecos: viewEnderecos, itens: viewItens, campanhas: viewCampanhas, divergencias: viewDiv, perdas: viewPerdas, etiquetas: viewEtiquetas, auditoria: viewAuditoria });

    async function go(tab) {
        stop();
        S.tab = tab;
        renderShell();
        $('page').innerHTML = skeleton();
        try {
            if (['visao', 'mapa', 'enderecos', 'divergencias'].includes(tab) && S.cd.loadedFor !== S.campId) await safeLoadCD();
            await VIEWS()[tab]();
        } catch (e) {
            paint(statePanel('erro', (NAV.find(n => n[0] === tab) || [])[1] || '', 'Não foi possível carregar os dados', `${esc(e.message || e)}<br><span class="muted">As contagens no celular dos operadores continuam salvas e serão enviadas.</span>`, 'Tentar novamente'));
        }
    }
    // atualiza sozinho (visão geral e mapa) sem recarregar a casca nem perder o scroll
    function liveRefresh(tabName) {
        S.timer = setInterval(async () => {
            if (document.getElementById('modal-bg') || S.tab !== tabName) return;
            try { await safeLoadCD(); await loadCampaigns(); if (S.tab === tabName) { const y = window.scrollY; VIEWS()[tabName](true); window.scrollTo(0, y); } } catch (e) { /* tenta de novo no próximo ciclo */ }
        }, 20000);
    }
    const emptyCamp = tela => statePanel('vazio', tela, 'Nenhuma campanha ativa', 'Crie uma campanha e atribua as ruas às equipes para acompanhar o inventário ao vivo.', 'Ir para Campanhas', 'gocamp');

    // ============================================================
    // 1. VISÃO GERAL
    // ============================================================
    function viewVisao(isRefresh) {
        const camp = campaign();
        if (!camp) { paint(emptyCamp('Visão geral'), { gocamp: () => go('campanhas') }); return; }
        const m = metrics(), al = alertsList(m);
        const pr = S.progress.filter(p => p.campaign_id === camp.id && p.round === 1).sort((a, b) => nat(a.assigned_code, b.assigned_code));
        const ruaIdx = id => Math.max(0, S.ruas.findIndex(r => r.id === id));
        const dEta = m.eta ? m.eta.toLocaleDateString('pt-BR') : '—';
        paint(`
        ${pgHead(`${esc(camp.name)} · ${CAMP[camp.status][0].toLowerCase()}`, 'Visão geral', `<span class="live"><span class="dot pulse"></span>Ao vivo · atualizado às ${fmt.time(new Date())}</span>${S.campaigns.length > 1 ? `<select id="camp-sel" style="width:auto">${S.campaigns.map(c => `<option value="${c.id}" ${c.id === S.campId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}`)}
        <div class="kpis">
            <div class="kpi-hero"><div class="kpi-l">Conclusão da campanha</div>
                <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap"><span class="big">${fmt.pct(Math.round(m.pct))}</span><span style="font-size:15px;color:var(--text-body-2)"><b style="color:#fff">${fmt.int(m.done)}</b> de ${fmt.int(m.total)} endereços contados</span></div>
                <div class="bar lg" role="progressbar" aria-valuenow="${Math.round(m.pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${m.pct}%"></i></div>
                <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);gap:12px;flex-wrap:wrap"><span>Ritmo atual: ${m.lastHour ? fmt.int(m.lastHour) + ' endereços/h' : 'sem contagem na última hora'}</span><span>Previsão de término: ${dEta}</span></div></div>
            <div class="kpi2" style="--c:var(--blue)"><div class="kpi-l">Itens contados</div><div class="kpi-v">${fmt.int(m.linhas)}</div><div class="kpi-n">combinações endereço × item</div></div>
            <div class="kpi2" style="--c:var(--green)"><div class="kpi-l">Acuracidade</div><div class="kpi-v">${m.acc == null ? '—' : fmt.pct(Number(m.acc.toFixed(1)))}</div><div class="kpi-n" style="color:var(--green-text)">${m.acc == null ? 'ainda sem 2ª contagem' : fmt.int(m.twoCount) + ' linhas com 2ª contagem'}</div></div>
            <div class="kpi2" style="--c:var(--red)"><div class="kpi-l">Divergências abertas</div><div class="kpi-v">${fmt.int(m.cnt('DIVERGENTE'))}</div><div class="kpi-n" style="color:var(--red-text)">${m.divCrit ? '! ' + m.divCrit + ' em itens críticos' : fmt.int(m.cnt('RECONTAGEM')) + ' em recontagem'}</div></div>
        </div>
        <div class="grid-auto">
            ${panel('Progresso por rua', pr.length ? `<div style="display:flex;flex-direction:column;gap:14px">${pr.map(p => { const loc = S.byId.get(p.assigned_location_id) || {}; return `<div class="rua-row"><span class="nm"><span class="sw" style="background:${ruaColor(ruaIdx(p.assigned_location_id))}"></span>${loc.kind === 'RUA' ? 'Rua ' : ''}${esc(loc.code || p.assigned_code)}</span><div class="bar"><i style="width:${Math.min(100, Number(p.pct_done) || 0)}%;background:${(Number(p.pct_done) || 0) < 50 ? 'var(--amber)' : 'var(--blue)'}"></i></div><b class="right tnum">${fmt.pct(Math.round(p.pct_done || 0))}</b><span class="right muted tnum" style="font-size:12px">${p.counted_addresses} / ${p.total_addresses}</span></div>`; }).join('')}</div>` : '<div class="empty-box">Nenhuma rua atribuída. Atribua ruas às equipes em Campanhas.</div>', '<button class="btn-link" data-act="gomapa">Ver no mapa →</button>')}
            ${panel('Produtividade por equipe', m.teams.length ? `<div style="display:flex;flex-direction:column;gap:18px">${m.teams.map(t => { const mx = Math.max(1, ...t.hours.map(h => h[1])); return `<div class="team-row"><div style="display:flex;flex-direction:column;gap:4px"><span><b>${esc(t.name)}</b> <span class="muted">· ${t.n} pessoa${t.n === 1 ? '' : 's'}</span></span><span class="muted" style="font-size:12px">${t.ruas.length ? 'Ruas ' + esc(t.ruas.join(', ')) : ''}</span><span style="display:flex;align-items:baseline;gap:8px;margin-top:6px"><span style="font-size:28px;font-weight:700;line-height:1" class="tnum">${t.tot}</span><span class="muted" style="font-size:13px">endereços · ${fmt.num(t.rate, 1)} end./h</span></span></div><div class="bars" aria-label="${esc(t.name)} por hora">${t.hours.map((h, i) => `<i class="${i === t.hours.length - 1 ? 'now' : ''}" title="${h[0]}h: ${h[1]}" style="height:${Math.max(3, 60 * h[1] / mx)}px"></i>`).join('')}</div></div>`; }).join('')}<div style="text-align:right;font-size:11px;color:var(--text-muted)">${m.teams[0].hours[0][0]}h → ${m.teams[0].hours[m.teams[0].hours.length - 1][0]}h · barra clara = hora atual</div></div>` : '<div class="empty-box">Nenhum endereço finalizado hoje.</div>', '<small>Hoje · endereços por hora</small>')}
        </div>
        <div class="grid-auto">
            ${panel('<span style="display:flex;align-items:center;gap:8px"><span class="dot pulse" style="background:var(--red)"></span>Últimas contagens</span>', S.cd.events.length ? S.cd.events.map(e => { const l = S.byId.get(e.location_id), it = S.itemById.get(e.item_id); return `<div class="feed-row"><span class="mono muted" style="font-size:12px">${fmt.time(e.counted_at)}</span><span class="mono" style="font-size:12px;color:var(--blue-text)">${esc(l ? l.full_code : '—')}</span><span style="display:flex;flex-direction:column;min-width:0"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${it ? esc(it.description) : '<span class="muted">endereço vazio / sem cadastro</span>'}</span><span class="muted" style="font-size:12px">${esc(e.counted_by_label || '—')} · ${e.round}ª contagem</span></span><b class="nowrap tnum">${fmt.num(e.qty)}${it ? ' ' + esc(it.uom) : ''}</b></div>`; }).join('') : '<div class="empty-box" style="margin:18px">Assim que o campo lançar, aparece aqui.</div>', '<small>tempo real</small>', true)}
            ${panel('Alertas pendentes', al.length ? `<div style="display:flex;flex-direction:column;gap:10px">${al.slice(0, 4).map((a, i) => `<div class="alert-row ${a.cls}"><span class="ic">${a.i}</span><div class="tx"><b>${esc(a.t)}</b><span>${esc(a.d)}</span></div><button class="btn btn-sm btn-card" data-act="alert" data-i="${i}">${esc(a.cta)}</button></div>`).join('')}</div>` : '<div class="empty-box">Nenhum alerta. Tudo em dia.</div>', `<small style="color:var(--red-text);font-weight:600">${al.length ? al.length + ' abertos' : ''}</small>`)}
        </div>`, { gomapa: () => go('mapa'), alert: d => al[Number(d.i)].go() });
        const cs = $('camp-sel'); if (cs) cs.addEventListener('change', () => { setCamp(cs.value); go('visao'); });
        if (!isRefresh) liveRefresh('visao');
    }

    // ============================================================
    // 2. MAPA DO GALPÃO
    // ============================================================
    function leafStatus(l, m) { return m.divLoc.get(l.id) ? 'div' : m.closed1.has(l.id) ? 'ok' : 'pend'; }
    function viewMapa(isRefresh) {
        const camp = campaign();
        if (!camp) { paint(emptyCamp('Mapa do galpão'), { gocamp: () => go('campanhas') }); return; }
        const m = metrics();
        if (!S.ruas.length) { paint(statePanel('vazio', 'Mapa do galpão', 'Nenhum endereço cadastrado', 'Gere os endereços do galpão em lote (ruas, prateleiras, níveis) para ver o mapa.', 'Ir para Endereços', 'goend'), { goend: () => go('enderecos') }); return; }
        if (S.selRua && !S.byId.get(S.selRua)) S.selRua = null;
        const stat = id => { const lv = S.under.get(id) || []; const d = lv.filter(l => m.closed1.has(l.id)).length; const dv = lv.reduce((s, l) => s + (m.divLoc.get(l.id) || 0), 0); return { n: lv.length, done: d, pct: lv.length ? 100 * d / lv.length : 0, div: dv }; };
        const shelvesTotal = S.ruas.reduce((s, r) => s + (S.kids.get(r.id) || []).length, 0);
        const divTotal = [...m.divLoc.values()].reduce((a, b) => a + b, 0);
        const shelvesDiv = S.ruas.reduce((s, r) => s + (S.kids.get(r.id) || []).filter(c => stat(c.id).div > 0).length, 0);
        const rows = S.ruas.map((r, i) => {
            const kids = S.kids.get(r.id) || [], st = stat(r.id), col = ruaColor(i);
            return `<button class="maprow ${S.selRua === r.id ? 'sel' : ''}" data-act="selrua" data-id="${r.id}" aria-label="Rua ${esc(r.code)}: ${Math.round(st.pct)}% concluída, ${st.div} divergências">
                <span class="lab"><b><span class="sw" style="background:${col}"></span>Rua ${esc(r.code)}</b><small>${fmt.int(st.n)} end.</small></span>
                <span class="mcells" style="--n:${Math.max(kids.length, 1)}">${kids.map(c => { const s = stat(c.id); const bg = S.layer === 'pct' ? `color-mix(in oklab, #3b82f6 ${Math.round(s.pct)}%, #141b26)` : '#141b26'; const div = S.layer === 'div' && s.div > 0; return `<span class="mc ${div ? 'div' : ''}" title="${esc(r.code)}-${esc(c.code)}: ${Math.round(s.pct)}% · ${s.div} divergência(s)" style="background:${bg};${S.layer === 'pct' && s.pct === 0 ? 'border-color:#2b394e' : ''}">${div ? '!' + s.div : ''}</span>`; }).join('')}</span></button>`;
        }).join('');
        const sel = S.selRua ? S.byId.get(S.selRua) : null;
        let side = '';
        if (sel) {
            const st = stat(sel.id), i = S.ruas.indexOf(sel);
            const shelves = (S.kids.get(sel.id) || []);
            const lvMax = Math.min(8, Math.max(1, ...shelves.map(c => (S.under.get(c.id) || []).length)));
            side = `<aside class="panel-side" style="--rc:${ruaColor(Math.max(0, i))}"><div class="ph"><b style="font-size:18px">Rua ${esc(sel.code)}</b><span class="muted" style="font-size:13px">${fmt.int(st.n)} endereços</span><button class="dlg-x" data-act="closerua" aria-label="Fechar painel">✕</button></div>
                <div class="stat2"><div><div class="muted" style="font-size:12px">Contados</div><div style="font-size:22px;font-weight:700">${fmt.pct(Math.round(st.pct))}</div><div class="muted" style="font-size:12px">${st.done} / ${st.n}</div></div>
                <div><div class="muted" style="font-size:12px">Divergências</div><div style="font-size:22px;font-weight:700;color:var(--red-text)">${st.div}</div><div class="muted" style="font-size:12px">abertas</div></div></div>
                <div style="display:flex;gap:12px;padding:10px 16px;font-size:11px;color:var(--text-secondary);border-bottom:1px solid var(--divider)"><span>✓ contado</span><span style="color:var(--red-text)">! divergente</span><span>· pendente</span></div>
                <div style="max-height:440px;overflow-y:auto;padding:6px 8px 10px">${shelves.map(c => { const lv = (S.under.get(c.id) || []).slice(0, lvMax); const s = stat(c.id); return `<div class="shelf-row" style="--lv:${lvMax}"><span class="mono" style="font-size:12px;color:var(--text-body-2)">${c.kind === 'PRATELEIRA' ? 'Prat. ' : ''}${esc(c.code)}</span>${lv.map(l => { const k = leafStatus(l, m); return `<span class="lvl ${k}" title="${esc(l.full_code)}">${esc(l.code)} ${k === 'ok' ? '✓' : k === 'div' ? '!' : '·'}</span>`; }).join('')}${Array(Math.max(0, lvMax - lv.length)).fill('<span></span>').join('')}<span class="muted right" style="font-size:12px">${Math.round(s.pct)}%</span></div>`; }).join('') || '<div class="empty-box" style="margin:10px">Sem prateleiras.</div>'}</div></aside>`;
        }
        paint(`
        ${pgHead(`${esc((S.ctx.sites.find(s => s.key === S.site) || {}).label || '')} · ${S.ruas.length} ruas · ${fmt.int(shelvesTotal)} prateleiras`, 'Mapa do galpão', `<div class="seg" role="tablist" aria-label="Camada do mapa"><button class="${S.layer === 'pct' ? 'on' : ''}" data-act="layer" data-l="pct">% concluído</button><button class="${S.layer === 'div' ? 'on' : ''}" data-act="layer" data-l="div">! Divergência</button></div>`)}
        <div class="split">
            <section class="map-panel">
                <div class="dock" style="margin-bottom:4px">Doca de recebimento</div>
                ${rows}
                <div class="dock" style="margin-top:4px">Expedição</div>
                <div class="map-legend">${S.layer === 'pct' ? '<span style="display:flex;align-items:center;gap:8px">0%<span style="width:160px;height:10px;border-radius:999px;background:linear-gradient(90deg,#141b26,#3b82f6);border:1px solid #2b394e"></span>100% concluído</span>'
                : `<span style="display:flex;align-items:center;gap:8px"><span style="width:18px;height:14px;border-radius:3px;border:2px solid #ef4444;background:rgba(239,68,68,.18);color:#fecaca;font-size:9px;font-weight:800;display:flex;align-items:center;justify-content:center">!</span>Prateleira com divergência aberta (número = ocorrências)</span><span>${divTotal} divergências em ${shelvesDiv} prateleiras</span>`}<span style="margin-left:auto">Clique numa rua para ver prateleiras e níveis</span></div>
            </section>${side}
        </div>`, {
            layer: d => { S.layer = d.l; viewMapa(true); }, selrua: d => { S.selRua = d.id; viewMapa(true); }, closerua: () => { S.selRua = null; viewMapa(true); }
        });
        if (!isRefresh) liveRefresh('mapa');
    }

    // ============================================================
    // 3. ENDEREÇOS (árvore + detalhe com QR)
    // ============================================================
    function treeRows() {
        const q = S.treeQ.trim().toUpperCase();
        if (q) return S.locs.filter(l => l.full_code.includes(q)).slice(0, 200).map(l => ({ l, depth: 0, flat: true }));
        const out = [];
        (function walk(parent, depth) { for (const l of (S.kids.get(parent) || [])) { out.push({ l, depth }); if (S.expanded.has(l.id)) walk(l.id, depth + 1); } })('root', 0);
        return out;
    }
    function locInfo(l, m) {
        const lv = l.is_countable ? [l] : (S.under.get(l.id) || []);
        const done = lv.filter(x => m.closed1.has(x.id)).length;
        const div = lv.some(x => m.divLoc.get(x.id));
        const cl = S.cd.closures.filter(c => lv.some(x => x.id === c.location_id)).sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at));
        let st = 'pend'; if (div) st = 'div'; else if (lv.length && done === lv.length) st = 'ok'; else if (done) st = 'part';
        return { lv, done, st, last: cl[0], rounds: new Set(S.cd.closures.filter(c => c.location_id === l.id).map(c => c.round)).size };
    }
    function viewEnderecos() {
        const w = S.ctx.canWrite, m = metrics();
        if (!S.locs.length) {
            paint(`${pgHead('0 endereços', 'Endereços', `<button class="btn btn-primary" data-act="batch" ${ctaRO()}>+ Gerar em lote</button>`)}${statePanel('vazio', 'Endereços', 'Nenhum endereço cadastrado', 'Gere os endereços do galpão em lote (ruas, prateleiras, níveis e posições).', w ? 'Gerar em lote' : '', 'batch')}`, { batch: openBatchModal });
            return;
        }
        if (!S.selLoc || !S.byId.get(S.selLoc)) { const first = (S.kids.get('root') || [])[0]; S.selLoc = first ? first.id : null; if (first) S.expanded.add(first.id); }
        const sel = S.byId.get(S.selLoc);
        const rows = treeRows();
        let detail = '';
        if (sel) {
            const inf = locInfo(sel, m);
            const crumb = (sel.path || []).map(id => S.byId.get(id)).filter(Boolean).map(l => esc(l.code)).join(' › ');
            const stb = { ok: '<span class="st st-ok">✓ Contado</span>', div: '<span class="st st-err">! Divergente</span>', part: '<span class="st st-warn">◐ Em andamento</span>', pend: '<span class="st">· Pendente</span>' }[inf.st];
            detail = `<section class="panel" style="flex:1 1 480px;min-width:0"><div class="panel-h" style="font-weight:400;color:var(--text-secondary);font-size:13px">${crumb}</div>
                <div style="display:flex;gap:24px;padding:20px;flex-wrap:wrap">
                    <div style="display:flex;flex-direction:column;align-items:center;gap:10px">${qrGrid(qrPayload(sel.qr_token), 'qrbox', 'width:168px;height:168px')}
                        <button class="btn btn-sm" data-act="printone" data-id="${sel.id}">Imprimir etiqueta</button></div>
                    <div style="flex:1;min-width:240px;display:flex;flex-direction:column;gap:14px">
                        <div class="detail-code">${esc(sel.full_code)}</div>
                        <div style="display:flex;gap:8px;flex-wrap:wrap">${stb}<span class="st">${KIND_LABEL[sel.kind]}${sel.is_countable ? ' · contável' : ''}</span>${sel.active ? '' : '<span class="st st-err">Inativo</span>'}</div>
                        <div class="detail-stats"><div><small>Última contagem</small><b>${inf.last ? fmt.dt(inf.last.finished_at) : '—'}</b></div><div><small>Contado por</small><b>${inf.last ? esc(inf.last.counted_by_label || '—') : '—'}</b></div><div><small>${sel.is_countable ? 'Rodadas' : 'Endereços contados'}</small><b>${sel.is_countable ? inf.rounds : inf.done + ' / ' + inf.lv.length}</b></div></div>
                        ${w ? `<div class="actions"><button class="btn btn-sm" data-act="editloc" data-id="${sel.id}">Editar endereço</button></div>` : ''}
                    </div></div>
                <div style="padding:0 20px 20px"><div class="sect-title">Itens neste endereço</div>
                    ${sel.is_countable ? (S.cd.cons.filter(r => r.location_id === sel.id).map(r => `<div class="item-row"><span class="mono" style="font-size:12px;color:var(--blue-text)">${esc(r.item_code)}</span><span>${esc(r.item_description)}</span>${r.criticality !== 'NORMAL' ? seal : '<span></span>'}<b class="nowrap tnum">${fmt.num(r.final_qty != null ? r.final_qty : (r.r3 != null ? r.r3 : r.r2 != null ? r.r2 : r.r1))}</b></div>`).join('') || `<div class="empty-box">${inf.st === 'ok' ? 'Endereço contado e vazio.' : 'Ainda não contado.'}</div>`)
                    : '<div class="empty-box">Selecione um endereço contável (último nível) para ver os itens.</div>'}</div></section>`;
        }
        paint(`
        ${pgHead(`${fmt.int(S.locs.length)} endereços · armazém › rua › prateleira › nível › posição`, 'Endereços', w ? '<button class="btn btn-primary" data-act="batch">+ Gerar em lote</button><button class="btn" data-act="newloc">+ Novo endereço</button>' : '')}
        <div class="split">
            <section class="tree-panel"><div class="s"><input id="tree-q" placeholder="Ir para endereço (ex.: B-12-1)" value="${esc(S.treeQ)}" aria-label="Buscar endereço"></div>
                <div class="tree-list" role="tree">${rows.map(({ l, depth, flat }) => { const hasKids = (S.kids.get(l.id) || []).length > 0; const mark = l.is_countable && m.closed1.has(l.id) ? '✓' : (hasKids ? fmt.int((S.under.get(l.id) || []).length) : ''); const pre = flat ? '' : l.kind === 'RUA' ? 'Rua ' : l.kind === 'PRATELEIRA' ? 'Prat. ' : l.kind === 'NIVEL' ? 'N' : ''; return `<button class="tnode ${S.selLoc === l.id ? 'on' : ''} ${l.active ? '' : 'off'}" role="treeitem" data-act="pick" data-id="${l.id}" style="padding-left:${10 + depth * 18}px"><span class="car">${!flat && hasKids ? (S.expanded.has(l.id) ? '▾' : '▸') : ''}</span><span class="t">${esc(pre + (flat ? l.full_code : l.code))}</span><span class="m" style="${mark === '✓' ? 'color:var(--green-text)' : ''}">${mark}</span></button>`; }).join('') || '<div class="muted" style="padding:14px">Nada encontrado.</div>'}</div></section>
            ${detail}
        </div>`, {
            pick: d => { S.selLoc = d.id; if ((S.kids.get(d.id) || []).length) { S.expanded.has(d.id) ? S.expanded.delete(d.id) : S.expanded.add(d.id); } viewEnderecos(); },
            batch: openBatchModal, newloc: openNewLocModal, editloc: d => openEditLocModal(d.id), printone: d => printLabels([labelOf(S.byId.get(d.id))])
        });
        const tq = $('tree-q');
        tq.addEventListener('input', () => { S.treeQ = tq.value; const p = tq.selectionStart; viewEnderecos(); const n = $('tree-q'); n.focus(); n.setSelectionRange(p, p); });
    }

    // ---- geração em lote ----
    function expandSpec(spec, defaultPad, label) {
        const out = [];
        const parts = String(spec || '').toUpperCase().split(/[,;\s]+/).filter(Boolean);
        for (const p of parts) {
            const m = p.match(/^([A-Z0-9_.]+)\s*[-–:]\s*([A-Z0-9_.]+)$/);
            if (m) {
                const [, a, b] = m;
                if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
                    const padn = (a.length > 1 && a[0] === '0') ? a.length : defaultPad;
                    const x = parseInt(a, 10), y = parseInt(b, 10);
                    if (x > y) throw new Error(`${label}: intervalo invertido "${p}".`);
                    for (let n = x; n <= y; n++) out.push(String(n).padStart(padn, '0'));
                } else if (/^[A-Z]$/.test(a) && /^[A-Z]$/.test(b)) {
                    const x = a.charCodeAt(0), y = b.charCodeAt(0);
                    if (x > y) throw new Error(`${label}: intervalo invertido "${p}".`);
                    for (let n = x; n <= y; n++) out.push(String.fromCharCode(n));
                } else throw new Error(`${label}: intervalo inválido "${p}" (use A-F ou 1-20).`);
            } else {
                if (!/^[A-Z0-9_.]+$/.test(p)) throw new Error(`${label}: "${p}" tem caractere inválido (só letras, números, _ e .).`);
                out.push(/^\d+$/.test(p) ? p.padStart(defaultPad, '0') : p);
            }
            if (out.length > 3000) throw new Error(`${label}: itens demais.`);
        }
        return [...new Set(out)];
    }
    function buildPlan(f) {
        const arm = String(f.arm || '').toUpperCase().trim();
        if (!/^[A-Z0-9_.]+$/.test(arm)) throw new Error('Código do armazém inválido (só letras, números, _ e .).');
        const ruas = expandSpec(f.ruas, 0, 'Ruas'), prat = expandSpec(f.prat, f.padPrat, 'Prateleiras'), niv = expandSpec(f.niv, f.padNiv, 'Níveis'), pos = expandSpec(f.pos, f.padPos, 'Posições');
        if (!ruas.length) throw new Error('Informe ao menos uma rua.');
        const nodes = [{ kind: 'ARMAZEM', code: arm, full: arm, parent: null }];
        for (const r of ruas) {
            const rf = `${arm}-${r}`; nodes.push({ kind: 'RUA', code: r, full: rf, parent: arm });
            for (const p of prat) {
                const pf = `${rf}-${p}`; nodes.push({ kind: 'PRATELEIRA', code: p, full: pf, parent: rf });
                for (const n of niv) {
                    const nf = `${pf}-${n}`; nodes.push({ kind: 'NIVEL', code: n, full: nf, parent: pf });
                    for (const o of pos) nodes.push({ kind: 'POSICAO', code: o, full: `${nf}-${o}`, parent: nf });
                }
            }
        }
        if (!new Set(nodes.map(n => n.kind)).has(f.countAt)) throw new Error(`Você escolheu contar por ${KIND_LABEL[f.countAt]}, mas esse nível não foi informado.`);
        for (const n of nodes) { n.countable = n.kind === f.countAt; n.exists = S.byFull.has(n.full); }
        return nodes;
    }
    const readBatch = () => ({ arm: $('b-arm').value, ruas: $('b-ruas').value, prat: $('b-prat').value, niv: $('b-niv').value, pos: $('b-pos').value, padPrat: parseInt($('b-padprat').value, 10) || 0, padNiv: parseInt($('b-padniv').value, 10) || 0, padPos: parseInt($('b-padpos').value, 10) || 0, countAt: $('b-count').value });
    function previewBatch() {
        const box = $('b-prev'), btn = $('b-go');
        try {
            const nodes = buildPlan(readBatch()), novos = nodes.filter(n => !n.exists), exist = nodes.length - novos.length;
            if (novos.length > 5000) throw new Error(`Seriam ${fmt.int(novos.length)} endereços novos. O máximo por vez é 5.000.`);
            const leafs = novos.filter(n => n.countable), shown = leafs.length ? leafs : novos;
            box.className = ''; box.style.cssText = 'border:1px solid var(--border-color);border-radius:10px;background:var(--bg-sidebar);overflow:hidden';
            box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:12px 14px;border-bottom:1px solid var(--border-color)"><span class="muted" style="font-size:13px">Prévia</span><span><b style="font-size:22px">${fmt.int(shown.length)}</b> <span class="muted">endereços${leafs.length ? ' contáveis' : ''}</span></span></div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;padding:12px 14px;font-family:var(--font-code);font-size:12px">${shown.slice(0, 6).map(n => `<span style="padding:3px 8px;border-radius:6px;border:1px solid var(--border-color);color:var(--text-body-2)">${esc(n.full)}</span>`).join('')}${shown.length ? `<span style="padding:3px 8px;color:var(--text-secondary)">… ${esc(shown[shown.length - 1].full)}</span>` : ''}</div>
                <div style="padding:10px 14px;border-top:1px solid var(--border-color);font-size:12px;color:#fde68a">${exist ? `⚠ ${exist} já existem e serão ignorados. Nada é apagado.` : 'Nada será apagado.'}</div>`;
            btn.disabled = novos.length === 0; btn.textContent = novos.length ? `Criar ${fmt.int(novos.length)} endereços` : 'Nada a criar';
        } catch (e) { box.className = 'notice warn'; box.style.cssText = ''; box.textContent = e.message; btn.disabled = true; btn.textContent = 'Criar endereços'; }
    }
    function openBatchModal() {
        const arm0 = (S.kids.get('root') || []).find(l => l.kind === 'ARMAZEM');
        openModal('Gerar endereços em lote', `
            <div class="field"><label class="f">Código do armazém</label><input id="b-arm" value="${esc(arm0 ? arm0.code : 'VGR')}" ${arm0 ? 'readonly' : ''}></div>
            <div class="field"><label class="f">Ruas (ex.: A-F ou A,B,C)</label><input id="b-ruas" value="A-F"></div>
            <div class="row" style="margin-bottom:14px"><div class="field"><label class="f">Prateleiras (ex.: 1-20)</label><input id="b-prat" value="1-20"></div><div class="field" style="flex:0 0 90px"><label class="f">Dígitos</label><input id="b-padprat" type="number" min="0" max="4" value="2"></div></div>
            <div class="row" style="margin-bottom:14px"><div class="field"><label class="f">Níveis (ex.: 1-4)</label><input id="b-niv" value="1-4"></div><div class="field" style="flex:0 0 90px"><label class="f">Dígitos</label><input id="b-padniv" type="number" min="0" max="4" value="1"></div></div>
            <div class="row" style="margin-bottom:14px"><div class="field"><label class="f">Posições (opcional, ex.: 1-5)</label><input id="b-pos" value=""></div><div class="field" style="flex:0 0 90px"><label class="f">Dígitos</label><input id="b-padpos" type="number" min="0" max="4" value="2"></div></div>
            <div class="field"><label class="f">O inventário é contado em qual nível?</label><select id="b-count"><option value="NIVEL">Nível (recomendado)</option><option value="POSICAO">Posição</option><option value="PRATELEIRA">Prateleira</option></select></div>
            <div id="b-prev" class="notice"></div><div id="b-prog" class="muted" style="font-size:13px;margin-top:8px"></div>`,
            `<button class="btn" id="b-cancel">Cancelar</button><button class="btn btn-primary" id="b-go" disabled>Criar endereços</button>`, { width: '560px' });
        $('b-cancel').addEventListener('click', closeModal);
        document.querySelectorAll('#modal-bg input, #modal-bg select').forEach(el => el.addEventListener('input', previewBatch));
        $('b-go').addEventListener('click', () => guarded(runBatch));
        previewBatch();
    }
    async function runBatch() {
        const nodes = buildPlan(readBatch());
        const ids = new Map();
        for (const n of nodes) if (n.exists) ids.set(n.full, S.byFull.get(n.full).id);
        const btn = $('b-go'), prog = $('b-prog'); btn.disabled = true;
        for (const kind of KIND_ORDER) {
            const lvl = nodes.filter(n => n.kind === kind && !n.exists);
            if (!lvl.length) continue;
            const rows = lvl.map(n => { const id = uuid(); ids.set(n.full, id); return { id, site_key: S.site, parent_id: n.parent ? ids.get(n.parent) : null, kind, code: n.code, is_countable: n.countable, created_by: S.ctx.user.id }; });
            for (let i = 0; i < rows.length; i += 200) {
                prog.textContent = `Criando ${KIND_PLURAL[kind].toLowerCase()}… ${Math.min(i + 200, rows.length)}/${rows.length}`;
                const { error } = await sb.from('wh_locations').insert(rows.slice(i, i + 200));
                if (error) { prog.textContent = ''; btn.disabled = false; throw new Error('Parou em ' + KIND_PLURAL[kind].toLowerCase() + ': ' + error.message + ' (o que já foi criado foi mantido; rode de novo para continuar).'); }
            }
        }
        await loadLocs(); closeModal(); toast('Endereços criados com sucesso.'); viewEnderecos();
    }
    function openNewLocModal() {
        const parents = S.locs.filter(l => l.kind !== 'POSICAO' && l.active);
        openModal('Novo endereço', `
            <div class="field"><label class="f">Dentro de (deixe vazio para criar um armazém)</label><select id="n-parent"><option value="">— nenhum (novo armazém) —</option>${parents.map(l => `<option value="${l.id}">${esc(l.full_code)} · ${KIND_LABEL[l.kind]}</option>`).join('')}</select></div>
            <div class="field"><label class="f">Código (letras, números, _ ou .; sem hífen)</label><input id="n-code" placeholder="ex.: 21"></div>
            <label class="checkline"><input type="checkbox" id="n-count"> Endereço contável (onde se conta o estoque)</label>`,
            `<button class="btn" id="n-cancel">Cancelar</button><button class="btn btn-primary" id="n-go">Criar</button>`);
        $('n-cancel').addEventListener('click', closeModal);
        $('n-go').addEventListener('click', () => guarded(async () => {
            const pid = $('n-parent').value || null, parent = pid ? S.byId.get(pid) : null;
            const kind = parent ? KIND_ORDER[KIND_ORDER.indexOf(parent.kind) + 1] : 'ARMAZEM', code = $('n-code').value.trim().toUpperCase();
            if (!code) throw new Error('Informe o código.');
            const { error } = await sb.from('wh_locations').insert({ id: uuid(), site_key: S.site, parent_id: pid, kind, code, is_countable: $('n-count').checked, created_by: S.ctx.user.id });
            if (error) throw error;
            await loadLocs(); closeModal(); toast('Endereço criado.'); viewEnderecos();
        }));
    }
    function openEditLocModal(id) {
        const l = S.byId.get(id); if (!l) return;
        openModal(l.full_code, `<p class="muted" style="margin-bottom:12px">${KIND_LABEL[l.kind]} · código do QR <span class="mono">${esc(l.qr_token)}</span><br>Código e posição na árvore não mudam depois de criados (a etiqueta pode já estar colada).</p>
            <label class="checkline" style="margin-bottom:10px"><input type="checkbox" id="e-count" ${l.is_countable ? 'checked' : ''}> Endereço contável</label><label class="checkline"><input type="checkbox" id="e-active" ${l.active ? 'checked' : ''}> Ativo</label>`,
            `<button class="btn" id="e-cancel">Cancelar</button><button class="btn btn-primary" id="e-go">Salvar</button>`);
        $('e-cancel').addEventListener('click', closeModal);
        $('e-go').addEventListener('click', () => guarded(async () => {
            const { error } = await sb.from('wh_locations').update({ is_countable: $('e-count').checked, active: $('e-active').checked }).eq('id', id);
            if (error) throw error;
            await loadLocs(); closeModal(); toast('Salvo.'); viewEnderecos();
        }));
    }

    // ============================================================
    // 4. ITENS
    // ============================================================
    function viewItens() {
        const w = S.ctx.canWrite, q = norm(S.itemQ);
        const list = S.items.filter(i => (S.crit === 'todos' || (S.crit === 'critico' ? i.criticality === 'CRITICO' : S.crit === 'alto' ? i.criticality === 'ALTO_VALOR' : i.criticality === 'NORMAL')) && (!q || norm(`${i.code} ${i.vale_material_code || ''} ${i.description}`).includes(q)));
        if (!S.items.length) {
            paint(`${pgHead('Catálogo de materiais · 0 itens', 'Itens', `<button class="btn" data-act="import" ${ctaRO()}>Importar planilha</button><button class="btn btn-primary" data-act="newitem" ${ctaRO()}>+ Novo item</button>`)}${statePanel('vazio', 'Itens', 'Nenhum item no catálogo', 'Importe a planilha de materiais da Vale para começar o inventário.', w ? 'Importar planilha' : '', 'import')}`, { import: openImportModal, newitem: () => openItemModal(null) });
            return;
        }
        const chips = [['todos', 'Todos'], ['normal', 'Normal'], ['alto', 'Alto valor'], ['critico', 'Crítico']];
        const shown = list.slice(0, 200);
        paint(`
        ${pgHead(`Catálogo de materiais · ${fmt.int(S.items.length)} itens`, 'Itens', `<button class="btn btn-card" data-act="import" ${ctaRO()}>Importar planilha</button><button class="btn btn-primary" data-act="newitem" ${ctaRO()}>+ Novo item</button><button class="btn btn-ghost" data-act="template" ${ctaRO()}>Baixar modelo</button>`)}
        <section class="panel">
            <div class="toolbar"><input id="it-q" placeholder="Buscar por código, material Vale ou descrição" value="${esc(S.itemQ)}" aria-label="Buscar itens"><div class="chips">${chips.map(([k, l]) => `<button class="chip ${S.crit === k ? 'on' : ''}" data-act="crit" data-k="${k}" aria-pressed="${S.crit === k}">${l}</button>`).join('')}</div></div>
            <div class="tbl-wrap"><table class="tb"><thead><tr><th>Código</th><th>Material Vale</th><th>Descrição</th><th>Un.</th><th>ABC</th><th>Criticidade</th>${S.costs.size ? '<th class="num">Custo</th>' : ''}<th class="num">Endereços</th><th></th></tr></thead><tbody>
            ${shown.map(i => { const n = (S.whereByItem.get(i.id) || []).length; return `<tr style="${i.active ? '' : 'opacity:.5'}"><td class="code">${esc(i.code)}</td><td class="mono muted" style="font-size:13px">${esc(i.vale_material_code || '—')}</td><td>${esc(i.description)}</td><td class="muted">${esc(i.uom)}</td><td><span class="abc">${esc(i.abc_class || '—')}</span></td><td><span style="display:flex;gap:6px;flex-wrap:wrap">${critBadge(i.criticality)}${i.criticality !== 'NORMAL' ? seal : ''}</span></td>${S.costs.size ? `<td class="num">${S.costs.has(i.id) ? fmt.money(S.costs.get(i.id)) : '—'}</td>` : ''}<td class="num muted">${n ? n + (n > 1 ? ' endereços' : ' endereço') : '—'}</td><td class="right">${w ? `<button class="btn btn-sm" data-act="edititem" data-id="${i.id}">Editar</button>` : ''}</td></tr>`; }).join('')}
            </tbody></table></div>
            ${list.length ? '' : '<div style="padding:40px 16px;text-align:center" class="muted">Nenhum item corresponde à busca. <button class="btn-link" data-act="clear">Limpar filtros</button></div>'}
            <div class="panel-foot">Mostrando ${fmt.int(shown.length)} de ${fmt.int(S.items.length)} itens</div>
        </section>`, {
            newitem: () => openItemModal(null), edititem: d => openItemModal(d.id), import: openImportModal, template: downloadTemplate,
            crit: d => { S.crit = d.k; viewItens(); }, clear: () => { S.itemQ = ''; S.crit = 'todos'; viewItens(); }
        });
        const qi = $('it-q');
        qi.addEventListener('input', () => { S.itemQ = qi.value; const p = qi.selectionStart; viewItens(); const n = $('it-q'); n.focus(); n.setSelectionRange(p, p); });
    }
    async function openItemModal(id) {
        const it = id ? S.itemById.get(id) : null;
        let barcodes = [];
        if (it) { const { data } = await sb.from('wh_item_barcodes').select('barcode').eq('item_id', id); barcodes = (data || []).map(b => b.barcode); }
        const critVal = it ? (it.criticality_source === 'AUTOMATICA' ? 'AUTO' : it.criticality) : 'AUTO';
        openModal(it ? `Editar item ${it.code}` : 'Novo item', `
            <div class="row" style="margin-bottom:14px"><div class="field"><label class="f">Código do item *</label><input id="i-code" value="${esc(it ? it.code : '')}" ${it ? 'readonly' : ''} placeholder="ex.: MAT-004512"></div><div class="field"><label class="f">Código material Vale (SAP)</label><input id="i-vale" value="${esc(it ? it.vale_material_code || '' : '')}"></div></div>
            <div class="field"><label class="f">Descrição *</label><input id="i-desc" value="${esc(it ? it.description : '')}"></div>
            <div class="row" style="margin-bottom:14px"><div class="field"><label class="f">Unidade</label><input id="i-uom" value="${esc(it ? it.uom : 'UN')}"></div><div class="field"><label class="f">Custo unitário (R$)</label><input id="i-cost" type="number" step="0.01" min="0" value="${it && S.costs.has(id) ? S.costs.get(id) : ''}"></div>
                <div class="field"><label class="f">Criticidade</label><select id="i-crit"><option value="AUTO" ${critVal === 'AUTO' ? 'selected' : ''}>Automática (pelo custo)</option><option value="NORMAL" ${critVal === 'NORMAL' ? 'selected' : ''}>Normal</option><option value="ALTO_VALOR" ${critVal === 'ALTO_VALOR' ? 'selected' : ''}>Alto valor</option><option value="CRITICO" ${critVal === 'CRITICO' ? 'selected' : ''}>Crítico</option></select></div></div>
            <div class="field"><label class="f">Código de barras / QR da etiqueta ${barcodes.length ? `(já cadastrados: ${esc(barcodes.join(', '))})` : ''}</label><input id="i-bar" placeholder="opcional — adiciona mais um código a este item"></div>
            <label class="checkline"><input type="checkbox" id="i-active" ${!it || it.active ? 'checked' : ''}> Item ativo</label>
            <p class="muted" style="margin-top:12px;font-size:12px">Itens de <b>alto valor</b> ou <b>críticos</b> exigem dupla conferência (duas pessoas diferentes contando).</p>`,
            `<button class="btn" id="i-cancel">Cancelar</button><button class="btn btn-primary" id="i-go">Salvar</button>`, { width: '640px' });
        $('i-cancel').addEventListener('click', closeModal);
        $('i-go').addEventListener('click', () => guarded(async () => {
            const code = $('i-code').value.trim(), desc = $('i-desc').value.trim();
            if (!code || !desc) throw new Error('Código e descrição são obrigatórios.');
            const crit = $('i-crit').value;
            const row = { vale_material_code: $('i-vale').value.trim() || null, description: desc, uom: $('i-uom').value.trim() || 'UN', criticality_source: crit === 'AUTO' ? 'AUTOMATICA' : 'MANUAL', active: $('i-active').checked };
            if (crit !== 'AUTO') row.criticality = crit;
            let itemId = id;
            if (it) { const { error } = await sb.from('wh_items').update(row).eq('id', id); if (error) throw error; }
            else { itemId = uuid(); const { error } = await sb.from('wh_items').insert({ id: itemId, site_key: S.site, code, created_by: S.ctx.user.id, ...row }); if (error) throw error; }
            const cost = $('i-cost').value;
            if (cost !== '') { const { error } = await sb.from('wh_item_costs').upsert({ item_id: itemId, site_key: S.site, unit_cost: Number(cost), cost_source: 'MANUAL', cost_updated_at: new Date().toISOString(), updated_by: S.ctx.user.id }, { onConflict: 'item_id' }); if (error) throw error; }
            const bar = $('i-bar').value.trim();
            if (bar) { const { error } = await sb.from('wh_item_barcodes').insert({ site_key: S.site, item_id: itemId, barcode: bar }); if (error) throw new Error('Código de barras: ' + error.message); }
            await loadItems(); closeModal(); toast('Item salvo.'); viewItens();
        }));
    }
    const COLS = {
        code: ['codigo', 'cod', 'codigo_item', 'codigo_interno', 'item', 'id'], vale: ['codigo_vale', 'cod_vale', 'codigo_material_vale', 'material_vale', 'sap', 'codigo_sap'],
        desc: ['descricao', 'descr', 'nome'], uom: ['unidade', 'un', 'und', 'unid'], cost: ['custo', 'custo_unitario', 'valor', 'preco'], bar: ['codigo_barras', 'codigo_de_barras', 'barras', 'ean', 'qr', 'barcode']
    };
    function downloadTemplate() {
        const ws = XLSX.utils.aoa_to_sheet([['CODIGO', 'CODIGO_VALE', 'DESCRICAO', 'UNIDADE', 'CUSTO', 'CODIGO_BARRAS'], ['MAT-004512', '10045120', 'Rolamento autocompensador 22218 E', 'UN', 1850.9, '7891234567890'], ['MAT-009021', '10090210', 'Luva de raspa cano longo', 'PAR', 12.5, '']]);
        ws['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 44 }, { wch: 10 }, { wch: 12 }, { wch: 20 }];
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Itens'); XLSX.writeFile(wb, 'modelo_itens_armazem.xlsx');
    }
    function parseSheet(rows) {
        const nk = k => norm(k).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const out = [], errors = [], seen = new Map();
        rows.forEach((r, idx) => {
            const m = {}; for (const [k, v] of Object.entries(r)) m[nk(k)] = v;
            const pick = names => { for (const n of names) if (m[n] != null && String(m[n]).trim() !== '') return String(m[n]).trim(); return ''; };
            const code = pick(COLS.code), desc = pick(COLS.desc);
            if (!code && !desc) return;
            if (!code || !desc) { errors.push(`Linha ${idx + 2}: ${!code ? 'sem código' : 'sem descrição'}.`); return; }
            const costTxt = pick(COLS.cost).replace(/[R$\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
            const cost = costTxt === '' ? null : Number(costTxt);
            if (cost != null && (isNaN(cost) || cost < 0)) { errors.push(`Linha ${idx + 2}: custo inválido "${pick(COLS.cost)}".`); return; }
            const rec = { code, vale: pick(COLS.vale) || null, desc, uom: (pick(COLS.uom) || 'UN').toUpperCase(), cost, bar: pick(COLS.bar) || null };
            if (seen.has(code)) { errors.push(`Linha ${idx + 2}: código "${code}" repetido no arquivo (vale o último).`); out[seen.get(code)] = rec; } else { seen.set(code, out.length); out.push(rec); }
        });
        return { items: out.filter(Boolean), errors };
    }
    function openImportModal() {
        openModal('Importar planilha de itens', `
            <label id="imp-drop" style="padding:32px 16px;border:2px dashed var(--border-color);border-radius:12px;text-align:center;display:flex;flex-direction:column;gap:6px;align-items:center;cursor:pointer"><b>Arraste o arquivo .xlsx ou .csv aqui</b><span class="muted" style="font-size:13px">ou</span><span class="btn btn-sm" style="background:var(--bg-sidebar)">Escolher arquivo</span><input type="file" id="imp-file" accept=".xlsx,.xls,.csv" style="display:none"></label>
            <p class="muted" style="font-size:13px;margin-top:12px">Colunas: <b>CODIGO</b> e <b>DESCRICAO</b> (obrigatórias), CODIGO_VALE, UNIDADE, CUSTO, CODIGO_BARRAS. Itens que já existem são atualizados. <button class="btn-link" id="imp-tpl">Baixar modelo</button></p>
            <div id="imp-prev" style="margin-top:12px"></div>`,
            `<button class="btn" id="imp-close">Fechar</button><button class="btn btn-primary" id="imp-go" disabled>Importar</button>`);
        $('imp-close').addEventListener('click', closeModal); $('imp-tpl').addEventListener('click', downloadTemplate);
        let parsed = null;
        const onFile = async f => {
            if (!f) return;
            await guarded(async () => {
                const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
                parsed = parseSheet(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }));
                const existing = new Set(S.items.map(i => i.code)), novos = parsed.items.filter(i => !existing.has(i.code)).length;
                $('imp-prev').innerHTML = `<div class="notice"><b>${fmt.int(parsed.items.length)} itens válidos</b> · ${fmt.int(novos)} novos · ${fmt.int(parsed.items.length - novos)} serão atualizados · ${parsed.items.filter(i => i.cost != null).length} com custo · ${parsed.items.filter(i => i.bar).length} com código de barras</div>
                    ${parsed.errors.length ? `<div class="notice warn"><b>${parsed.errors.length} aviso(s):</b><br>${parsed.errors.slice(0, 6).map(esc).join('<br>')}${parsed.errors.length > 6 ? '<br>…' : ''}</div>` : ''}<div id="imp-prog" class="muted" style="font-size:13px"></div>`;
                $('imp-go').disabled = parsed.items.length === 0;
            });
        };
        $('imp-file').addEventListener('change', e => onFile(e.target.files[0]));
        const drop = $('imp-drop');
        drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--blue-ring)'; });
        drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
        drop.addEventListener('drop', e => { e.preventDefault(); drop.style.borderColor = ''; onFile(e.dataTransfer.files[0]); });
        $('imp-go').addEventListener('click', () => guarded(async () => {
            if (!parsed) return;
            $('imp-go').disabled = true;
            const prog = $('imp-prog'), list = parsed.items;
            for (let i = 0; i < list.length; i += 300) {
                prog.textContent = `Gravando itens… ${Math.min(i + 300, list.length)}/${list.length}`;
                const { error } = await sb.from('wh_items').upsert(list.slice(i, i + 300).map(x => ({ site_key: S.site, code: x.code, vale_material_code: x.vale, description: x.desc, uom: x.uom })), { onConflict: 'site_key,code' });
                if (error) throw error;
            }
            await loadItems();
            const idOf = new Map(S.items.map(i => [i.code, i.id]));
            const costRows = list.filter(x => x.cost != null && idOf.has(x.code)).map(x => ({ item_id: idOf.get(x.code), site_key: S.site, unit_cost: x.cost, cost_source: 'MANUAL', cost_updated_at: new Date().toISOString(), updated_by: S.ctx.user.id }));
            for (let i = 0; i < costRows.length; i += 300) { prog.textContent = `Gravando custos… ${Math.min(i + 300, costRows.length)}/${costRows.length}`; const { error } = await sb.from('wh_item_costs').upsert(costRows.slice(i, i + 300), { onConflict: 'item_id' }); if (error) throw error; }
            const barRows = list.filter(x => x.bar && idOf.has(x.code)).map(x => ({ site_key: S.site, item_id: idOf.get(x.code), barcode: x.bar }));
            for (let i = 0; i < barRows.length; i += 300) { prog.textContent = `Gravando códigos de barras… ${Math.min(i + 300, barRows.length)}/${barRows.length}`; const { error } = await sb.from('wh_item_barcodes').upsert(barRows.slice(i, i + 300), { onConflict: 'site_key,barcode', ignoreDuplicates: true }); if (error) throw error; }
            await loadItems(); closeModal(); toast(`${fmt.int(list.length)} itens importados.`); viewItens();
        }));
    }

    // ============================================================
    // 5. CAMPANHAS (+ equipes e atribuição de ruas)
    // ============================================================
    const MODES = [
        ['AMOSTRA', 'Recontar uma amostra dos endereços'], ['TODAS', 'Recontar todos os endereços (2ª contagem completa)'],
        ['DIVERGENCIA', 'Recontar quando a 1ª contagem divergir do saldo de referência'], ['NENHUMA', 'Sem recontagem automática']
    ];
    function viewCampanhas() {
        const w = S.ctx.canWrite, camp = campaign();
        const prog = id => { const rows = S.progress.filter(p => p.campaign_id === id && p.round === 1); const t = rows.reduce((s, p) => s + Number(p.total_addresses || 0), 0), d = rows.reduce((s, p) => s + Number(p.counted_addresses || 0), 0); return t ? 100 * d / t : 0; };
        const head = pgHead('Ciclos de inventário', 'Campanhas', `<button class="btn btn-primary" data-act="newcamp" ${ctaRO()}>+ Nova campanha</button>`);
        if (!camp) { paint(`${head}${statePanel('vazio', 'Campanhas', 'Nenhuma campanha', 'Crie a primeira campanha de inventário e atribua as ruas às equipes.', w ? 'Criar campanha' : '', 'newcamp')}`, { newcamp: openNewCampModal }); return; }
        const editable = w && (camp.status === 'RASCUNHO' || camp.status === 'ATIVA');
        const stage = CAMP[camp.status][1];
        const asg = S.assignments.filter(a => a.campaign_id === S.campId && a.round === 1);
        const teamOfRua = id => asg.find(a => a.location_id === id);
        const actLabel = camp.status === 'RASCUNHO' ? 'Ativar campanha' : camp.status === 'ATIVA' ? 'Fechar campanha' : '';
        paint(`${head}
        <div class="split">
            <div style="flex:0 1 320px;min-width:260px;display:flex;flex-direction:column;gap:10px">
                ${S.campaigns.map(c => `<button class="camp-card ${c.id === S.campId ? 'on' : ''}" style="--c:${CAMP[c.status][2]}" data-act="pickcamp" data-id="${c.id}"><span style="display:flex;justify-content:space-between;gap:8px"><b>${esc(c.name)}</b><span style="font-size:12px;font-weight:600;color:${CAMP[c.status][2]}">${CAMP[c.status][0]}</span></span><span class="muted" style="font-size:12px">${c.kind === 'GERAL' ? 'Inventário geral' : 'Contagem cíclica'} · criada em ${new Date(c.created_at).toLocaleDateString('pt-BR')}</span><span class="bar sm"><i style="width:${prog(c.id)}%;background:${CAMP[c.status][2]}"></i></span></button>`).join('')}
            </div>
            <section class="panel" style="flex:1 1 520px;min-width:0">
                <div style="padding:16px 20px;background:var(--bg-card-header);border-bottom:1px solid var(--border-color);display:flex;flex-direction:column;gap:14px">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><span style="font-size:18px;font-weight:700">${esc(camp.name)}</span>
                        <span class="actions">${w && (camp.status === 'ATIVA' || camp.status === 'RASCUNHO') ? '<button class="btn btn-sm btn-danger" data-act="cancelcamp">Cancelar campanha</button>' : ''}${actLabel && w ? `<button class="btn ${camp.status === 'ATIVA' ? 'btn-primary' : 'btn-ok'}" data-act="campaction">${actLabel}</button>` : ''}</span></div>
                    ${camp.status === 'CANCELADA' ? '<span class="st st-err">Campanha cancelada</span>' : `<div class="stepper" aria-label="Ciclo da campanha">${['Rascunho', 'Ativa', 'Fechada'].map((l, i) => `<div class="step ${i < stage ? 'done' : i === stage ? 'cur' : ''}"><span class="b"><span class="c">${i < stage ? '✓' : i + 1}</span><span style="font-weight:${i === stage ? 700 : 500};color:${i <= stage ? '#fff' : 'var(--text-secondary)'}">${l}</span></span><span class="ln"></span></div>`).join('')}</div>`}
                </div>
                <div style="padding:18px 20px;display:flex;flex-direction:column;gap:22px">
                    <div><div class="sect-title">Atribuição de ruas</div>
                        ${S.ruas.length ? `<div class="assign-grid">${S.ruas.map((r, i) => { const a = teamOfRua(r.id); return `<div class="assign"><span class="sw" style="background:${ruaColor(i)}"></span><b style="width:52px">Rua ${esc(r.code)}</b><span class="pills">${S.teams.map(t => `<button class="pill ${a && a.team_id === t.id ? 'on' : ''}" data-act="assign" data-loc="${r.id}" data-team="${t.id}" aria-pressed="${!!(a && a.team_id === t.id)}" ${editable ? '' : 'disabled'}>${esc(t.name)}</button>`).join('') || '<span class="muted" style="font-size:12px">crie uma equipe</span>'}</span></div>`; }).join('')}</div>
                        <div class="muted" style="font-size:12px;padding-top:8px">${S.teams.map(t => `${esc(t.name)} (${S.members.filter(m => m.team_id === t.id).length} pessoas): ${esc(S.ruas.filter(r => (teamOfRua(r.id) || {}).team_id === t.id).map(r => r.code).join(', ') || '—')}`).join(' · ')}</div>` : '<div class="empty-box">Cadastre os endereços (ruas) primeiro, na tela Endereços.</div>'}
                    </div>
                    <div><div class="sect-title">Regra de recontagem</div>
                        <div style="display:flex;flex-direction:column;gap:8px">
                            ${MODES.map(([k, l]) => `<button class="rule ${camp.recount_mode === k ? 'on' : ''}" data-act="mode" data-m="${k}" role="switch" aria-checked="${camp.recount_mode === k}" ${w && camp.status === 'RASCUNHO' ? '' : 'disabled'}><span class="switch"></span><span style="flex:1">${l}${k === 'AMOSTRA' && camp.recount_mode === 'AMOSTRA' ? ` <span class="muted">(${camp.recount_sample_pct}%)</span>` : ''}</span></button>`).join('')}
                            <button class="rule on" disabled><span class="switch"></span><span style="flex:1">Itens críticos sempre exigem dupla conferência (2 pessoas diferentes)</span></button>
                            <button class="rule on" disabled><span class="switch"></span><span style="flex:1">3ª contagem quando a 1ª e a 2ª forem diferentes</span></button>
                        </div>
                        <div class="muted" style="font-size:12px;padding-top:8px">Tolerância: ${fmt.num(camp.tolerance_qty)} un · ${fmt.num(camp.tolerance_pct)}%. As regras só podem ser alteradas enquanto a campanha é rascunho.</div>
                    </div>
                    ${panelEquipes(w)}
                </div>
            </section>
        </div>`, {
            newcamp: openNewCampModal, pickcamp: d => { setCamp(d.id); viewCampanhas(); },
            assign: async d => {
                const cur = asg.find(a => a.location_id === d.loc);
                if (cur) { const { error } = await sb.from('wh_campaign_assignments').delete().eq('campaign_id', S.campId).eq('location_id', d.loc).eq('round', 1); if (error) throw error; }
                if (!cur || cur.team_id !== d.team) { const { error } = await sb.from('wh_campaign_assignments').insert({ campaign_id: S.campId, site_key: S.site, location_id: d.loc, team_id: d.team, round: 1 }); if (error) throw error; }
                await loadCampaigns(); viewCampanhas();
            },
            mode: async d => { const { error } = await sb.from('wh_campaigns').update({ recount_mode: d.m }).eq('id', S.campId); if (error) throw error; await loadCampaigns(); viewCampanhas(); },
            campaction: async () => {
                const next = camp.status === 'RASCUNHO' ? 'ATIVA' : 'FECHADA';
                if (!confirm(next === 'ATIVA' ? 'Ativar agora? As regras de contagem não poderão mais ser alteradas.' : 'Fechar a campanha? Depois disso não entram mais contagens nem decisões.')) return;
                const { error } = await sb.from('wh_campaigns').update({ status: next }).eq('id', S.campId); if (error) throw error;
                await loadCampaigns(); S.cd.loadedFor = null; toast('Status atualizado.'); viewCampanhas();
            },
            cancelcamp: async () => {
                if (!confirm('Cancelar esta campanha? Não dá para desfazer.')) return;
                const { error } = await sb.from('wh_campaigns').update({ status: 'CANCELADA' }).eq('id', S.campId); if (error) throw error;
                await loadCampaigns(); toast('Campanha cancelada.'); viewCampanhas();
            },
            newteam: openNewTeamModal,
            addmember: async d => { const { error } = await sb.from('wh_team_members').insert({ team_id: d.t, site_key: S.site, profile_id: $('add-' + d.t).value }); if (error) throw error; await loadTeams(); viewCampanhas(); },
            rmmember: async (d, b, ev) => { ev.preventDefault(); const { error } = await sb.from('wh_team_members').delete().eq('team_id', d.t).eq('profile_id', d.p); if (error) throw error; await loadTeams(); viewCampanhas(); },
            delteam: async d => { if (!confirm('Excluir esta equipe?')) return; const { error } = await sb.from('wh_teams').delete().eq('id', d.id); if (error) throw new Error('Não deu para excluir (a equipe está atribuída a uma campanha?): ' + error.message); await loadTeams(); viewCampanhas(); }
        });
    }
    function panelEquipes(w) {
        return `<div><div class="sect-title" style="display:flex;justify-content:space-between;align-items:center">Equipes${w ? '<button class="btn btn-sm" data-act="newteam">+ Nova equipe</button>' : ''}</div>
            ${S.teams.length ? S.teams.map(t => { const ms = S.members.filter(m => m.team_id === t.id), free = S.people.filter(p => !ms.find(m => m.profile_id === p.id)); return `<div style="padding:12px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-sidebar);margin-bottom:8px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>${esc(t.name)}</b>${w ? `<button class="btn-link" style="color:var(--red-text)" data-act="delteam" data-id="${t.id}">excluir</button>` : ''}</div>
                <div class="chips" style="margin-bottom:${w && free.length ? 10 : 0}px">${ms.map(m => { const p = S.people.find(x => x.id === m.profile_id); return `<span class="st st-info" style="font-size:13px;padding:4px 12px">${esc(p ? p.name : m.profile_id.slice(0, 8))}${w ? ` <a href="#" data-act="rmmember" data-t="${t.id}" data-p="${m.profile_id}" style="color:var(--red-text);margin-left:6px">×</a>` : ''}</span>`; }).join('') || '<span class="muted">Sem membros</span>'}</div>
                ${w && free.length ? `<div class="row"><div class="field"><select id="add-${t.id}">${free.map(p => `<option value="${p.id}">${esc(p.name)} · ${esc(TV.ROLE_LABEL[p.role] || p.role)}</option>`).join('')}</select></div><button class="btn" data-act="addmember" data-t="${t.id}" style="flex:0 0 auto">Adicionar</button></div>` : ''}</div>`; }).join('') : '<div class="empty-box">Nenhuma equipe. Os operadores são criados em Usuários, no app principal (perfil “Armazém · Operador”).</div>'}</div>`;
    }
    function openNewTeamModal() {
        openModal('Nova equipe', '<div class="field"><label class="f">Nome da equipe</label><input id="t-name" placeholder="ex.: Equipe 1"></div>', '<button class="btn" id="t-cancel">Cancelar</button><button class="btn btn-primary" id="t-go">Criar</button>');
        $('t-cancel').addEventListener('click', closeModal);
        $('t-go').addEventListener('click', () => guarded(async () => {
            const name = $('t-name').value.trim(); if (!name) throw new Error('Informe o nome.');
            const { error } = await sb.from('wh_teams').insert({ id: uuid(), site_key: S.site, name }); if (error) throw error;
            await loadTeams(); closeModal(); viewCampanhas();
        }));
    }
    function openNewCampModal() {
        openModal('Nova campanha', `
            <div class="field"><label class="f">Nome *</label><input id="c-name" placeholder="ex.: Inventário Inicial 2026"></div>
            <div class="row" style="margin-bottom:14px"><div class="field"><label class="f">Tipo</label><select id="c-kind"><option value="GERAL">Geral (todo o armazém)</option><option value="CICLICO">Cíclica</option></select></div>
                <div class="field"><label class="f">Recontagem automática</label><select id="c-mode">${MODES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div><div class="field" style="flex:0 0 100px"><label class="f">% amostra</label><input id="c-pct" type="number" min="0" max="100" value="20"></div></div>
            <div class="row" style="margin-bottom:14px"><div class="field"><label class="f">Tolerância (unidades)</label><input id="c-tq" type="number" min="0" step="any" value="0"></div><div class="field"><label class="f">Tolerância (%)</label><input id="c-tp" type="number" min="0" step="any" value="0"></div></div>
            <p class="muted" style="font-size:12px">Na primeira campanha, como não existe saldo de referência, use <b>Amostra</b> ou <b>Todos</b>. Estas regras não mudam depois que a campanha é ativada.</p>`,
            '<button class="btn" id="c-cancel">Cancelar</button><button class="btn btn-primary" id="c-go">Criar campanha</button>');
        $('c-cancel').addEventListener('click', closeModal);
        $('c-go').addEventListener('click', () => guarded(async () => {
            const name = $('c-name').value.trim(); if (!name) throw new Error('Informe o nome.');
            const id = uuid();
            const { error } = await sb.from('wh_campaigns').insert({ id, site_key: S.site, name, status: 'RASCUNHO', kind: $('c-kind').value, recount_mode: $('c-mode').value, recount_sample_pct: Number($('c-pct').value) || 0, tolerance_qty: Number($('c-tq').value) || 0, tolerance_pct: Number($('c-tp').value) || 0, created_by: S.ctx.user.id });
            if (error) throw error;
            await loadCampaigns(); setCamp(id); closeModal(); toast('Campanha criada. Agora atribua as ruas às equipes.'); viewCampanhas();
        }));
    }

    // ============================================================
    // 6. DIVERGÊNCIAS (comparação das rodadas + aprovação)
    // ============================================================
    function rowCalc(r) {
        const ref = S.cd.expected.has(r.location_id + ':' + r.item_id) ? S.cd.expected.get(r.location_id + ':' + r.item_id) : null;
        const last = r.r3 != null ? Number(r.r3) : r.r2 != null ? Number(r.r2) : r.r1 != null ? Number(r.r1) : null;
        const base = ref != null ? ref : (r.r1 != null && last !== Number(r.r1) ? Number(r.r1) : null);
        const dif = (last != null && base != null) ? last - base : null;
        const cost = S.costs.get(r.item_id);
        return { ref, last, dif, val: dif != null && cost != null ? dif * cost : null };
    }
    function lastRound(r) { return r.r3 != null ? 3 : r.r2 != null ? 2 : 1; }
    const closedSet = () => new Set(S.cd.closures.map(c => c.location_id + ':' + c.round));
    function approvable(r, cs) { return ['CONFERE', 'CONTADO'].includes(r.status) && cs.has(r.location_id + ':' + lastRound(r)); }
    function viewDiv() {
        const camp = campaign(), w = S.ctx.canWrite;
        if (!camp) { paint(emptyCamp('Divergências'), { gocamp: () => go('campanhas') }); return; }
        const all = S.cd.cons, cs = closedSet(), q = norm(S.contQ);
        const rows = all.filter(r => (!S.contStatus || r.status === S.contStatus) && (!q || norm(`${r.location_code} ${r.item_code} ${r.item_description}`).includes(q)));
        const nAppr = all.filter(r => approvable(r, cs)).length, cnt = st => all.filter(r => r.status === st).length;
        if (!all.length) { paint(`${pgHead('1ª × 2ª × 3ª contagem · referência = saldo do sistema Vale', 'Divergências e aprovações', '')}${statePanel('vazio', 'Divergências', 'Nenhuma contagem nesta campanha', 'Assim que o campo lançar, as divergências aparecem aqui automaticamente.', 'Ver visão geral', 'govisao')}`, { govisao: () => go('visao') }); return; }
        paint(`
        ${pgHead('1ª × 2ª × 3ª contagem · referência = saldo do sistema Vale', 'Divergências e aprovações', `${S.campaigns.length > 1 ? `<select id="camp-sel" style="width:auto">${S.campaigns.map(c => `<option value="${c.id}" ${c.id === S.campId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}<button class="btn btn-card" data-act="export">Exportar planilha</button>${w && camp.status === 'ATIVA' ? `<button class="btn btn-ok" data-act="approveall" ${nAppr ? '' : 'disabled'}>Aprovar tudo que está OK (${fmt.int(nAppr)})</button>` : ''}`)}
        <div class="chips"><button class="chip ${S.contStatus === '' ? 'on' : ''}" data-act="stf" data-st="" aria-pressed="${S.contStatus === ''}">Todos <span class="n">${fmt.int(all.length)}</span></button>
            ${Object.entries(ST).map(([k, [, i, l]]) => `<button class="chip ${S.contStatus === k ? 'on' : ''}" data-act="stf" data-st="${k}" aria-pressed="${S.contStatus === k}">${i} ${l} <span class="n">${fmt.int(cnt(k))}</span></button>`).join('')}
            <input id="ct-q" placeholder="Buscar endereço ou item" value="${esc(S.contQ)}" style="width:240px;margin-left:auto"></div>
        <section class="panel"><div class="tbl-wrap"><table class="tb" style="min-width:980px"><thead><tr><th>Endereço</th><th>Item</th><th class="num">Ref.</th><th class="num" style="border-left:1px solid var(--border-color)">1ª</th><th class="num">2ª</th><th class="num" style="border-right:1px solid var(--border-color)">3ª</th><th class="num">Diferença</th><th class="num">Valor</th><th>Status</th><th class="num">Ação</th></tr></thead><tbody>
        ${rows.slice(0, 300).map(r => { const c = rowCalc(r), idx = all.indexOf(r), dc = c.dif == null || c.dif === 0 ? 'var(--text-secondary)' : 'var(--red-text)'; const diff1 = r.r2 != null && Number(r.r2) !== Number(r.r1), diff2 = r.r3 != null && Number(r.r3) !== Number(r.r2);
            return `<tr><td class="code">${esc(r.location_code)}</td><td><div style="display:flex;flex-direction:column;gap:3px"><span>${esc(r.item_description)}</span><span style="display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text-secondary)"><span class="mono">${esc(r.item_code)}</span>${r.criticality !== 'NORMAL' ? seal : ''}</span></div></td>
                <td class="num muted">${c.ref == null ? '—' : fmt.num(c.ref)}</td><td class="num" style="font-weight:600;border-left:1px solid var(--divider)">${r.r1 == null ? '—' : fmt.num(r.r1)}</td><td class="num" style="font-weight:600;color:${diff1 ? 'var(--amber-text)' : 'inherit'}">${r.r2 == null ? '—' : fmt.num(r.r2)}</td><td class="num" style="font-weight:600;border-right:1px solid var(--divider);color:${diff2 ? 'var(--amber-text)' : 'inherit'}">${r.r3 == null ? '—' : fmt.num(r.r3)}</td>
                <td class="num" style="font-weight:700;color:${dc}">${c.dif == null ? '—' : (c.dif > 0 ? '+' : c.dif < 0 ? '−' : '') + fmt.num(Math.abs(c.dif))}</td><td class="num" style="color:${dc}">${c.val == null || c.val === 0 ? '—' : (c.val < 0 ? '− ' : '+ ') + fmt.money(Math.abs(c.val))}</td>
                <td>${stBadge(r.status)}</td><td class="num nowrap">${w && camp.status === 'ATIVA' && r.status !== 'PENDENTE_2A_CONTAGEM' ? `<button class="btn btn-sm ${r.status === 'APROVADO' ? '' : 'btn-primary'}" data-act="decide" data-i="${idx}">${r.status === 'APROVADO' ? 'Revisar' : 'Aprovar'}</button>` : `<span class="muted" style="font-size:12px">${r.status === 'PENDENTE_2A_CONTAGEM' ? 'aguarda 2ª pessoa' : ''}</span>`}</td></tr>`; }).join('') || '<tr><td colspan="10" class="muted" style="padding:24px;text-align:center">Nada encontrado.</td></tr>'}
        </tbody></table></div><div class="panel-foot">Números em âmbar diferem da contagem anterior. Itens críticos exigem duas contagens iguais antes da aprovação. Ref. = saldo de referência carregado; sem referência, a diferença compara a última contagem com a 1ª.${rows.length > 300 ? ` Mostrando 300 de ${fmt.int(rows.length)}.` : ''}</div></section>`, {
            stf: d => { S.contStatus = d.st; viewDiv(); }, export: exportDiv, decide: d => openDecideModal(all[Number(d.i)]), approveall: approveAll
        });
        const cs2 = $('camp-sel'); if (cs2) cs2.addEventListener('change', () => { setCamp(cs2.value); go('divergencias'); });
        const qi = $('ct-q'); qi.addEventListener('input', () => { S.contQ = qi.value; const p = qi.selectionStart; viewDiv(); const n = $('ct-q'); n.focus(); n.setSelectionRange(p, p); });
    }
    function exportDiv() {
        const aoa = [['Endereço', 'Código item', 'Descrição', 'Criticidade', 'Referência', '1ª contagem', '2ª contagem', '3ª contagem', 'Diferença', 'Valor (R$)', 'Status', 'Quantidade aprovada']];
        for (const r of S.cd.cons.filter(r => !S.contStatus || r.status === S.contStatus)) { const c = rowCalc(r); aoa.push([r.location_code, r.item_code, r.item_description, CRIT[r.criticality][0], c.ref, r.r1, r.r2, r.r3, c.dif, c.val, (ST[r.status] || [0, 0, r.status])[2], r.final_qty]); }
        const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 22 }, { wch: 18 }];
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Divergências');
        XLSX.writeFile(wb, `divergencias_${(campaign().name || 'campanha').replace(/[^a-z0-9]+/gi, '_')}.xlsx`);
    }
    function openDecideModal(r) {
        if (!r) return;
        const cs = closedSet(), c = rowCalc(r), needJust = r.status === 'DIVERGENTE' || r.status === 'RECONTAGEM';
        const opts = [1, 2, 3].filter(n => r['r' + n] != null && cs.has(r.location_id + ':' + n));
        openModal('Aprovar divergência', `
            <div style="display:flex;flex-direction:column;gap:4px;padding:12px 14px;border:1px solid ${needJust ? 'rgba(239,68,68,.45)' : 'var(--border-color)'};border-radius:10px;background:${needJust ? 'rgba(239,68,68,.08)' : 'var(--bg-sidebar)'};margin-bottom:14px">
                <span class="mono" style="font-size:13px;color:var(--blue-text)">${esc(r.location_code)}</span><b>${esc(r.item_description)}</b>
                <span style="font-size:13px;color:${needJust ? 'var(--red-text)' : 'var(--text-secondary)'}">${c.dif != null ? '! Diferença ' + (c.dif > 0 ? '+' : '−') + fmt.num(Math.abs(c.dif)) + (c.val ? ' · ' + fmt.money(Math.abs(c.val)) : '') : esc((ST[r.status] || [0, 0, r.status])[2])}</span></div>
            <div class="field"><label class="f">Qual valor vale?</label>
                ${opts.map((n, i) => `<label class="checkline" style="margin-bottom:8px"><input type="radio" name="dec" value="APROVAR_R${n}" ${i === opts.length - 1 ? 'checked' : ''}> Contagem da <b>${n}ª rodada</b>: ${fmt.num(r['r' + n])}</label>`).join('')}
                <label class="checkline"><input type="radio" name="dec" value="AJUSTE_MANUAL" ${opts.length ? '' : 'checked'}> Ajuste manual</label></div>
            <div id="dec-manual" class="${opts.length ? 'hidden' : ''}" style="margin-bottom:14px"><label class="f">Quantidade</label><input id="dec-qty" type="number" min="0" step="any" style="max-width:180px"></div>
            <div class="field"><label class="f" style="color:var(--text-body-2)">Justificativa ${needJust ? '(obrigatória)' : '(opcional)'}</label><textarea id="dec-reason" rows="3" placeholder="Ex.: Consumo da OM 4501928 não baixado no sistema; conferido com o almoxarife."></textarea></div>
            <span class="muted" style="font-size:12px">A aprovação fica registrada na auditoria com seu nome, data e hora.</span>`,
            '<button class="btn" id="dec-cancel">Cancelar</button><button class="btn btn-primary" id="dec-go">Aprovar</button>');
        $('dec-cancel').addEventListener('click', closeModal);
        document.querySelectorAll('input[name=dec]').forEach(x => x.addEventListener('change', () => $('dec-manual').classList.toggle('hidden', document.querySelector('input[name=dec]:checked').value !== 'AJUSTE_MANUAL')));
        $('dec-go').addEventListener('click', () => guarded(async () => {
            const how = document.querySelector('input[name=dec]:checked').value, reason = $('dec-reason').value.trim();
            let qty;
            if (how === 'AJUSTE_MANUAL') { qty = Number($('dec-qty').value); if ($('dec-qty').value === '' || isNaN(qty) || qty < 0) throw new Error('Informe a quantidade.'); if (reason.length < 5) throw new Error('Ajuste manual exige justificativa (mínimo 5 letras).'); }
            else qty = Number(r['r' + how.slice(-1)]);
            if (needJust && reason.length < 5) throw new Error('Escreva uma justificativa (mínimo 5 letras).');
            const { error } = await sb.from('wh_count_decisions').insert({ site_key: S.site, campaign_id: S.campId, location_id: r.location_id, item_id: r.item_id, final_qty: qty, decision: how, reason: reason || null, decided_by: S.ctx.user.id });
            if (error) throw error;
            closeModal(); toast('Divergência aprovada · registrada na auditoria'); await safeLoadCD(); await loadItems(); go('divergencias');
        }));
    }
    async function approveAll() {
        const cs = closedSet(), todo = S.cd.cons.filter(r => approvable(r, cs));
        if (!todo.length) return;
        if (!confirm(`Aprovar ${todo.length} linhas que estão OK (confere ou contagem única)? Fica registrado na trilha de auditoria.`)) return;
        for (let i = 0; i < todo.length; i += 200) {
            toast(`Aprovando… ${Math.min(i + 200, todo.length)}/${todo.length}`);
            const { error } = await sb.from('wh_count_decisions').insert(todo.slice(i, i + 200).map(r => { const n = lastRound(r); return { site_key: S.site, campaign_id: S.campId, location_id: r.location_id, item_id: r.item_id, final_qty: Number(r['r' + n]), decision: 'APROVAR_R' + n, decided_by: S.ctx.user.id }; }));
            if (error) throw new Error('Parou numa linha: ' + error.message + ' (as anteriores foram aprovadas).');
        }
        toast('Aprovado.'); await safeLoadCD(); await loadItems(); go('divergencias');
    }

    // ============================================================
    // 7. PERDAS E ACURACIDADE (prévia com dados de exemplo — fase futura)
    // ============================================================
    function viewPerdas() {
        const K = [['Acuracidade por linha', '97,4%', '#fff', 'var(--green)', '3.804 de 3.906 linhas conferem'], ['Acuracidade por valor', '98,1%', '#fff', 'var(--green)', 'sobre R$ 1,14 mi inventariados'], ['Faltas', 'R$ 18.420,00', 'var(--red-text)', 'var(--red)', '▼ 41 ocorrências'], ['Sobras', 'R$ 3.150,00', 'var(--blue-text)', '#60a5fa', '▲ 12 ocorrências'], ['Saídas sem OM', '14', 'var(--amber-text)', 'var(--amber)', 'R$ 6.870,00 sem ordem de manutenção']];
        const T = [['S34', 94.1], ['S35', 94.8], ['S36', 95.6], ['S37', 95.2], ['S38', 96.3], ['S39', 96.8], ['S40', 97.0], ['S41', 97.4]];
        const M = [['Jul', 6210, 1020], ['Ago', 4880, 870], ['Set', 4150, 760], ['Out', 3180, 500]];
        const RI = [['MAT-001873', 'Correia transportadora EP 400, 1200 mm', '4 ocorr.', '− R$ 9.680,00', 'var(--red-text)'], ['MAT-004512', 'Rolamento autocompensador 22218 E', '3 ocorr.', '− R$ 4.380,00', 'var(--red-text)'], ['MAT-005518', 'Rolete de carga Ø 152 mm', '3 ocorr.', '− R$ 2.205,00', 'var(--red-text)'], ['MAT-007734', 'Graxa de lítio EP2, balde 20 kg', '2 ocorr.', '+ R$ 1.240,00', 'var(--blue-text)'], ['MAT-009021', 'Luva de raspa cano longo', '5 ocorr.', '− R$ 612,00', 'var(--red-text)']];
        const RE = [['VGR-B-12-1', 4], ['VGR-A-03-2', 3], ['VGR-D-09-3', 3], ['VGR-C-05-1', 3], ['VGR-F-20-4', 2]];
        paint(`
        ${pgHead('Para a gestão Vale · Jul–Out/2026', 'Perdas e Acuracidade', '<span class="badge-future">Fase futura · prévia com dados de exemplo</span>')}
        <div class="notice" style="margin:0">Os números desta tela são <b>de exemplo</b>, para mostrar como o painel vai ficar. Eles passam a ser reais quando entrarem as saídas de material (com OM) e o saldo de referência da Vale.</div>
        <div class="kpis">${K.map(k => `<div class="kpi2" style="--c:${k[3]}"><div class="kpi-l">${k[0]}</div><div class="kpi-v" style="font-size:30px;color:${k[2]}">${k[1]}</div><div class="kpi-n">${k[4]}</div></div>`).join('')}</div>
        <div class="grid-auto" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr))">
            ${panel('Acuracidade por linha · tendência semanal', `<div class="trend"><div class="goal" style="bottom:154px"></div><span style="position:absolute;right:18px;bottom:158px;font-size:11px;color:var(--text-secondary)">98%</span>${T.map(([wk, v], i) => `<div class="col"><span style="font-size:11px;font-weight:600;color:${i === T.length - 1 ? 'var(--green-text)' : 'var(--text-secondary)'}">${String(v).replace('.', ',')}%</span><i style="height:${Math.round((v - 92) * 24)}px;background:${i === T.length - 1 ? 'var(--green)' : '#2b6a5a'}"></i><span class="muted" style="font-size:11px">${wk}</span></div>`).join('')}</div>`, '<small>meta 98%</small>', true)}
            ${panel('Valor em divergência por mês', `<div style="display:flex;align-items:flex-end;gap:20px;height:200px;padding:24px 22px 34px">${M.map(([mm, f, s]) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px"><div style="display:flex;align-items:flex-end;gap:6px;height:140px"><div style="display:flex;flex-direction:column;align-items:center;gap:3px"><span style="font-size:11px;color:var(--red-text);white-space:nowrap">R$ ${fmt.int(f)}</span><div style="width:28px;height:${Math.round(f / 6210 * 110)}px;background:var(--red);border-radius:3px 3px 0 0"></div></div><div style="display:flex;flex-direction:column;align-items:center;gap:3px"><span style="font-size:11px;color:var(--blue-text);white-space:nowrap">R$ ${fmt.int(s)}</span><div style="width:28px;height:${Math.max(4, Math.round(s / 6210 * 110))}px;background:#60a5fa;border-radius:3px 3px 0 0"></div></div></div><span class="muted" style="font-size:12px">${mm}</span></div>`).join('')}</div>`, '<span style="display:flex;gap:14px;font-size:12px;color:var(--text-body-2)"><span style="display:flex;align-items:center;gap:6px"><span class="sw" style="background:var(--red);border-radius:2px"></span>Faltas</span><span style="display:flex;align-items:center;gap:6px"><span class="sw" style="background:#60a5fa;border-radius:2px"></span>Sobras</span></span>', true)}
        </div>
        <div class="grid-auto" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr))">
            ${panel('Itens com mais ocorrências', RI.map((r, i) => `<div class="rank-row"><span class="n">${i + 1}</span><span style="display:flex;flex-direction:column;min-width:0"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r[1]}</span><span class="mono muted" style="font-size:12px">${r[0]}</span></span><span style="font-size:12px;color:var(--text-body-2)" class="nowrap">${r[2]}</span><b class="nowrap" style="color:${r[4]}">${r[3]}</b></div>`).join(''), '', true)}
            ${panel('Endereços com mais ocorrências', RE.map((r, i) => `<div class="rank-row" style="grid-template-columns:24px 120px minmax(0,1fr) 36px"><span class="n">${i + 1}</span><span class="mono" style="font-size:13px;color:var(--blue-text)">${r[0]}</span><span class="bar" style="height:8px"><i style="width:${r[1] / 4 * 100}%;background:var(--amber)"></i></span><b class="right">${r[1]}</b></div>`).join(''), '', true)}
        </div>`, {});
    }

    // ============================================================
    // 8. ETIQUETAS (PDF com QR)
    // ============================================================
    function labelOf(l) {
        const path = (l.path || []).map(id => S.byId.get(id)).filter(Boolean);
        const rua = path.find(p => p.kind === 'RUA');
        const i = rua ? S.ruas.findIndex(r => r.id === rua.id) : 0;
        return { loc: l, code: l.full_code, token: l.qr_token, color: ruaColor(Math.max(0, i)), sub: path.filter(p => p.kind !== 'ARMAZEM').map(p => `${KIND_LABEL[p.kind]} ${p.code}`).join(' · '), rua, prat: path.find(p => p.kind === 'PRATELEIRA') };
    }
    function etqLabels() {
        const out = [];
        for (const l of S.locs) {
            if (!(l.is_countable && l.active)) continue;
            const lb = labelOf(l);
            if (!lb.rua || !S.etq.ruas.has(lb.rua.id)) continue;
            if (lb.prat && /^\d+$/.test(lb.prat.code)) { const n = parseInt(lb.prat.code, 10); if (n < S.etq.de || n > S.etq.ate) continue; }
            out.push(lb);
        }
        return out.sort((a, b) => nat(a.code, b.code));
    }
    function viewEtiquetas() {
        if (!S.ruas.length) { paint(`${pgHead('Identificação física dos endereços', 'Etiquetas', '')}${statePanel('vazio', 'Etiquetas', 'Nenhum endereço cadastrado', 'Cadastre os endereços para imprimir as etiquetas.', 'Ir para Endereços', 'goend')}`, { goend: () => go('enderecos') }); return; }
        const labs = etqLabels(), first = labs[0], mod = MOD[S.etq.modelo];
        const sheets = Math.ceil(labs.length / mod.per);
        const shelfNums = S.locs.filter(l => l.kind === 'PRATELEIRA' && /^\d+$/.test(l.code) && S.etq.ruas.has(l.parent_id)).map(l => parseInt(l.code, 10));
        const mx = shelfNums.length ? Math.max(...shelfNums) : 99;
        paint(`
        ${pgHead('Identificação física dos endereços', 'Etiquetas', '')}
        <div class="split">
            <section class="panel" style="flex:0 1 360px;min-width:280px">
                <div class="panel-h">1. Escopo</div>
                <div style="padding:16px 18px;display:flex;flex-direction:column;gap:14px">
                    <div><div class="muted" style="font-size:13px;margin-bottom:8px">Rua</div><div class="chips">${S.ruas.map((r, i) => `<button class="ruabtn ${S.etq.ruas.has(r.id) ? 'on' : ''}" style="--rc:${ruaColor(i)}" data-act="rua" data-id="${r.id}" aria-pressed="${S.etq.ruas.has(r.id)}">${esc(r.code)}</button>`).join('')}</div></div>
                    <div class="row"><div class="field"><label class="f">Prateleira de</label><input id="e-de" type="number" min="1" max="${mx}" value="${S.etq.de}"></div><div class="field"><label class="f">até</label><input id="e-ate" type="number" min="1" max="999" value="${Math.min(S.etq.ate, 999)}"></div></div>
                </div>
                <div class="panel-h" style="border-top:1px solid var(--border-color)">2. Modelo</div>
                <div style="padding:16px 18px;display:flex;flex-direction:column;gap:8px">${Object.entries(MOD).map(([k, m]) => `<button class="model ${S.etq.modelo === k ? 'on' : ''}" data-act="modelo" data-k="${k}" role="radio" aria-checked="${S.etq.modelo === k}"><span class="rd"></span><span style="display:flex;flex-direction:column"><b>${m.l}</b><span class="muted" style="font-size:12px">${m.s}</span></span></button>`).join('')}</div>
                <div style="padding:16px 18px;border-top:1px solid var(--border-color);display:flex;flex-direction:column;gap:10px">
                    <div style="display:flex;justify-content:space-between"><span class="muted">Total</span><b>${fmt.int(labs.length)} etiquetas · ${mod.per === 1 ? labs.length + ' no rolo' : sheets + ' folha(s)'}</b></div>
                    <button class="btn btn-primary" style="height:44px;font-weight:700" data-act="pdf" ${labs.length ? '' : 'disabled'}>Gerar PDF</button>
                    <button class="btn btn-sm" data-act="pdftest" ${labs.length ? '' : 'disabled'}>Folha de teste (3 etiquetas)</button>
                </div>
            </section>
            <section class="panel" style="flex:1 1 480px;min-width:0"><div class="panel-h"><span>Prévia da etiqueta</span><small>tamanho real ≈ ${mod.size}</small></div>
                ${first ? `<div class="label-stage"><div class="label-prev"><div class="strip" style="background:${first.color}"></div><div class="in">${qrGrid(qrPayload(first.token), 'qrcells', '')}<div style="display:flex;flex-direction:column;gap:6px;min-width:0"><span style="font-size:12px;font-weight:700;letter-spacing:.1em">VGR - ARMAZÉM</span><span class="code">${esc(first.code)}</span><span style="font-size:13px;font-weight:600">${esc(first.sub)}</span></div></div></div></div>`
                : '<div class="empty-box" style="margin:28px">Nenhum endereço no escopo escolhido.</div>'}
                <div class="panel-foot" style="font-size:13px;padding:14px 18px">Primeira etiqueta do lote. Faixa lateral na cor da rua para identificar à distância; código legível mesmo sem leitor. O QR guarda <span class="mono">TVA1|L|código curto</span>, que o app reconhece como endereço.</div>
            </section>
        </div>`, {
            rua: d => { S.etq.ruas.has(d.id) ? S.etq.ruas.delete(d.id) : S.etq.ruas.add(d.id); viewEtiquetas(); },
            modelo: d => { S.etq.modelo = d.k; viewEtiquetas(); },
            pdf: () => printLabels(labs), pdftest: () => printLabels(labs.slice(0, 3))
        });
        const de = $('e-de'), ate = $('e-ate');
        const upd = () => { S.etq.de = Math.max(1, parseInt(de.value, 10) || 1); S.etq.ate = Math.max(S.etq.de, parseInt(ate.value, 10) || 999); viewEtiquetas(); };
        de.addEventListener('change', upd); ate.addEventListener('change', upd);
    }
    function drawLabel(doc, x, y, w, h, lb, border) {
        const rgb = lb.color.match(/\w\w/g).map(h2 => parseInt(h2, 16));
        if (border) { doc.setDrawColor(200); doc.setLineWidth(0.15); doc.rect(x, y, w, h); }
        doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.rect(x, y, 5, h, 'F');            // faixa lateral na cor da rua
        const m = qrMatrix(qrPayload(lb.token));
        const q = Math.min(h - 8, w * 0.4), qx = x + 10, qy = y + (h - q) / 2;
        if (m) {
            const cell = q / m.n; doc.setFillColor(12, 16, 23);
            for (let r = 0; r < m.n; r++) { let c = 0; while (c < m.n) { if (m.rows[r][c]) { let e = c; while (e < m.n && m.rows[r][e]) e++; doc.rect(qx + c * cell, qy + r * cell, (e - c) * cell, cell, 'F'); c = e; } else c++; } }
        }
        const tx = qx + q + 5, tw = x + w - tx - 3;
        doc.setTextColor(12, 16, 23); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text('VGR - ARMAZÉM', tx, y + h / 2 - 8);
        let fs = 30; doc.setFont('courier', 'bold');
        while (fs > 10) { doc.setFontSize(fs); if (doc.getTextWidth(lb.code) <= tw) break; fs -= 1; }
        doc.text(lb.code, tx, y + h / 2 + 1);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text(doc.splitTextToSize(lb.sub, tw), tx, y + h / 2 + 8);
    }
    function printLabels(labs) {
        if (!labs.length) return;
        if (!window.jspdf) { toast('A biblioteca de PDF não carregou. Verifique a conexão e recarregue.', 'err'); return; }
        const mod = MOD[S.etq.modelo], term = mod.per === 1;
        const doc = new window.jspdf.jsPDF({ unit: 'mm', format: term ? [mod.w, mod.h] : 'a4', orientation: term ? 'landscape' : 'portrait' });
        const x0 = term ? 0 : (210 - mod.cols * mod.w) / 2, y0 = term ? 0 : (297 - mod.rows * mod.h) / 2;
        labs.forEach((lb, i) => {
            if (term) { if (i > 0) doc.addPage([mod.w, mod.h], 'landscape'); drawLabel(doc, 0, 0, mod.w, mod.h, lb, false); return; }
            const k = i % mod.per; if (i > 0 && k === 0) doc.addPage();
            drawLabel(doc, x0 + (k % mod.cols) * mod.w, y0 + Math.floor(k / mod.cols) * mod.h, mod.w, mod.h, lb, true);
        });
        doc.save(`etiquetas_${S.site}_${labs.length}.pdf`);
        toast(`PDF gerado: ${fmt.int(labs.length)} etiquetas.`);
    }

    // ============================================================
    // 9. AUDITORIA
    // ============================================================
    const TBL_LABEL = { wh_locations: 'endereço', wh_items: 'item', wh_item_costs: 'custo do item', wh_item_barcodes: 'código de barras', wh_teams: 'equipe', wh_team_members: 'membro de equipe', wh_campaigns: 'campanha', wh_campaign_assignments: 'atribuição de rua', wh_expected_stock: 'saldo esperado', wh_unidentified_items: 'item sem cadastro', wh_recount_tasks: 'recontagem', wh_site_settings: 'parâmetros' };
    const ACT_LABEL = { INSERT: 'cadastrou', UPDATE: 'alterou', DELETE: 'removeu' };
    function auditDiff(a) {
        if (a.action === 'INSERT') return ['—', 'criado'];
        if (a.action === 'DELETE') return ['existia', 'removido'];
        const o = a.old_data || {}, n = a.new_data || {}, ch = Object.keys(n).filter(k => !/_at$|^updated|^chain|hash/.test(k) && JSON.stringify(n[k]) !== JSON.stringify(o[k])).slice(0, 2);
        return [ch.map(k => `${k}: ${o[k] == null ? '—' : o[k]}`).join(' · ') || '—', ch.map(k => `${k}: ${n[k] == null ? '—' : n[k]}`).join(' · ') || '—'];
    }
    async function loadAudit() {
        const tables = ['wh_count_events', 'wh_count_closures', 'wh_count_decisions', 'wh_audit_log'];
        const [au, ev, de, counts, ver] = await Promise.all([
            sb.from('wh_audit_log').select('id, table_name, row_id, action, old_data, new_data, actor_label, at, row_hash').eq('site_key', S.site).order('at', { ascending: false }).limit(60),
            sb.from('wh_count_events').select('id, location_id, item_id, qty, round, counted_by_label, counted_at, row_hash').eq('site_key', S.site).order('counted_at', { ascending: false }).limit(60),
            sb.from('wh_count_decisions').select('id, location_id, item_id, final_qty, decision, reason, decided_by_label, decided_at, row_hash').eq('site_key', S.site).order('decided_at', { ascending: false }).limit(60),
            Promise.all(tables.map(t => sb.from(t).select('id', { count: 'exact', head: true }).eq('site_key', S.site))),
            Promise.all(tables.map(t => sb.rpc('wh_verify_chain', { p_site: S.site, p_table: t })))
        ]);
        const lines = [];
        for (const e of (ev.data || [])) { const l = S.byId.get(e.location_id), it = S.itemById.get(e.item_id); lines.push({ t: e.counted_at, cat: 'contagens', c: 'var(--blue-ring)', who: e.counted_by_label || '—', act: `contou na ${e.round}ª rodada`, where: `${l ? l.full_code : ''}${it ? ' · ' + it.code : ''}`, a: '—', d: `${fmt.num(e.qty)}${it ? ' ' + it.uom : ''}`, h: e.row_hash }); }
        for (const e of (de.data || [])) { const l = S.byId.get(e.location_id), it = S.itemById.get(e.item_id); lines.push({ t: e.decided_at, cat: 'aprovacoes', c: 'var(--green)', who: e.decided_by_label || '—', act: `aprovou (${(e.decision || '').replace('APROVAR_R', 'rodada ').replace('AJUSTE_MANUAL', 'ajuste manual')})`, where: `${l ? l.full_code : ''}${it ? ' · ' + it.code : ''}`, a: e.reason || '—', d: `${fmt.num(e.final_qty)}${it ? ' ' + it.uom : ''}`, h: e.row_hash }); }
        for (const a of (au.data || [])) { const [antes, depois] = auditDiff(a), nd = a.new_data || a.old_data || {}; lines.push({ t: a.at, cat: 'cadastros', c: 'var(--amber)', who: a.actor_label || 'sistema', act: `${ACT_LABEL[a.action]} ${TBL_LABEL[a.table_name] || a.table_name}`, where: nd.full_code || nd.code || nd.name || '', a: antes, d: depois, h: a.row_hash }); }
        lines.sort((x, y) => new Date(y.t) - new Date(x.t));
        const total = counts.reduce((s, c) => s + (c.count || 0), 0);
        const results = ver.map((v, i) => ({ t: tables[i], ok: !v.error && !!(v.data && v.data[0] && v.data[0].ok), detail: v.error ? v.error.message : (v.data && v.data[0] ? v.data[0].detail : '') }));
        S.aud = { lines: lines.slice(0, 80), total, results, at: new Date(), hash: ((au.data || [])[0] || {}).row_hash };
    }
    async function viewAuditoria() {
        await loadAudit();
        const a = S.aud, ok = a.results.every(r => r.ok), bad = a.results.find(r => !r.ok);
        const lines = a.lines.filter(l => S.audFilter === 'todos' || l.cat === S.audFilter);
        paint(`
        ${pgHead(`Registro imutável · ${fmt.int(a.total)} eventos`, 'Auditoria', `<div class="chain-ok ${ok ? '' : 'bad'}"><span class="ck">${ok ? '✓' : '!'}</span><span style="display:flex;flex-direction:column"><b style="color:${ok ? '#6ee7b7' : 'var(--red-text)'}">${ok ? 'Cadeia íntegra ✓' : 'Cadeia com problema'}</b><span class="mono" style="font-size:12px;color:var(--text-body-2)">${ok ? `último hash ${a.hash ? esc(a.hash.slice(0, 4) + '…' + a.hash.slice(-4)) : '—'} · verificado ${fmt.time(a.at)}` : esc(bad.t + ': ' + bad.detail)}</span></span></div>`)}
        <section class="panel"><div class="toolbar" style="gap:8px">${[['todos', 'Todos'], ['contagens', 'Contagens'], ['aprovacoes', 'Aprovações'], ['cadastros', 'Cadastros']].map(([k, l]) => `<button class="chip ${S.audFilter === k ? 'on' : ''}" data-act="af" data-k="${k}">${l}</button>`).join('')}<span class="muted" style="margin-left:auto">Mais recentes</span></div>
            <div style="padding:8px 20px 16px">${lines.map(l => `<div class="tl"><span class="t">${fmt.time(l.t)}<br><span style="font-size:10px">${new Date(l.t).toLocaleDateString('pt-BR').slice(0, 5)}</span></span><span class="rail"><i></i><b style="--c:${l.c}"></b><i></i></span><div class="bd"><span style="display:flex;gap:8px;flex-wrap:wrap;align-items:baseline"><b>${esc(l.who)}</b><span style="color:var(--text-body-2)">${esc(l.act)}</span><span class="mono" style="font-size:12px;color:var(--blue-text)">${esc(l.where)}</span></span><span class="diff"><span class="v old">${esc(l.a)}</span><span class="muted">→</span><span class="v">${esc(l.d)}</span><span class="hash">${l.h ? '#' + esc(l.h.slice(0, 4)) : ''}</span></span></div></div>`).join('') || '<div class="empty-box" style="margin:16px 0">Nenhum registro neste filtro.</div>'}</div></section>`, {
            af: d => { S.audFilter = d.k; viewAuditoria(); }
        });
    }

    // ============================================================
    // INÍCIO
    // ============================================================
    async function init(ctx) {
        S.ctx = ctx;
        if (!ctx.sites.length) {
            $('app').innerHTML = `<div style="flex:1">${statePanel('vazio', 'Armazém', 'Nenhum armazém liberado para o seu usuário', 'Peça ao Admin para liberar o site <b>VGR - Armazém</b> no seu cadastro (Usuários, no app principal).', 'Sair', 'out')}</div>`;
            $('app').onclick = ev => { if (ev.target.closest('[data-act]')) TV.signOut(); };
            return;
        }
        const saved = store.get('tv_arm_site', null);
        S.site = (ctx.sites.find(s => s.key === saved) || ctx.sites[0]).key;
        $('app').innerHTML = `<div style="flex:1;padding:24px">${skeleton()}</div>`;
        try { await reloadAll(); } catch (e) { toast('Erro ao carregar dados: ' + e.message, 'err'); }
        await go('visao');
    }
    window.Gestao = { init, _S: S, _refresh: safeLoadCD };
})();
