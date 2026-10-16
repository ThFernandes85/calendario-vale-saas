/* ============================================================
   TerraVia Armazém — código compartilhado (login, gestão e campo).
   Tudo fica no objeto global `TV`. Mesmo projeto Supabase do app principal:
   como as duas páginas ficam na MESMA origem (mesmo domínio), a sessão de
   login do navegador é compartilhada — quem entrou num já entra no outro.
   A chave `anon` é pública por natureza (está no HTML do app principal
   também): quem protege os dados é a RLS do banco, nunca esta chave.
   ============================================================ */
(function () {
    'use strict';

    const SUPABASE_URL = 'https://ybgszlflvzxepywbjkyo.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InliZ3N6bGZsdnp4ZXB5d2Jqa3lvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3MDU1MDQsImV4cCI6MjA5OTI4MTUwNH0.uvjTUKXT7nxtCw1gfmYEWATOKcVvzlklCa_1dyjGUz8';

    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Papéis do módulo + Admin (que administra mas não registra contagem).
    const ROLE_LABEL = {
        ARM_OPERADOR: 'Operador (Sodexo)',
        ARM_SUPERVISOR: 'Supervisor (Sodexo)',
        ARM_GESTOR_VALE: 'Gestor (Vale)',
        ADMIN: 'Admin Master'
    };
    const GESTAO_ROLES = ['ARM_SUPERVISOR', 'ARM_GESTOR_VALE', 'ADMIN'];
    const CAMPO_ROLES = ['ARM_OPERADOR', 'ARM_SUPERVISOR'];
    const WRITE_ROLES = ['ARM_SUPERVISOR', 'ADMIN'];

    // ---------- utilidades ----------
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function uuid() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        // fallback p/ navegador antigo
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }
    const store = {
        get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
        del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignora */ } }
    };
    const fmt = {
        int: n => (Number(n) || 0).toLocaleString('pt-BR'),
        num: (n, d = 2) => (Number(n) || 0).toLocaleString('pt-BR', { maximumFractionDigits: d }),
        pct: n => (Number(n) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%',
        money: n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
        dt: s => { if (!s) return '—'; const d = new Date(s); return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); },
        time: s => s ? new Date(s).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'
    };

    function toast(msg, kind) {
        let host = document.getElementById('toast-host');
        if (!host) { host = document.createElement('div'); host.id = 'toast-host'; host.className = 'toast-host'; document.body.appendChild(host); }
        const el = document.createElement('div');
        el.className = 'toast' + (kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
        el.textContent = msg;
        host.appendChild(el);
        setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
    }

    // ---------- modal simples ----------
    function openModal(title, bodyHtml, footHtml, opts) {
        closeModal();
        const bg = document.createElement('div');
        bg.className = 'scrim'; bg.id = 'modal-bg';
        bg.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="${opts && opts.width ? 'max-width:' + opts.width : ''}">
            <div class="dlg-h"><b>${esc(title)}</b><button class="dlg-x" type="button" data-close aria-label="Fechar">✕</button></div>
            <div class="dlg-b">${bodyHtml}</div>
            ${footHtml ? `<div class="dlg-f">${footHtml}</div>` : ''}
        </div>`;
        bg.addEventListener('mousedown', e => { if (e.target === bg) closeModal(); });
        bg.querySelector('[data-close]').addEventListener('click', closeModal);
        document.body.appendChild(bg);
        return bg;
    }
    function closeModal() { const m = document.getElementById('modal-bg'); if (m) m.remove(); }

    // ---------- QR Code (biblioteca qrcode-generator carregada pela página) ----------
    // Conteúdo do QR de endereço: TVA1|L|<token>. O prefixo permite ao app saber, ao
    // ler, se é um endereço (L) ou outra coisa, e a versão (1) deixa evoluir o formato.
    const qrPayload = token => 'TVA1|L|' + token;
    function qrMatrix(text) {
        if (!window.qrcode) return null;
        const q = window.qrcode(0, 'M'); q.addData(text); q.make();
        const n = q.getModuleCount(); const rows = [];
        for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(q.isDark(r, c)); rows.push(row); }
        return { n, rows };
    }
    // QR como grade de <span>. O número de colunas depende do tamanho do QR gerado (21, 25, 29...
    // módulos conforme o texto), então a grade é montada aqui e NUNCA com colunas fixas.
    function qrGrid(text, cls, style) {
        const m = qrMatrix(text);
        if (!m) return `<div class="${cls || ''}" style="${style || ''}"><span style="color:#000;font-size:11px;padding:6px">QR indisponível (biblioteca não carregou)</span></div>`;
        return `<div class="${cls || ''}" style="${style || ''};grid-template-columns:repeat(${m.n},1fr)">${m.rows.map(r => r.map(d => `<span style="background:${d ? '#0c1017' : '#fff'}"></span>`).join('')).join('')}</div>`;
    }
    // paleta das ruas (etiquetas, mapa e progresso usam a mesma cor pra mesma rua)
    const RUA_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#a78bfa', '#f472b6', '#22d3ee'];
    const ruaColor = i => RUA_COLORS[((i % RUA_COLORS.length) + RUA_COLORS.length) % RUA_COLORS.length];

    // ---------- paginação (o Supabase devolve no máximo 1.000 linhas por consulta) ----------
    // make(from, to) recebe o intervalo e devolve a consulta já com .range(from, to).
    async function fetchAll(make, pageSize) {
        const size = pageSize || 1000;
        const all = [];
        for (let from = 0; ; from += size) {
            const { data, error } = await make(from, from + size - 1);
            if (error) throw error;
            all.push(...(data || []));
            if (!data || data.length < size) break;
        }
        return all;
    }

    // ---------- autenticação ----------
    // Confere a sessão, carrega o perfil e os armazéns liberados. Se não houver
    // sessão (ou o papel não servir pra esta tela), manda de volta pro login.
    async function requireAuth(allowedRoles) {
        const { data: s } = await sb.auth.getSession();
        if (!s || !s.session) { location.replace('index.html'); return null; }
        const user = s.session.user;
        const cacheKey = 'tv_arm_ctx_' + user.id;
        let profile = null, sites = null;
        try {
            const r = await sb.from('profiles').select('id, name, email, role, active').eq('id', user.id).maybeSingle();
            if (r.error) throw r.error;
            profile = r.data;
            if (profile) {
                const st = await sb.from('sites').select('key, label').eq('warehouse_module', true).order('label');
                if (st.error) throw st.error;
                sites = st.data || [];
                store.set(cacheKey, { profile, sites });
            }
        } catch (e) {
            // Sem sinal: usa o perfil guardado da última vez (o operador não pode ficar
            // fora do app dentro do galpão). A RLS do banco continua mandando de verdade.
            const c = isNetErr(e) ? store.get(cacheKey, null) : null;
            if (!c) {
                if (isNetErr(e)) { document.body.innerHTML = '<div style="padding:30px;text-align:center;color:#8a99ad">Sem sinal e sem dados guardados neste aparelho. Abra o app uma vez com internet.</div>'; return null; }
                location.replace('index.html?erro=perfil'); return null;
            }
            profile = c.profile; sites = c.sites;
        }
        if (!profile) { location.replace('index.html?erro=perfil'); return null; }
        if (!profile.active) { await sb.auth.signOut(); location.replace('index.html?erro=inativo'); return null; }
        if (allowedRoles && !allowedRoles.includes(profile.role)) { location.replace('index.html?erro=papel'); return null; }
        return {
            user, profile, role: profile.role,
            canWrite: WRITE_ROLES.includes(profile.role),
            sites: sites || []
        };
    }
    // Erro de rede (sem sinal / servidor inalcançável), diferente de erro de regra do banco.
    function isNetErr(e) {
        const m = String(e && e.message != null ? e.message : e);
        return (typeof navigator !== 'undefined' && navigator.onLine === false) || /failed to fetch|networkerror|network request failed|load failed|timeout|aborted|fetch/i.test(m);
    }
    async function signOut() { try { await sb.auth.signOut(); } catch (e) { /* segue */ } location.replace('index.html'); }

    function registerSW() {
        if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* PWA é opcional */ });
    }

    // Beep curto (WebAudio) + vibração: feedback de leitura/ação confirmada.
    function beep(ok) {
        try {
            const C = window.AudioContext || window.webkitAudioContext;
            if (C) {
                const ctx = new C(); const o = ctx.createOscillator(); const g = ctx.createGain();
                o.type = 'sine'; o.frequency.value = ok === false ? 220 : 880; g.gain.value = 0.08;
                o.connect(g); g.connect(ctx.destination); o.start(); setTimeout(() => { o.stop(); ctx.close(); }, ok === false ? 260 : 120);
            }
        } catch (e) { /* sem áudio */ }
        try { if (navigator.vibrate) navigator.vibrate(ok === false ? [80, 60, 80] : 40); } catch (e) { /* iOS não vibra */ }
    }

    // Texto digitado -> sem acento/minúsculo (busca tolerante).
    function norm(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

    window.TV = { sb, isNetErr, qrPayload, qrMatrix, qrGrid, RUA_COLORS, ruaColor, esc, uuid, store, fmt, toast, openModal, closeModal, fetchAll, requireAuth, signOut, registerSW, beep, norm,
        ROLE_LABEL, GESTAO_ROLES, CAMPO_ROLES, WRITE_ROLES };
})();
