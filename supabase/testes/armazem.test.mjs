// Testes do módulo Armazém (supabase/armazem.sql) num Postgres local (PGlite).
//
// O que roda: um Supabase simulado (mock_supabase.sql) + o schema.sql REAL +
// o armazem.sql. Depois, cada teste "vira" um usuário (papel authenticated +
// o JWT dele) e tenta o que ele pode e o que ele NÃO pode fazer. Tudo em
// memória, nada toca o Supabase de verdade.
//
// Como rodar (precisa de Node):   cd supabase/testes   &&   npm install   &&   npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

// uuids fixos legíveis
const u = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ADMIN = u(1), SUP = u(2), OP1 = u(3), OP2 = u(4), OP3 = u(5), GESTOR = u(6), OUTRO = u(7), VISIT = u(8);
const SITE = 'VGR_ARMAZEM';

const db = new PGlite();

// Executa SQL como um usuário (papel `authenticated` + JWT com o id dele).
async function as(who, sql, params) {
  const claims = typeof who === 'string' ? { sub: who } : who;
  await db.exec(`set role authenticated`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  try {
    return await db.query(sql, params);
  } catch (e) {
    e.message += `  [SQL: ${String(sql).replace(/\s+/g, ' ').slice(0, 140)}]`;
    throw e;
  } finally {
    await db.exec(`reset role`);
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}
async function fails(who, sql, re, params) {
  try { await as(who, sql, params); } catch (e) {
    assert.match(e.message, re, `erro diferente do esperado: ${e.message}`);
    return;
  }
  assert.fail(`deveria ter falhado: ${sql.slice(0, 90)}`);
}
// Como superusuário (o dono do banco), pra montar cenário.
const su = (sql, params) => db.query(sql, params);

// O schema.sql real assume que o site F_BRICA já foi criado pela tela do app
// (ele só insere as áreas dele). Num banco zerado precisamos criar antes.
const loadSchema = () => read('../schema.sql').split(String.fromCharCode(13)).join('')  // CRLF do Windows -> LF
  .replace('create extension if not exists "pgcrypto";', '')
  .replace(`insert into public.areas (site_key, code, label) values
  ('F_BRICA','ELETRICA'`,
           `insert into public.sites (key, label, company_key) values ('F_BRICA','Fábrica Materiais','SODEXO') on conflict (key) do nothing;
insert into public.areas (site_key, code, label) values
  ('F_BRICA','ELETRICA'`);

const RLS = /row-level security|violates row-level/i;
const ids = {};   // ids criados ao longo dos testes

test('0. instalação: mock + schema.sql real + armazem.sql, e reexecução (idempotência)', async () => {
  await db.exec(read('mock_supabase.sql'));
  await db.exec(loadSchema());
  await db.exec(read('../armazem.sql'));

  // Usuários de teste (profiles exige a linha em auth.users).
  const users = [
    [ADMIN, 'Admin', 'ADMIN'], [SUP, 'Supervisora', 'ARM_SUPERVISOR'],
    [OP1, 'Operador Um', 'ARM_OPERADOR'], [OP2, 'Operador Dois', 'ARM_OPERADOR'],
    [OP3, 'Operador Tres', 'ARM_OPERADOR'], [GESTOR, 'Gestor Vale', 'ARM_GESTOR_VALE'],
  ];
  for (const [id, name, role] of users) {
    await su(`insert into auth.users (id, email) values ($1, $2)`, [id, `${name}@x.com`]);
    await su(`insert into public.profiles (id, name, email, role, company_key) values ($1,$2,$3,$4,'SODEXO')`, [id, name, `${name}@x.com`, role]);
    await su(`insert into public.profile_sites (profile_id, site_key) values ($1, $2)`, [id, SITE]);
  }
  // Usuário de OUTRA empresa e de outro site.
  await su(`insert into public.companies (key, label) values ('OUTRA','Outra')`);
  await su(`insert into public.sites (key, label, company_key, warehouse_module) values ('S_OUT','Outro','OUTRA', true)`);
  await su(`insert into auth.users (id, email) values ($1,'o@x.com')`, [OUTRO]);
  await su(`insert into public.profiles (id, name, email, role, company_key) values ($1,'Outro','o@x.com','ARM_SUPERVISOR','OUTRA')`, [OUTRO]);
  await su(`insert into public.profile_sites (profile_id, site_key) values ($1,'S_OUT')`, [OUTRO]);

  // Reexecutar tudo não pode dar erro nem apagar nada (usuários ARM_* continuam válidos).
  await db.exec(read('../armazem.sql'));
  await db.exec(loadSchema());
  await db.exec(read('../armazem.sql'));
  const r = await su(`select count(*)::int n from public.profiles where role like 'ARM\\_%'`);
  assert.equal(r.rows[0].n, 6);
  const s = await su(`select label, warehouse_module from public.sites where key = $1`, [SITE]);
  assert.equal(s.rows[0].label, 'VGR - Armazém');
  assert.equal(s.rows[0].warehouse_module, true);
});

test('1. endereços: hierarquia, código completo, QR e imutabilidade', async () => {
  const ins = (kind, code, parent, countable = false) => as(SUP,
    `insert into wh_locations (site_key, parent_id, kind, code, is_countable) values ($1,$2,$3,$4,$5) returning id, full_code, qr_token, path`,
    [SITE, parent, kind, code, countable]);
  const arm = (await ins('ARMAZEM', 'VGR', null)).rows[0];
  const rua = (await ins('RUA', 'A', arm.id)).rows[0];
  const pr = (await ins('PRATELEIRA', '01', rua.id)).rows[0];
  const n1 = (await ins('NIVEL', '1', pr.id, true)).rows[0];
  const n2 = (await ins('NIVEL', '2', pr.id, true)).rows[0];
  Object.assign(ids, { arm: arm.id, rua: rua.id, pr: pr.id, n1: n1.id, n2: n2.id, n1tok: n1.qr_token });
  assert.equal(n1.full_code, 'VGR-A-01-1');
  assert.match(n1.qr_token, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.deepEqual(n1.path, [arm.id, rua.id, pr.id, n1.id]);

  await fails(SUP, `insert into wh_locations (site_key, parent_id, kind, code) values ('${SITE}', '${rua.id}', 'RUA', 'X')`, /Hierarquia inválida/);
  await fails(SUP, `insert into wh_locations (site_key, kind, code) values ('${SITE}', 'RUA', 'X')`, /Só o endereço do tipo ARMAZEM/);
  await fails(SUP, `insert into wh_locations (site_key, parent_id, kind, code) values ('${SITE}', '${arm.id}', 'RUA', 'B-2')`, /check/i);
  await fails(SUP, `update wh_locations set code = 'Z' where id = '${n1.id}'`, /não mudam depois de criados/);
  await fails(OP1, `insert into wh_locations (site_key, parent_id, kind, code) values ('${SITE}', '${arm.id}', 'RUA', 'Q')`, RLS);
  // leitura: operador e gestor leem; outra empresa não
  assert.equal((await as(OP1, `select 1 from wh_locations`)).rows.length, 5);
  assert.equal((await as(GESTOR, `select 1 from wh_locations`)).rows.length, 5);
  assert.equal((await as(OUTRO, `select 1 from wh_locations`)).rows.length, 0);
  // Gestor Vale nunca escreve
  await fails(GESTOR, `insert into wh_locations (site_key, parent_id, kind, code) values ('${SITE}', '${arm.id}', 'RUA', 'Q')`, RLS);
  // Visitante (login anônimo) não lê nada do armazém
  const visit = { sub: VISIT, is_anonymous: true, user_metadata: { company_key: 'SODEXO' } };
  assert.equal((await as(visit, `select 1 from wh_locations`)).rows.length, 0);
  assert.equal((await as(visit, `select 1 from wh_items`)).rows.length, 0);
});

test('2. itens e custos: operador lê o catálogo mas NÃO os custos; criticidade automática', async () => {
  await as(SUP, `update wh_site_settings set high_value_threshold = 50 where site_key = $1`, [SITE]);
  const mk = async (code) => (await as(SUP, `insert into wh_items (site_key, code, description) values ($1,$2,$3) returning id`, [SITE, code, 'Item ' + code])).rows[0].id;
  ids.i1 = await mk('I1'); ids.i2 = await mk('I2'); ids.i3 = await mk('I3');
  await as(SUP, `insert into wh_item_costs (item_id, site_key, unit_cost) values ($1,$2,100)`, [ids.i1, SITE]);
  await as(SUP, `insert into wh_item_costs (item_id, site_key, unit_cost) values ($1,$2,10)`, [ids.i2, SITE]);
  const crit = async (id) => (await su(`select criticality from wh_items where id = $1`, [id])).rows[0].criticality;
  assert.equal(await crit(ids.i1), 'ALTO_VALOR');
  assert.equal(await crit(ids.i2), 'NORMAL');
  // custo muda → criticidade e histórico acompanham
  await as(SUP, `update wh_item_costs set unit_cost = 60 where item_id = $1`, [ids.i2]);
  assert.equal(await crit(ids.i2), 'ALTO_VALOR');
  await as(SUP, `update wh_item_costs set unit_cost = 10 where item_id = $1`, [ids.i2]);
  assert.equal(await crit(ids.i2), 'NORMAL');
  assert.equal((await su(`select count(*)::int n from wh_item_cost_history where item_id = $1`, [ids.i2])).rows[0].n, 3);
  // limite do site muda → reclassifica
  await as(SUP, `update wh_site_settings set high_value_threshold = 500 where site_key = $1`, [SITE]);
  assert.equal(await crit(ids.i1), 'NORMAL');
  await as(SUP, `update wh_site_settings set high_value_threshold = 50 where site_key = $1`, [SITE]);
  assert.equal(await crit(ids.i1), 'ALTO_VALOR');

  assert.equal((await as(OP1, `select 1 from wh_items`)).rows.length, 3);
  assert.equal((await as(OP1, `select 1 from wh_item_costs`)).rows.length, 0, 'operador não pode ver custo');
  assert.equal((await as(SUP, `select 1 from wh_item_costs`)).rows.length, 2);
  assert.equal((await as(GESTOR, `select 1 from wh_item_costs`)).rows.length, 2);
  await fails(OP1, `insert into wh_items (site_key, code, description) values ('${SITE}','X','x')`, RLS);

  await as(SUP, `insert into wh_item_barcodes (site_key, item_id, barcode) values ($1,$2,'789000111')`, [SITE, ids.i2]);
  await fails(SUP, `insert into wh_item_barcodes (site_key, item_id, barcode) values ('${SITE}','${ids.i3}','789000111')`, /unique|duplicate/i);
});

test('3. equipes, campanha e atribuição; ativação exige atribuição', async () => {
  const t1 = (await as(SUP, `insert into wh_teams (site_key, name) values ($1,'Equipe 1') returning id`, [SITE])).rows[0].id;
  const t2 = (await as(SUP, `insert into wh_teams (site_key, name) values ($1,'Equipe 2') returning id`, [SITE])).rows[0].id;
  ids.t1 = t1; ids.t2 = t2;
  await as(SUP, `insert into wh_team_members (team_id, site_key, profile_id) values ($1,$2,$3)`, [t1, SITE, OP1]);
  await as(SUP, `insert into wh_team_members (team_id, site_key, profile_id) values ($1,$2,$3)`, [t2, SITE, OP2]);
  ids.camp = (await as(SUP, `insert into wh_campaigns (site_key, name, recount_mode) values ($1,'Inventário inicial','TODAS') returning id`, [SITE])).rows[0].id;

  await fails(SUP, `update wh_campaigns set status = 'ATIVA' where id = '${ids.camp}'`, /Atribua ao menos uma rua/);
  await as(SUP, `insert into wh_campaign_assignments (campaign_id, site_key, location_id, team_id, round) values ($1,$2,$3,$4,1)`, [ids.camp, SITE, ids.rua, t1]);
  await fails(SUP, `insert into wh_campaigns (site_key, name, status) values ('${SITE}','x','ATIVA')`, /nasce como RASCUNHO/);
  await as(SUP, `update wh_campaigns set status = 'ATIVA' where id = $1`, [ids.camp]);
  await fails(SUP, `update wh_campaigns set recount_mode = 'NENHUMA' where id = '${ids.camp}'`, /não podem mudar/);
  await fails(SUP, `update wh_campaigns set status = 'RASCUNHO' where id = '${ids.camp}'`, /inválida/);

  // operador vê só as equipes/atribuições dele
  assert.equal((await as(OP1, `select 1 from wh_teams`)).rows.length, 1);
  assert.equal((await as(OP1, `select 1 from wh_campaign_assignments`)).rows.length, 1);
  assert.equal((await as(OP2, `select 1 from wh_campaign_assignments`)).rows.length, 0);
});

test('3b. lista de pessoas do armazém (para montar equipes) só para supervisor/gestor/admin', async () => {
  const names = r => r.rows.map(x => x.name).sort();
  const sup = await as(SUP, `select * from wh_site_people($1)`, [SITE]);
  assert.deepEqual(names(sup), ['Operador Dois', 'Operador Tres', 'Operador Um', 'Supervisora']);
  assert.ok(sup.rows.every(x => !('email' in x)), 'não vaza e-mail');
  assert.equal((await as(GESTOR, `select * from wh_site_people($1)`, [SITE])).rows.length, 4);
  assert.equal((await as(OP1, `select * from wh_site_people($1)`, [SITE])).rows.length, 0, 'operador não lista colegas');
  assert.equal((await as(OUTRO, `select * from wh_site_people($1)`, [SITE])).rows.length, 0, 'outra empresa não vê');
  // inativo some da lista
  await su(`update public.profiles set active = false where id = $1`, [OP3]);
  assert.equal((await as(SUP, `select * from wh_site_people($1)`, [SITE])).rows.length, 3);
  await su(`update public.profiles set active = true where id = $1`, [OP3]);
});

const ev = (id, loc, item, qty, round = 1, extra = '') =>
  [`insert into wh_count_events (id, site_key, campaign_id, location_id, item_id, qty, round, source ${extra ? ',' + extra.split('=')[0] : ''})
    values ($1,$2,$3,$4,$5,$6,$7,'LEITOR' ${extra ? ',' + extra.split('=')[1] : ''}) on conflict (id) do nothing`,
   [id, SITE, ids.camp, loc, item, qty, round]];
const closure = (id, loc, lines, round = 1) =>
  [`insert into wh_count_closures (id, site_key, campaign_id, location_id, round, line_count) values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing`,
   [id, SITE, ids.camp, loc, round, lines]];

test('4. contagem de campo: atribuição, cegueira, idempotência e anti-spoof', async () => {
  await as(OP1, ...ev(u(101), ids.n1, ids.i2, 5));
  // reenvio (rede caiu): mesmo id → ignorado, sem erro e sem duplicar
  await as(OP1, ...ev(u(101), ids.n1, ids.i2, 5));
  assert.equal((await su(`select count(*)::int n from wh_count_events`)).rows[0].n, 1);

  // outro operador (não atribuído) não conta nessa rua
  await fails(OP2, ev(u(102), ids.n1, ids.i2, 3)[0], /não está atribuído/, ev(u(102), ids.n1, ids.i2, 3)[1]);
  // gestor e visitante não inserem
  await fails(GESTOR, ev(u(103), ids.n1, ids.i2, 3)[0], RLS, ev(u(103), ids.n1, ids.i2, 3)[1]);
  // admin não registra contagem
  await fails(ADMIN, ev(u(104), ids.n1, ids.i2, 3)[0], RLS, ev(u(104), ids.n1, ids.i2, 3)[1]);

  // anti-spoof: operador tenta gravar como se fosse o OP2 → o banco carimba o dele
  await as(OP1, `insert into wh_count_events (id, site_key, campaign_id, location_id, item_id, qty, counted_by, received_at)
                 values ($1,$2,$3,$4,$5,1,$6,'2020-01-01')`, [u(105), SITE, ids.camp, ids.n1, ids.i3, OP2]);
  const sp = (await su(`select counted_by, counted_by_label, received_at > '2024-01-01' as fresh from wh_count_events where id = $1`, [u(105)])).rows[0];
  assert.equal(sp.counted_by, OP1);
  assert.equal(sp.counted_by_label, 'Operador Um');
  assert.equal(sp.fresh, true, 'received_at vem do servidor');

  // cegueira: OP1 vê as próprias; OP2 não vê nada; supervisor e gestor veem tudo
  assert.equal((await as(OP1, `select 1 from wh_count_events`)).rows.length, 2);
  assert.equal((await as(OP2, `select 1 from wh_count_events`)).rows.length, 0);
  assert.equal((await as(SUP, `select 1 from wh_count_events`)).rows.length, 2);
  assert.equal((await as(GESTOR, `select 1 from wh_count_events`)).rows.length, 2);

  // validações de conteúdo
  await fails(OP1, ev(u(106), ids.rua, ids.i2, 1)[0], /não contável/, ev(u(106), ids.rua, ids.i2, 1)[1]);
  await fails(OP1, ev(u(107), ids.n1, ids.i2, -1)[0], /check/i, ev(u(107), ids.n1, ids.i2, -1)[1]);
  await fails(OP1, `insert into wh_count_events (id, site_key, campaign_id, location_id, qty) values ($1,$2,$3,$4,3)`, /check/i, [u(108), SITE, ids.camp, ids.n1]);
  // "endereço vazio" = sem item, qtd 0
  await as(OP1, `insert into wh_count_events (id, site_key, campaign_id, location_id, qty) values ($1,$2,$3,$4,0)`, [u(109), SITE, ids.camp, ids.n2]);
  // (bloqueado por duas regras ao mesmo tempo: "mesma pessoa noutra rodada" e "rodada 1 não finalizada")
  await fails(OP1, ev(u(110), ids.n1, ids.i2, 1, 2)[0], /outra rodada|ainda não foi finalizada/, ev(u(110), ids.n1, ids.i2, 1, 2)[1]);
});

test('5. finalizar endereço: linhas declaradas, recontagem automática e regra "outra pessoa"', async () => {
  // N1 tem 2 linhas do OP1 (I2=5, I3=1)
  await fails(OP1, closure(u(201), ids.n1, 3)[0], /Faltam linhas/, closure(u(201), ids.n1, 3)[1]);
  await as(OP1, ...closure(u(201), ids.n1, 2));
  await as(OP1, ...closure(u(201), ids.n1, 2)); // reenvio ignorado
  assert.equal((await su(`select count(*)::int n from wh_count_closures`)).rows[0].n, 1);
  await fails(OP1, ev(u(111), ids.n1, ids.i2, 1)[0], /já finalizou/, ev(u(111), ids.n1, ids.i2, 1)[1]);

  // modo TODAS → tarefa de recontagem rodada 2 (sem ver valores)
  let tasks = (await su(`select round, reason, status from wh_recount_tasks where location_id = $1`, [ids.n1])).rows;
  assert.deepEqual(tasks, [{ round: 2, reason: 'TODAS', status: 'ABERTA' }]);
  assert.equal((await as(OP2, `select 1 from wh_recount_tasks`)).rows.length, 1, 'tarefa sem equipe definida é visível ao operador');
  assert.equal((await as(OP2, `select 1 from wh_count_events`)).rows.length, 0, 'mas ele não vê a contagem anterior');

  // quem contou na rodada 1 não conta na 2; outro operador pode (sem atribuição de rodada 2 = livre)
  await fails(OP1, ev(u(112), ids.n1, ids.i2, 4, 2)[0], /outra pessoa|outra rodada/, ev(u(112), ids.n1, ids.i2, 4, 2)[1]);
  await as(OP2, ...ev(u(112), ids.n1, ids.i2, 4, 2));   // divergente: 5 x 4
  await as(OP2, ...ev(u(113), ids.n1, ids.i3, 1, 2));
  await as(OP2, ...closure(u(202), ids.n1, 2, 2));
  tasks = (await su(`select round, reason, status from wh_recount_tasks where location_id = $1 order by round`, [ids.n1])).rows;
  assert.deepEqual(tasks, [
    { round: 2, reason: 'TODAS', status: 'CONCLUIDA' },
    { round: 3, reason: 'DIVERGENCIA', status: 'ABERTA' },
  ]);
  // rodada 3: terceira pessoa desempata (I2 = 5, I3 = 1)
  await as(OP3, ...ev(u(114), ids.n1, ids.i2, 5, 3));
  await as(OP3, ...ev(u(115), ids.n1, ids.i3, 1, 3));
  await as(OP3, ...closure(u(203), ids.n1, 2, 3));
  assert.equal((await su(`select count(*)::int n from wh_recount_tasks where round = 4 or status = 'ABERTA'`)).rows[0].n, 0, 'não existe 4ª rodada');
  // recontagem só se foi pedida
  await fails(OP2, ev(u(116), ids.n2, ids.i2, 1, 2)[0], /rodada 1 deste endereço ainda não foi finalizada/, ev(u(116), ids.n2, ids.i2, 1, 2)[1]);
});

test('6. consolidação, decisão do supervisor e "onde está o item"', async () => {
  const rows = (await as(SUP, `select item_code, r1, r2, r3, status from v_wh_count_consolidated where location_code = 'VGR-A-01-1' order by item_code`)).rows;
  assert.deepEqual(rows.map(r => [r.item_code, Number(r.r1), Number(r.r2), Number(r.r3), r.status]),
    [['I2', 5, 4, 5, 'CONFERE'], ['I3', 1, 1, 1, 'CONFERE']]);

  // decisão: valor precisa bater com a rodada escolhida
  const dec = (item, qty, how, reason = null) => as(SUP,
    `insert into wh_count_decisions (site_key, campaign_id, location_id, item_id, final_qty, decision, reason, decided_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [SITE, ids.camp, ids.n1, item, qty, how, reason, SUP]);
  await assert.rejects(dec(ids.i2, 4, 'APROVAR_R3'), /não bate com a contagem da rodada 3/);
  await assert.rejects(dec(ids.i2, 9, 'AJUSTE_MANUAL'), /check/i);                // sem justificativa
  await dec(ids.i2, 5, 'APROVAR_R3');
  await dec(ids.i3, 1, 'APROVAR_R3');
  await assert.rejects(as(OP1, `insert into wh_count_decisions (site_key, campaign_id, location_id, item_id, final_qty, decision, decided_by) values ($1,$2,$3,$4,5,'APROVAR_R1',$5)`,
    [SITE, ids.camp, ids.n1, ids.i2, OP1]), RLS);
  await assert.rejects(as(GESTOR, `insert into wh_count_decisions (site_key, campaign_id, location_id, item_id, final_qty, decision, decided_by) values ($1,$2,$3,$4,5,'APROVAR_R1',$5)`,
    [SITE, ids.camp, ids.n1, ids.i2, GESTOR]), RLS);
  const st = (await as(GESTOR, `select distinct status from v_wh_count_consolidated where location_code = 'VGR-A-01-1'`)).rows;
  assert.deepEqual(st, [{ status: 'APROVADO' }]);

  const where = (await as(GESTOR, `select item_code, location_code, final_qty from v_wh_item_whereabouts order by item_code`)).rows;
  assert.deepEqual(where.map(r => [r.item_code, r.location_code, Number(r.final_qty)]), [['I2', 'VGR-A-01-1', 5], ['I3', 'VGR-A-01-1', 1]]);
  // operador não enxerga decisões
  assert.equal((await as(OP1, `select 1 from wh_count_decisions`)).rows.length, 0);
});

test('7. item crítico/alto valor: dupla conferência obrigatória', async () => {
  // N2: OP1 conta o item I1 (ALTO_VALOR) na rodada 1 → já nasce tarefa de rodada 2 mesmo sem divergência
  const camp2 = (await as(SUP, `insert into wh_campaigns (site_key, name, recount_mode) values ($1,'Campanha crítica','NENHUMA') returning id`, [SITE])).rows[0].id;
  await as(SUP, `insert into wh_campaign_assignments (campaign_id, site_key, location_id, team_id, round) values ($1,$2,$3,$4,1)`, [camp2, SITE, ids.rua, ids.t1]);
  await as(SUP, `update wh_campaigns set status = 'ATIVA' where id = $1`, [camp2]);
  const e = (id, round) => as(round === 1 ? OP1 : OP2, `insert into wh_count_events (id, site_key, campaign_id, location_id, item_id, qty, round) values ($1,$2,$3,$4,$5,2,$6)`, [id, SITE, camp2, ids.n2, ids.i1, round]);
  const c = (id, round) => as(round === 1 ? OP1 : OP2, `insert into wh_count_closures (id, site_key, campaign_id, location_id, round, line_count) values ($1,$2,$3,$4,$5,1)`, [id, SITE, camp2, ids.n2, round]);
  await e(u(301), 1); await c(u(302), 1);
  const t = (await su(`select round, reason from wh_recount_tasks where campaign_id = $1`, [camp2])).rows;
  assert.deepEqual(t, [{ round: 2, reason: 'ITEM_CRITICO' }]);
  const dec = () => as(SUP, `insert into wh_count_decisions (site_key, campaign_id, location_id, item_id, final_qty, decision, decided_by) values ($1,$2,$3,$4,2,'APROVAR_R1',$5)`, [SITE, camp2, ids.n2, ids.i1, SUP]);
  await assert.rejects(dec(), /dupla conferência/);
  await assert.rejects(as(SUP, `update wh_campaigns set status = 'FECHADA' where id = $1`, [camp2]), /recontagens pendentes/);
  await e(u(303), 2); await c(u(304), 2);
  await dec();                                            // agora com duas pessoas, pode
  await as(SUP, `update wh_campaigns set status = 'FECHADA' where id = $1`, [camp2]);
  // campanha fechada não aceita mais contagem nem mudança
  await assert.rejects(as(OP1, `insert into wh_count_events (id, site_key, campaign_id, location_id, item_id, qty, round) values ($1,$2,$3,$4,$5,1,1)`, [u(305), SITE, camp2, ids.n2, ids.i2]), /não está ativa/);
  await assert.rejects(as(SUP, `update wh_campaigns set name = 'x' where id = $1`, [camp2]), /FECHADA/);
});

test('8. saldo esperado: operador não vê (contagem cega); recontagem por divergência com o esperado', async () => {
  const camp3 = (await as(SUP, `insert into wh_campaigns (site_key, name, recount_mode) values ($1,'Cíclica','DIVERGENCIA') returning id`, [SITE])).rows[0].id;
  await as(SUP, `insert into wh_campaign_assignments (campaign_id, site_key, location_id, team_id, round) values ($1,$2,$3,$4,1)`, [camp3, SITE, ids.rua, ids.t1]);
  await as(SUP, `insert into wh_expected_stock (campaign_id, site_key, location_id, item_id, qty_expected) values ($1,$2,$3,$4,10)`, [camp3, SITE, ids.n2, ids.i2]);
  await as(SUP, `update wh_campaigns set status = 'ATIVA' where id = $1`, [camp3]);
  assert.equal((await as(OP1, `select 1 from wh_expected_stock`)).rows.length, 0);
  assert.equal((await as(GESTOR, `select 1 from wh_expected_stock`)).rows.length, 1);
  await assert.rejects(as(OP1, `insert into wh_expected_stock (campaign_id, site_key, location_id, item_id, qty_expected) values ($1,$2,$3,$4,1)`, [camp3, SITE, ids.n2, ids.i3]), RLS);
  await assert.rejects(as(GESTOR, `insert into wh_expected_stock (campaign_id, site_key, location_id, item_id, qty_expected) values ($1,$2,$3,$4,1)`, [camp3, SITE, ids.n2, ids.i3]), RLS);

  await as(OP1, `insert into wh_count_events (id, site_key, campaign_id, location_id, item_id, qty) values ($1,$2,$3,$4,$5,7)`, [u(401), SITE, camp3, ids.n2, ids.i2]);
  await as(OP1, `insert into wh_count_closures (id, site_key, campaign_id, location_id, round, line_count) values ($1,$2,$3,$4,1,1)`, [u(402), SITE, camp3, ids.n2]);
  const t = (await su(`select round, reason from wh_recount_tasks where campaign_id = $1`, [camp3])).rows;
  assert.deepEqual(t, [{ round: 2, reason: 'DIVERGENCIA_ESPERADO' }]);
});

test('9. progresso por rua e itens não identificados', async () => {
  // campanha 1: N1 finalizado; N2 ainda não (só o marcador "vazio" sem finalizar)
  const p = (await as(SUP, `select assigned_code, total_addresses::int t, counted_addresses::int c, pct_done from v_wh_campaign_progress where campaign_id = $1`, [ids.camp])).rows[0];
  assert.deepEqual([p.assigned_code, p.t, p.c, Number(p.pct_done)], ['VGR-A', 2, 1, 50]);
  await as(OP1, ...closure(u(210), ids.n2, 1));
  const p2 = (await as(SUP, `select pct_done from v_wh_campaign_progress where campaign_id = $1`, [ids.camp])).rows[0];
  assert.equal(Number(p2.pct_done), 100);

  // item sem etiqueta: precisa de foto
  const camp4 = (await as(SUP, `insert into wh_campaigns (site_key, name, recount_mode) values ($1,'Sem etiqueta','NENHUMA') returning id`, [SITE])).rows[0].id;
  await as(SUP, `insert into wh_campaign_assignments (campaign_id, site_key, location_id, team_id, round) values ($1,$2,$3,$4,1)`, [camp4, SITE, ids.rua, ids.t1]);
  await as(SUP, `update wh_campaigns set status = 'ATIVA' where id = $1`, [camp4]);
  await assert.rejects(as(OP1, `insert into wh_unidentified_items (id, site_key, campaign_id, location_id, photo_paths, qty) values ($1,$2,$3,$4,'{}',2)`, [u(501), SITE, camp4, ids.n1]), /check/i);
  await as(OP1, `insert into wh_unidentified_items (id, site_key, campaign_id, location_id, photo_paths, description, qty) values ($1,$2,$3,$4,$5,'caixa azul',2)`,
    [u(501), SITE, camp4, ids.n1, [`${SITE}/${camp4}/${u(501)}.jpg`]]);
  await as(OP1, `insert into wh_count_events (id, site_key, campaign_id, location_id, unidentified_id, qty) values ($1,$2,$3,$4,$5,2)`, [u(502), SITE, camp4, ids.n1, u(501)]);
  assert.equal((await as(OP2, `select 1 from wh_unidentified_items`)).rows.length, 0);
  assert.equal((await as(SUP, `select 1 from wh_unidentified_items`)).rows.length, 1);
  assert.equal((await as(OP1, `update wh_unidentified_items set status = 'DESCARTADO' where id = $1`, [u(501)])).affectedRows, 0, 'operador não resolve item não identificado');
  await assert.rejects(as(SUP, `update wh_unidentified_items set status = 'IDENTIFICADO' where id = $1`, [u(501)]), /qual item do catálogo/);
  await as(SUP, `update wh_unidentified_items set status = 'IDENTIFICADO', resolved_item_id = $2 where id = $1`, [u(501), ids.i3]);
  await assert.rejects(as(SUP, `update wh_unidentified_items set qty = 99 where id = $1`, [u(501)]), /só o status/);
});

test('10. fotos (Storage): bucket privado, pasta = site', async () => {
  const b = (await su(`select public from storage.buckets where id = 'warehouse-photos'`)).rows[0];
  assert.equal(b.public, false);
  const put = (who, name) => as(who, `insert into storage.objects (bucket_id, name) values ('warehouse-photos', $1)`, [name]);
  await put(OP1, `${SITE}/camp/foto1.jpg`);
  await assert.rejects(put(OP1, `S_OUT/camp/foto2.jpg`), RLS);          // outro site
  await assert.rejects(put(GESTOR, `${SITE}/camp/foto3.jpg`), RLS);      // gestor não envia
  assert.equal((await as(OP1, `select 1 from storage.objects`)).rows.length, 1);   // dono vê a própria
  assert.equal((await as(OP2, `select 1 from storage.objects`)).rows.length, 0);   // outro operador não
  assert.equal((await as(SUP, `select 1 from storage.objects`)).rows.length, 1);
  assert.equal((await as(GESTOR, `select 1 from storage.objects`)).rows.length, 1);
  assert.equal((await as(OUTRO, `select 1 from storage.objects`)).rows.length, 0);
  // sem política de update/delete: foto é evidência
  await as(SUP, `delete from storage.objects`);
  assert.equal((await su(`select count(*)::int n from storage.objects`)).rows[0].n, 1);
});

test('11. isolamento entre empresas e sites', async () => {
  for (const t of ['wh_locations', 'wh_items', 'wh_campaigns', 'wh_count_events', 'wh_count_closures', 'wh_count_decisions', 'wh_audit_log', 'wh_teams']) {
    assert.equal((await as(OUTRO, `select 1 from ${t}`)).rows.length, 0, `OUTRO enxergou ${t}`);
  }
  await assert.rejects(as(OUTRO, `insert into wh_items (site_key, code, description) values ('${SITE}','Z','z')`), RLS);
  await assert.rejects(as(OUTRO, `insert into wh_locations (site_key, kind, code) values ('${SITE}','ARMAZEM','Z')`), RLS);
});

test('12. imutabilidade e trilha de auditoria', async () => {
  // nem o dono do banco altera/apaga evidência com SQL comum
  for (const t of ['wh_count_events', 'wh_count_closures', 'wh_count_decisions', 'wh_audit_log']) {
    await assert.rejects(su(`update ${t} set site_key = site_key`), /imutável/);
    await assert.rejects(su(`delete from ${t}`), /imutável/);
    await assert.rejects(su(`truncate ${t} cascade`), /imutável/);
  }
  // usuários: sem política de update/delete → 0 linhas afetadas, e o valor não muda
  const upd = await as(SUP, `update wh_count_events set qty = 999`);
  assert.equal(upd.affectedRows, 0);
  const del = await as(SUP, `delete from wh_count_events`);
  assert.equal(del.affectedRows, 0);

  // log de auditoria: registrou quem fez o quê; só supervisor/gestor/admin leem
  const log = (await as(SUP, `select action, table_name, actor_label from wh_audit_log where table_name = 'wh_campaigns' and action = 'UPDATE' order by at limit 1`)).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_label, 'Supervisora');
  assert.equal((await as(OP1, `select 1 from wh_audit_log`)).rows.length, 0);
  assert.ok((await as(GESTOR, `select 1 from wh_audit_log`)).rows.length > 10);
});

test('13. cadeia de hashes: envio em lote, verificação e detecção de adulteração', async () => {
  // lote de 3 linhas num único INSERT (como o app faz ao sincronizar)
  const camp5 = (await as(SUP, `insert into wh_campaigns (site_key, name, recount_mode) values ($1,'Lote','NENHUMA') returning id`, [SITE])).rows[0].id;
  await as(SUP, `insert into wh_campaign_assignments (campaign_id, site_key, location_id, team_id, round) values ($1,$2,$3,$4,1)`, [camp5, SITE, ids.rua, ids.t1]);
  await as(SUP, `update wh_campaigns set status = 'ATIVA' where id = $1`, [camp5]);
  await as(OP1, `insert into wh_count_events (id, site_key, campaign_id, location_id, item_id, qty) values
      ($1,$2,$3,$4,$5,1), ($6,$2,$3,$4,$7,2), ($8,$2,$3,$4,$9,3) on conflict (id) do nothing`,
    [u(601), SITE, camp5, ids.n1, ids.i1, u(602), ids.i2, u(603), ids.i3]);

  for (const t of ['wh_count_events', 'wh_count_closures', 'wh_count_decisions', 'wh_audit_log']) {
    const r = (await as(SUP, `select * from wh_verify_chain($1, $2)`, [SITE, t])).rows[0];
    assert.equal(r.ok, true, `${t}: ${r.detail}`);
    assert.ok(Number(r.rows_checked) > 0);
  }
  await assert.rejects(as(OP1, `select * from wh_verify_chain('${SITE}', 'wh_count_events')`), /Sem permissão/);
  await assert.rejects(as(SUP, `select * from wh_verify_chain('${SITE}', 'profiles')`), /não encadeada/);

  // adulteração por baixo dos panos (desligando o trigger, só o dono do banco consegue)
  await su(`alter table wh_count_events disable trigger trg_wh_immutable`);
  await su(`update wh_count_events set qty = 777 where id = $1`, [u(101)]);
  await su(`alter table wh_count_events enable trigger trg_wh_immutable`);
  const bad = (await as(SUP, `select * from wh_verify_chain($1, 'wh_count_events')`, [SITE])).rows[0];
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /alterado/);

  // apagar uma linha do meio também quebra o elo
  await su(`alter table wh_count_events disable trigger trg_wh_immutable`);
  await su(`update wh_count_events set qty = 5 where id = $1`, [u(101)]);   // desfaz a adulteração anterior
  await su(`delete from wh_count_events where id = $1`, [u(105)]);
  await su(`alter table wh_count_events enable trigger trg_wh_immutable`);
  const gap = (await as(SUP, `select * from wh_verify_chain($1, 'wh_count_events')`, [SITE])).rows[0];
  assert.equal(gap.ok, false);
});

test('14. site de teste: criar, usar e limpar por completo sem tocar no site real', async () => {
  const T = 'VGR_TESTE';
  await db.exec(read('../teste_criar_site.sql'));
  await db.exec(read('../teste_criar_site.sql'));            // idempotente
  for (const id of [SUP, OP1]) await su(`insert into public.profile_sites (profile_id, site_key) values ($1, $2) on conflict do nothing`, [id, T]);

  // mini inventário no site de teste
  const loc = async (kind, code, parent, cnt) => (await as(SUP, `insert into wh_locations (site_key, parent_id, kind, code, is_countable) values ($1,$2,$3,$4,$5) returning id`, [T, parent, kind, code, cnt])).rows[0].id;
  const arm = await loc('ARMAZEM', 'TST', null, false), rua = await loc('RUA', 'A', arm, false), pr = await loc('PRATELEIRA', '01', rua, false), nv = await loc('NIVEL', '1', pr, true);
  const it = (await as(SUP, `insert into wh_items (site_key, code, description) values ($1,'T1','Item teste') returning id`, [T])).rows[0].id;
  await as(SUP, `insert into wh_item_costs (item_id, site_key, unit_cost) values ($1,$2,10)`, [it, T]);
  const team = (await as(SUP, `insert into wh_teams (site_key, name) values ($1,'Eq teste') returning id`, [T])).rows[0].id;
  await as(SUP, `insert into wh_team_members (team_id, site_key, profile_id) values ($1,$2,$3)`, [team, T, OP1]);
  const camp = (await as(SUP, `insert into wh_campaigns (site_key, name, recount_mode) values ($1,'Camp teste','NENHUMA') returning id`, [T])).rows[0].id;
  await as(SUP, `insert into wh_campaign_assignments (campaign_id, site_key, location_id, team_id, round) values ($1,$2,$3,$4,1)`, [camp, T, rua, team]);
  await as(SUP, `update wh_campaigns set status = 'ATIVA' where id = $1`, [camp]);
  await as(OP1, `insert into wh_count_events (id, site_key, campaign_id, location_id, item_id, qty) values ($1,$2,$3,$4,$5,3)`, [u(9001), T, camp, nv, it]);
  await as(OP1, `insert into wh_count_closures (id, site_key, campaign_id, location_id, round, line_count) values ($1,$2,$3,$4,1,1)`, [u(9002), T, camp, nv]);
  await as(SUP, `insert into wh_count_decisions (site_key, campaign_id, location_id, item_id, final_qty, decision, decided_by) values ($1,$2,$3,$4,3,'APROVAR_R1',$5)`, [T, camp, nv, it, SUP]);

  // o apagar "normal" é barrado (a contagem é evidência)
  await assert.rejects(su(`delete from wh_campaigns where id = $1`, [camp]));
  const antesReal = (await su(`select count(*)::int n from wh_count_events where site_key = $1`, [SITE])).rows[0].n;
  assert.ok(antesReal > 0);

  // o script de limpeza RECUSA o site real
  const script = read('../teste_limpar_site.sql');
  await assert.rejects(db.exec(script.replace("v_site text := 'VGR_TESTE'", "v_site text := 'VGR_ARMAZEM'")), /Recusado/);
  // e recusa site inexistente
  await assert.rejects(db.exec(script.replace("v_site text := 'VGR_TESTE'", "v_site text := 'NAO_EXISTE'")), /não existe/);

  // limpa o site de teste
  await db.exec(script);
  for (const t of ['wh_count_events', 'wh_count_closures', 'wh_count_decisions', 'wh_campaigns', 'wh_campaign_assignments', 'wh_teams', 'wh_team_members', 'wh_items', 'wh_item_costs', 'wh_item_cost_history', 'wh_locations', 'wh_audit_log']) {
    assert.equal((await su(`select count(*)::int n from ${t} where site_key = $1`, [T])).rows[0].n, 0, `${t} não ficou vazio`);
  }
  // o site real não foi tocado
  assert.equal((await su(`select count(*)::int n from wh_count_events where site_key = $1`, [SITE])).rows[0].n, antesReal);
  // triggers voltaram a valer: imutabilidade e auditoria
  await su(`update wh_site_settings set updated_at = now() where site_key = $1`, [T]);
  const aud = (await su(`select count(*)::int n from wh_audit_log where site_key = $1`, [T])).rows[0].n;
  assert.equal(aud, 1, 'auditoria religada');
  // novo uso do site limpo começa cadeia nova e funciona
  const camp2 = (await as(SUP, `insert into wh_campaigns (site_key, name) values ($1,'Depois da limpeza') returning id`, [T])).rows[0].id;
  assert.ok(camp2);
  const v2 = (await as(SUP, `select * from wh_verify_chain($1, 'wh_audit_log')`, [T])).rows[0];
  assert.equal(v2.ok, true);
  await su(`insert into wh_audit_log (site_key, table_name, action) values ($1,'x','INSERT')`, [T]);
  await assert.rejects(su(`update wh_audit_log set action = 'DELETE' where site_key = $1`, [T]), /imutável/);
});

test('15. remover o site de teste de vez (v_remover_site) sem afetar usuários nem o site real', async () => {
  const T = 'VGR_TESTE';
  await db.exec(read('../teste_criar_site.sql'));
  await su(`insert into public.profile_sites (profile_id, site_key) values ($1, $2) on conflict do nothing`, [SUP, T]);
  const rua = (await as(SUP, `insert into wh_locations (site_key, kind, code) values ($1,'ARMAZEM','XYZ') returning id`, [T])).rows[0].id;
  assert.ok(rua);
  const script = read('../teste_limpar_site.sql');
  await db.exec(script.replace('v_remover_site boolean := false;', 'v_remover_site boolean := true;'));
  assert.equal((await su(`select count(*)::int n from public.sites where key = $1`, [T])).rows[0].n, 0, 'site removido');
  assert.equal((await su(`select count(*)::int n from public.profile_sites where site_key = $1`, [T])).rows[0].n, 0, 'vínculos removidos');
  assert.equal((await su(`select count(*)::int n from public.wh_site_settings where site_key = $1`, [T])).rows[0].n, 0);
  assert.equal((await su(`select count(*)::int n from public.profiles where id = $1`, [SUP])).rows[0].n, 1, 'usuário continua existindo');
  assert.equal((await su(`select count(*)::int n from public.sites where key = $1`, [SITE])).rows[0].n, 1, 'site real intacto');
  // o site real continua acessível ao supervisor
  assert.ok((await as(SUP, `select 1 from wh_locations`)).rows.length > 0);
  // os triggers voltaram a valer
  await assert.rejects(su(`update wh_count_events set qty = qty`), /imutável/);
  // e dá para recriar o site de teste depois
  await db.exec(read('../teste_criar_site.sql'));
  assert.equal((await su(`select count(*)::int n from public.sites where key = $1`, [T])).rows[0].n, 1);
});

test('16. foto do item (catálogo): supervisor/admin enviam, operador lê, gestor e outro site não', async () => {
  const put = (who, name) => as(who, `insert into storage.objects (bucket_id, name) values ('warehouse-photos', $1)`, [name]);
  const seen = who => as(who, `select name from storage.objects where name like '%/catalogo/%'`).then(r => r.rows.length);
  await put(SUP, `${SITE}/catalogo/item1-1.jpg`);
  await put(ADMIN, `${SITE}/catalogo/item2-1.jpg`);
  await assert.rejects(put(OP1, `${SITE}/catalogo/item3-1.jpg`), RLS, 'OP1');      // operador não envia foto de catálogo
  await assert.rejects(put(GESTOR, `${SITE}/catalogo/item3-1.jpg`), RLS, 'GESTOR');   // gestor Vale não escreve
  await assert.rejects(put(OUTRO, `${SITE}/catalogo/item3-1.jpg`), RLS, 'OUTRO');    // outro site
  assert.equal(await seen(OP1), 2);                                         // operador enxerga todas do catálogo
  assert.equal(await seen(OP2), 2);
  assert.equal(await seen(GESTOR), 2);
  assert.equal(await seen(OUTRO), 0);
  // a coluna existe e o operador a lê junto com o catálogo
  await su(`update wh_items set photo_path = '${SITE}/catalogo/item1-1.jpg' where id = (select id from wh_items where site_key = '${SITE}' limit 1)`);
  assert.ok((await as(OP1, `select photo_path from wh_items where photo_path is not null`)).rows.length >= 1);
});
