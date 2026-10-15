/* ============================================================
   TerraVia Armazém — CAMPO (celular): contagem com digitação manual.
   Fluxo: campanha -> endereço -> itens -> finalizar endereço.

   FILA DE ENVIO (outbox): tudo que o operador lança é gravado primeiro no
   próprio aparelho (localStorage) e enviado em segundo plano. Sem sinal, o
   app continua funcionando e envia depois. Cada lançamento tem um id gerado
   no aparelho, então reenviar nunca duplica (o banco ignora o id repetido).

   REGRA DE OURO (aprendida no app principal): NENHUMA atualização automática
   de dados no meio da contagem. Só o envio da fila roda sozinho; ele nunca
   mexe no que está na tela.
   ============================================================ */
(function () {
    'use strict';
    const { sb, esc, fmt, toast, openModal, closeModal, fetchAll, uuid, norm, store, isNetErr } = TV;
    const APP_VERSION = 'campo-1';
    const OB_KEY = 'tv_arm_outbox_v1';
    const KIND_LABEL = { ARMAZEM: 'Armazém', RUA: 'Rua', PRATELEIRA: 'Prateleira', NIVEL: 'Nível', POSICAO: 'Posição' };

    const C = {
        ctx: null, site: null, camp: null, campaigns: [],
        locs: [], byId: new Map(), kids: new Map(), assign: [], tasks: [], closed: new Set(),
        allowed: [], navSet: new Set(), progress: new Map(),
        items: [], itemById: new Map(), byBarcode: new Map(),
        nav: [], cur: null, round: 1, raw: new Map(), unidDesc: new Map(),
        sel: null, search: '', deviceId: null
    };
    const app = () => document.getElementById('app');
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
        // O endereço só fecha quando todas as linhas dele chegaram: se a ordem do envio
        // atrapalhou, tenta de novo mais tarde em vez de dar a linha como perdida.
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
                if (r === 'net') break;
                if (r === 'wait') continue;
                const l = ob.list();
                const i = l.findIndex(o => o.id === op.id);
                if (i >= 0) {
                    if (r === 'ok') l.splice(i, 1); else { l[i].failed = true; l[i].error = r; }
                    ob.save(l);
                }
                renderSync();
            }
        } finally { flushing = false; renderSync(); }
    }
    function renderSync() {
        const el = document.getElementById('sync-btn');
        if (!el) return;
        const p = ob.pendingCount(), f = ob.failed().length;
        el.className = 'm-sync' + (f ? ' fail' : p ? ' pend' : '');
        el.textContent = f ? `⚠ ${f} com erro` : p ? `● ${p} pendente${p > 1 ? 's' : ''}` : (navigator.onLine === false ? 'Sem sinal' : '✓ Enviado');
    }
    function openSyncModal() {
        const l = ob.list();
        const name = op => ({ event: 'Contagem', closure: 'Endereço finalizado', unid: 'Item sem cadastro' }[op.kind]);
        const where = op => { const loc = C.byId.get(op.payload.location_id); return loc ? loc.full_code : ''; };
        openModal('Envio dos dados', `
            <p class="muted" style="margin-bottom:12px">${navigator.onLine === false ? 'Sem sinal agora. ' : ''}O que você lança é guardado neste aparelho e enviado assim que houver sinal.</p>
            ${l.length === 0 ? '<div class="notice">Tudo enviado ✓</div>' : l.map(op => `
                <div class="m-line"><div><b>${esc(name(op))}</b> <span class="muted">${esc(where(op))}</span>${op.failed ? `<div style="color:#fca5a5;font-size:12px">${esc(op.error)}</div>` : ''}</div>
                ${op.failed ? `<button class="btn btn-sm btn-danger" data-drop="${op.id}">Descartar</button>` : '<span class="badge badge-warn">aguardando</span>'}</div>`).join('')}`,
            '<button class="btn btn-primary" id="sy-go">Enviar agora</button><button class="btn" data-x>Fechar</button>');
        document.querySelector('[data-x]').addEventListener('click', closeModal);
        document.getElementById('sy-go').addEventListener('click', async () => { await flush(); openSyncModal(); });
        document.querySelectorAll('[data-drop]').forEach(b => b.addEventListener('click', () => {
            if (!confirm('Descartar este lançamento? Ele NÃO será enviado.')) return;
            ob.save(ob.list().filter(o => o.id !== b.dataset.drop)); renderSync(); openSyncModal();
        }));
    }

    // ============================================================
    // CARGA DOS DADOS (com cópia no aparelho pra abrir sem sinal)
    // ============================================================
    const packKey = () => `tv_arm_pack_${C.site}_${C.camp}`;
    async function loadPack() {
        try {
            const [locs, asg, tasks, cls, items, bars] = await Promise.all([
                fetchAll((f, t) => sb.from('wh_locations').select('id, parent_id, kind, code, full_code, path, is_countable, active').eq('site_key', C.site).order('full_code').range(f, t)),
                sb.from('wh_campaign_assignments').select('location_id, team_id, round').eq('campaign_id', C.camp),
                sb.from('wh_recount_tasks').select('id, location_id, round, reason').eq('campaign_id', C.camp).eq('status', 'ABERTA'),
                sb.from('wh_count_closures').select('location_id, round').eq('campaign_id', C.camp),
                fetchAll((f, t) => sb.from('wh_items').select('id, code, vale_material_code, description, uom, criticality, active').eq('site_key', C.site).eq('active', true).order('code').range(f, t)),
                fetchAll((f, t) => sb.from('wh_item_barcodes').select('item_id, barcode').eq('site_key', C.site).range(f, t))
            ]);
            for (const r of [asg, tasks, cls]) if (r.error) throw r.error;
            const pack = { locs, assign: asg.data, tasks: tasks.data, closed: cls.data.map(c => c.location_id + ':' + c.round), items, bars, at: Date.now() };
            store.set(packKey(), pack);
            applyPack(pack);
            return true;
        } catch (e) {
            if (!isNetErr(e)) throw e;
            const pack = store.get(packKey(), null);
            if (!pack) throw new Error('Sem sinal e sem dados guardados desta campanha. Abra uma vez com internet.');
            applyPack(pack);
            toast('Sem sinal: usando os dados guardados no aparelho.', 'warn');
            return false;
        }
    }
    function applyPack(p) {
        C.locs = p.locs; C.byId = new Map(); C.kids = new Map();
        for (const l of C.locs) {
            C.byId.set(l.id, l);
            const k = l.parent_id || 'root';
            if (!C.kids.has(k)) C.kids.set(k, []);
            C.kids.get(k).push(l);
        }
        for (const a of C.kids.values()) a.sort((x, y) => x.code.localeCompare(y.code, 'pt-BR', { numeric: true }));
        C.assign = p.assign || []; C.tasks = p.tasks || [];
        C.closed = new Set(p.closed || []);
        C.items = p.items || []; C.itemById = new Map(C.items.map(i => [i.id, i]));
        C.byBarcode = new Map((p.bars || []).map(b => [b.barcode, b.item_id]));
        computeAllowed();
    }
    function persistClosed() {
        const p = store.get(packKey(), null);
        if (p) { p.closed = [...C.closed]; p.tasks = C.tasks; store.set(packKey(), p); }
    }
    // Quais endereços este usuário pode contar na rodada 1: os debaixo das ruas da equipe dele.
    function computeAllowed() {
        const a1 = new Set(C.assign.filter(a => a.round === 1).map(a => a.location_id));
        const free = C.ctx.role === 'ARM_SUPERVISOR' && C.assign.length === 0;   // supervisor sem equipe: vê tudo
        C.allowed = C.locs.filter(l => l.is_countable && l.active && (free || (l.path || []).some(p => a1.has(p))));
        recomputeProgress();
    }
    function recomputeProgress() {
        C.navSet = new Set(); C.progress = new Map();
        for (const l of C.allowed) {
            const done = C.closed.has(l.id + ':1');
            for (const p of (l.path || [])) {
                C.navSet.add(p);
                const g = C.progress.get(p) || { done: 0, total: 0 };
                g.total++; if (done) g.done++;
                C.progress.set(p, g);
            }
        }
    }

    // ============================================================
    // CASCA (cabeçalho + navegação)
    // ============================================================
    function head(title, sub, back) {
        return `<div class="m-head">
            <div style="display:flex;align-items:center;gap:10px;min-width:0">${back ? `<button class="btn btn-sm" data-act="${back}" aria-label="Voltar">←</button>` : ''}
                <div style="min-width:0"><div class="ttl" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div></div>
            <div style="display:flex;gap:8px;align-items:center"><button class="m-sync" id="sync-btn" data-act="sync"></button><button class="btn btn-sm" data-act="menu" aria-label="Menu">⋯</button></div></div>`;
    }
    function paint(html, map) {
        app().innerHTML = html;
        handlers = map || {};
        app().onclick = ev => {
            const b = ev.target.closest('[data-act]');
            if (!b) return;
            const fn = handlers[b.dataset.act] || common[b.dataset.act];
            if (fn) Promise.resolve(fn(b.dataset, b, ev)).catch(e => toast(e.message || String(e), 'err'));
        };
        renderSync();
    }
    const common = {
        sync: openSyncModal,
        menu() {
            openModal(C.ctx.profile.name, `<p class="muted" style="margin-bottom:14px">${esc(TV.ROLE_LABEL[C.ctx.role])}${C.camp ? ' · ' + esc((C.campaigns.find(c => c.id === C.camp) || {}).name || '') : ''}</p>
                <div class="m-list">
                    ${C.camp ? '<button class="btn btn-lg" id="mn-camp">Trocar de campanha</button>' : ''}
                    ${C.ctx.role === 'ARM_SUPERVISOR' ? '<a class="btn btn-lg" href="index.html?ir=gestao">Abrir a gestão (notebook)</a>' : ''}
                    <button class="btn btn-lg btn-danger" id="mn-out">Sair</button></div>`);
            const c = document.getElementById('mn-camp'); if (c) c.addEventListener('click', () => { closeModal(); C.camp = null; screenCampaigns(); });
            document.getElementById('mn-out').addEventListener('click', async () => {
                if (ob.pendingCount() && !confirm(`Há ${ob.pendingCount()} lançamentos ainda não enviados. Se sair agora, eles ficam guardados neste aparelho, mas só sobem quando você entrar de novo. Sair mesmo?`)) return;
                TV.signOut();
            });
        }
    };

    // ============================================================
    // TELA 1: campanha
    // ============================================================
    async function screenCampaigns() {
        paint(head('Armazém', C.ctx.profile.name) + '<div class="m-body"><div class="spinner"></div></div>');
        let list = null;
        try {
            const { data, error } = await sb.from('wh_campaigns').select('id, name, kind, status').eq('site_key', C.site).eq('status', 'ATIVA').order('created_at', { ascending: false });
            if (error) throw error;
            list = data || [];
            store.set('tv_arm_camps_' + C.site, list);
        } catch (e) {
            if (!isNetErr(e)) { toast(e.message, 'err'); list = []; } else list = store.get('tv_arm_camps_' + C.site, []);
        }
        C.campaigns = list;
        if (list.length === 1 && !C.skipAuto) { return pickCampaign(list[0].id); }
        paint(head('Campanhas', C.ctx.profile.name) + `<div class="m-body">
            <div class="m-title">Escolha a campanha</div><div class="m-hint">Só aparecem as campanhas ativas.</div>
            ${list.length ? `<div class="m-list">${list.map(c => `<button class="m-card" data-act="pick" data-id="${c.id}"><span><span class="big">${esc(c.name)}</span><br><span class="muted">${c.kind === 'GERAL' ? 'Inventário geral' : 'Contagem cíclica'}</span></span><span>›</span></button>`).join('')}</div>`
                : '<div class="empty"><b>Nenhuma campanha ativa</b>Peça ao supervisor para ativar a campanha.</div>'}</div>`,
            { pick: d => pickCampaign(d.id) });
    }
    async function pickCampaign(id) {
        C.camp = id; C.skipAuto = false;
        paint(head('Carregando…', 'Baixando endereços e itens') + '<div class="m-body"><div class="spinner"></div></div>');
        try { await loadPack(); } catch (e) { toast(e.message, 'err'); C.camp = null; C.skipAuto = true; return screenCampaigns(); }
        C.nav = [];
        screenAddress();
    }

    // ============================================================
    // TELA 2: escolher o endereço
    // ============================================================
    function navNodes() {
        let parent = 'root';
        const trail = [];
        // desce sozinho enquanto só houver uma opção (ex.: o único armazém)
        const children = p => (C.kids.get(p) || []).filter(l => C.navSet.has(l.id));
        for (const id of C.nav) { parent = id; trail.push(C.byId.get(id)); }
        for (;;) {
            const ch = children(parent);
            if (ch.length === 1 && !C.allowed.includes(ch[0]) && C.nav.indexOf(ch[0].id) < 0) { parent = ch[0].id; trail.push(ch[0]); } else return { parent, trail, ch };
        }
    }
    function screenAddress() {
        const camp = C.campaigns.find(c => c.id === C.camp);
        const { trail, ch } = navNodes();
        const total = C.allowed.length, done = C.allowed.filter(l => C.closed.has(l.id + ':1')).length;
        const tasks = C.tasks.filter(t => C.byId.get(t.location_id) && !C.closed.has(t.location_id + ':' + t.round));
        const leaf = ch.length && ch.every(l => C.allowed.includes(l));
        paint(head(camp ? camp.name : 'Campanha', `${done} de ${total} endereços feitos por você`, null) + `<div class="m-body">
            <div class="bar ${done === total && total ? 'ok' : ''}" style="margin-bottom:14px"><i style="width:${total ? 100 * done / total : 0}%"></i></div>
            ${total === 0 ? '<div class="empty"><b>Nenhum endereço para você</b>Peça ao supervisor para atribuir uma rua à sua equipe.</div>' : ''}
            ${tasks.length ? `<div class="m-title" style="font-size:16px">Recontagens pedidas</div><div class="m-list" style="margin-bottom:16px">${tasks.map(t => { const l = C.byId.get(t.location_id); return `<button class="m-card" data-act="task" data-loc="${t.location_id}" data-round="${t.round}"><span><span class="big mono">${esc(l.full_code)}</span><br><span class="muted">Contar de novo · ${t.round}ª rodada</span></span><span class="badge badge-warn">recontar</span></button>`; }).join('')}</div>` : ''}
            ${total ? `
            <div class="field"><label class="f">Digitar o endereço (ex.: A-03-2)</label>
                <div style="display:flex;gap:8px"><input id="addr-in" class="m-input-lg" placeholder="A-03-2" autocapitalize="characters" autocomplete="off"><button class="btn btn-primary" style="flex:0 0 80px" data-act="goto">Ir</button></div></div>
            <div class="m-title" style="font-size:16px;margin-top:18px">Ou escolha pela lista</div>
            ${trail.length ? `<div class="m-hint">${trail.map(l => esc(l.code)).join(' › ')} ${C.nav.length ? '<button class="btn btn-sm btn-ghost" data-act="up">↑ Voltar um nível</button>' : ''}</div>` : ''}
            <div class="m-chips">${ch.map(l => {
                const g = C.progress.get(l.id) || { done: 0, total: 0 };
                const isLeaf = C.allowed.includes(l);
                const fin = isLeaf ? C.closed.has(l.id + ':1') : (g.total > 0 && g.done === g.total);
                return `<button class="m-chip ${fin ? 'done' : ''}" data-act="${isLeaf ? 'open' : 'down'}" data-id="${l.id}">${esc(l.code)}${isLeaf ? (fin ? ' ✓' : '') : `<div style="font-size:11px;font-weight:400;color:var(--text-secondary)">${KIND_LABEL[l.kind]} · ${g.done}/${g.total}</div>`}</button>`;
            }).join('')}</div>` : ''}
        </div>`, {
            down: d => { C.nav.push(d.id); screenAddress(); },
            up: () => { C.nav.pop(); screenAddress(); },
            open: d => openAddress(d.id, 1),
            task: d => openAddress(d.loc, Number(d.round)),
            goto() {
                const t = document.getElementById('addr-in').value.trim().toUpperCase().replace(/\s+/g, '');
                if (!t) return;
                const hits = C.allowed.filter(l => l.full_code === t || l.full_code.endsWith('-' + t));
                if (hits.length === 1) return openAddress(hits[0].id, 1);
                toast(hits.length ? 'Mais de um endereço combina. Digite mais completo.' : 'Endereço não encontrado entre os seus.', 'warn');
            }
        });
        const inp = document.getElementById('addr-in');
        if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') handlers.goto(); });
    }

    // ============================================================
    // TELA 3: lançar os itens do endereço
    // ============================================================
    async function openAddress(locId, round) {
        const loc = C.byId.get(locId);
        if (!loc) return;
        if (C.closed.has(locId + ':' + round)) { toast('Você já finalizou este endereço nesta rodada.', 'warn'); return; }
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
    function suggestions(q) {
        const t = norm(q);
        if (!t) return [];
        const exact = C.byBarcode.get(q.trim());
        if (exact && C.itemById.get(exact)) return [C.itemById.get(exact)];
        const toks = t.split(/\s+/);
        const scored = [];
        for (const i of C.items) {
            const code = norm(i.code), vale = norm(i.vale_material_code || ''), hay = `${code} ${vale} ${norm(i.description)}`;
            if (!toks.every(x => hay.includes(x))) continue;
            scored.push([code === t || vale === t ? 0 : code.startsWith(t) || vale.startsWith(t) ? 1 : 2, i]);
            if (scored.length > 200) break;
        }
        return scored.sort((a, b) => a[0] - b[0]).slice(0, 8).map(x => x[1]);
    }
    function screenEntry() {
        const loc = C.cur, lines = currentLines();
        const real = lines.filter(e => e.item_id || e.unidentified_id);
        const empty = lines.length > 0 && real.length === 0;
        const sel = C.sel ? C.itemById.get(C.sel.item_id) : null;
        const sug = !sel ? suggestions(C.search) : [];
        paint(head(loc.full_code, `${C.round}ª rodada · ${real.length} ${real.length === 1 ? 'item' : 'itens'} lançado${real.length === 1 ? '' : 's'}`, 'back') + `
        <div class="m-body">
            ${!sel ? `
            <div class="field"><label class="f">Buscar item (código ou descrição)</label>
                <input id="it-in" class="m-input-lg" placeholder="ex.: rolamento 22218" value="${esc(C.search)}" autocomplete="off" ${empty ? 'disabled' : ''}></div>
            ${C.search && !sug.length ? '<div class="notice warn">Nenhum item encontrado. Use “Item sem cadastro” se não estiver na lista.</div>' : ''}
            <div class="m-suggest">${sug.map(i => `<button data-act="pickitem" data-id="${i.id}"><b>${esc(i.code)}</b> · ${esc(i.description)}<small>${esc(i.uom)}${i.vale_material_code ? ' · Vale ' + esc(i.vale_material_code) : ''}${i.criticality !== 'NORMAL' ? ' · ⚠ ' + (i.criticality === 'CRITICO' ? 'crítico' : 'alto valor') : ''}</small></button>`).join('')}</div>`
            : `
            <div class="card" style="margin-bottom:10px"><b>${esc(sel.code)}</b> · ${esc(sel.description)}<div class="muted" style="margin-top:2px">Unidade: ${esc(sel.uom)}</div>
                ${sel.criticality !== 'NORMAL' ? `<div class="notice warn" style="margin:10px 0 0">⚠ Item ${sel.criticality === 'CRITICO' ? 'crítico' : 'de alto valor'}: outra pessoa também vai contar (dupla conferência).</div>` : ''}</div>
            <div class="m-hint" style="margin-bottom:0">Quantidade contada</div>
            <div class="m-qty"><button data-act="dec" aria-label="Menos">−</button><input id="qty-in" type="number" inputmode="decimal" step="any" min="0" value="${esc(C.sel.qty)}"><button data-act="inc" aria-label="Mais">+</button></div>
            <button class="btn btn-ok btn-lg" data-act="additem">Adicionar</button>
            <button class="btn btn-ghost btn-lg" style="margin-top:8px" data-act="cancelsel">Trocar item</button>`}

            <div style="margin-top:20px" class="m-title" ${real.length ? '' : 'hidden'}>Lançado neste endereço</div>
            ${real.map(e => {
                const it = e.item_id ? C.itemById.get(e.item_id) : null;
                return `<div class="m-line"><div style="min-width:0"><b>${it ? esc(it.code) : 'Sem cadastro'}</b> <span class="muted">${it ? esc(it.description) : esc(C.unidDesc.get(e.unidentified_id) || '')}</span></div>
                    <div style="display:flex;gap:8px;align-items:center;flex:none"><b style="font-size:18px">${fmt.num(e.qty)}</b>${e.unidentified_id ? '' : `<button class="btn btn-sm" data-act="fix" data-id="${e.id}">Corrigir</button>`}</div></div>`;
            }).join('')}
            ${empty ? '<div class="notice">Endereço marcado como vazio.</div>' : ''}
            ${!lines.length ? '<div class="empty" style="padding:20px 10px">Nenhum item ainda. Busque acima ou toque em “Endereço vazio”.</div>' : ''}
        </div>
        <div class="m-foot">
            ${!lines.length ? '<button class="btn btn-lg" data-act="emptyaddr">Endereço vazio</button>' : ''}
            ${!empty && !sel ? '<button class="btn btn-lg" data-act="unid">Item sem cadastro / sem etiqueta</button>' : ''}
            <button class="btn btn-primary btn-lg" data-act="finish" ${lines.length ? '' : 'disabled'}>Finalizar endereço</button>
        </div>`, {
            back() { screenAddress(); },
            pickitem: d => { C.sel = { item_id: d.id, qty: '1' }; screenEntry(); setTimeout(() => { const q = document.getElementById('qty-in'); if (q) { q.focus(); q.select(); } }, 30); },
            cancelsel() { C.sel = null; screenEntry(); },
            dec() { const q = document.getElementById('qty-in'); q.value = Math.max(0, (Number(q.value) || 0) - 1); },
            inc() { const q = document.getElementById('qty-in'); q.value = (Number(q.value) || 0) + 1; },
            additem() {
                const q = Number(document.getElementById('qty-in').value);
                if (!(q > 0)) { toast('Informe a quantidade (maior que zero).', 'warn'); return; }
                if (q > 100000 && !confirm(`Quantidade ${fmt.num(q)} é muito alta. Confirma?`)) return;
                addEvent({ item_id: C.sel.item_id, qty: q });
                C.sel = null; C.search = ''; TV.beep(true); screenEntry();
                setTimeout(() => { const i = document.getElementById('it-in'); if (i) i.focus(); }, 30);
            },
            fix: d => openFixModal(d.id),
            emptyaddr() {
                if (!confirm('Confirmar que este endereço está VAZIO?')) return;
                addEvent({ item_id: null, qty: 0 }); finalize(1);
            },
            unid: openUnidModal,
            finish() {
                const n = currentLines().filter(e => e.item_id || e.unidentified_id).length;
                openModal('Finalizar endereço', `<p style="margin-bottom:6px"><b>${esc(loc.full_code)}</b> · ${C.round}ª rodada</p><p class="muted">${n} ${n === 1 ? 'item lançado' : 'itens lançados'}. Depois de finalizar, só o supervisor corrige.</p>`,
                    '<button class="btn" data-x>Voltar</button><button class="btn btn-primary" id="fin-go">Finalizar</button>');
                document.querySelector('[data-x]').addEventListener('click', closeModal);
                document.getElementById('fin-go').addEventListener('click', () => { closeModal(); finalize(); });
            }
        });
        const inp = document.getElementById('it-in');
        if (inp && !inp.disabled) {
            inp.addEventListener('input', () => { C.search = inp.value; const pos = inp.selectionStart; screenEntry(); const n = document.getElementById('it-in'); n.focus(); n.setSelectionRange(pos, pos); });
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const s = suggestions(C.search); if (s.length === 1) handlers.pickitem({ id: s[0].id }); } });
        }
        const q = document.getElementById('qty-in');
        if (q) q.addEventListener('keydown', e => { if (e.key === 'Enter') handlers.additem(); });
    }

    function basePayload() {
        return {
            id: uuid(), site_key: C.site, campaign_id: C.camp, location_id: C.cur.id, round: C.round,
            counted_at: new Date().toISOString(), device_id: C.deviceId, app_version: APP_VERSION
        };
    }
    function addEvent({ item_id, qty, unidentified_id, supersedes_id }) {
        const p = { ...basePayload(), item_id: item_id || null, unidentified_id: unidentified_id || null, qty, source: 'MANUAL' };
        if (supersedes_id) p.supersedes_id = supersedes_id;
        C.raw.set(p.id, p);
        ob.add({ kind: 'event', id: p.id, payload: p });
        return p;
    }
    function openFixModal(id) {
        const e = C.raw.get(id), it = C.itemById.get(e.item_id);
        openModal('Corrigir quantidade', `<p style="margin-bottom:10px"><b>${esc(it ? it.code : '')}</b> ${esc(it ? it.description : '')}</p>
            <div class="m-qty"><input id="fix-in" type="number" inputmode="decimal" step="any" min="0" value="${esc(e.qty)}"></div>
            <p class="muted" style="font-size:12px">Digite 0 para remover este item do endereço.</p>`,
            '<button class="btn" data-x>Cancelar</button><button class="btn btn-primary" id="fix-go">Salvar</button>');
        document.querySelector('[data-x]').addEventListener('click', closeModal);
        document.getElementById('fix-go').addEventListener('click', () => {
            const q = Number(document.getElementById('fix-in').value);
            if (isNaN(q) || q < 0) { toast('Quantidade inválida.', 'warn'); return; }
            addEvent({ item_id: e.item_id, qty: q, supersedes_id: id });
            closeModal(); screenEntry();
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
    function openUnidModal() {
        openModal('Item sem cadastro / sem etiqueta', `
            <div class="field"><label class="f">Descreva o que é</label><input id="un-desc" class="m-input-lg" placeholder="ex.: caixa azul com parafusos"></div>
            <div class="field"><label class="f">Quantidade</label><input id="un-qty" class="m-input-lg" type="number" inputmode="decimal" step="any" min="0" value="1"></div>
            <div class="field"><label class="f">Foto (obrigatória — precisa de sinal)</label><input id="un-photo" type="file" accept="image/*" capture="environment"></div>`,
            '<button class="btn" data-x>Cancelar</button><button class="btn btn-primary" id="un-go">Salvar</button>');
        document.querySelector('[data-x]').addEventListener('click', closeModal);
        document.getElementById('un-go').addEventListener('click', async () => {
            const desc = document.getElementById('un-desc').value.trim(), qty = Number(document.getElementById('un-qty').value);
            const file = document.getElementById('un-photo').files[0];
            if (!desc) return toast('Descreva o item.', 'warn');
            if (!(qty > 0)) return toast('Informe a quantidade.', 'warn');
            if (!file) return toast('Tire uma foto do item.', 'warn');
            const btn = document.getElementById('un-go'); btn.disabled = true; btn.textContent = 'Enviando foto…';
            try {
                const id = uuid(), path = `${C.site}/${C.camp}/${id}.jpg`;
                const blob = await compressPhoto(file);
                const { error } = await sb.storage.from('warehouse-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
                if (error) throw new Error(isNetErr(error) ? 'Sem sinal para enviar a foto. Tente de novo com sinal.' : error.message);
                const p = { id, site_key: C.site, campaign_id: C.camp, location_id: C.cur.id, photo_paths: [path], description: desc, qty };
                C.unidDesc.set(id, desc);
                ob.add({ kind: 'unid', id, payload: p });
                addEvent({ unidentified_id: id, qty });
                closeModal(); TV.beep(true); screenEntry();
            } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Salvar'; }
        });
    }

    // ---- finalizar ----
    function finalize(forceLines) {
        const loc = C.cur, round = C.round;
        const lineCount = forceLines != null ? forceLines : [...C.raw.values()].length;
        const p = { id: uuid(), site_key: C.site, campaign_id: C.camp, location_id: loc.id, round, line_count: lineCount, finished_at: new Date().toISOString(), device_id: C.deviceId, app_version: APP_VERSION };
        ob.add({ kind: 'closure', id: p.id, payload: p });
        C.closed.add(loc.id + ':' + round);
        C.tasks = C.tasks.filter(t => !(t.location_id === loc.id && t.round === round));
        recomputeProgress(); persistClosed();
        toast(`${loc.full_code} finalizado.`); TV.beep(true);
        C.cur = null;
        screenAddress();
    }

    // ============================================================
    // INÍCIO
    // ============================================================
    async function init(ctx) {
        C.ctx = ctx;
        if (!ctx.sites.length) {
            paint(head('Armazém', '') + '<div class="m-body"><div class="empty"><b>Nenhum armazém liberado</b>Peça ao Admin para liberar o site VGR - Armazém no seu cadastro.</div></div>');
            return;
        }
        const saved = store.get('tv_arm_site', null);
        C.site = (ctx.sites.find(s => s.key === saved) || ctx.sites[0]).key;
        C.deviceId = store.get('tv_arm_device', null);
        if (!C.deviceId) { C.deviceId = 'dev-' + uuid().slice(0, 8); store.set('tv_arm_device', C.deviceId); }
        window.addEventListener('online', () => { renderSync(); flush(); });
        window.addEventListener('offline', renderSync);
        setInterval(flush, 15000);          // só envia a fila; nunca recarrega dados na tela
        flush();
        await screenCampaigns();
    }
    window.Campo = { init, _C: C, _ob: ob };
})();
