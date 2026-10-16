/* ============================================================
   TerraVia Armazém — CAMPO (celular): contagem com digitação manual.
   Fluxo do design: Campanhas > Escolher endereço > Lançar itens >
   Finalizar endereço > Concluído (com o próximo endereço sugerido).

   FILA DE ENVIO (outbox): tudo que o operador lança é gravado primeiro no
   próprio aparelho (localStorage) e enviado em segundo plano. Sem sinal, o
   app continua funcionando e envia depois. Cada lançamento tem um id gerado
   no aparelho, então reenviar nunca duplica (o banco ignora o id repetido).

   REGRA DE OURO (aprendida no app principal): NENHUMA atualização automática
   de dados no meio da contagem. Só o envio da fila roda sozinho; ele nunca
   mexe no que está na tela.

   CONTAGEM CEGA: o operador nunca vê saldo esperado nem contagens de outras
   pessoas (o banco nem entrega esses dados pra ele). Recontagem aparece só
   como "recontagem solicitada", sem números.
   ============================================================ */
(function () {
    'use strict';
    const { sb, esc, fmt, openModal, closeModal, fetchAll, uuid, norm, store, isNetErr, ruaColor } = TV;
    const APP_VERSION = 'campo-2';
    const OB_KEY = 'tv_arm_outbox_v1';
    const KIND_LABEL = { ARMAZEM: 'Armazém', RUA: 'Rua', PRATELEIRA: 'Prateleira', NIVEL: 'Nível', POSICAO: 'Posição' };

    const C = {
        ctx: null, site: null, camp: null, campaigns: [], mine: {},
        locs: [], byId: new Map(), kids: new Map(), assign: [], tasks: [], closed: new Set(),
        allowed: [], allowedIds: new Set(), navSet: new Set(), progress: new Map(), ruas: [],
        items: [], itemById: new Map(), byBarcode: new Map(),
        selPath: [], cur: null, round: 1, raw: new Map(), unidDesc: new Map(),
        sel: null, search: '', deviceId: null, netDown: false, last: null, screen: 'camp', team: null
    };
    const root = () => document.getElementById('app');
    let handlers = {};
    let flushing = false;

    // ============================================================
    // FILA DE ENVIO
    // ============================================================
    const ob = {
        list: () => store.get(OB_KEY, []),
        save: l => store.set(OB_KEY, l),
        add(op) { const l = ob.list(); l.push(op); ob.save(l); renderSync(); flush(); },
        pendingCount: () => ob.list().filter(o => !o.failed).length,
        failed: () => ob.list().filter(o => o.failed)
    };
    const TABLE = { event: 'wh_count_events', closure: 'wh_count_closures', unid: 'wh_unidentified_items' };
    async function sendOp(op) {
        const { error } = await sb.from(TABLE[op.kind]).upsert(op.payload, { onConflict: 'id', ignoreDuplicates: true });
        if (!error) return 'ok';
        if (isNetErr(error) || /jwt|token/i.test(error.message)) return 'net';
        // o endereço só fecha quando todas as linhas dele chegaram: se a ordem do envio
        // atrapalhou, tenta de novo mais tarde em vez de dar a linha como perdida
        if (op.kind === 'closure' && /Faltam linhas/i.test(error.message)) return 'wait';
        return error.message;
    }
    async function flush() {
        if (flushing) return;
        flushing = true;
        const tried = new Set();
        try {
            for (;;) {
                const op = ob.list().find(o => !o.failed && !tried.has(o.id));
                if (!op) break;
                tried.add(op.id);
                const r = await sendOp(op);
                if (r === 'net') { C.netDown = true; break; }
                C.netDown = false;
                if (r === 'wait') continue;
                const l = ob.list(), i = l.findIndex(o => o.id === op.id);
                if (i >= 0) { if (r === 'ok') l.splice(i, 1); else { l[i].failed = true; l[i].error = r; } ob.save(l); }
                renderSync();
            }
        } finally { flushing = false; renderSync(); }
    }
    function syncState() {
        const p = ob.pendingCount(), f = ob.failed().length, off = navigator.onLine === false || C.netDown;
        if (f) return { cls: 'fail', ico: '⚠', txt: `${f} com erro` };
        if (p) return { cls: 'pend', ico: '●', txt: `${p} pendente${p > 1 ? 's' : ''}` };
        return off ? { cls: 'pend', ico: '⌁', txt: 'Sem sinal' } : { cls: '', ico: '✓', txt: 'Enviado' };
    }
    function renderSync() {
        const el = document.getElementById('sync-btn'); if (!el) return;
        const s = syncState();
        el.className = 'm-sync ' + s.cls; el.textContent = `${s.ico} ${s.txt}`;
        const off = document.getElementById('m-off');
        if (off) off.classList.toggle('hidden', !(navigator.onLine === false || C.netDown));
        const d = document.getElementById('done-sync');
        if (d) { const x = doneSync(s); d.textContent = x.txt; d.style.color = x.color; }
    }
    // texto da tela "Concluído": acompanha o estado real do envio (muda sozinho quando o envio termina)
    function doneSync(s) {
        if (s.cls === 'fail') return { txt: 'Há lançamentos com erro: toque no aviso de envio, no topo.', color: 'var(--red-text)' };
        if (s.cls) return { txt: 'Salvo no aparelho · será enviado quando houver sinal', color: 'var(--amber-text)' };
        return { txt: 'Enviado ✓', color: 'var(--green-text)' };
    }
    function openSyncModal() {
        const l = ob.list();
        const name = op => ({ event: 'Contagem', closure: 'Endereço finalizado', unid: 'Item sem cadastro' }[op.kind]);
        const where = op => { const loc = C.byId.get(op.payload.location_id); return loc ? loc.full_code : ''; };
        openModal('Envio dos dados', `
            <p class="muted" style="margin-bottom:12px">${navigator.onLine === false ? 'Sem sinal agora. ' : ''}O que você lança é guardado neste aparelho e enviado assim que houver sinal.</p>
            ${l.length === 0 ? '<div class="notice">Tudo enviado ✓</div>' : l.map(op => `
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--divider)"><div><b>${esc(name(op))}</b> <span class="muted">${esc(where(op))}</span>${op.failed ? `<div style="color:var(--red-text);font-size:12px">${esc(op.error)}</div>` : ''}</div>
                ${op.failed ? `<button class="btn btn-sm btn-danger" data-drop="${op.id}">Descartar</button>` : '<span class="st st-warn">aguardando</span>'}</div>`).join('')}`,
            '<button class="btn btn-primary" id="sy-go">Enviar agora</button><button class="btn" id="sy-x">Fechar</button>');
        document.getElementById('sy-x').addEventListener('click', closeModal);
        document.getElementById('sy-go').addEventListener('click', async () => { await flush(); openSyncModal(); });
        document.querySelectorAll('[data-drop]').forEach(b => b.addEventListener('click', () => {
            if (!confirm('Descartar este lançamento? Ele NÃO será enviado.')) return;
            ob.save(ob.list().filter(o => o.id !== b.dataset.drop)); renderSync(); openSyncModal();
        }));
    }
    function notify(msg, kind) {
        const el = document.createElement('div'); el.className = 'm-toast' + (kind === 'err' ? ' err' : ''); el.textContent = msg;
        document.body.appendChild(el); setTimeout(() => el.remove(), kind === 'err' ? 6000 : 2600);
    }

    // ============================================================
    // DADOS (com cópia no aparelho pra abrir sem sinal)
    // ============================================================
    const packKey = () => `tv_arm_pack_${C.site}_${C.camp}`;
    async function loadLocs() {
        try {
            const locs = await fetchAll((f, t) => sb.from('wh_locations').select('id, parent_id, kind, code, full_code, path, is_countable, active').eq('site_key', C.site).order('full_code').range(f, t));
            store.set('tv_arm_locs_' + C.site, locs); return locs;
        } catch (e) { if (!isNetErr(e)) throw e; const c = store.get('tv_arm_locs_' + C.site, null); if (!c) throw new Error('Sem sinal e sem endereços guardados neste aparelho. Abra uma vez com internet.'); return c; }
    }
    function indexLocs(locs) {
        C.locs = locs; C.byId = new Map(); C.kids = new Map();
        for (const l of locs) { C.byId.set(l.id, l); const k = l.parent_id || 'root'; if (!C.kids.has(k)) C.kids.set(k, []); C.kids.get(k).push(l); }
        for (const a of C.kids.values()) a.sort((x, y) => x.code.localeCompare(y.code, 'pt-BR', { numeric: true }));
        C.ruas = locs.filter(l => l.kind === 'RUA' && l.active).sort((x, y) => x.code.localeCompare(y.code, 'pt-BR', { numeric: true }));
    }
    async function loadPack() {
        try {
            const [locs, asg, tasks, cls, items, bars] = await Promise.all([
                loadLocs(),
                sb.from('wh_campaign_assignments').select('location_id, team_id, round').eq('campaign_id', C.camp),
                sb.from('wh_recount_tasks').select('id, location_id, round, reason').eq('campaign_id', C.camp).eq('status', 'ABERTA'),
                sb.from('wh_count_closures').select('location_id, round').eq('campaign_id', C.camp),
                fetchAll((f, t) => sb.from('wh_items').select('id, code, vale_material_code, description, uom, criticality, active').eq('site_key', C.site).eq('active', true).order('code').range(f, t)),
                fetchAll((f, t) => sb.from('wh_item_barcodes').select('item_id, barcode').eq('site_key', C.site).range(f, t))
            ]);
            for (const r of [asg, tasks, cls]) if (r.error) throw r.error;
            const pack = { assign: asg.data, tasks: tasks.data, closed: cls.data.map(c => c.location_id + ':' + c.round), items, bars, at: Date.now() };
            store.set(packKey(), pack);
            indexLocs(locs); applyPack(pack);
            return true;
        } catch (e) {
            if (!isNetErr(e)) throw e;
            const pack = store.get(packKey(), null), locs = store.get('tv_arm_locs_' + C.site, null);
            if (!pack || !locs) throw new Error('Sem sinal e sem dados guardados desta campanha. Abra uma vez com internet.');
            indexLocs(locs); applyPack(pack);
            notify('Sem sinal: usando os dados guardados no aparelho.');
            return false;
        }
    }
    function applyPack(p) {
        C.assign = p.assign || []; C.tasks = p.tasks || [];
        C.closed = new Set(p.closed || []);
        C.items = p.items || []; C.itemById = new Map(C.items.map(i => [i.id, i]));
        C.byBarcode = new Map((p.bars || []).map(b => [b.barcode, b.item_id]));
        computeAllowed();
    }
    function persistClosed() { const p = store.get(packKey(), null); if (p) { p.closed = [...C.closed]; p.tasks = C.tasks; store.set(packKey(), p); } }
    // endereços que ESTE usuário pode contar na rodada 1: os debaixo das ruas da equipe dele
    function computeAllowed() {
        const a1 = new Set(C.assign.filter(a => a.round === 1).map(a => a.location_id));
        const free = C.ctx.role === 'ARM_SUPERVISOR' && C.assign.length === 0;       // supervisor sem equipe: vê tudo
        C.allowed = C.locs.filter(l => l.is_countable && l.active && (free || (l.path || []).some(p => a1.has(p))));
        C.allowedIds = new Set(C.allowed.map(l => l.id));
        recomputeProgress();
    }
    function recomputeProgress() {
        C.navSet = new Set(); C.progress = new Map();
        for (const l of C.allowed) {
            const done = C.closed.has(l.id + ':1');
            for (const p of (l.path || [])) { C.navSet.add(p); const g = C.progress.get(p) || { done: 0, total: 0 }; g.total++; if (done) g.done++; C.progress.set(p, g); }
        }
    }
    const ruaIdx = id => Math.max(0, C.ruas.findIndex(r => r.id === id));
    const ruaOf = l => (l.path || []).map(id => C.byId.get(id)).find(p => p && p.kind === 'RUA');

    // ============================================================
    // CASCA
    // ============================================================
    function bar(sub, title, back, mono) {
        return `<div class="m-bar">${back ? `<button class="m-back" data-act="${back}" aria-label="Voltar">‹</button>` : ''}
            <div class="tt"><small>${esc(sub || '')}</small><b ${mono ? 'class="mono"' : ''}>${esc(title)}</b></div>
            <button class="m-sync" id="sync-btn" data-act="sync" role="status"></button></div>
            ${/teste/i.test(((C.ctx.sites.find(x => x.key === C.site) || {}).label) || '') ? '<div class="m-test">SITE DE TESTE · nada daqui vale para o inventário real</div>' : ''}
            <div class="m-off hidden" id="m-off">Sem sinal — continue contando. Tudo fica salvo no aparelho e é enviado quando o sinal voltar.</div>`;
    }
    function paint(html, map, cta) {
        root().innerHTML = `<div class="m-root">${html}${cta || ''}</div>`;
        handlers = map || {};
        root().onclick = ev => {
            const b = ev.target.closest('[data-act]');
            if (!b) return;
            const fn = handlers[b.dataset.act] || common[b.dataset.act];
            if (fn) Promise.resolve(fn(b.dataset, b, ev)).catch(e => notify(e.message || String(e), 'err'));
        };
        renderSync();
    }
    const cta = (primary, secondary) => `<div class="m-cta">${primary}${secondary || ''}</div>`;
    const common = {
        sync: openSyncModal,
        logout: async () => {
            if (ob.pendingCount() && !confirm(`Há ${ob.pendingCount()} lançamentos ainda não enviados. Se sair agora, eles ficam guardados neste aparelho, mas só sobem quando você entrar de novo. Sair mesmo?`)) return;
            TV.signOut();
        }
    };
    const firstName = n => String(n || '').split(/\s+/)[0] || '';

    // ============================================================
    // B2 · CAMPANHAS
    // ============================================================
    async function screenCampaigns() {
        C.screen = 'camp'; C.camp = null;
        paint(bar('Armazém', C.ctx.profile.name) + '<div class="m-body"><div class="spinner" style="margin:30vh auto"></div></div>');
        let list = null, asg = [], cls = [], team = null;
        try {
            const c = await sb.from('wh_campaigns').select('id, name, kind, status, start_date, end_date').eq('site_key', C.site).order('created_at', { ascending: false });
            if (c.error) throw c.error;
            list = (c.data || []).filter(x => x.status === 'ATIVA' || x.status === 'RASCUNHO');
            const [a, k, tm] = await Promise.all([
                sb.from('wh_campaign_assignments').select('campaign_id, location_id, team_id, round').eq('site_key', C.site),
                sb.from('wh_count_closures').select('campaign_id, location_id, round').eq('site_key', C.site),
                sb.from('wh_team_members').select('team_id').eq('profile_id', C.ctx.user.id)
            ]);
            asg = a.data || []; cls = k.data || [];
            if (tm.data && tm.data[0]) { const t = await sb.from('wh_teams').select('id, name').eq('id', tm.data[0].team_id).maybeSingle(); team = t.data || null; }
            const locs = await loadLocs(); indexLocs(locs);
            store.set('tv_arm_camps_' + C.site, { list, asg, cls, team });
        } catch (e) {
            if (!isNetErr(e)) { notify(e.message, 'err'); list = []; }
            else { const c = store.get('tv_arm_camps_' + C.site, null), locs = store.get('tv_arm_locs_' + C.site, null); if (c && locs) { ({ list, asg, cls, team } = c); indexLocs(locs); } else list = []; }
        }
        C.campaigns = list; C.team = team;
        C.mine = {};
        for (const c of list) {
            const mineAsg = asg.filter(a => a.campaign_id === c.id && a.round === 1 && (a.team_id === (team && team.id) || C.ctx.role === 'ARM_SUPERVISOR'));
            const roots = new Set(mineAsg.map(a => a.location_id));
            const leaves = C.locs.filter(l => l.is_countable && l.active && (l.path || []).some(p => roots.has(p)));
            const done = leaves.filter(l => cls.some(k => k.campaign_id === c.id && k.location_id === l.id && k.round === 1)).length;
            C.mine[c.id] = { ruas: [...roots].map(id => (C.byId.get(id) || {}).code).filter(Boolean).sort((x, y) => x.localeCompare(y, 'pt-BR', { numeric: true })), total: leaves.length, done };
        }
        const ativas = list.filter(c => c.status === 'ATIVA'), agend = list.filter(c => c.status === 'RASCUNHO');
        const join = a => a.length > 1 ? a.slice(0, -1).join(', ') + ' e ' + a[a.length - 1] : (a[0] || '—');
        paint(bar('TerraVia Ops', 'Campanhas') + `<div class="m-body">
            <span class="m-hello">Olá, ${esc(firstName(C.ctx.profile.name))}${team ? ' · ' + esc(team.name) : ''}</span>
            ${ativas.map(c => { const m = C.mine[c.id]; const pct = m.total ? Math.round(100 * m.done / m.total) : 0; return `<button class="m-camp" data-act="pick" data-id="${c.id}"><span class="tag"><span>● ATIVA</span><span class="muted" style="font-weight:400;font-size:13px">${c.end_date ? 'até ' + new Date(c.end_date + 'T12:00').toLocaleDateString('pt-BR').slice(0, 5) : ''}</span></span>
                <span class="nm">${esc(c.name)}</span><span style="font-size:15px;color:var(--text-body-2)">${m.ruas.length ? 'Suas ruas: ' + esc(join(m.ruas)) : 'Nenhuma rua atribuída a você ainda'}</span>
                <span style="display:flex;flex-direction:column;gap:6px"><span style="display:flex;justify-content:space-between;font-size:14px"><span class="muted">Sua parte</span><b>${pct}%</b></span><span class="bar" style="height:10px"><i style="width:${pct}%"></i></span></span>
                <span class="go">Continuar contagem</span></button>`; }).join('')}
            ${agend.map(c => `<div style="display:flex;flex-direction:column;gap:6px;padding:18px;border:1px solid var(--border-color);border-radius:16px;background:var(--bg-sidebar)"><span style="font-size:13px;font-weight:700;color:var(--text-secondary)">AGENDADA</span><span style="font-size:18px;font-weight:700;color:var(--text-body-2)">${esc(c.name)}</span><span style="font-size:14px;color:var(--text-secondary)">${c.start_date ? 'Começa em ' + new Date(c.start_date + 'T12:00').toLocaleDateString('pt-BR') + '. Você será avisado.' : 'Em preparação pela supervisão.'}</span></div>`).join('')}
            ${list.length ? '' : '<div class="m-empty"><b style="display:block;color:#fff;margin-bottom:4px">Nenhuma campanha ativa</b>Peça ao supervisor para ativar a campanha.</div>'}
            <div style="display:flex;justify-content:center;gap:10px;margin-top:8px;flex-wrap:wrap">
                ${C.ctx.role === 'ARM_SUPERVISOR' ? '<a class="btn" href="index.html?ir=gestao">Abrir a gestão (notebook)</a>' : ''}<button class="btn btn-ghost" data-act="logout">Sair</button></div>
        </div>`, { pick: d => pickCampaign(d.id) });
    }
    async function pickCampaign(id) {
        C.camp = id; C.skipAuto = false; C.selPath = [];
        paint(bar('Carregando…', 'Baixando endereços e itens') + '<div class="m-body"><div class="spinner" style="margin:30vh auto"></div></div>');
        try { await loadPack(); } catch (e) { notify(e.message, 'err'); C.camp = null; C.skipAuto = true; return screenCampaigns(); }
        initSelPath();
        screenAddress();
    }

    // ============================================================
    // B3 · ESCOLHER O ENDEREÇO (rua > prateleira > nível, em chips grandes)
    // ============================================================
    const doneLeaf = l => C.closed.has(l.id + ':1');
    const pendingUnder = id => { const g = C.progress.get(id); return g ? g.total - g.done : 0; };
    const visKids = id => (C.kids.get(id) || []).filter(l => C.navSet.has(l.id));
    // escolhe sozinho a primeira rua e a primeira prateleira que ainda têm algo por contar
    function initSelPath() {
        C.selPath = [];
        const ruas = C.ruas.filter(r => C.navSet.has(r.id));
        let node = ruas.find(r => pendingUnder(r.id) > 0) || ruas[0];
        while (node) {
            C.selPath.push(node.id);
            const kids = visKids(node.id);
            if (!kids.length || kids.every(k => C.allowedIds.has(k.id))) break;
            node = kids.find(k => pendingUnder(k.id) > 0) || kids[0];
        }
    }
    function nextSuggested(from) {
        const order = C.allowed.slice().sort((a, b) => a.full_code.localeCompare(b.full_code, 'pt-BR', { numeric: true }));
        const pend = order.filter(l => !doneLeaf(l) && (!from || l.id !== from.id));
        if (!pend.length) return null;
        if (from) { const after = pend.find(l => l.full_code.localeCompare(from.full_code, 'pt-BR', { numeric: true }) > 0); return after || pend[0]; }
        return pend[0];
    }
    function screenAddress() {
        C.screen = 'addr';
        const camp = C.campaigns.find(c => c.id === C.camp) || {};
        const total = C.allowed.length, done = C.allowed.filter(doneLeaf).length;
        const ruas = C.ruas.filter(r => C.navSet.has(r.id));
        const tasks = C.tasks.filter(t => C.byId.get(t.location_id) && !C.closed.has(t.location_id + ':' + t.round));
        if (!C.selPath.length) initSelPath();
        const rua = C.byId.get(C.selPath[0]);
        // níveis da cascata: a partir da rua, um bloco por nível até chegar nos endereços contáveis
        const levels = [];
        for (let i = 0; i < C.selPath.length; i++) {
            const kids = visKids(C.selPath[i]);
            if (!kids.length) break;
            levels.push({ kids, sel: C.selPath[i + 1], leaf: kids.every(k => C.allowedIds.has(k.id)) });
            if (kids.every(k => C.allowedIds.has(k.id))) break;
        }
        const g = rua ? (C.progress.get(rua.id) || { done: 0, total: 0 }) : { done: 0, total: 0 };
        const sug = tasks[0] ? C.byId.get(tasks[0].location_id) : null;
        paint(bar(camp.name || 'Campanha', `${done} de ${total} endereços`, 'backcamp') + `<div class="m-body">
            ${total === 0 ? '<div class="m-empty"><b style="display:block;color:#fff;margin-bottom:4px">Nenhum endereço para você</b>Peça ao supervisor para atribuir uma rua à sua equipe.</div>' : ''}
            ${sug ? `<button class="m-suggest" data-act="task" data-loc="${sug.id}" data-round="${tasks[0].round}"><span style="flex:1"><span class="a">↻ SUGERIDO · RECONTAGEM SOLICITADA</span><span class="c">${esc(sug.full_code)}</span></span><span style="font-size:24px">›</span></button>` : ''}
            ${total ? `
            <div class="m-sec"><span class="tl">1. Rua</span>
                <div class="m-g3">${ruas.map(r => `<button class="m-rua ${C.selPath[0] === r.id ? 'on' : ''}" style="--rc:${ruaColor(ruaIdx(r.id))}" data-act="rua" data-id="${r.id}" aria-pressed="${C.selPath[0] === r.id}">${esc(r.code)}</button>`).join('')}</div>
                ${rua ? `<div style="display:flex;justify-content:space-between;font-size:14px;color:var(--text-body-2)"><span>Rua ${esc(rua.code)} · ${g.done} de ${g.total} feitas</span><span class="muted">${g.total - g.done ? 'faltam ' + (g.total - g.done) : 'tudo feito ✓'}</span></div><span class="bar" style="height:8px"><i style="width:${g.total ? 100 * g.done / g.total : 0}%"></i></span>` : ''}</div>
            ${levels.map((lv, i) => { const kind = KIND_LABEL[lv.kids[0].kind]; const cols = lv.leaf ? (lv.kids.length > 8 ? 5 : 4) : 5; return `<div class="m-sec"><span class="tl">${i + 2}. ${esc(kind)}${i === 0 ? ' <small>· contorno branco = falta contar</small>' : ''}</span>
                <div class="${cols === 4 ? 'm-g4' : 'm-g5'}">${lv.kids.map(k => { const leaf = C.allowedIds.has(k.id); const fin = leaf ? doneLeaf(k) : pendingUnder(k.id) === 0; const on = lv.sel === k.id; const left = leaf ? '' : pendingUnder(k.id);
                    return `<button class="${leaf ? 'm-pb m-nb' : 'm-pb'} ${fin ? 'done' : ''} ${on ? 'on' : ''}" data-act="${leaf ? 'open' : 'down'}" data-id="${k.id}" data-lvl="${i}" aria-label="${esc(k.full_code)}${fin ? ', contado' : ''}">${esc(k.code)}<small>${fin ? '✓' : (left ? left + ' faltam' : '')}</small></button>`; }).join('')}</div></div>`; }).join('')}
            <label class="m-sec"><span class="tl">ou digite o código</span><input id="addr-in" class="m-input code" placeholder="VGR-A-03-2" autocapitalize="characters" autocomplete="off"></label>` : ''}
        </div>`, {
            backcamp: () => { C.skipAuto = true; screenCampaigns(); },
            rua: d => { C.selPath = [d.id]; let node = C.byId.get(d.id); while (node) { const kids = visKids(node.id); if (!kids.length || kids.every(k => C.allowedIds.has(k.id))) break; node = kids.find(k => pendingUnder(k.id) > 0) || kids[0]; C.selPath.push(node.id); } screenAddress(); },
            down: d => { C.selPath = C.selPath.slice(0, Number(d.lvl) + 1); C.selPath.push(d.id); let node = C.byId.get(d.id); while (node) { const kids = visKids(node.id); if (!kids.length || kids.every(k => C.allowedIds.has(k.id))) break; node = kids.find(k => pendingUnder(k.id) > 0) || kids[0]; C.selPath.push(node.id); } screenAddress(); },
            open: d => openAddress(d.id, 1),
            task: d => openAddress(d.loc, Number(d.round)),
            goto: () => {
                const t = document.getElementById('addr-in').value.trim().toUpperCase().replace(/\s+/g, '');
                if (!t) return;
                const hits = C.allowed.filter(l => l.full_code === t || l.full_code.endsWith('-' + t));
                if (hits.length === 1) return openAddress(hits[0].id, 1);
                notify(hits.length ? 'Mais de um endereço combina. Digite mais completo.' : 'Endereço não encontrado entre os seus.', 'err');
            }
        });
        const inp = document.getElementById('addr-in');
        if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') handlers.goto(); });
    }

    // ============================================================
    // B4 · LANÇAR OS ITENS
    // ============================================================
    async function openAddress(locId, round) {
        const loc = C.byId.get(locId);
        if (!loc) return;
        if (C.closed.has(locId + ':' + round)) { notify('Você já finalizou este endereço nesta rodada.', 'err'); return; }
        C.cur = loc; C.round = round; C.sel = null; C.search = '';
        C.raw = new Map(); C.unidDesc = new Map();
        // o que já foi lançado aqui (servidor) + o que ainda está na fila
        try {
            const [ev, un] = await Promise.all([
                sb.from('wh_count_events').select('id, item_id, unidentified_id, qty, supersedes_id').eq('campaign_id', C.camp).eq('location_id', locId).eq('round', round),
                sb.from('wh_unidentified_items').select('id, description').eq('campaign_id', C.camp).eq('location_id', locId)
            ]);
            for (const e of (ev.data || [])) C.raw.set(e.id, e);
            for (const u of (un.data || [])) C.unidDesc.set(u.id, u.description);
        } catch (e) { /* sem sinal: só o que está na fila */ }
        for (const op of ob.list()) {
            const p = op.payload;
            if (p.campaign_id !== C.camp || p.location_id !== locId) continue;
            if (op.kind === 'event' && p.round === round) C.raw.set(p.id, p);
            if (op.kind === 'unid') C.unidDesc.set(p.id, p.description);
        }
        screenEntry();
    }
    function currentLines() {
        const superseded = new Set([...C.raw.values()].map(e => e.supersedes_id).filter(Boolean));
        return [...C.raw.values()].filter(e => !superseded.has(e.id));
    }
    const realLines = () => currentLines().filter(e => (e.item_id || e.unidentified_id) && Number(e.qty) > 0);
    function suggestions(q) {
        const t = norm(q);
        if (!t) return [];
        const exact = C.byBarcode.get(q.trim());                            // leitor-teclado ou digitado
        if (exact && C.itemById.get(exact)) return [C.itemById.get(exact)];
        const toks = t.split(/\s+/), scored = [];
        for (const i of C.items) {
            const code = norm(i.code), vale = norm(i.vale_material_code || ''), hay = `${code} ${vale} ${norm(i.description)}`;
            if (!toks.every(x => hay.includes(x))) continue;
            scored.push([code === t || vale === t ? 0 : code.startsWith(t) || vale.startsWith(t) ? 1 : 2, i]);
            if (scored.length > 200) break;
        }
        return scored.sort((a, b) => a[0] - b[0]).slice(0, 8).map(x => x[1]);
    }
    const qtyNum = () => Number(String(C.sel.qty).replace(',', '.'));
    const qtyTxt = () => String(C.sel.qty).replace('.', ',');
    function screenEntry() {
        C.screen = 'entry';
        const loc = C.cur, lines = currentLines(), real = realLines();
        const sel = C.sel ? C.itemById.get(C.sel.item_id) : null;
        const sug = !sel ? suggestions(C.search) : [];
        const noItem = !sel;
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'];
        const body = noItem ? `
            <div style="display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;gap:8px"><input id="it-in" class="m-input focus" style="flex:1;min-width:0;height:60px;border-color:var(--blue-ring)" placeholder="Código ou descrição do item" value="${esc(C.search)}" autocomplete="off" aria-label="Buscar item">
                    <button disabled title="Disponível em breve" aria-label="Ler código (em breve)" style="width:60px;height:60px;border:1px dashed var(--border-color);border-radius:12px;background:transparent;color:var(--text-muted);font-size:11px;font-weight:700;line-height:1.1;cursor:not-allowed;flex:none">Ler<br>código</button></div>
                ${sug.map(i => `<button class="m-sug" data-act="pickitem" data-id="${i.id}"><b>${esc(i.description)}</b><span class="mt"><span class="id">${esc(i.code)}</span><span>${esc(i.uom)}</span>${i.criticality !== 'NORMAL' ? `<span style="color:var(--red-text);font-weight:700">◆ ${i.criticality === 'CRITICO' ? 'crítico' : 'alto valor'}</span>` : ''}</span></button>`).join('')}
                ${C.search && !sug.length ? `<div class="m-empty" style="text-align:left;color:var(--text-body-2)">Nada encontrado para “${esc(C.search)}”. Use <b>Item sem cadastro</b> abaixo.</div>` : ''}
            </div>
            <div class="m-twin"><button data-act="emptyaddr" ${lines.length ? 'disabled style="opacity:.4"' : ''}>○ Endereço vazio</button><button data-act="unid">+ Item sem cadastro / sem etiqueta</button></div>
            <div style="display:flex;flex-direction:column;gap:8px">
                <div style="display:flex;justify-content:space-between;align-items:center"><span class="m-lg">Lançados aqui (${real.length})</span>${real.length ? '<button class="btn btn-ghost" style="color:var(--blue-text);font-weight:700;height:44px" data-act="undo">↶ Desfazer último</button>' : ''}</div>
                ${real.map(e => { const it = e.item_id ? C.itemById.get(e.item_id) : null; return `<div class="m-line"><span class="d"><b>${it ? esc(it.description) : 'Sem cadastro · ' + esc(C.unidDesc.get(e.unidentified_id) || '')}</b><small>${it ? esc(it.code) : 'para análise'}</small></span><span class="q">${esc(fmt.num(e.qty))}${it ? ' ' + esc(it.uom) : ''}</span>${e.unidentified_id ? '' : `<button class="ed" data-act="fix" data-id="${e.id}" aria-label="Editar">Editar</button>`}</div>`; }).join('')}
                ${!real.length ? `<div class="m-empty">${lines.length ? 'Endereço marcado como vazio.' : 'Nenhum item lançado ainda. Busque o primeiro item acima.'}</div>` : ''}
            </div>`
            : `
            <div class="m-itemcard"><div style="display:flex;justify-content:space-between;gap:8px"><span class="mono" style="font-size:14px;color:var(--blue-text)">${esc(sel.code)}</span><button class="btn-link" style="font-size:15px;font-weight:700" data-act="cancelsel">Trocar</button></div>
                <span style="font-size:20px;font-weight:700;line-height:1.25">${esc(sel.description)}</span>
                <span style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="st" style="font-size:14px">Unidade: ${esc(sel.uom)}</span>${sel.criticality !== 'NORMAL' ? '<span class="st st-seal" style="font-size:13px">◆ Dupla conferência</span>' : ''}</span></div>
            ${sel.criticality !== 'NORMAL' ? '<div class="notice warn" style="margin:0">Item de alto valor/crítico: outra pessoa também vai contar este endereço.</div>' : ''}
            <div class="m-qty"><button data-act="dec" aria-label="Diminuir">−</button><div class="v"><span id="qty-txt">${esc(qtyTxt())}</span><small>${esc(sel.uom)}</small></div><button data-act="inc" aria-label="Aumentar">+</button></div>
            <div class="m-keys">${keys.map(k => `<button data-act="key" data-k="${k}" aria-label="${k === '⌫' ? 'Apagar' : k}">${k}</button>`).join('')}</div>`;
        const primary = sel
            ? `<button class="btn btn-primary btn-lg" data-act="additem" ${qtyNum() > 0 ? '' : 'disabled'}>Adicionar</button>`
            : `<button class="btn btn-primary btn-lg" data-act="finish" ${lines.length ? '' : 'disabled'}>Finalizar endereço${real.length ? ` (${real.length})` : ''}</button>`;
        paint(bar(`${C.round}ª rodada · ${real.length} ${real.length === 1 ? 'item' : 'itens'}`, loc.full_code, 'backaddr', true) + `<div class="m-body">${body}</div>`, {
            backaddr: () => { C.sel = null; screenAddress(); },
            pickitem: d => { C.sel = { item_id: d.id, qty: '1', fresh: true }; screenEntry(); },
            cancelsel: () => { C.sel = null; screenEntry(); },
            dec: () => { C.sel.qty = String(Math.max(0, Math.round((qtyNum() - 1) * 1000) / 1000)); C.sel.fresh = false; refreshQty(); },
            inc: () => { C.sel.qty = String(Math.round((qtyNum() + 1) * 1000) / 1000); C.sel.fresh = false; refreshQty(); },
            key: d => {
                let q = C.sel.fresh ? '' : String(C.sel.qty);
                if (d.k === '⌫') q = q.slice(0, -1);
                else if (d.k === ',') { if (!q.includes('.')) q = (q || '0') + '.'; }
                else if (q.replace('.', '').length < 9) q = (q === '0' ? '' : q) + d.k;
                C.sel.qty = q === '' ? '0' : q; C.sel.fresh = false; refreshQty();
            },
            additem: () => {
                const q = qtyNum();
                if (!(q > 0)) { notify('Informe a quantidade (maior que zero).', 'err'); return; }
                if (q > 100000 && !confirm(`Quantidade ${fmt.num(q)} é muito alta. Confirma?`)) return;
                addEvent({ item_id: C.sel.item_id, qty: q });
                C.sel = null; C.search = ''; TV.beep(true); screenEntry();
            },
            undo: () => { const last = real[real.length - 1]; if (!last || last.unidentified_id) return; addEvent({ item_id: last.item_id, qty: 0, supersedes_id: last.id }); screenEntry(); },
            fix: d => openFixSheet(d.id),
            emptyaddr: () => { if (!confirm('Confirmar que este endereço está VAZIO?')) return; addEvent({ item_id: null, qty: 0 }); finalize(1); },
            unid: openUnidSheet,
            finish: () => screenFinish()
        }, cta(primary));
        const inp = document.getElementById('it-in');
        if (inp) {
            inp.addEventListener('input', () => { C.search = inp.value; const p = inp.selectionStart; screenEntry(); const n = document.getElementById('it-in'); n.focus(); n.setSelectionRange(p, p); });
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const s = suggestions(C.search); if (s.length === 1) handlers.pickitem({ id: s[0].id }); } });
        }
    }
    function refreshQty() {
        const t = document.getElementById('qty-txt'); if (t) t.textContent = qtyTxt();
        const b = document.querySelector('[data-act="additem"]'); if (b) b.disabled = !(qtyNum() > 0);
    }
    const basePayload = () => ({ id: uuid(), site_key: C.site, campaign_id: C.camp, location_id: C.cur.id, round: C.round, counted_at: new Date().toISOString(), device_id: C.deviceId, app_version: APP_VERSION });
    function addEvent({ item_id, qty, unidentified_id, supersedes_id }) {
        const p = { ...basePayload(), item_id: item_id || null, unidentified_id: unidentified_id || null, qty, source: 'MANUAL' };
        if (supersedes_id) p.supersedes_id = supersedes_id;
        C.raw.set(p.id, p);
        ob.add({ kind: 'event', id: p.id, payload: p });
        return p;
    }

    // ---- folha de baixo: corrigir linha ----
    function sheet(html, onMount) {
        closeSheet();
        const bg = document.createElement('div'); bg.className = 'm-sheet-bg'; bg.id = 'sheet-bg';
        bg.innerHTML = `<div class="m-sheet" role="dialog" aria-modal="true"><span class="grab"></span>${html}</div>`;
        bg.addEventListener('mousedown', e => { if (e.target === bg) closeSheet(); });
        document.body.appendChild(bg);
        if (onMount) onMount(bg);
    }
    function closeSheet() { const s = document.getElementById('sheet-bg'); if (s) s.remove(); }
    function openFixSheet(id) {
        const e = C.raw.get(id), it = C.itemById.get(e.item_id);
        let q = String(e.qty);
        sheet(`<h3>Corrigir quantidade</h3><div><b>${esc(it ? it.code : '')}</b> <span class="muted">${esc(it ? it.description : '')}</span></div>
            <div class="m-qty"><button id="f-dec">−</button><div class="v"><span id="f-txt">${esc(q.replace('.', ','))}</span><small>${esc(it ? it.uom : '')}</small></div><button id="f-inc">+</button></div>
            <button class="btn btn-primary btn-lg" id="f-save">Salvar</button><button class="btn btn-lg" style="height:56px;font-size:17px;color:var(--red-text)" id="f-del">Remover este item do endereço</button>`, () => {
            const upd = () => { document.getElementById('f-txt').textContent = q.replace('.', ','); };
            document.getElementById('f-dec').addEventListener('click', () => { q = String(Math.max(0, Number(q) - 1)); upd(); });
            document.getElementById('f-inc').addEventListener('click', () => { q = String(Number(q) + 1); upd(); });
            document.getElementById('f-save').addEventListener('click', () => { addEvent({ item_id: e.item_id, qty: Number(q), supersedes_id: id }); closeSheet(); screenEntry(); });
            document.getElementById('f-del').addEventListener('click', () => { addEvent({ item_id: e.item_id, qty: 0, supersedes_id: id }); closeSheet(); screenEntry(); });
        });
    }

    // ---- item sem cadastro (foto obrigatória) ----
    async function compressPhoto(file) {
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
        const max = 1280, k = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(img.src);
        return await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.72));
    }
    function openUnidSheet() {
        let qty = 1;
        sheet(`<h3>Item sem cadastro / sem etiqueta</h3>
            <label style="display:flex;flex-direction:column;gap:6px;font-size:15px;font-weight:600;color:var(--text-body-2)">Descrição do que você vê<input id="un-desc" class="m-input" style="height:58px;font-size:17px" placeholder="Ex.: rolamento sem etiqueta, caixa azul"></label>
            <label class="m-photo" id="un-photo-l"><span id="un-photo-t">[ tirar foto do item ]</span><input id="un-photo" type="file" accept="image/*" capture="environment"></label>
            <div class="m-qty"><button id="u-dec" style="width:64px;height:64px">−</button><div class="v" style="height:64px"><span id="u-txt" style="font-size:32px">1</span></div><button id="u-inc" style="width:64px;height:64px">+</button></div>
            <button class="btn btn-primary btn-lg" id="un-go">Adicionar para análise</button>`, () => {
            document.getElementById('u-dec').addEventListener('click', () => { qty = Math.max(1, qty - 1); document.getElementById('u-txt').textContent = qty; });
            document.getElementById('u-inc').addEventListener('click', () => { qty += 1; document.getElementById('u-txt').textContent = qty; });
            document.getElementById('un-photo').addEventListener('change', e => { document.getElementById('un-photo-t').textContent = e.target.files[0] ? '✓ foto pronta: ' + e.target.files[0].name.slice(0, 22) : '[ tirar foto do item ]'; });
            document.getElementById('un-go').addEventListener('click', async () => {
                const desc = document.getElementById('un-desc').value.trim(), file = document.getElementById('un-photo').files[0];
                if (!desc) return notify('Descreva o item.', 'err');
                if (!file) return notify('Tire uma foto do item.', 'err');
                const btn = document.getElementById('un-go'); btn.disabled = true; btn.textContent = 'Enviando foto…';
                try {
                    const id = uuid(), path = `${C.site}/${C.camp}/${id}.jpg`;
                    const blob = await compressPhoto(file);
                    const { error } = await sb.storage.from('warehouse-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
                    if (error) throw new Error(isNetErr(error) ? 'Sem sinal para enviar a foto. Tente de novo com sinal.' : error.message);
                    C.unidDesc.set(id, desc);
                    ob.add({ kind: 'unid', id, payload: { id, site_key: C.site, campaign_id: C.camp, location_id: C.cur.id, photo_paths: [path], description: desc, qty } });
                    addEvent({ unidentified_id: id, qty });
                    closeSheet(); TV.beep(true); screenEntry();
                } catch (e) { notify(e.message, 'err'); btn.disabled = false; btn.textContent = 'Adicionar para análise'; }
            });
        });
    }

    // ============================================================
    // B5 · FINALIZAR  /  B6 · CONCLUÍDO
    // ============================================================
    function screenFinish() {
        C.screen = 'fin';
        const real = realLines();
        paint(bar(`${C.round}ª rodada`, C.cur.full_code, 'backentry', true) + `<div class="m-body">
            <div class="m-fin"><small>Você contou</small><b>${real.length}</b><span style="font-size:17px;color:var(--text-body-2)">${real.length === 1 ? 'item' : 'itens'} neste endereço</span></div>
            ${real.map(e => { const it = e.item_id ? C.itemById.get(e.item_id) : null; return `<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--divider)"><span style="flex:1;font-size:16px">${it ? esc(it.description) : 'Sem cadastro · ' + esc(C.unidDesc.get(e.unidentified_id) || '')}</span><b style="font-size:18px;font-weight:800">${esc(fmt.num(e.qty))}${it ? ' ' + esc(it.uom) : ''}</b></div>`; }).join('')}
            <div class="muted" style="font-size:14px;padding:0 4px">Depois de finalizar, só a supervisão pode alterar este endereço.</div>
        </div>`, { backentry: () => screenEntry(), back2: () => screenEntry(), confirm: () => finalize() },
            cta('<button class="btn btn-primary btn-lg" data-act="confirm">Confirmar e finalizar</button>', '<button class="sec" data-act="back2">Voltar e editar</button>'));
    }
    function finalize(forceLines) {
        const loc = C.cur, round = C.round;
        const lineCount = forceLines != null ? forceLines : [...C.raw.values()].length;
        const p = { id: uuid(), site_key: C.site, campaign_id: C.camp, location_id: loc.id, round, line_count: lineCount, finished_at: new Date().toISOString(), device_id: C.deviceId, app_version: APP_VERSION };
        ob.add({ kind: 'closure', id: p.id, payload: p });
        C.closed.add(loc.id + ':' + round);
        C.tasks = C.tasks.filter(t => !(t.location_id === loc.id && t.round === round));
        recomputeProgress(); persistClosed();
        C.last = { loc, round, empty: forceLines === 1 && realLines().length === 0 };
        TV.beep(true);
        screenDone();
    }
    function screenDone() {
        C.screen = 'done';
        const { loc, empty } = C.last, nx = nextSuggested(loc), s = syncState();
        const sub = l => l ? (l.path || []).map(id => C.byId.get(id)).filter(p => p && p.kind !== 'ARMAZEM').map(p => `${KIND_LABEL[p.kind]} ${p.code}`).join(' · ') : '';
        paint(bar('', 'Concluído', null) + `<div class="m-body"><div class="m-done">
            <span class="ok">✓</span><span style="font-size:24px;font-weight:700">Endereço finalizado</span>
            <span class="mono" style="font-size:18px;color:var(--text-body-2)">${esc(loc.full_code)} · ${empty ? 'vazio' : realLines().length + ' ' + (realLines().length === 1 ? 'item' : 'itens')}</span>
            <span id="done-sync" style="font-size:15px;font-weight:600;color:${doneSync(s).color}">${doneSync(s).txt}</span></div>
            ${nx ? `<div class="m-next"><span class="a">PRÓXIMO SUGERIDO · mais perto de você</span><span class="c">${esc(nx.full_code)}</span><span style="font-size:15px;color:var(--text-body-2)">${esc(sub(nx))}</span></div>` : '<div class="m-empty" style="margin-top:auto">🎉 Você contou todos os seus endereços.</div>'}
        </div>`, { next: () => openAddress(nx.id, 1), other: () => { C.selPath = []; initSelPath(); screenAddress(); } },
            cta(nx ? `<button class="btn btn-primary btn-lg" data-act="next">Ir para ${esc(nx.full_code)}</button>` : '', '<button class="sec" data-act="other">Escolher outro endereço</button>'));
    }

    // ============================================================
    // INÍCIO
    // ============================================================
    async function init(ctx) {
        C.ctx = ctx;
        if (!ctx.sites.length) {
            paint(bar('Armazém', '') + '<div class="m-body"><div class="m-empty"><b style="display:block;color:#fff;margin-bottom:4px">Nenhum armazém liberado</b>Peça ao Admin para liberar o site VGR - Armazém no seu cadastro.</div></div>');
            return;
        }
        const saved = store.get('tv_arm_site', null);
        C.site = (ctx.sites.find(s => s.key === saved) || ctx.sites[0]).key;
        C.deviceId = store.get('tv_arm_device', null);
        if (!C.deviceId) { C.deviceId = 'dev-' + uuid().slice(0, 8); store.set('tv_arm_device', C.deviceId); }
        window.addEventListener('online', () => { C.netDown = false; renderSync(); flush(); });
        window.addEventListener('offline', renderSync);
        setInterval(flush, 15000);          // só envia a fila; nunca recarrega dados na tela
        flush();
        await screenCampaigns();
    }
    window.Campo = { init, _C: C, _ob: ob };
})();
