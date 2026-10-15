/* ============================================================
   TerraVia Armazém — GESTÃO (notebook): visão geral, endereços, itens,
   equipes, campanhas e contagens/aprovação.
   Quem pode o quê é decidido pelo BANCO (RLS). Aqui, `ctx.canWrite` só
   esconde os botões de escrita pra quem não tem permissão (Gestor Vale).
   ============================================================ */
(function () {
    'use strict';
    const { sb, esc, fmt, toast, openModal, closeModal, fetchAll, uuid, norm, store } = TV;

    const KIND_LABEL = { ARMAZEM: 'Armazém', RUA: 'Rua', PRATELEIRA: 'Prateleira', NIVEL: 'Nível', POSICAO: 'Posição' };
    const KIND_PLURAL = { ARMAZEM: 'Armazéns', RUA: 'Ruas', PRATELEIRA: 'Prateleiras', NIVEL: 'Níveis', POSICAO: 'Posições' };
    const KIND_ORDER = ['ARMAZEM', 'RUA', 'PRATELEIRA', 'NIVEL', 'POSICAO'];
    const CAMP_BADGE = { RASCUNHO: ['', 'Rascunho'], ATIVA: ['badge-ok', 'Ativa'], FECHADA: ['badge-info', 'Fechada'], CANCELADA: ['badge-err', 'Cancelada'] };
    const STATUS_BADGE = {
        APROVADO: ['badge-ok', 'Aprovado'], CONFERE: ['badge-ok', 'Confere'], CONTADO: ['badge-info', 'Contado'],
        DIVERGENTE: ['badge-err', 'Divergente'], RECONTAGEM: ['badge-warn', 'Recontagem'], PENDENTE_2A_CONTAGEM: ['badge-warn', 'Falta 2ª conferência']
    };
    const CRIT_LABEL = { NORMAL: 'Normal', ALTO_VALOR: 'Alto valor', CRITICO: 'Crítico' };
    const ICON = {
        geral: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
        enderecos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
        itens: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/></svg>',
        equipes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17.5 14.5c2.4.2 3.9 1.7 4.5 4.5"/></svg>',
        campanhas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/></svg>',
        contagens: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>'
    };
    const TABS = [
        ['geral', 'Visão geral'], ['enderecos', 'Endereços'], ['itens', 'Itens'],
        ['equipes', 'Equipes'], ['campanhas', 'Campanhas'], ['contagens', 'Contagens']
    ];

    const S = {
        ctx: null, site: null, tab: 'geral', timer: null,
        locs: [], byId: new Map(), byFull: new Map(), kids: new Map(),
        items: [], itemById: new Map(), costs: new Map(),
        teams: [], members: [], people: [],
        campaigns: [], assignments: [], campId: null,
        expanded: new Set(), q: '', kindFilter: '',
        itemQ: '', contQ: '', contStatus: '', contRows: [], contClosures: new Set()
    };
    let handlers = {};

    const $ = id => document.getElementById(id);
    const view = () => $('view');
    function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }
    async function guarded(fn) { try { return await fn(); } catch (e) { toast(e && e.message ? e.message : String(e), 'err'); } }
    function badge(cls, text) { return `<span class="badge ${cls}">${esc(text)}</span>`; }

    // ============================================================
    // CARREGAMENTO DE DADOS
    // ============================================================
    async function loadLocs() {
        S.locs = await fetchAll((f, t) => sb.from('wh_locations')
            .select('id, parent_id, kind, code, full_code, qr_token, path, is_countable, active')
            .eq('site_key', S.site).order('full_code').range(f, t));
        S.byId = new Map(); S.byFull = new Map(); S.kids = new Map();
        for (const l of S.locs) {
            S.byId.set(l.id, l); S.byFull.set(l.full_code, l);
            const k = l.parent_id || 'root';
            if (!S.kids.has(k)) S.kids.set(k, []);
            S.kids.get(k).push(l);
        }
        for (const arr of S.kids.values()) arr.sort((a, b) => a.code.localeCompare(b.code, 'pt-BR', { numeric: true }));
    }
    async function loadItems() {
        S.items = await fetchAll((f, t) => sb.from('wh_items')
            .select('id, code, vale_material_code, description, uom, criticality, criticality_source, abc_class, active')
            .eq('site_key', S.site).order('code').range(f, t));
        S.itemById = new Map(S.items.map(i => [i.id, i]));
        S.costs = new Map();
        // Custo só existe pra quem pode ver (operador não chega nesta tela).
        try {
            const cs = await fetchAll((f, t) => sb.from('wh_item_costs').select('item_id, unit_cost').eq('site_key', S.site).range(f, t));
            for (const c of cs) S.costs.set(c.item_id, Number(c.unit_cost));
        } catch (e) { /* sem permissão: segue sem custo */ }
    }
    async function loadTeams() {
        const [t, m, p] = await Promise.all([
            sb.from('wh_teams').select('id, name').eq('site_key', S.site).order('name'),
            sb.from('wh_team_members').select('team_id, profile_id').eq('site_key', S.site),
            sb.rpc('wh_site_people', { p_site: S.site })      // a tabela profiles não é legível pelo supervisor
        ]);
        if (t.error) throw t.error;
        S.teams = t.data || []; S.members = m.data || [];
        S.people = p.data || [];
    }
    async function loadCampaigns() {
        const [c, a] = await Promise.all([
            sb.from('wh_campaigns').select('*').eq('site_key', S.site).order('created_at', { ascending: false }),
            sb.from('wh_campaign_assignments').select('*').eq('site_key', S.site)
        ]);
        if (c.error) throw c.error;
        S.campaigns = c.data || []; S.assignments = a.data || [];
        const saved = store.get('tv_arm_camp_' + S.site, null);
        if (!S.campaigns.find(x => x.id === S.campId)) {
            S.campId = (S.campaigns.find(x => x.id === saved) || S.campaigns.find(x => x.status === 'ATIVA') || S.campaigns[0] || {}).id || null;
        }
    }
    const campaign = () => S.campaigns.find(c => c.id === S.campId) || null;
    function setCamp(id) { S.campId = id; store.set('tv_arm_camp_' + S.site, id); }

    // ============================================================
    // CASCA: menu, topo, navegação
    // ============================================================
    function renderShell() {
        const c = S.ctx;
        $('side').innerHTML = `
            <div class="brand"><img src="../assets/terravia-icon-192.png" alt=""><div><b>Armazém</b><div class="muted" style="font-size:11px;">TerraVia Ops</div></div></div>
            ${TABS.map(([k, l]) => `<button class="nav-item ${S.tab === k ? 'active' : ''}" data-tab="${k}">${ICON[k]}<span>${l}</span></button>`).join('')}
            <div class="side-foot">
                <div><b style="color:var(--text-primary)">${esc(c.profile.name)}</b></div>
                <div style="margin-bottom:8px">${esc(TV.ROLE_LABEL[c.role] || c.role)}</div>
                ${c.role === 'ARM_SUPERVISOR' ? '<a class="btn btn-sm" href="index.html?ir=campo" style="margin-bottom:6px;width:100%">Modo campo (celular)</a>' : ''}
                ${c.role === 'ADMIN' ? '<a class="btn btn-sm" href="../index.html" style="margin-bottom:6px;width:100%">Usuários (app principal)</a>' : ''}
                <button class="btn btn-sm btn-ghost" id="btn-logout" style="width:100%">Sair</button>
            </div>`;
        $('side').querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
        $('btn-logout').addEventListener('click', () => TV.signOut());
        const title = (TABS.find(t => t[0] === S.tab) || [])[1] || '';
        const siteSel = c.sites.length > 1
            ? `<select id="site-sel" style="width:auto">${c.sites.map(s => `<option value="${esc(s.key)}" ${s.key === S.site ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>`
            : `<span class="badge badge-info">${esc((c.sites[0] || {}).label || '')}</span>`;
        $('topbar').innerHTML = `<h2>${esc(title)}</h2><div class="row" style="gap:8px;align-items:center">${siteSel}</div>`;
        const ss = $('site-sel');
        if (ss) ss.addEventListener('change', async () => { S.site = ss.value; store.set('tv_arm_site', S.site); await reloadAll(); go(S.tab); });
    }
    async function go(tab) {
        stopTimer();
        S.tab = tab;
        renderShell();
        view().innerHTML = '<div class="spinner"></div>';
        await guarded(async () => {
            if (tab === 'geral') await viewGeral();
            else if (tab === 'enderecos') viewEnderecos();
            else if (tab === 'itens') viewItens();
            else if (tab === 'equipes') viewEquipes();
            else if (tab === 'campanhas') viewCampanhas();
            else if (tab === 'contagens') await viewContagens();
        });
    }
    function bindView(map) {
        handlers = map;
        view().onclick = ev => {
            const b = ev.target.closest('[data-act]');
            if (!b || !handlers[b.dataset.act]) return;
            guarded(() => handlers[b.dataset.act](b.dataset, b, ev));
        };
    }
    async function reloadAll() {
        await Promise.all([loadLocs(), loadItems(), loadTeams(), loadCampaigns()]);
    }
    function campSelectHtml(extra) {
        if (!S.campaigns.length) return '';
        return `<select id="camp-sel" style="width:auto;min-width:240px" ${extra || ''}>${S.campaigns.map(c => `<option value="${c.id}" ${c.id === S.campId ? 'selected' : ''}>${esc(c.name)} · ${CAMP_BADGE[c.status][1]}</option>`).join('')}</select>`;
    }
    function bindCampSelect(after) {
        const el = $('camp-sel');
        if (el) el.addEventListener('change', () => { setCamp(el.value); after(); });
    }
    const emptyHtml = (title, text) => `<div class="empty"><b>${esc(title)}</b>${text || ''}</div>`;

    // ============================================================
    // VISÃO GERAL (atualiza sozinha a cada 20 s)
    // ============================================================
    async function viewGeral() {
        const camp = campaign();
        if (!camp) {
            view().innerHTML = `<div class="card">${emptyHtml('Nenhuma campanha ainda', 'Cadastre endereços e itens, monte uma equipe e crie a primeira campanha em <b>Campanhas</b>.')}</div>`;
            bindView({});
            return;
        }
        await paintGeral();
        S.timer = setInterval(() => { if (S.tab === 'geral' && !document.getElementById('modal-bg')) paintGeral().catch(() => { }); }, 20000);
    }
    async function paintGeral() {
        const camp = campaign();
        const startDay = new Date(); startDay.setHours(0, 0, 0, 0);
        const [prog, nEv, nCl, cons, last, today] = await Promise.all([
            sb.from('v_wh_campaign_progress').select('*').eq('campaign_id', camp.id),
            sb.from('wh_count_events').select('id', { count: 'exact', head: true }).eq('campaign_id', camp.id),
            sb.from('wh_count_closures').select('id', { count: 'exact', head: true }).eq('campaign_id', camp.id),
            fetchAll((f, t) => sb.from('v_wh_count_consolidated').select('status').eq('campaign_id', camp.id).range(f, t)),
            sb.from('wh_count_events').select('id, location_id, item_id, qty, round, counted_by_label, counted_at').eq('campaign_id', camp.id).order('counted_at', { ascending: false }).limit(12),
            sb.from('wh_count_events').select('counted_by_label').eq('campaign_id', camp.id).gte('counted_at', startDay.toISOString()).limit(5000)
        ]);
        const pr = (prog.data || []);
        const r1 = pr.filter(p => p.round === 1);
        const total = r1.reduce((s, p) => s + Number(p.total_addresses || 0), 0);
        const done = r1.reduce((s, p) => s + Number(p.counted_addresses || 0), 0);
        const cnt = st => cons.filter(c => c.status === st).length;
        const pct = total ? (100 * done / total) : 0;
        const byPerson = {};
        for (const e of (today.data || [])) byPerson[e.counted_by_label || '—'] = (byPerson[e.counted_by_label || '—'] || 0) + 1;
        const people = Object.entries(byPerson).sort((a, b) => b[1] - a[1]);
        const maxP = people.length ? people[0][1] : 1;

        view().innerHTML = `
            <div class="toolbar">${campSelectHtml()} ${badge(CAMP_BADGE[camp.status][0], CAMP_BADGE[camp.status][1])}
                <span class="muted" style="font-size:12px">Atualiza sozinha a cada 20 s · ${fmt.time(new Date())}</span></div>
            <div class="kpi-row">
                <div class="kpi" style="--accent:var(--color-primary)"><div class="v">${fmt.pct(pct)}</div><div class="l">Conclusão da campanha</div><div class="s">${fmt.int(done)} de ${fmt.int(total)} endereços</div></div>
                <div class="kpi" style="--accent:var(--color-ok)"><div class="v">${fmt.int(cons.length)}</div><div class="l">Itens contados</div><div class="s">combinações endereço × item</div></div>
                <div class="kpi" style="--accent:var(--color-info)"><div class="v">${fmt.int(nEv.count)}</div><div class="l">Linhas de contagem</div><div class="s">${fmt.int(nCl.count)} endereços finalizados</div></div>
                <div class="kpi" style="--accent:var(--color-err)"><div class="v">${fmt.int(cnt('DIVERGENTE'))}</div><div class="l">Divergências</div><div class="s">${fmt.int(cnt('RECONTAGEM'))} em recontagem</div></div>
                <div class="kpi" style="--accent:var(--color-warn)"><div class="v">${fmt.int(cnt('APROVADO'))}</div><div class="l">Aprovados</div><div class="s">${fmt.int(cnt('CONFERE') + cnt('CONTADO'))} aguardando aprovação</div></div>
            </div>
            <div class="grid2">
                <div class="card"><div class="card-head"><h3>Progresso por rua</h3></div>
                    ${pr.length ? `<div class="rua-bars">${pr.sort((a, b) => String(a.assigned_code).localeCompare(String(b.assigned_code), 'pt-BR', { numeric: true })).map(p => `
                        <div class="rb"><div><b>${esc(p.assigned_code)}</b>${p.round > 1 ? ` <span class="muted">R${p.round}</span>` : ''}<div class="muted" style="font-size:11px">${esc(p.team_name)}</div></div>
                        <div class="bar ${Number(p.pct_done) >= 100 ? 'ok' : ''}"><i style="width:${Math.min(100, Number(p.pct_done) || 0)}%"></i></div>
                        <div class="right"><b>${fmt.pct(p.pct_done)}</b><div class="muted" style="font-size:11px">${p.counted_addresses}/${p.total_addresses}</div></div></div>`).join('')}</div>`
                        : emptyHtml('Nenhuma rua atribuída', 'Atribua ruas a equipes na campanha.')}
                </div>
                <div class="card"><div class="card-head"><h3>Produtividade de hoje</h3><span class="muted" style="font-size:12px">linhas lançadas</span></div>
                    ${people.length ? `<div class="rua-bars">${people.map(([n, v]) => `<div class="rb" style="grid-template-columns:130px 1fr 50px"><div>${esc(n)}</div><div class="bar"><i style="width:${100 * v / maxP}%"></i></div><div class="right"><b>${v}</b></div></div>`).join('')}</div>`
                        : emptyHtml('Sem contagens hoje', '')}
                </div>
            </div>
            <div class="card"><div class="card-head"><h3>Últimas contagens</h3></div>
                ${(last.data || []).length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Hora</th><th>Endereço</th><th>Item</th><th class="num">Qtd</th><th>Rodada</th><th>Quem</th></tr></thead><tbody>
                    ${last.data.map(e => { const l = S.byId.get(e.location_id); const it = S.itemById.get(e.item_id); return `<tr><td class="nowrap">${fmt.time(e.counted_at)}</td><td class="mono">${esc(l ? l.full_code : '—')}</td><td>${it ? `<b>${esc(it.code)}</b> ${esc(it.description)}` : '<span class="muted">sem cadastro / endereço vazio</span>'}</td><td class="num">${fmt.num(e.qty)}</td><td>${e.round}ª</td><td>${esc(e.counted_by_label || '—')}</td></tr>`; }).join('')}
                </tbody></table></div>` : emptyHtml('Nenhuma contagem registrada', 'Assim que o campo lançar, aparece aqui.')}
            </div>`;
        bindCampSelect(() => go('geral'));
    }

    // ============================================================
    // ENDEREÇOS
    // ============================================================
    function visibleRows() {
        const q = S.q.trim().toUpperCase();
        if (q || S.kindFilter) {
            return S.locs.filter(l => (!q || l.full_code.includes(q)) && (!S.kindFilter || l.kind === S.kindFilter)).slice(0, 400).map(l => ({ l, depth: 0, flat: true }));
        }
        const out = [];
        (function walk(parent, depth) {
            for (const l of (S.kids.get(parent) || [])) {
                out.push({ l, depth });
                if (S.expanded.has(l.id)) walk(l.id, depth + 1);
            }
        })('root', 0);
        return out;
    }
    function viewEnderecos() {
        const w = S.ctx.canWrite;
        const counts = KIND_ORDER.map(k => [k, S.locs.filter(l => l.kind === k).length]);
        const countable = S.locs.filter(l => l.is_countable).length;
        const rows = visibleRows();
        view().innerHTML = `
            <div class="kpi-row">
                ${counts.filter(c => c[1] > 0 || c[0] !== 'POSICAO').map(([k, n]) => `<div class="kpi" style="--accent:var(--color-primary)"><div class="v">${fmt.int(n)}</div><div class="l">${n === 1 ? KIND_LABEL[k] : KIND_PLURAL[k]}</div></div>`).join('')}
                <div class="kpi" style="--accent:var(--color-ok)"><div class="v">${fmt.int(countable)}</div><div class="l">Endereços contáveis</div></div>
            </div>
            <div class="toolbar">
                <input id="loc-q" placeholder="Buscar (ex.: A-03)" value="${esc(S.q)}">
                <select id="loc-kind"><option value="">Todos os tipos</option>${KIND_ORDER.map(k => `<option value="${k}" ${S.kindFilter === k ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select>
                ${w ? '<button class="btn btn-primary" data-act="batch">+ Gerar em lote</button><button class="btn" data-act="newloc">+ Novo endereço</button>' : ''}
            </div>
            ${S.locs.length === 0 ? `<div class="card">${emptyHtml('Nenhum endereço cadastrado', w ? 'Use <b>Gerar em lote</b> para criar ruas, prateleiras e níveis de uma vez.' : 'O supervisor ainda não cadastrou os endereços.')}</div>` : `
            <div class="tablewrap"><table class="t"><thead><tr><th>Endereço</th><th>Tipo</th><th>Contável</th><th>Situação</th><th>Código do QR</th><th></th></tr></thead><tbody id="loc-body">
                ${rows.map(({ l, depth, flat }) => {
                    const hasKids = (S.kids.get(l.id) || []).length > 0;
                    return `<tr style="${l.active ? '' : 'opacity:.5'}">
                        <td style="padding-left:${12 + depth * 22}px">${!flat && hasKids ? `<span class="twisty" data-act="toggle" data-id="${l.id}">${S.expanded.has(l.id) ? '▾' : '▸'}</span>` : '<span class="twisty"></span>'}<span class="tree-code">${esc(flat ? l.full_code : l.code)}</span>${!flat ? '' : ''}</td>
                        <td>${esc(KIND_LABEL[l.kind])}</td><td>${l.is_countable ? badge('badge-ok', 'Sim') : '<span class="muted">—</span>'}</td>
                        <td>${l.active ? badge('badge-ok', 'Ativo') : badge('badge-err', 'Inativo')}</td>
                        <td class="mono muted">${esc(l.qr_token)}</td>
                        <td class="right">${w ? `<button class="btn btn-sm" data-act="editloc" data-id="${l.id}">Editar</button>` : ''}</td></tr>`;
                }).join('') || '<tr><td colspan="6" class="muted" style="padding:20px;text-align:center">Nada encontrado.</td></tr>'}
            </tbody></table></div>
            ${rows.length >= 400 ? '<p class="muted" style="margin-top:8px;font-size:12px">Mostrando os 400 primeiros. Refine a busca.</p>' : ''}`}`;
        const q = $('loc-q');
        if (q) q.addEventListener('input', () => { S.q = q.value; repaintLocBody(); });
        const k = $('loc-kind');
        if (k) k.addEventListener('change', () => { S.kindFilter = k.value; viewEnderecos(); });
        bindView({
            toggle: d => { S.expanded.has(d.id) ? S.expanded.delete(d.id) : S.expanded.add(d.id); viewEnderecos(); },
            batch: openBatchModal, newloc: openNewLocModal, editloc: d => openEditLocModal(d.id)
        });
        if (!S.expanded.size) { for (const l of (S.kids.get('root') || [])) S.expanded.add(l.id); if (S.expanded.size) viewEnderecos(); }
    }
    // Redesenha só a tabela enquanto digita (não perde o foco do campo de busca).
    function repaintLocBody() {
        const pos = $('loc-q') ? $('loc-q').selectionStart : 0;
        viewEnderecos();
        const q = $('loc-q'); if (q) { q.focus(); q.setSelectionRange(pos, pos); }
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
                    const pad = (a.length > 1 && a[0] === '0') ? a.length : defaultPad;
                    const x = parseInt(a, 10), y = parseInt(b, 10);
                    if (x > y) throw new Error(`${label}: intervalo invertido "${p}".`);
                    for (let n = x; n <= y; n++) out.push(String(n).padStart(pad, '0'));
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
        const ruas = expandSpec(f.ruas, 0, 'Ruas');
        const prat = expandSpec(f.prat, f.padPrat, 'Prateleiras');
        const niv = expandSpec(f.niv, f.padNiv, 'Níveis');
        const pos = expandSpec(f.pos, f.padPos, 'Posições');
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
        const generated = new Set(nodes.map(n => n.kind));
        if (!generated.has(f.countAt)) throw new Error(`Você escolheu contar por ${KIND_LABEL[f.countAt]}, mas esse nível não foi informado.`);
        for (const n of nodes) { n.countable = n.kind === f.countAt; n.exists = S.byFull.has(n.full); }
        return nodes;
    }
    function readBatchForm() {
        return {
            arm: $('b-arm').value, ruas: $('b-ruas').value, prat: $('b-prat').value, niv: $('b-niv').value, pos: $('b-pos').value,
            padPrat: parseInt($('b-padprat').value, 10) || 0, padNiv: parseInt($('b-padniv').value, 10) || 0, padPos: parseInt($('b-padpos').value, 10) || 0,
            countAt: $('b-count').value
        };
    }
    function previewBatch() {
        const box = $('b-prev'), btn = $('b-go');
        try {
            const nodes = buildPlan(readBatchForm());
            const novos = nodes.filter(n => !n.exists);
            const por = KIND_ORDER.map(k => [k, novos.filter(n => n.kind === k).length]).filter(x => x[1] > 0);
            if (novos.length > 5000) throw new Error(`Seriam ${fmt.int(novos.length)} endereços novos. O máximo por vez é 5.000.`);
            box.className = 'notice';
            box.innerHTML = novos.length
                ? `<b>${fmt.int(novos.length)} endereços novos</b> (${por.map(([k, n]) => `${fmt.int(n)} ${(n === 1 ? KIND_LABEL[k] : KIND_PLURAL[k]).toLowerCase()}`).join(', ')}) · ${nodes.length - novos.length === 1 ? '1 já existe e será aproveitado' : (nodes.length - novos.length) + ' já existem e serão aproveitados'}.<br>
                   <span class="mono">${esc(novos[0].full)}</span> … <span class="mono">${esc(novos[novos.length - 1].full)}</span>`
                : 'Tudo isso já existe. Nada a criar.';
            btn.disabled = novos.length === 0;
        } catch (e) { box.className = 'notice warn'; box.textContent = e.message; btn.disabled = true; }
    }
    function openBatchModal() {
        const arm0 = (S.kids.get('root') || []).find(l => l.kind === 'ARMAZEM');
        openModal('Gerar endereços em lote', `
            <div class="field"><label class="f">Código do armazém</label><input id="b-arm" value="${esc(arm0 ? arm0.code : 'VGR')}" ${arm0 ? 'readonly' : ''}></div>
            <div class="field"><label class="f">Ruas (ex.: A-F ou A,B,C)</label><input id="b-ruas" value="A-F"></div>
            <div class="row" style="margin-bottom:12px">
                <div class="field"><label class="f">Prateleiras (ex.: 1-20)</label><input id="b-prat" value="1-20"></div>
                <div class="field" style="flex:0 0 90px"><label class="f">Dígitos</label><input id="b-padprat" type="number" min="0" max="4" value="2"></div></div>
            <div class="row" style="margin-bottom:12px">
                <div class="field"><label class="f">Níveis (ex.: 1-4)</label><input id="b-niv" value="1-4"></div>
                <div class="field" style="flex:0 0 90px"><label class="f">Dígitos</label><input id="b-padniv" type="number" min="0" max="4" value="1"></div></div>
            <div class="row" style="margin-bottom:12px">
                <div class="field"><label class="f">Posições (opcional, ex.: 1-5)</label><input id="b-pos" value=""></div>
                <div class="field" style="flex:0 0 90px"><label class="f">Dígitos</label><input id="b-padpos" type="number" min="0" max="4" value="2"></div></div>
            <div class="field"><label class="f">O inventário é contado em qual nível?</label>
                <select id="b-count"><option value="NIVEL">Nível (recomendado)</option><option value="POSICAO">Posição</option><option value="PRATELEIRA">Prateleira</option></select></div>
            <div id="b-prev" class="notice"></div>
            <div id="b-prog" class="muted" style="font-size:13px"></div>`,
            `<button class="btn" data-close2>Cancelar</button><button class="btn btn-primary" id="b-go" disabled>Criar endereços</button>`, { width: '620px' });
        document.querySelector('[data-close2]').addEventListener('click', closeModal);
        document.querySelectorAll('#modal-bg input, #modal-bg select').forEach(el => el.addEventListener('input', previewBatch));
        $('b-go').addEventListener('click', () => guarded(runBatch));
        previewBatch();
    }
    async function runBatch() {
        const nodes = buildPlan(readBatchForm());
        const ids = new Map();
        for (const n of nodes) if (n.exists) ids.set(n.full, S.byFull.get(n.full).id);
        const btn = $('b-go'), prog = $('b-prog');
        btn.disabled = true;
        for (const kind of KIND_ORDER) {
            const lvl = nodes.filter(n => n.kind === kind && !n.exists);
            if (!lvl.length) continue;
            const rows = lvl.map(n => { const id = uuid(); ids.set(n.full, id); return { id, site_key: S.site, parent_id: n.parent ? ids.get(n.parent) : null, kind, code: n.code, is_countable: n.countable, created_by: S.ctx.user.id }; });
            for (let i = 0; i < rows.length; i += 200) {
                prog.textContent = `Criando ${KIND_PLURAL[kind].toLowerCase()}… ${Math.min(i + 200, rows.length)}/${rows.length}`;
                const { error } = await sb.from('wh_locations').insert(rows.slice(i, i + 200));
                if (error) { prog.textContent = ''; btn.disabled = false; throw new Error('Parou em ' + KIND_LABEL[kind].toLowerCase() + ': ' + error.message + ' (o que já foi criado foi mantido; rode de novo para continuar).'); }
            }
        }
        await loadLocs();
        closeModal(); toast('Endereços criados com sucesso.');
        viewEnderecos();
    }
    function openNewLocModal() {
        const parents = S.locs.filter(l => l.kind !== 'POSICAO' && l.active);
        openModal('Novo endereço', `
            <div class="field"><label class="f">Dentro de (deixe vazio para criar um armazém)</label>
                <select id="n-parent"><option value="">— nenhum (novo armazém) —</option>${parents.map(l => `<option value="${l.id}">${esc(l.full_code)} · ${KIND_LABEL[l.kind]}</option>`).join('')}</select></div>
            <div class="field"><label class="f">Código (letras, números, _ ou .; sem hífen)</label><input id="n-code" placeholder="ex.: 21"></div>
            <label class="checkline"><input type="checkbox" id="n-count"> Endereço contável (onde se conta o estoque)</label>`,
            `<button class="btn" data-close2>Cancelar</button><button class="btn btn-primary" id="n-go">Criar</button>`);
        document.querySelector('[data-close2]').addEventListener('click', closeModal);
        $('n-go').addEventListener('click', () => guarded(async () => {
            const pid = $('n-parent').value || null;
            const parent = pid ? S.byId.get(pid) : null;
            const kind = parent ? KIND_ORDER[KIND_ORDER.indexOf(parent.kind) + 1] : 'ARMAZEM';
            const code = $('n-code').value.trim().toUpperCase();
            if (!code) throw new Error('Informe o código.');
            const { error } = await sb.from('wh_locations').insert({ id: uuid(), site_key: S.site, parent_id: pid, kind, code, is_countable: $('n-count').checked, created_by: S.ctx.user.id });
            if (error) throw error;
            await loadLocs(); closeModal(); toast('Endereço criado.'); viewEnderecos();
        }));
    }
    function openEditLocModal(id) {
        const l = S.byId.get(id); if (!l) return;
        openModal(l.full_code, `
            <p class="muted" style="margin-bottom:12px">${KIND_LABEL[l.kind]} · código do QR <span class="mono">${esc(l.qr_token)}</span><br>Código e posição na árvore não mudam depois de criados (a etiqueta pode já estar colada).</p>
            <label class="checkline" style="margin-bottom:10px"><input type="checkbox" id="e-count" ${l.is_countable ? 'checked' : ''}> Endereço contável</label>
            <label class="checkline"><input type="checkbox" id="e-active" ${l.active ? 'checked' : ''}> Ativo</label>`,
            `<button class="btn" data-close2>Cancelar</button><button class="btn btn-primary" id="e-go">Salvar</button>`);
        document.querySelector('[data-close2]').addEventListener('click', closeModal);
        $('e-go').addEventListener('click', () => guarded(async () => {
            const { error } = await sb.from('wh_locations').update({ is_countable: $('e-count').checked, active: $('e-active').checked }).eq('id', id);
            if (error) throw error;
            await loadLocs(); closeModal(); toast('Salvo.'); viewEnderecos();
        }));
    }

    // ============================================================
    // ITENS
    // ============================================================
    function viewItens() {
        const w = S.ctx.canWrite;
        const q = norm(S.itemQ);
        const list = q ? S.items.filter(i => norm(`${i.code} ${i.vale_material_code || ''} ${i.description}`).includes(q)) : S.items;
        const shown = list.slice(0, 200);
        view().innerHTML = `
            <div class="toolbar">
                <input id="it-q" placeholder="Buscar por código ou descrição" value="${esc(S.itemQ)}" style="min-width:280px">
                ${w ? '<button class="btn btn-primary" data-act="newitem">+ Novo item</button><button class="btn" data-act="import">Importar planilha</button><button class="btn btn-ghost" data-act="template">Baixar modelo</button>' : ''}
                <span class="muted" style="font-size:12px">${fmt.int(list.length)} de ${fmt.int(S.items.length)} itens</span>
            </div>
            ${S.items.length === 0 ? `<div class="card">${emptyHtml('Nenhum item cadastrado', w ? 'Importe a lista de materiais por planilha ou cadastre um a um.' : 'O supervisor ainda não cadastrou os itens.')}</div>` : `
            <div class="tablewrap"><table class="t"><thead><tr><th>Código</th><th>Cód. Vale</th><th>Descrição</th><th>Un.</th><th>Criticidade</th>${S.costs.size ? '<th class="num">Custo</th>' : ''}<th>Situação</th><th></th></tr></thead><tbody>
                ${shown.map(i => `<tr style="${i.active ? '' : 'opacity:.5'}"><td class="mono"><b>${esc(i.code)}</b></td><td class="mono muted">${esc(i.vale_material_code || '—')}</td><td>${esc(i.description)}</td><td>${esc(i.uom)}</td>
                    <td>${i.criticality === 'NORMAL' ? '<span class="muted">Normal</span>' : badge(i.criticality === 'CRITICO' ? 'badge-err' : 'badge-warn', CRIT_LABEL[i.criticality])}</td>
                    ${S.costs.size ? `<td class="num">${S.costs.has(i.id) ? fmt.money(S.costs.get(i.id)) : '—'}</td>` : ''}
                    <td>${i.active ? badge('badge-ok', 'Ativo') : badge('badge-err', 'Inativo')}</td>
                    <td class="right">${w ? `<button class="btn btn-sm" data-act="edititem" data-id="${i.id}">Editar</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted" style="padding:20px;text-align:center">Nada encontrado.</td></tr>'}
            </tbody></table></div>${list.length > 200 ? '<p class="muted" style="margin-top:8px;font-size:12px">Mostrando 200. Refine a busca.</p>' : ''}`}`;
        const qi = $('it-q');
        qi.addEventListener('input', () => { S.itemQ = qi.value; const pos = qi.selectionStart; viewItens(); const n = $('it-q'); n.focus(); n.setSelectionRange(pos, pos); });
        bindView({ newitem: () => openItemModal(null), edititem: d => openItemModal(d.id), import: openImportModal, template: downloadTemplate });
    }
    async function openItemModal(id) {
        const it = id ? S.itemById.get(id) : null;
        let barcodes = [];
        if (it) { const { data } = await sb.from('wh_item_barcodes').select('barcode').eq('item_id', id); barcodes = (data || []).map(b => b.barcode); }
        const critVal = it ? (it.criticality_source === 'AUTOMATICA' ? 'AUTO' : it.criticality) : 'AUTO';
        openModal(it ? `Editar item ${it.code}` : 'Novo item', `
            <div class="row" style="margin-bottom:12px">
                <div class="field"><label class="f">Código do item *</label><input id="i-code" value="${esc(it ? it.code : '')}" ${it ? 'readonly' : ''} placeholder="ex.: MAT-004512"></div>
                <div class="field"><label class="f">Código material Vale (SAP)</label><input id="i-vale" value="${esc(it ? it.vale_material_code || '' : '')}"></div></div>
            <div class="field"><label class="f">Descrição *</label><input id="i-desc" value="${esc(it ? it.description : '')}"></div>
            <div class="row" style="margin-bottom:12px">
                <div class="field"><label class="f">Unidade</label><input id="i-uom" value="${esc(it ? it.uom : 'UN')}"></div>
                <div class="field"><label class="f">Custo unitário (R$)</label><input id="i-cost" type="number" step="0.01" min="0" value="${it && S.costs.has(id) ? S.costs.get(id) : ''}"></div>
                <div class="field"><label class="f">Criticidade</label><select id="i-crit"><option value="AUTO" ${critVal === 'AUTO' ? 'selected' : ''}>Automática (pelo custo)</option><option value="NORMAL" ${critVal === 'NORMAL' ? 'selected' : ''}>Normal</option><option value="ALTO_VALOR" ${critVal === 'ALTO_VALOR' ? 'selected' : ''}>Alto valor</option><option value="CRITICO" ${critVal === 'CRITICO' ? 'selected' : ''}>Crítico</option></select></div></div>
            <div class="field"><label class="f">Código de barras / QR da etiqueta ${barcodes.length ? `(já cadastrados: ${esc(barcodes.join(', '))})` : ''}</label><input id="i-bar" placeholder="opcional — adiciona mais um código a este item"></div>
            <label class="checkline"><input type="checkbox" id="i-active" ${!it || it.active ? 'checked' : ''}> Item ativo</label>
            <p class="muted" style="margin-top:10px;font-size:12px">Itens de <b>alto valor</b> ou <b>críticos</b> exigem dupla conferência (duas pessoas diferentes contando).</p>`,
            `<button class="btn" data-close2>Cancelar</button><button class="btn btn-primary" id="i-go">Salvar</button>`, { width: '640px' });
        document.querySelector('[data-close2]').addEventListener('click', closeModal);
        $('i-go').addEventListener('click', () => guarded(async () => {
            const code = $('i-code').value.trim(), desc = $('i-desc').value.trim();
            if (!code || !desc) throw new Error('Código e descrição são obrigatórios.');
            const crit = $('i-crit').value;
            const row = {
                vale_material_code: $('i-vale').value.trim() || null, description: desc, uom: $('i-uom').value.trim() || 'UN',
                criticality_source: crit === 'AUTO' ? 'AUTOMATICA' : 'MANUAL', active: $('i-active').checked
            };
            if (crit !== 'AUTO') row.criticality = crit;
            let itemId = id;
            if (it) {
                const { error } = await sb.from('wh_items').update(row).eq('id', id); if (error) throw error;
            } else {
                itemId = uuid();
                const { error } = await sb.from('wh_items').insert({ id: itemId, site_key: S.site, code, created_by: S.ctx.user.id, ...row }); if (error) throw error;
            }
            const cost = $('i-cost').value;
            if (cost !== '') {
                const { error } = await sb.from('wh_item_costs').upsert({ item_id: itemId, site_key: S.site, unit_cost: Number(cost), cost_source: 'MANUAL', cost_updated_at: new Date().toISOString(), updated_by: S.ctx.user.id }, { onConflict: 'item_id' });
                if (error) throw error;
            }
            const bar = $('i-bar').value.trim();
            if (bar) {
                const { error } = await sb.from('wh_item_barcodes').insert({ site_key: S.site, item_id: itemId, barcode: bar });
                if (error) throw new Error('Código de barras: ' + error.message);
            }
            await loadItems(); closeModal(); toast('Item salvo.'); viewItens();
        }));
    }

    // ---- importação por planilha ----
    const COLS = {
        code: ['codigo', 'cod', 'codigo_item', 'item', 'id'],
        vale: ['codigo_vale', 'cod_vale', 'codigo_material_vale', 'material_vale', 'sap', 'codigo_sap'],
        desc: ['descricao', 'descr', 'nome'],
        uom: ['unidade', 'un', 'und', 'unid'],
        cost: ['custo', 'custo_unitario', 'valor', 'preco'],
        bar: ['codigo_barras', 'codigo_de_barras', 'barras', 'ean', 'qr', 'barcode']
    };
    function downloadTemplate() {
        const ws = XLSX.utils.aoa_to_sheet([
            ['CODIGO', 'CODIGO_VALE', 'DESCRICAO', 'UNIDADE', 'CUSTO', 'CODIGO_BARRAS'],
            ['MAT-004512', '10045120', 'Rolamento autocompensador 22218 E', 'UN', 1850.9, '7891234567890'],
            ['MAT-009021', '10090210', 'Luva de raspa cano longo', 'PAR', 12.5, '']
        ]);
        ws['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 44 }, { wch: 10 }, { wch: 12 }, { wch: 20 }];
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Itens');
        XLSX.writeFile(wb, 'modelo_itens_armazem.xlsx');
    }
    function parseSheet(rows) {
        const norm2 = k => norm(k).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const out = [], errors = [], seen = new Map();
        rows.forEach((r, idx) => {
            const m = {};
            for (const [k, v] of Object.entries(r)) m[norm2(k)] = v;
            const pick = names => { for (const n of names) if (m[n] != null && String(m[n]).trim() !== '') return String(m[n]).trim(); return ''; };
            const code = pick(COLS.code), desc = pick(COLS.desc);
            if (!code && !desc) return;
            if (!code || !desc) { errors.push(`Linha ${idx + 2}: ${!code ? 'sem código' : 'sem descrição'}.`); return; }
            const costTxt = pick(COLS.cost).replace(/[R$\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
            const cost = costTxt === '' ? null : Number(costTxt);
            if (cost != null && (isNaN(cost) || cost < 0)) { errors.push(`Linha ${idx + 2}: custo inválido "${pick(COLS.cost)}".`); return; }
            if (seen.has(code)) errors.push(`Linha ${idx + 2}: código "${code}" repetido no arquivo (vale o último).`);
            seen.set(code, out.length);
            const rec = { code, vale: pick(COLS.vale) || null, desc, uom: (pick(COLS.uom) || 'UN').toUpperCase(), cost, bar: pick(COLS.bar) || null };
            if (seen.get(code) !== out.length) out[seen.get(code)] = rec; else out.push(rec);
        });
        return { items: out.filter(Boolean), errors };
    }
    function openImportModal() {
        openModal('Importar itens por planilha', `
            <p class="muted" style="margin-bottom:12px">Colunas aceitas: <b>CODIGO</b> e <b>DESCRICAO</b> (obrigatórias), CODIGO_VALE, UNIDADE, CUSTO, CODIGO_BARRAS. Use <b>Baixar modelo</b> se quiser o formato certo. Itens que já existem são atualizados.</p>
            <input type="file" id="imp-file" accept=".xlsx,.xls,.csv">
            <div id="imp-prev" style="margin-top:14px"></div>`,
            `<button class="btn" data-close2>Fechar</button><button class="btn btn-primary" id="imp-go" disabled>Importar</button>`, { width: '640px' });
        document.querySelector('[data-close2]').addEventListener('click', closeModal);
        let parsed = null;
        $('imp-file').addEventListener('change', async e => {
            const f = e.target.files[0]; if (!f) return;
            await guarded(async () => {
                const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
                parsed = parseSheet(rows);
                const existing = new Set(S.items.map(i => i.code));
                const novos = parsed.items.filter(i => !existing.has(i.code)).length;
                $('imp-prev').innerHTML = `<div class="notice"><b>${fmt.int(parsed.items.length)} itens válidos</b> · ${fmt.int(novos)} novos · ${fmt.int(parsed.items.length - novos)} serão atualizados · ${parsed.items.filter(i => i.cost != null).length} com custo · ${parsed.items.filter(i => i.bar).length} com código de barras</div>
                    ${parsed.errors.length ? `<div class="notice warn"><b>${parsed.errors.length} aviso(s):</b><br>${parsed.errors.slice(0, 6).map(esc).join('<br>')}${parsed.errors.length > 6 ? '<br>…' : ''}</div>` : ''}
                    <div id="imp-prog" class="muted" style="font-size:13px"></div>`;
                $('imp-go').disabled = parsed.items.length === 0;
            });
        });
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
            for (let i = 0; i < costRows.length; i += 300) {
                prog.textContent = `Gravando custos… ${Math.min(i + 300, costRows.length)}/${costRows.length}`;
                const { error } = await sb.from('wh_item_costs').upsert(costRows.slice(i, i + 300), { onConflict: 'item_id' });
                if (error) throw error;
            }
            const barRows = list.filter(x => x.bar && idOf.has(x.code)).map(x => ({ site_key: S.site, item_id: idOf.get(x.code), barcode: x.bar }));
            for (let i = 0; i < barRows.length; i += 300) {
                prog.textContent = `Gravando códigos de barras… ${Math.min(i + 300, barRows.length)}/${barRows.length}`;
                const { error } = await sb.from('wh_item_barcodes').upsert(barRows.slice(i, i + 300), { onConflict: 'site_key,barcode', ignoreDuplicates: true });
                if (error) throw error;
            }
            await loadItems(); closeModal(); toast(`${fmt.int(list.length)} itens importados.`); viewItens();
        }));
    }

    // ============================================================
    // EQUIPES
    // ============================================================
    function viewEquipes() {
        const w = S.ctx.canWrite;
        view().innerHTML = `
            <div class="toolbar">${w ? '<button class="btn btn-primary" data-act="newteam">+ Nova equipe</button>' : ''}
                <span class="muted" style="font-size:12px">Os operadores são criados na tela de Usuários do app principal (perfil “Armazém · Operador”).</span></div>
            ${S.teams.length === 0 ? `<div class="card">${emptyHtml('Nenhuma equipe', w ? 'Crie uma equipe e adicione os operadores.' : '')}</div>` :
                S.teams.map(t => {
                    const ms = S.members.filter(m => m.team_id === t.id);
                    const free = S.people.filter(p => !ms.find(m => m.profile_id === p.id));
                    return `<div class="card"><div class="card-head"><h3>${esc(t.name)}</h3>${w ? `<button class="btn btn-sm btn-danger" data-act="delteam" data-id="${t.id}">Excluir equipe</button>` : ''}</div>
                        <div class="chips" style="margin-bottom:12px">${ms.length ? ms.map(m => { const p = S.people.find(x => x.id === m.profile_id); return `<span class="badge badge-info" style="font-size:13px;padding:5px 12px">${esc(p ? p.name : m.profile_id.slice(0, 8))}${w ? ` <a href="#" data-act="rmmember" data-t="${t.id}" data-p="${m.profile_id}" style="color:#fca5a5;text-decoration:none;margin-left:6px">×</a>` : ''}</span>`; }).join('') : '<span class="muted">Sem membros</span>'}</div>
                        ${w && free.length ? `<div class="row"><div class="field"><select id="add-${t.id}">${free.map(p => `<option value="${p.id}">${esc(p.name)} · ${esc(TV.ROLE_LABEL[p.role] || p.role)}</option>`).join('')}</select></div><button class="btn" data-act="addmember" data-t="${t.id}" style="flex:0 0 auto">Adicionar</button></div>` : ''}
                    </div>`;
                }).join('')}`;
        bindView({
            newteam: () => {
                openModal('Nova equipe', '<div class="field"><label class="f">Nome da equipe</label><input id="t-name" placeholder="ex.: Equipe 1"></div>',
                    '<button class="btn" data-close2>Cancelar</button><button class="btn btn-primary" id="t-go">Criar</button>');
                document.querySelector('[data-close2]').addEventListener('click', closeModal);
                $('t-go').addEventListener('click', () => guarded(async () => {
                    const name = $('t-name').value.trim(); if (!name) throw new Error('Informe o nome.');
                    const { error } = await sb.from('wh_teams').insert({ id: uuid(), site_key: S.site, name }); if (error) throw error;
                    await loadTeams(); closeModal(); viewEquipes();
                }));
            },
            addmember: async d => {
                const { error } = await sb.from('wh_team_members').insert({ team_id: d.t, site_key: S.site, profile_id: $('add-' + d.t).value }); if (error) throw error;
                await loadTeams(); viewEquipes();
            },
            rmmember: async (d, b, ev) => {
                ev.preventDefault();
                const { error } = await sb.from('wh_team_members').delete().eq('team_id', d.t).eq('profile_id', d.p); if (error) throw error;
                await loadTeams(); viewEquipes();
            },
            delteam: async d => {
                if (!confirm('Excluir esta equipe?')) return;
                const { error } = await sb.from('wh_teams').delete().eq('id', d.id); if (error) throw new Error('Não deu para excluir (a equipe está atribuída a uma campanha?): ' + error.message);
                await loadTeams(); viewEquipes();
            }
        });
    }

    // ============================================================
    // CAMPANHAS
    // ============================================================
    function viewCampanhas() {
        const w = S.ctx.canWrite;
        view().innerHTML = `
            <div class="toolbar">${w ? '<button class="btn btn-primary" data-act="newcamp">+ Nova campanha</button>' : ''}</div>
            ${S.campaigns.length === 0 ? `<div class="card">${emptyHtml('Nenhuma campanha', w ? 'Crie a primeira campanha de inventário.' : '')}</div>` : `
            <div class="tablewrap"><table class="t"><thead><tr><th>Campanha</th><th>Tipo</th><th>Status</th><th>Recontagem</th><th>Ruas atribuídas</th><th>Criada</th><th></th></tr></thead><tbody>
            ${S.campaigns.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${c.kind === 'GERAL' ? 'Geral' : 'Cíclica'}</td><td>${badge(CAMP_BADGE[c.status][0], CAMP_BADGE[c.status][1])}</td>
                <td>${{ NENHUMA: 'Nenhuma', AMOSTRA: `Amostra ${c.recount_sample_pct}%`, TODAS: 'Todas', DIVERGENCIA: 'Por divergência' }[c.recount_mode]}</td>
                <td>${S.assignments.filter(a => a.campaign_id === c.id).length}</td><td>${fmt.dt(c.created_at)}</td>
                <td class="right"><button class="btn btn-sm" data-act="opencamp" data-id="${c.id}">Abrir</button></td></tr>`).join('')}
            </tbody></table></div>`}`;
        bindView({ newcamp: openNewCampModal, opencamp: d => openCampModal(d.id) });
    }
    function openNewCampModal() {
        openModal('Nova campanha', `
            <div class="field"><label class="f">Nome *</label><input id="c-name" placeholder="ex.: Inventário Inicial 2026"></div>
            <div class="row" style="margin-bottom:12px">
                <div class="field"><label class="f">Tipo</label><select id="c-kind"><option value="GERAL">Geral (todo o armazém)</option><option value="CICLICO">Cíclica</option></select></div>
                <div class="field"><label class="f">Recontagem automática</label><select id="c-mode">
                    <option value="AMOSTRA">Amostra de endereços</option><option value="TODAS">Todos os endereços</option><option value="NENHUMA">Nenhuma</option><option value="DIVERGENCIA">Só se divergir do saldo esperado</option></select></div>
                <div class="field"><label class="f">% da amostra</label><input id="c-pct" type="number" min="0" max="100" value="20"></div></div>
            <div class="row" style="margin-bottom:12px">
                <div class="field"><label class="f">Tolerância (unidades)</label><input id="c-tq" type="number" min="0" step="any" value="0"></div>
                <div class="field"><label class="f">Tolerância (%)</label><input id="c-tp" type="number" min="0" step="any" value="0"></div></div>
            <p class="muted" style="font-size:12px">Na primeira campanha, como não existe saldo de referência, use <b>Amostra</b> ou <b>Todos</b>. Itens de alto valor/críticos sempre pedem 2ª contagem. Estas regras não mudam depois que a campanha é ativada.</p>`,
            '<button class="btn" data-close2>Cancelar</button><button class="btn btn-primary" id="c-go">Criar campanha</button>');
        document.querySelector('[data-close2]').addEventListener('click', closeModal);
        $('c-go').addEventListener('click', () => guarded(async () => {
            const name = $('c-name').value.trim(); if (!name) throw new Error('Informe o nome.');
            const id = uuid();
            const { error } = await sb.from('wh_campaigns').insert({ id, site_key: S.site, name, status: 'RASCUNHO', kind: $('c-kind').value, recount_mode: $('c-mode').value, recount_sample_pct: Number($('c-pct').value) || 0, tolerance_qty: Number($('c-tq').value) || 0, tolerance_pct: Number($('c-tp').value) || 0, created_by: S.ctx.user.id });
            if (error) throw error;
            await loadCampaigns(); setCamp(id); closeModal(); toast('Campanha criada. Agora atribua as ruas às equipes.'); openCampModal(id); viewCampanhas();
        }));
    }
    function openCampModal(id) {
        const c = S.campaigns.find(x => x.id === id); if (!c) return;
        const w = S.ctx.canWrite;
        const asg = S.assignments.filter(a => a.campaign_id === id);
        const atribuiveis = S.locs.filter(l => ['ARMAZEM', 'RUA', 'PRATELEIRA'].includes(l.kind) && l.active)
            .sort((a, b) => ({ RUA: 0, PRATELEIRA: 1, ARMAZEM: 2 }[a.kind] - { RUA: 0, PRATELEIRA: 1, ARMAZEM: 2 }[b.kind]) || a.full_code.localeCompare(b.full_code, 'pt-BR', { numeric: true }));
        const editable = w && (c.status === 'RASCUNHO' || c.status === 'ATIVA');
        openModal(c.name, `
            <div class="chips" style="margin-bottom:12px">${badge(CAMP_BADGE[c.status][0], CAMP_BADGE[c.status][1])} ${badge('', c.kind === 'GERAL' ? 'Geral' : 'Cíclica')}</div>
            <h3 style="font-size:14px;margin-bottom:8px">Quem conta o quê</h3>
            ${asg.length ? `<div class="tablewrap" style="margin-bottom:12px"><table class="t"><thead><tr><th>Local</th><th>Equipe</th><th>Rodada</th><th></th></tr></thead><tbody>
                ${asg.map(a => { const l = S.byId.get(a.location_id), t = S.teams.find(x => x.id === a.team_id); return `<tr><td class="mono"><b>${esc(l ? l.full_code : '—')}</b></td><td>${esc(t ? t.name : '—')}</td><td>${a.round}ª</td><td class="right">${editable ? `<button class="btn btn-sm btn-danger" data-rm-asg data-loc="${a.location_id}" data-round="${a.round}">Remover</button>` : ''}</td></tr>`; }).join('')}
            </tbody></table></div>` : '<div class="notice warn">Nenhuma rua atribuída ainda.</div>'}
            ${editable ? `<div class="row" style="margin-bottom:6px">
                <div class="field"><label class="f">Local (rua)</label><select id="a-loc">${atribuiveis.map(l => `<option value="${l.id}">${esc(l.full_code)} · ${KIND_LABEL[l.kind]}</option>`).join('')}</select></div>
                <div class="field"><label class="f">Equipe</label><select id="a-team">${S.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
                <div class="field" style="flex:0 0 90px"><label class="f">Rodada</label><select id="a-round"><option>1</option><option>2</option><option>3</option></select></div>
                <button class="btn" id="a-add" style="flex:0 0 auto">Atribuir</button></div>
                ${!S.teams.length ? '<p class="muted" style="font-size:12px">Crie uma equipe primeiro (aba Equipes).</p>' : ''}` : ''}`,
            `${w && c.status === 'RASCUNHO' ? '<button class="btn btn-ok" id="c-activate">Ativar campanha</button>' : ''}
             ${w && c.status === 'ATIVA' ? '<button class="btn btn-primary" id="c-close">Fechar campanha</button>' : ''}
             ${w && (c.status === 'RASCUNHO' || c.status === 'ATIVA') ? '<button class="btn btn-danger" id="c-cancel">Cancelar campanha</button>' : ''}
             <button class="btn" data-close2>Fechar janela</button>`, { width: '680px' });
        document.querySelector('[data-close2]').addEventListener('click', () => { closeModal(); viewCampanhas(); });
        const reopen = async () => { await loadCampaigns(); openCampModal(id); };
        const addBtn = $('a-add');
        if (addBtn) addBtn.addEventListener('click', () => guarded(async () => {
            const { error } = await sb.from('wh_campaign_assignments').insert({ campaign_id: id, site_key: S.site, location_id: $('a-loc').value, team_id: $('a-team').value, round: Number($('a-round').value) });
            if (error) throw new Error(/duplicate|unique/i.test(error.message) ? 'Esse local já está atribuído nessa rodada.' : error.message);
            await reopen();
        }));
        document.querySelectorAll('[data-rm-asg]').forEach(b => b.addEventListener('click', () => guarded(async () => {
            const { error } = await sb.from('wh_campaign_assignments').delete().eq('campaign_id', id).eq('location_id', b.dataset.loc).eq('round', Number(b.dataset.round));
            if (error) throw error; await reopen();
        })));
        const setStatus = async (status, ask) => {
            if (ask && !confirm(ask)) return;
            const { error } = await sb.from('wh_campaigns').update({ status }).eq('id', id); if (error) throw error;
            await loadCampaigns(); closeModal(); toast('Status atualizado.'); viewCampanhas();
        };
        const act = $('c-activate'); if (act) act.addEventListener('click', () => guarded(() => setStatus('ATIVA', 'Ativar agora? As regras de contagem não poderão mais ser alteradas.')));
        const cls = $('c-close'); if (cls) cls.addEventListener('click', () => guarded(() => setStatus('FECHADA', 'Fechar a campanha? Depois disso não entram mais contagens nem decisões.')));
        const can = $('c-cancel'); if (can) can.addEventListener('click', () => guarded(() => setStatus('CANCELADA', 'Cancelar esta campanha? Não dá para desfazer.')));
    }

    // ============================================================
    // CONTAGENS (comparação das rodadas + aprovação do supervisor)
    // ============================================================
    async function viewContagens() {
        const camp = campaign();
        if (!camp) { view().innerHTML = `<div class="card">${emptyHtml('Nenhuma campanha', 'Crie uma campanha primeiro.')}</div>`; bindView({}); return; }
        const [rows, cl] = await Promise.all([
            fetchAll((f, t) => sb.from('v_wh_count_consolidated').select('*').eq('campaign_id', camp.id).order('location_code').range(f, t)),
            fetchAll((f, t) => sb.from('wh_count_closures').select('location_id, round').eq('campaign_id', camp.id).range(f, t))
        ]);
        S.contRows = rows; S.contClosures = new Set(cl.map(c => c.location_id + ':' + c.round));
        paintContagens();
    }
    function filteredCont() {
        const q = norm(S.contQ);
        return S.contRows.filter(r => (!S.contStatus || r.status === S.contStatus) &&
            (!q || norm(`${r.location_code} ${r.item_code} ${r.item_description}`).includes(q)));
    }
    function lastRound(r) { return r.r3 != null ? 3 : r.r2 != null ? 2 : 1; }
    function approvable(r) {
        if (!['CONFERE', 'CONTADO'].includes(r.status)) return false;
        return S.contClosures.has(r.location_id + ':' + lastRound(r));
    }
    function paintContagens() {
        const camp = campaign(), w = S.ctx.canWrite;
        const rows = filteredCont();
        const cnt = st => S.contRows.filter(r => r.status === st).length;
        const nApprovable = S.contRows.filter(approvable).length;
        view().innerHTML = `
            <div class="toolbar">${campSelectHtml()}
                <input id="ct-q" placeholder="Buscar endereço ou item" value="${esc(S.contQ)}">
                <button class="btn" data-act="export">Exportar Excel</button>
                ${w && camp.status === 'ATIVA' ? `<button class="btn btn-ok" data-act="approveall" ${nApprovable ? '' : 'disabled'}>Aprovar tudo que está OK (${fmt.int(nApprovable)})</button>` : ''}</div>
            <div class="chips" style="margin-bottom:14px">
                <button class="chip ${S.contStatus === '' ? 'on' : ''}" data-act="stfilter" data-st="">Todos (${fmt.int(S.contRows.length)})</button>
                ${Object.entries(STATUS_BADGE).map(([k, v]) => `<button class="chip ${S.contStatus === k ? 'on' : ''}" data-act="stfilter" data-st="${k}">${v[1]} (${fmt.int(cnt(k))})</button>`).join('')}
            </div>
            ${S.contRows.length === 0 ? `<div class="card">${emptyHtml('Nenhuma contagem nesta campanha', 'Assim que o campo lançar, aparece aqui.')}</div>` : `
            <div class="tablewrap"><table class="t"><thead><tr><th>Endereço</th><th>Item</th><th class="num">1ª</th><th class="num">2ª</th><th class="num">3ª</th><th>Status</th><th class="num">Aprovado</th><th></th></tr></thead><tbody>
            ${rows.slice(0, 300).map((r, i) => `<tr><td class="mono"><b>${esc(r.location_code)}</b></td>
                <td><b>${esc(r.item_code)}</b> <span class="muted">${esc(r.item_description)}</span>${r.criticality !== 'NORMAL' ? ' ' + badge('badge-warn', CRIT_LABEL[r.criticality]) : ''}</td>
                <td class="num">${r.r1 == null ? '—' : fmt.num(r.r1)}</td><td class="num">${r.r2 == null ? '—' : fmt.num(r.r2)}</td><td class="num">${r.r3 == null ? '—' : fmt.num(r.r3)}</td>
                <td>${badge(...STATUS_BADGE[r.status] || ['', r.status])}</td><td class="num">${r.final_qty == null ? '—' : '<b>' + fmt.num(r.final_qty) + '</b>'}</td>
                <td class="right">${w && camp.status === 'ATIVA' && r.status !== 'PENDENTE_2A_CONTAGEM' ? `<button class="btn btn-sm" data-act="decide" data-i="${S.contRows.indexOf(r)}">${r.status === 'APROVADO' ? 'Revisar' : 'Decidir'}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted" style="padding:20px;text-align:center">Nada encontrado.</td></tr>'}
            </tbody></table></div>${rows.length > 300 ? `<p class="muted" style="margin-top:8px;font-size:12px">Mostrando 300 de ${fmt.int(rows.length)}. Use a busca ou o filtro.</p>` : ''}`}`;
        bindCampSelect(() => go('contagens'));
        const q = $('ct-q');
        if (q) q.addEventListener('input', () => { S.contQ = q.value; const pos = q.selectionStart; paintContagens(); const n = $('ct-q'); n.focus(); n.setSelectionRange(pos, pos); });
        bindView({
            stfilter: d => { S.contStatus = d.st; paintContagens(); },
            export: exportCont, decide: d => openDecideModal(S.contRows[Number(d.i)]),
            approveall: approveAll
        });
    }
    function exportCont() {
        const rows = filteredCont();
        const aoa = [['Endereço', 'Código item', 'Descrição', 'Criticidade', '1ª contagem', '2ª contagem', '3ª contagem', 'Status', 'Quantidade aprovada']];
        for (const r of rows) aoa.push([r.location_code, r.item_code, r.item_description, CRIT_LABEL[r.criticality], r.r1, r.r2, r.r3, (STATUS_BADGE[r.status] || [0, r.status])[1], r.final_qty]);
        const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 22 }, { wch: 18 }];
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Contagens');
        XLSX.writeFile(wb, `contagens_${(campaign().name || 'campanha').replace(/[^a-z0-9]+/gi, '_')}.xlsx`);
    }
    function openDecideModal(r) {
        if (!r) return;
        const opts = [1, 2, 3].filter(n => r['r' + n] != null && S.contClosures.has(r.location_id + ':' + n));
        openModal(`${r.location_code} · ${r.item_code}`, `
            <p class="muted" style="margin-bottom:12px">${esc(r.item_description)}</p>
            <div class="field"><label class="f">Qual valor vale?</label>
                ${opts.map((n, i) => `<label class="checkline" style="margin-bottom:8px"><input type="radio" name="dec" value="APROVAR_R${n}" ${i === opts.length - 1 ? 'checked' : ''}> Contagem da <b>${n}ª rodada</b>: ${fmt.num(r['r' + n])}</label>`).join('')}
                <label class="checkline"><input type="radio" name="dec" value="AJUSTE_MANUAL" ${opts.length ? '' : 'checked'}> Ajuste manual</label></div>
            <div id="dec-manual" class="${opts.length ? 'hidden' : ''}"><div class="row">
                <div class="field" style="flex:0 0 140px"><label class="f">Quantidade</label><input id="dec-qty" type="number" min="0" step="any"></div>
                <div class="field"><label class="f">Justificativa (obrigatória)</label><input id="dec-reason" placeholder="ex.: conferido presencialmente com o supervisor"></div></div></div>`,
            '<button class="btn" data-close2>Cancelar</button><button class="btn btn-primary" id="dec-go">Registrar decisão</button>');
        document.querySelector('[data-close2]').addEventListener('click', closeModal);
        document.querySelectorAll('input[name=dec]').forEach(x => x.addEventListener('change', () => $('dec-manual').classList.toggle('hidden', document.querySelector('input[name=dec]:checked').value !== 'AJUSTE_MANUAL')));
        $('dec-go').addEventListener('click', () => guarded(async () => {
            const how = document.querySelector('input[name=dec]:checked').value;
            const camp = campaign();
            let qty, reason = null;
            if (how === 'AJUSTE_MANUAL') {
                qty = Number($('dec-qty').value); reason = $('dec-reason').value.trim();
                if ($('dec-qty').value === '' || isNaN(qty) || qty < 0) throw new Error('Informe a quantidade.');
                if (reason.length < 5) throw new Error('Escreva uma justificativa (mínimo 5 letras).');
            } else qty = Number(r['r' + how.slice(-1)]);
            const { error } = await sb.from('wh_count_decisions').insert({ site_key: S.site, campaign_id: camp.id, location_id: r.location_id, item_id: r.item_id, final_qty: qty, decision: how, reason, decided_by: S.ctx.user.id });
            if (error) throw error;
            closeModal(); toast('Decisão registrada.'); await viewContagens();
        }));
    }
    async function approveAll() {
        const todo = S.contRows.filter(approvable);
        if (!todo.length) return;
        if (!confirm(`Aprovar ${todo.length} linhas que estão OK (confere ou contagem única)? Fica registrado na trilha de auditoria.`)) return;
        const camp = campaign();
        for (let i = 0; i < todo.length; i += 200) {
            toast(`Aprovando… ${Math.min(i + 200, todo.length)}/${todo.length}`);
            const { error } = await sb.from('wh_count_decisions').insert(todo.slice(i, i + 200).map(r => {
                const n = lastRound(r);
                return { site_key: S.site, campaign_id: camp.id, location_id: r.location_id, item_id: r.item_id, final_qty: Number(r['r' + n]), decision: 'APROVAR_R' + n, decided_by: S.ctx.user.id };
            }));
            if (error) throw new Error('Parou numa linha: ' + error.message + ' (as anteriores foram aprovadas).');
        }
        toast('Aprovado.'); await viewContagens();
    }

    // ============================================================
    // INÍCIO
    // ============================================================
    async function init(ctx) {
        S.ctx = ctx;
        if (!ctx.sites.length) {
            $('side').innerHTML = ''; $('topbar').innerHTML = '';
            view().innerHTML = `<div class="card">${emptyHtml('Nenhum armazém liberado para o seu usuário', 'Peça ao Admin para liberar o site <b>VGR - Armazém</b> no seu cadastro (Usuários, no app principal).')}</div>
                <p style="text-align:center"><button class="btn" id="btn-x">Sair</button></p>`;
            $('btn-x').addEventListener('click', () => TV.signOut());
            return;
        }
        const saved = store.get('tv_arm_site', null);
        S.site = (ctx.sites.find(s => s.key === saved) || ctx.sites[0]).key;
        renderShell();
        try { await reloadAll(); } catch (e) { toast('Erro ao carregar dados: ' + e.message, 'err'); }
        await go('geral');
    }
    window.Gestao = { init, _S: S };
})();
