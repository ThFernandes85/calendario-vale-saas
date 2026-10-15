-- ============================================================
-- TerraVia Ops — módulo ARMAZÉM (inventário e controle de estoque)
-- Cole este script INTEIRO no SQL Editor do Supabase e clique em "Run".
--
-- PRÉ-REQUISITO: o supabase/schema.sql já precisa ter sido rodado antes
-- (este módulo usa as tabelas `sites`, `profiles`, `profile_sites` e as
-- funções has_site_access(), is_admin(), current_role_key() que ele cria).
--
-- Este script é SEGURO de rodar quantas vezes precisar: só cria o que ainda
-- não existe e nunca apaga tabelas nem dados. Todas as tabelas novas têm o
-- prefixo `wh_` (de "warehouse") pra não se misturar com `bookings`,
-- `equipment` etc.
--
-- COMO O MÓDULO PROTEGE OS DADOS (resumo didático)
--   1. Todo dado carrega `site_key`, e toda política passa por
--      has_site_access() -- o mesmo mecanismo de empresa/site do resto do app.
--   2. Além do site, TODA política confere o PAPEL (role) do usuário. Isso é
--      proposital: has_site_access() também libera o Visitante (login
--      anônimo) pra ler sites da empresa, e o Visitante não pode ler nada
--      do armazém. Quem não tem papel ARM_* (ou ADMIN) não enxerga nem uma linha.
--   3. A contagem é SEMPRE cega, e isso é garantido pelo banco, não pela
--      tela: o operador só consegue ler as PRÓPRIAS contagens e não tem
--      nenhuma política de leitura sobre o saldo esperado (wh_expected_stock)
--      nem sobre custos (wh_item_costs).
--   4. Contagens, finalizações de endereço, decisões do supervisor e o log
--      de auditoria são IMUTÁVEIS: não existe UPDATE nem DELETE (um trigger
--      bloqueia até pra quem tem acesso administrativo comum). Correção =
--      novo lançamento. Cada linha também entra numa CADEIA DE HASHES
--      (prev_hash/row_hash): se alguém alterar uma linha antiga por baixo
--      dos panos, wh_verify_chain() acusa onde a cadeia quebrou. Isso
--      DETECTA adulteração (não a impede pra quem é dono do banco).
--
-- PAPÉIS NOVOS (profiles.role)
--   ARM_OPERADOR     operador Sodexo: bipa/conta; lê só as próprias contagens
--   ARM_SUPERVISOR   supervisor Sodexo: cadastra, atribui, aprova, vê tudo
--   ARM_GESTOR_VALE  gestor Vale: SOMENTE leitura de tudo do site
--   (ADMIN, que já existe, administra; mas não registra contagens.)
-- ============================================================

-- ============================================================
-- 1. PAPÉIS NOVOS + FLAG DO SITE + SITE "VGR - Armazém"
-- ============================================================
-- A lista de papéis vive em dois arquivos (aqui e no schema.sql) porque o
-- schema.sql recria essa regra inteira a cada execução. Se mexer num, mexa
-- nos dois, senão rodar um deles quebra os usuários do outro.
do $$
begin
  if exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where c.conname = 'profiles_role_check' and t.relname = 'profiles'
  ) then
    alter table public.profiles drop constraint profiles_role_check;
  end if;
  alter table public.profiles add constraint profiles_role_check
    check (role in ('ADMIN','PCM','PCO','PCM_PCO','ENG_CONF','ENG_EST','ENCARREGADO','CLIENTE_VALE','TECNICO_PLANEJAMENTO','GERENTE','TECNICO_CAMPO_VALE','SOLICITANTE_PORTARIA','APROVADOR_PORTARIA','PORTARIA','TECNICO_MANUTENCAO','TECNICO_OPERACAO','ARM_OPERADOR','ARM_SUPERVISOR','ARM_GESTOR_VALE'));
end $$;

-- Checkbox independente (igual correias_panel): liga o módulo de armazém
-- num site, sem ser mais um "tipo de site" exclusivo.
alter table public.sites add column if not exists warehouse_module boolean not null default false;

insert into public.sites (key, label, company_key, warehouse_module)
values ('VGR_ARMAZEM', 'VGR - Armazém', 'SODEXO', true)
on conflict (key) do update set warehouse_module = true;

-- ============================================================
-- 2. FUNÇÕES DE PERMISSÃO (usadas em todas as políticas abaixo)
-- Todas conferem o site (has_site_access) E o papel. `security definer` +
-- search_path fixo = padrão seguro do Supabase pra funções que leem tabelas
-- que o usuário comum não pode ler.
-- ============================================================
-- Qualquer papel do armazém (inclusive operador) com acesso ao site.
create or replace function public.wh_site_reader(p_site text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.has_site_access(p_site)
     and coalesce(public.current_role_key() in ('ARM_OPERADOR','ARM_SUPERVISOR','ARM_GESTOR_VALE','ADMIN'), false);
$$;

-- Quem enxerga TUDO do site (nunca o operador).
create or replace function public.wh_site_viewer_all(p_site text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.has_site_access(p_site)
     and coalesce(public.current_role_key() in ('ARM_SUPERVISOR','ARM_GESTOR_VALE','ADMIN'), false);
$$;

-- Quem cadastra, atribui, aprova (Gestor Vale nunca escreve).
create or replace function public.wh_site_supervisor(p_site text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.has_site_access(p_site)
     and coalesce(public.current_role_key() in ('ARM_SUPERVISOR','ADMIN'), false);
$$;

-- Quem registra contagens. ADMIN fica de fora de propósito: quem administra
-- o sistema não fabrica contagem.
create or replace function public.wh_site_counter(p_site text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.has_site_access(p_site)
     and coalesce(public.current_role_key() in ('ARM_OPERADOR','ARM_SUPERVISOR'), false);
$$;

-- Quem trabalha neste armazém (pra montar equipes). A política padrão de
-- `profiles` só deixa cada um ver o PRÓPRIO perfil (ou o Admin ver todos), então
-- o supervisor não conseguiria listar os operadores. Em vez de abrir `profiles`
-- pra todo mundo, esta função devolve SÓ nome e papel de operadores/supervisores
-- ativos que têm acesso ao armazém -- e só pra quem enxerga tudo do site.
create or replace function public.wh_site_people(p_site text)
returns table (id uuid, name text, role text)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.name, p.role
  from public.profiles p
  join public.profile_sites ps on ps.profile_id = p.id and ps.site_key = p_site
  where public.wh_site_viewer_all(p_site)
    and p.active
    and p.role in ('ARM_OPERADOR', 'ARM_SUPERVISOR')
    and p.company_key = public.my_company()
  order by p.name;
$$;

-- ============================================================
-- 3. TRIGGERS GENÉRICOS (imutabilidade, auditoria, cadeia de hashes)
-- ============================================================
-- Bloqueia UPDATE/DELETE/TRUNCATE. Aplicado nas tabelas de evidência.
create or replace function public.wh_block_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'Registro imutável: % em %.% não é permitido. Para corrigir, crie um novo lançamento (estorno ou nova decisão).',
    tg_op, tg_table_schema, tg_table_name using errcode = 'WH001';
end;
$$;

-- Cadeia de hashes. Roda por último (o nome começa com "zz_" de propósito:
-- o Postgres dispara triggers do mesmo evento em ordem alfabética, e o hash
-- precisa ser calculado depois de todo o resto ter mexido na linha).
-- Cada site tem sua própria cadeia por tabela. O lock (pg_advisory_xact_lock)
-- faz dois envios simultâneos entrarem na cadeia um de cada vez.
--
-- REGRA PRA FUTURAS COLUNAS: colunas novas nas tabelas encadeadas precisam
-- ser NULLABLE. O hash ignora campos nulos (jsonb_strip_nulls), então
-- adicionar uma coluna nova não invalida os hashes das linhas antigas.
create sequence if not exists public.wh_chain_seq;

create or replace function public.wh_chain_before_insert()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
set timezone = 'UTC' as $$
declare
  v_prev text;
begin
  perform pg_advisory_xact_lock(hashtextextended('wh_chain:' || tg_table_name || ':' || new.site_key, 0));
  execute format('select row_hash from public.%I where site_key = $1 order by chain_seq desc limit 1', tg_table_name)
    into v_prev using new.site_key;
  new.chain_seq := nextval('public.wh_chain_seq');
  new.prev_hash := coalesce(v_prev, 'GENESIS');
  new.row_hash := null;
  new.row_hash := encode(sha256(convert_to(jsonb_strip_nulls(to_jsonb(new) - 'row_hash')::text, 'UTF8')), 'hex');
  return new;
end;
$$;

-- Conferência da cadeia: devolve ok=true se nenhuma linha foi alterada ou
-- removida do meio. Só Supervisor, Gestor Vale e Admin podem rodar.
-- Uso:  select * from wh_verify_chain('VGR_ARMAZEM', 'wh_count_events');
create or replace function public.wh_verify_chain(p_site text, p_table text)
returns table (ok boolean, rows_checked bigint, first_bad_seq bigint, detail text)
language plpgsql stable security definer
set search_path = public, pg_temp
set timezone = 'UTC' as $$
declare
  r record;
  v_prev text := 'GENESIS';
  v_count bigint := 0;
  v_calc text;
begin
  if p_table not in ('wh_count_events','wh_count_closures','wh_count_decisions','wh_audit_log') then
    raise exception 'Tabela não encadeada: %', p_table;
  end if;
  if not public.wh_site_viewer_all(p_site) then
    raise exception 'Sem permissão para verificar a trilha deste site.';
  end if;
  for r in execute format('select to_jsonb(t) as j, t.chain_seq, t.prev_hash, t.row_hash from public.%I t where t.site_key = $1 order by t.chain_seq', p_table) using p_site loop
    v_count := v_count + 1;
    if r.prev_hash is distinct from v_prev then
      return query select false, v_count, r.chain_seq, 'Elo quebrado: uma linha anterior foi removida ou alterada.'::text;
      return;
    end if;
    v_calc := encode(sha256(convert_to(jsonb_strip_nulls(r.j - 'row_hash')::text, 'UTF8')), 'hex');
    if v_calc is distinct from r.row_hash then
      return query select false, v_count, r.chain_seq, 'Conteúdo da linha foi alterado depois de gravado.'::text;
      return;
    end if;
    v_prev := r.row_hash;
  end loop;
  return query select true, v_count, null::bigint, 'Cadeia íntegra.'::text;
end;
$$;

-- ============================================================
-- 4. TABELAS DE CADASTRO
-- ============================================================
-- ---------- Parâmetros do site ----------
create table if not exists public.wh_site_settings (
  site_key text primary key references public.sites(key),
  -- Custo unitário a partir do qual o item vira "ALTO_VALOR" automaticamente
  -- (null = nenhum item vira alto valor sozinho).
  high_value_threshold numeric check (high_value_threshold is null or high_value_threshold >= 0),
  -- Usados na Fase de movimentações (saída/ajuste), já ficam cadastrados.
  approval_limit numeric check (approval_limit is null or approval_limit >= 0),
  om_regex text not null default '^[0-9]{12}$',
  dest_areas text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

insert into public.wh_site_settings (site_key) values ('VGR_ARMAZEM')
on conflict (site_key) do nothing;

-- ---------- Endereços (armazém > rua > prateleira > nível > posição) ----------
-- Uma única tabela em árvore (parent_id). `path` guarda o id do próprio
-- endereço e de todos os ancestrais: com isso "esse endereço está debaixo
-- da rua A?" vira uma checagem simples (rua_id = any(path)), sem consulta
-- recursiva.
create table if not exists public.wh_locations (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key),
  parent_id uuid,
  kind text not null check (kind in ('ARMAZEM','RUA','PRATELEIRA','NIVEL','POSICAO')),
  -- Sem hífen: o hífen é o separador do código completo (ex.: VGR-A-03-2).
  code text not null check (code ~ '^[A-Za-z0-9_.]+$'),
  full_code text,
  qr_token text,
  path uuid[],
  is_countable boolean not null default false,
  map_x numeric, map_y numeric, map_w numeric, map_h numeric,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  unique (id, site_key),
  foreign key (parent_id, site_key) references public.wh_locations (id, site_key)
);
create unique index if not exists wh_locations_site_fullcode on public.wh_locations (site_key, full_code);
create unique index if not exists wh_locations_site_token on public.wh_locations (site_key, qr_token);
create index if not exists wh_locations_parent on public.wh_locations (site_key, parent_id);
create index if not exists wh_locations_path on public.wh_locations using gin (path);

-- Token curto e aleatório do QR (sem letras confundíveis: 0/O, 1/I).
create or replace function public.wh_new_qr_token(p_site text)
returns text language plpgsql set search_path = public, pg_temp as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_tok text;
  i int;
begin
  loop
    v_tok := '';
    for i in 1..8 loop
      v_tok := v_tok || substr(v_alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;
    exit when not exists (select 1 from public.wh_locations where site_key = p_site and qr_token = v_tok);
  end loop;
  return v_tok;
end;
$$;

create or replace function public.wh_locations_before()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_parent public.wh_locations;
  v_rank int;
  v_prank int;
begin
  if tg_op = 'UPDATE' then
    -- Etiquetas já podem estar impressas e coladas: o que identifica o
    -- endereço nunca muda. Só dá pra desativar e criar outro.
    if new.site_key <> old.site_key or new.parent_id is distinct from old.parent_id
       or new.kind <> old.kind or new.code <> old.code
       or new.full_code is distinct from old.full_code
       or new.qr_token is distinct from old.qr_token
       or new.path is distinct from old.path then
      raise exception 'Endereço: código, tipo, local pai e QR não mudam depois de criados (a etiqueta já pode estar impressa). Desative este endereço e crie outro.';
    end if;
    return new;
  end if;

  v_rank := case new.kind when 'ARMAZEM' then 1 when 'RUA' then 2 when 'PRATELEIRA' then 3 when 'NIVEL' then 4 else 5 end;
  if new.parent_id is null then
    if new.kind <> 'ARMAZEM' then
      raise exception 'Só o endereço do tipo ARMAZEM pode ficar sem local pai.';
    end if;
    new.full_code := new.code;
    new.path := array[new.id];
  else
    if new.kind = 'ARMAZEM' then
      raise exception 'Um ARMAZEM não pode ter local pai.';
    end if;
    select * into v_parent from public.wh_locations where id = new.parent_id and site_key = new.site_key;
    if not found then
      raise exception 'Local pai não encontrado neste site.';
    end if;
    v_prank := case v_parent.kind when 'ARMAZEM' then 1 when 'RUA' then 2 when 'PRATELEIRA' then 3 when 'NIVEL' then 4 else 5 end;
    if v_rank <= v_prank then
      raise exception 'Hierarquia inválida: % não pode ficar dentro de %.', new.kind, v_parent.kind;
    end if;
    new.full_code := v_parent.full_code || '-' || new.code;
    new.path := v_parent.path || new.id;
  end if;
  if new.qr_token is null then
    new.qr_token := public.wh_new_qr_token(new.site_key);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_wh_locations_before on public.wh_locations;
create trigger trg_wh_locations_before before insert or update on public.wh_locations
for each row execute function public.wh_locations_before();

-- ---------- Catálogo de itens ----------
create table if not exists public.wh_items (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key),
  code text not null,
  vale_material_code text,
  description text not null,
  uom text not null default 'UN',
  -- Classe da curva ABC (recalculada por rotina; abc_override = ajuste manual).
  abc_class text check (abc_class is null or abc_class in ('A','B','C')),
  abc_override boolean not null default false,
  -- NORMAL / ALTO_VALOR / CRITICO. ALTO_VALOR sai sozinho do custo
  -- (criticality_source = 'AUTOMATICA'); CRITICO é sempre decisão manual.
  criticality text not null default 'NORMAL' check (criticality in ('NORMAL','ALTO_VALOR','CRITICO')),
  criticality_source text not null default 'AUTOMATICA' check (criticality_source in ('AUTOMATICA','MANUAL')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  unique (id, site_key),
  unique (site_key, code)
);
create index if not exists wh_items_vale_code on public.wh_items (site_key, vale_material_code);

-- Custo unitário FICA EM TABELA SEPARADA, de propósito: o operador precisa
-- ler o catálogo (descrição, código) pra bipar, mas NÃO deve saber quanto
-- vale cada coisa que está contando. Em coluna da própria wh_items ele
-- veria o valor; em tabela à parte, a RLS esconde.
create table if not exists public.wh_item_costs (
  item_id uuid primary key,
  site_key text not null references public.sites(key),
  unit_cost numeric not null check (unit_cost >= 0),
  currency text not null default 'BRL',
  cost_source text not null default 'MANUAL' check (cost_source in ('SAP','MANUAL')),
  cost_updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  foreign key (item_id, site_key) references public.wh_items (id, site_key)
);

create table if not exists public.wh_item_cost_history (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key),
  item_id uuid not null,
  unit_cost numeric not null,
  currency text not null,
  cost_source text not null,
  valid_from timestamptz not null default now(),
  changed_by uuid,
  foreign key (item_id, site_key) references public.wh_items (id, site_key)
);
create index if not exists wh_item_cost_history_item on public.wh_item_cost_history (item_id, valid_from);

-- Criticidade automática: ALTO_VALOR quando o custo passa do limite do site.
create or replace function public.wh_auto_criticality(p_item uuid, p_site text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when s.high_value_threshold is not null and c.unit_cost is not null and c.unit_cost >= s.high_value_threshold
    then 'ALTO_VALOR' else 'NORMAL' end
  from (select 1) x
  left join public.wh_site_settings s on s.site_key = p_site
  left join public.wh_item_costs c on c.item_id = p_item;
$$;

create or replace function public.wh_items_before()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.criticality_source = 'AUTOMATICA' then
    new.criticality := public.wh_auto_criticality(new.id, new.site_key);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_wh_items_before on public.wh_items;
create trigger trg_wh_items_before before insert or update on public.wh_items
for each row execute function public.wh_items_before();

create or replace function public.wh_item_costs_after()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.unit_cost is distinct from old.unit_cost or new.currency is distinct from old.currency then
    insert into public.wh_item_cost_history (site_key, item_id, unit_cost, currency, cost_source, changed_by)
    values (new.site_key, new.item_id, new.unit_cost, new.currency, new.cost_source, auth.uid());
  end if;
  update public.wh_items set criticality = public.wh_auto_criticality(id, site_key)
   where id = new.item_id and criticality_source = 'AUTOMATICA'
     and criticality is distinct from public.wh_auto_criticality(id, site_key);
  return null;
end;
$$;
drop trigger if exists trg_wh_item_costs_after on public.wh_item_costs;
create trigger trg_wh_item_costs_after after insert or update on public.wh_item_costs
for each row execute function public.wh_item_costs_after();

-- Mudou o limite de "alto valor" do site: reclassifica os itens automáticos.
create or replace function public.wh_settings_after()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.high_value_threshold is distinct from old.high_value_threshold then
    update public.wh_items set criticality = public.wh_auto_criticality(id, site_key)
     where site_key = new.site_key and criticality_source = 'AUTOMATICA'
       and criticality is distinct from public.wh_auto_criticality(id, site_key);
  end if;
  return null;
end;
$$;
drop trigger if exists trg_wh_settings_after on public.wh_site_settings;
create trigger trg_wh_settings_after after update on public.wh_site_settings
for each row execute function public.wh_settings_after();

-- ---------- Códigos de barras / QR dos itens ----------
-- Um item pode ter vários códigos (EAN, QR da Vale, código interno). O bip
-- procura por aqui. `barcode` é guardado exatamente como o leitor entrega.
create table if not exists public.wh_item_barcodes (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key),
  item_id uuid not null,
  barcode text not null check (length(btrim(barcode)) > 0),
  created_at timestamptz not null default now(),
  foreign key (item_id, site_key) references public.wh_items (id, site_key),
  unique (site_key, barcode)
);
create index if not exists wh_item_barcodes_item on public.wh_item_barcodes (item_id);

-- ---------- Equipes ----------
create table if not exists public.wh_teams (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key),
  name text not null,
  created_at timestamptz not null default now(),
  unique (id, site_key),
  unique (site_key, name)
);
create table if not exists public.wh_team_members (
  team_id uuid not null,
  site_key text not null references public.sites(key),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  primary key (team_id, profile_id),
  foreign key (team_id, site_key) references public.wh_teams (id, site_key) on delete cascade
);
create index if not exists wh_team_members_profile on public.wh_team_members (profile_id);

-- ---------- Campanhas ----------
-- A contagem é SEMPRE cega (ver cabeçalho): por isso não existe um campo
-- "blind" aqui -- uma chave que não muda nada só daria falsa segurança.
--
-- recount_mode (quando a 2ª contagem acontece sozinha):
--   NENHUMA      nunca (itens críticos ainda exigem a 2ª contagem)
--   AMOSTRA      sorteia recount_sample_pct % dos endereços
--   TODAS        todos os endereços
--   DIVERGENCIA  só quando a 1ª contagem diverge do saldo ESPERADO
--                (wh_expected_stock). Sem saldo esperado carregado, nada
--                dispara -- na PRIMEIRA campanha (a Vale não tem saldo
--                estruturado) use AMOSTRA ou TODAS.
-- Se a 1ª e a 2ª divergirem, a 3ª contagem é pedida automaticamente.
create table if not exists public.wh_campaigns (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key),
  name text not null,
  kind text not null default 'GERAL' check (kind in ('GERAL','CICLICO')),
  start_date date,
  end_date date,
  status text not null default 'RASCUNHO' check (status in ('RASCUNHO','ATIVA','FECHADA','CANCELADA')),
  recount_mode text not null default 'AMOSTRA' check (recount_mode in ('NENHUMA','AMOSTRA','TODAS','DIVERGENCIA')),
  recount_sample_pct numeric not null default 20 check (recount_sample_pct between 0 and 100),
  tolerance_qty numeric not null default 0 check (tolerance_qty >= 0),
  tolerance_pct numeric not null default 0 check (tolerance_pct >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  closed_by uuid references public.profiles(id) on delete set null,
  unique (id, site_key)
);
create index if not exists wh_campaigns_site_status on public.wh_campaigns (site_key, status);

-- Atribuição: "a equipe X conta a rua A na rodada N". O local atribuído
-- costuma ser uma RUA, e vale pra todos os endereços debaixo dela.
create table if not exists public.wh_campaign_assignments (
  campaign_id uuid not null,
  site_key text not null references public.sites(key),
  location_id uuid not null,
  team_id uuid not null,
  round smallint not null default 1 check (round between 1 and 3),
  primary key (campaign_id, location_id, round),
  foreign key (campaign_id, site_key) references public.wh_campaigns (id, site_key),
  foreign key (location_id, site_key) references public.wh_locations (id, site_key),
  foreign key (team_id, site_key) references public.wh_teams (id, site_key)
);
create index if not exists wh_assignments_team on public.wh_campaign_assignments (team_id);

-- Saldo esperado (SAP, planilha, campanha anterior). O operador NÃO tem
-- política de leitura aqui -- é isso que garante a contagem cega.
create table if not exists public.wh_expected_stock (
  campaign_id uuid not null,
  site_key text not null references public.sites(key),
  location_id uuid not null,
  item_id uuid not null,
  qty_expected numeric not null check (qty_expected >= 0),
  source text,
  loaded_by uuid references public.profiles(id) on delete set null,
  loaded_at timestamptz not null default now(),
  primary key (campaign_id, location_id, item_id),
  foreign key (campaign_id, site_key) references public.wh_campaigns (id, site_key),
  foreign key (location_id, site_key) references public.wh_locations (id, site_key),
  foreign key (item_id, site_key) references public.wh_items (id, site_key)
);

-- Campanha: só avança (RASCUNHO > ATIVA > FECHADA, ou CANCELADA); depois de
-- ativada, as regras de contagem não mudam mais; pra fechar, não pode haver
-- recontagem pendente nem item crítico com uma contagem só.
create or replace function public.wh_campaigns_before()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'RASCUNHO' then
      raise exception 'Toda campanha nasce como RASCUNHO.';
    end if;
    return new;
  end if;

  if old.status in ('FECHADA','CANCELADA') then
    raise exception 'A campanha "%" está % e não pode mais ser alterada.', old.name, old.status;
  end if;
  if new.site_key <> old.site_key then
    raise exception 'A campanha não pode mudar de site.';
  end if;
  if old.status <> 'RASCUNHO' and (
       new.kind <> old.kind or new.recount_mode <> old.recount_mode
       or new.recount_sample_pct <> old.recount_sample_pct
       or new.tolerance_qty <> old.tolerance_qty or new.tolerance_pct <> old.tolerance_pct) then
    raise exception 'Depois de ativada, as regras de contagem da campanha não podem mudar (isso alteraria o resultado de contagens já feitas).';
  end if;

  if new.status <> old.status then
    if not ((old.status = 'RASCUNHO' and new.status in ('ATIVA','CANCELADA'))
         or (old.status = 'ATIVA' and new.status in ('FECHADA','CANCELADA'))) then
      raise exception 'Mudança de status inválida: % para %.', old.status, new.status;
    end if;
    if new.status = 'ATIVA' and not exists (
         select 1 from public.wh_campaign_assignments a where a.campaign_id = new.id) then
      raise exception 'Atribua ao menos uma rua a uma equipe antes de ativar a campanha.';
    end if;
    if new.status = 'FECHADA' then
      if exists (select 1 from public.wh_recount_tasks t where t.campaign_id = new.id and t.status = 'ABERTA') then
        raise exception 'Existem recontagens pendentes. Conclua ou cancele antes de fechar a campanha.';
      end if;
      if exists (
        select 1
        from public.wh_count_events e
        join public.wh_items i on i.id = e.item_id
        where e.campaign_id = new.id and i.criticality <> 'NORMAL'
        group by e.location_id, e.item_id
        having count(distinct e.counted_by) < 2
      ) then
        raise exception 'Há item crítico/alto valor com apenas uma contagem (exige dupla conferência). Conclua antes de fechar a campanha.';
      end if;
      new.closed_at := now();
      new.closed_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_wh_campaigns_before on public.wh_campaigns;
create trigger trg_wh_campaigns_before before insert or update on public.wh_campaigns
for each row execute function public.wh_campaigns_before();

-- ============================================================
-- 5. CONTAGENS (imutáveis, com cadeia de hashes)
-- ============================================================
-- Item que o operador não conseguiu identificar (sem etiqueta / ilegível).
-- Não é imutável: o supervisor depois "identifica" o item (status/resolução).
-- Atenção ao ENVIO OFFLINE: este registro precisa chegar ANTES do evento de
-- contagem que o referencia (o app deve enviar nessa ordem).
create table if not exists public.wh_unidentified_items (
  id uuid primary key,
  site_key text not null references public.sites(key),
  campaign_id uuid not null,
  location_id uuid not null,
  photo_paths text[] not null check (coalesce(array_length(photo_paths, 1), 0) >= 1),
  description text,
  qty numeric not null check (qty >= 0),
  reported_by uuid,
  reported_by_label text,
  reported_at timestamptz not null default now(),
  status text not null default 'ABERTO' check (status in ('ABERTO','IDENTIFICADO','DESCARTADO')),
  resolved_item_id uuid,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  resolution_note text,
  unique (id, site_key),
  foreign key (campaign_id, site_key) references public.wh_campaigns (id, site_key),
  foreign key (location_id, site_key) references public.wh_locations (id, site_key),
  foreign key (resolved_item_id, site_key) references public.wh_items (id, site_key)
);
create index if not exists wh_unidentified_campaign on public.wh_unidentified_items (campaign_id, status);

-- "Esse operador está atribuído a esse endereço nessa rodada?" Rodadas 2 e 3
-- sem nenhuma atribuição própria liberam qualquer operador (a regra de "não
-- pode ser quem já contou" continua valendo no trigger de contagem).
create or replace function public.wh_user_assigned(p_campaign uuid, p_location uuid, p_round smallint, p_uid uuid)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_path uuid[];
begin
  select path into v_path from public.wh_locations where id = p_location;
  if v_path is null then
    return false;
  end if;
  if exists (
    select 1
    from public.wh_campaign_assignments a
    join public.wh_team_members m on m.team_id = a.team_id
    where a.campaign_id = p_campaign and a.round = p_round and m.profile_id = p_uid
      and a.location_id = any (v_path)
  ) then
    return true;
  end if;
  return p_round > 1 and not exists (
    select 1 from public.wh_campaign_assignments a
    where a.campaign_id = p_campaign and a.round = p_round
      and a.location_id = any (v_path)
  );
end;
$$;

create or replace function public.wh_unidentified_before()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_camp public.wh_campaigns;
  v_loc public.wh_locations;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.reported_by := auth.uid(); end if;
    if exists (select 1 from public.wh_unidentified_items where id = new.id) then
      return new;  -- reenvio de algo que já chegou: o ON CONFLICT DO NOTHING descarta
    end if;
    new.reported_by_label := (select name from public.profiles where id = new.reported_by);
    new.reported_at := now();
    new.status := 'ABERTO';
    new.resolved_item_id := null; new.resolved_by := null; new.resolved_at := null; new.resolution_note := null;
    select * into v_camp from public.wh_campaigns where id = new.campaign_id and site_key = new.site_key;
    if not found or v_camp.status <> 'ATIVA' then
      raise exception 'A campanha não está ativa.';
    end if;
    select * into v_loc from public.wh_locations where id = new.location_id and site_key = new.site_key;
    if not found or not v_loc.is_countable or not v_loc.active then
      raise exception 'Endereço inválido, inativo ou não contável.';
    end if;
    if public.current_role_key() = 'ARM_OPERADOR'
       and not public.wh_user_assigned(new.campaign_id, new.location_id, 1::smallint, new.reported_by)
       and not public.wh_user_assigned(new.campaign_id, new.location_id, 2::smallint, new.reported_by)
       and not public.wh_user_assigned(new.campaign_id, new.location_id, 3::smallint, new.reported_by) then
      raise exception 'Você não está atribuído a este endereço nesta campanha.';
    end if;
    return new;
  end if;

  -- UPDATE: só a resolução pode mudar.
  if new.id <> old.id or new.site_key <> old.site_key or new.campaign_id <> old.campaign_id
     or new.location_id <> old.location_id or new.photo_paths <> old.photo_paths
     or new.description is distinct from old.description or new.qty <> old.qty
     or new.reported_by is distinct from old.reported_by or new.reported_at <> old.reported_at then
    raise exception 'Item não identificado: só o status e a resolução podem ser alterados.';
  end if;
  if old.status <> 'ABERTO' then
    raise exception 'Este item não identificado já foi resolvido (%).', old.status;
  end if;
  if new.status = 'IDENTIFICADO' and new.resolved_item_id is null then
    raise exception 'Informe qual item do catálogo foi identificado.';
  end if;
  if new.status <> 'ABERTO' then
    new.resolved_by := auth.uid();
    new.resolved_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists trg_wh_unidentified_before on public.wh_unidentified_items;
create trigger trg_wh_unidentified_before before insert or update on public.wh_unidentified_items
for each row execute function public.wh_unidentified_before();

-- ---------- Eventos de contagem (uma linha por "bip confirmado") ----------
create table if not exists public.wh_count_events (
  -- id gerado NO APARELHO: se o envio se repetir (caiu a rede no meio), o
  -- servidor reconhece o mesmo id e ignora a duplicata (idempotência).
  id uuid primary key,
  site_key text not null references public.sites(key),
  campaign_id uuid not null,
  location_id uuid not null,
  item_id uuid,
  unidentified_id uuid,
  scanned_code text,
  qty numeric not null check (qty >= 0),
  round smallint not null default 1 check (round between 1 and 3),
  source text not null default 'LEITOR' check (source in ('LEITOR','CAMERA','MANUAL')),
  -- Sem FK para profiles de propósito: apagar um usuário não pode tentar
  -- mexer numa linha imutável. O nome fica "fotografado" em counted_by_label.
  counted_by uuid not null,
  counted_by_label text,
  counted_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  device_id text,
  app_version text,
  photo_path text,
  note text,
  supersedes_id uuid references public.wh_count_events(id),
  chain_seq bigint,
  prev_hash text,
  row_hash text,
  foreign key (campaign_id, site_key) references public.wh_campaigns (id, site_key),
  foreign key (location_id, site_key) references public.wh_locations (id, site_key),
  foreign key (item_id, site_key) references public.wh_items (id, site_key),
  foreign key (unidentified_id, site_key) references public.wh_unidentified_items (id, site_key),
  -- Uma linha é: um item, OU um item não identificado, OU o marcador
  -- "endereço vazio" (sem item e quantidade zero).
  check (num_nonnulls(item_id, unidentified_id) = 1 or (item_id is null and unidentified_id is null and qty = 0))
);
create index if not exists wh_events_campaign_loc on public.wh_count_events (campaign_id, location_id);
create index if not exists wh_events_campaign_item on public.wh_count_events (campaign_id, item_id);
create index if not exists wh_events_site_time on public.wh_count_events (site_key, counted_at);
create index if not exists wh_events_counter on public.wh_count_events (counted_by, counted_at);
create index if not exists wh_events_supersedes on public.wh_count_events (supersedes_id);
create index if not exists wh_events_chain on public.wh_count_events (site_key, chain_seq);

-- "Finalizar endereço": o operador declara que terminou aquele endereço
-- naquela rodada e quantas linhas lançou. É isso que diferencia "endereço
-- vazio" de "endereço ainda não contado", e é o gatilho da comparação entre
-- rodadas. Só é aceito quando todas as linhas declaradas já chegaram.
create table if not exists public.wh_count_closures (
  id uuid primary key,
  site_key text not null references public.sites(key),
  campaign_id uuid not null,
  location_id uuid not null,
  round smallint not null default 1 check (round between 1 and 3),
  counted_by uuid not null,
  counted_by_label text,
  line_count int not null check (line_count >= 0),
  started_at timestamptz,
  finished_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  device_id text,
  app_version text,
  note text,
  chain_seq bigint,
  prev_hash text,
  row_hash text,
  foreign key (campaign_id, site_key) references public.wh_campaigns (id, site_key),
  foreign key (location_id, site_key) references public.wh_locations (id, site_key),
  unique (campaign_id, location_id, round, counted_by)
);
create index if not exists wh_closures_campaign_loc on public.wh_count_closures (campaign_id, location_id, round);
create index if not exists wh_closures_chain on public.wh_count_closures (site_key, chain_seq);

-- Recontagens pedidas automaticamente (ou pelo supervisor). A equipe que
-- recontar vê só "recontar o endereço X" -- nunca o valor da contagem anterior.
create table if not exists public.wh_recount_tasks (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key),
  campaign_id uuid not null,
  location_id uuid not null,
  item_id uuid,
  round smallint not null check (round between 2 and 3),
  reason text not null check (reason in ('DIVERGENCIA','DIVERGENCIA_ESPERADO','AMOSTRA','TODAS','ITEM_CRITICO','MANUAL')),
  status text not null default 'ABERTA' check (status in ('ABERTA','CONCLUIDA','CANCELADA')),
  assigned_team_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  completed_at timestamptz,
  foreign key (campaign_id, site_key) references public.wh_campaigns (id, site_key),
  foreign key (location_id, site_key) references public.wh_locations (id, site_key),
  foreign key (item_id, site_key) references public.wh_items (id, site_key),
  foreign key (assigned_team_id, site_key) references public.wh_teams (id, site_key)
);
create unique index if not exists wh_recount_open_unique on public.wh_recount_tasks (campaign_id, location_id, round) where status = 'ABERTA';
create index if not exists wh_recount_campaign on public.wh_recount_tasks (campaign_id, status);

-- Decisão do supervisor (a "verdade" aprovada, uma linha por decisão; vale a
-- mais recente de cada campanha+endereço+item). Imutável: mudar de ideia =
-- nova decisão.
create table if not exists public.wh_count_decisions (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key),
  campaign_id uuid not null,
  location_id uuid not null,
  item_id uuid not null,
  final_qty numeric not null check (final_qty >= 0),
  decision text not null check (decision in ('APROVAR_R1','APROVAR_R2','APROVAR_R3','AJUSTE_MANUAL')),
  reason text,
  decided_by uuid not null,
  decided_by_label text,
  decided_at timestamptz not null default now(),
  chain_seq bigint,
  prev_hash text,
  row_hash text,
  foreign key (campaign_id, site_key) references public.wh_campaigns (id, site_key),
  foreign key (location_id, site_key) references public.wh_locations (id, site_key),
  foreign key (item_id, site_key) references public.wh_items (id, site_key),
  check (decision <> 'AJUSTE_MANUAL' or length(btrim(coalesce(reason, ''))) >= 5)
);
create index if not exists wh_decisions_key on public.wh_count_decisions (campaign_id, location_id, item_id, chain_seq);
create index if not exists wh_decisions_chain on public.wh_count_decisions (site_key, chain_seq);

-- ---------- Log de auditoria genérico ----------
create table if not exists public.wh_audit_log (
  id uuid primary key default gen_random_uuid(),
  site_key text not null,
  table_name text not null,
  row_id text,
  action text not null check (action in ('INSERT','UPDATE','DELETE')),
  old_data jsonb,
  new_data jsonb,
  actor uuid,
  actor_label text,
  at timestamptz not null default now(),
  chain_seq bigint,
  prev_hash text,
  row_hash text
);
create index if not exists wh_audit_site_time on public.wh_audit_log (site_key, at);
create index if not exists wh_audit_table_row on public.wh_audit_log (table_name, row_id);
create index if not exists wh_audit_chain on public.wh_audit_log (site_key, chain_seq);

-- ---------- Comparação de rodadas (usada na recontagem automática) ----------
-- Soma, por item, o que foi contado numa rodada num endereço (ignora
-- linhas já corrigidas por outra, via supersedes_id). Itens não
-- identificados entram juntos num único balde (item_id = uuid zerado: o
-- FULL JOIN do Postgres não aceita comparar com NULL, só igualdade simples).
create or replace function public.wh_round_totals(p_campaign uuid, p_location uuid, p_round smallint)
returns table (item_id uuid, qty numeric) language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(e.item_id, '00000000-0000-0000-0000-000000000000'::uuid), sum(e.qty)
  from public.wh_count_events e
  where e.campaign_id = p_campaign and e.location_id = p_location and e.round = p_round
    and (e.item_id is not null or e.unidentified_id is not null)
    and not exists (select 1 from public.wh_count_events s where s.supersedes_id = e.id)
  group by 1;
$$;

-- Há divergência entre duas "fotos" (rodada x rodada, ou rodada x esperado)?
create or replace function public.wh_totals_diverge(p_campaign uuid, p_location uuid, p_round_a smallint, p_round_b smallint)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from public.wh_round_totals(p_campaign, p_location, p_round_a) a
    full outer join public.wh_round_totals(p_campaign, p_location, p_round_b) b on a.item_id = b.item_id
    cross join public.wh_campaigns c
    where c.id = p_campaign
      and abs(coalesce(a.qty, 0) - coalesce(b.qty, 0))
          > greatest(c.tolerance_qty, c.tolerance_pct / 100.0 * greatest(coalesce(a.qty, 0), coalesce(b.qty, 0)))
  );
$$;

-- ---------- Gatilhos de contagem ----------
create or replace function public.wh_count_events_before()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_camp public.wh_campaigns;
  v_loc public.wh_locations;
  v_unid public.wh_unidentified_items;
  v_sup public.wh_count_events;
  v_role text := public.current_role_key();
begin
  -- Reenvio de algo que já chegou: deixa passar pra o ON CONFLICT DO NOTHING
  -- descartar (as validações abaixo falhariam à toa, ex.: "endereço já finalizado").
  -- O autor é carimbado ANTES do atalho: sem isso o reenvio chegaria à RLS
  -- com counted_by vazio e seria recusado.
  if auth.uid() is not null then new.counted_by := auth.uid(); end if;
  if exists (select 1 from public.wh_count_events where id = new.id) then
    return new;
  end if;

  new.received_at := now();
  new.counted_by_label := (select name from public.profiles where id = new.counted_by);

  select * into v_camp from public.wh_campaigns where id = new.campaign_id and site_key = new.site_key;
  if not found then raise exception 'Campanha não encontrada neste site.'; end if;
  if v_camp.status <> 'ATIVA' then
    raise exception 'A campanha "%" não está ativa (status: %).', v_camp.name, v_camp.status;
  end if;

  select * into v_loc from public.wh_locations where id = new.location_id and site_key = new.site_key;
  if not found or not v_loc.is_countable or not v_loc.active then
    raise exception 'Endereço inválido, inativo ou não contável.';
  end if;

  if v_role = 'ARM_OPERADOR' and not public.wh_user_assigned(new.campaign_id, new.location_id, new.round, new.counted_by) then
    raise exception 'Você não está atribuído a este endereço na rodada %.', new.round;
  end if;

  -- Quem contou o endereço numa rodada não conta ele de novo noutra (a
  -- recontagem só vale se for outra pessoa).
  if exists (
    select 1 from public.wh_count_events e
    where e.campaign_id = new.campaign_id and e.location_id = new.location_id
      and e.counted_by = new.counted_by and e.round <> new.round
  ) then
    raise exception 'Quem contou este endereço em outra rodada não pode contá-lo de novo: a recontagem precisa ser de outra pessoa.';
  end if;

  if new.round > 1 and not exists (
    select 1 from public.wh_count_closures c
    where c.campaign_id = new.campaign_id and c.location_id = new.location_id and c.round = new.round - 1
  ) then
    raise exception 'A rodada % deste endereço ainda não foi finalizada.', new.round - 1;
  end if;

  -- Recontagem só existe se foi pedida (automaticamente ou pelo supervisor).
  if new.round > 1 and not exists (
    select 1 from public.wh_recount_tasks t
    where t.campaign_id = new.campaign_id and t.location_id = new.location_id
      and t.round = new.round and t.status <> 'CANCELADA'
  ) then
    raise exception 'Não há recontagem (rodada %) pedida para este endereço.', new.round;
  end if;

  if exists (
    select 1 from public.wh_count_closures c
    where c.campaign_id = new.campaign_id and c.location_id = new.location_id
      and c.round = new.round and c.counted_by = new.counted_by
  ) then
    raise exception 'Você já finalizou este endereço nesta rodada. Correções ficam com o supervisor.';
  end if;

  if new.unidentified_id is not null then
    select * into v_unid from public.wh_unidentified_items where id = new.unidentified_id and site_key = new.site_key;
    if not found or v_unid.campaign_id <> new.campaign_id or v_unid.location_id <> new.location_id then
      raise exception 'Item não identificado de outro endereço ou campanha.';
    end if;
  end if;

  if new.supersedes_id is not null then
    select * into v_sup from public.wh_count_events where id = new.supersedes_id;
    if not found or v_sup.campaign_id <> new.campaign_id or v_sup.location_id <> new.location_id
       or v_sup.round <> new.round or v_sup.counted_by <> new.counted_by then
      raise exception 'A correção precisa ser de uma linha sua, no mesmo endereço e rodada.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_wh_count_events_before on public.wh_count_events;
create trigger trg_wh_count_events_before before insert on public.wh_count_events
for each row execute function public.wh_count_events_before();

create or replace function public.wh_count_closures_before()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_camp public.wh_campaigns;
  v_loc public.wh_locations;
  v_arrived int;
begin
  if auth.uid() is not null then new.counted_by := auth.uid(); end if;
  if exists (select 1 from public.wh_count_closures where id = new.id) then
    return new;
  end if;
  new.received_at := now();
  new.counted_by_label := (select name from public.profiles where id = new.counted_by);

  select * into v_camp from public.wh_campaigns where id = new.campaign_id and site_key = new.site_key;
  if not found or v_camp.status <> 'ATIVA' then raise exception 'A campanha não está ativa.'; end if;
  select * into v_loc from public.wh_locations where id = new.location_id and site_key = new.site_key;
  if not found or not v_loc.is_countable or not v_loc.active then
    raise exception 'Endereço inválido, inativo ou não contável.';
  end if;
  if public.current_role_key() = 'ARM_OPERADOR' and not public.wh_user_assigned(new.campaign_id, new.location_id, new.round, new.counted_by) then
    raise exception 'Você não está atribuído a este endereço na rodada %.', new.round;
  end if;
  if new.round > 1 and not exists (
    select 1 from public.wh_count_closures c
    where c.campaign_id = new.campaign_id and c.location_id = new.location_id and c.round = new.round - 1
  ) then
    raise exception 'A rodada % deste endereço ainda não foi finalizada.', new.round - 1;
  end if;

  -- Só fecha o endereço quando TODAS as linhas declaradas já chegaram. Se o
  -- envio vier fora de ordem, o app tenta de novo depois.
  select count(*) into v_arrived from public.wh_count_events e
   where e.campaign_id = new.campaign_id and e.location_id = new.location_id
     and e.round = new.round and e.counted_by = new.counted_by;
  if v_arrived < new.line_count then
    raise exception 'Faltam linhas deste endereço (declaradas %, recebidas %). Reenvie as contagens antes de finalizar.', new.line_count, v_arrived;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_wh_count_closures_before on public.wh_count_closures;
create trigger trg_wh_count_closures_before before insert on public.wh_count_closures
for each row execute function public.wh_count_closures_before();

-- Depois de finalizar um endereço: conclui a tarefa de recontagem desta
-- rodada e decide se pede a próxima contagem.
create or replace function public.wh_evaluate_location(p_campaign uuid, p_location uuid, p_round smallint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_camp public.wh_campaigns;
  v_reason text;
  v_team uuid;
  v_critical boolean;
begin
  select * into v_camp from public.wh_campaigns where id = p_campaign;

  update public.wh_recount_tasks
     set status = 'CONCLUIDA', completed_at = now()
   where campaign_id = p_campaign and location_id = p_location and round = p_round and status = 'ABERTA';

  if p_round = 1 then
    select exists (
      select 1 from public.wh_count_events e join public.wh_items i on i.id = e.item_id
       where e.campaign_id = p_campaign and e.location_id = p_location and i.criticality <> 'NORMAL'
    ) into v_critical;
    if v_critical then
      v_reason := 'ITEM_CRITICO';
    elsif v_camp.recount_mode = 'TODAS' then
      v_reason := 'TODAS';
    elsif v_camp.recount_mode = 'AMOSTRA' and random() * 100 < v_camp.recount_sample_pct then
      v_reason := 'AMOSTRA';
    elsif v_camp.recount_mode = 'DIVERGENCIA'
          and exists (select 1 from public.wh_expected_stock x where x.campaign_id = p_campaign and x.location_id = p_location)
          and exists (
            select 1
            from public.wh_round_totals(p_campaign, p_location, 1::smallint) a
            full outer join (select x.item_id, x.qty_expected as qty from public.wh_expected_stock x
                              where x.campaign_id = p_campaign and x.location_id = p_location) b
              on a.item_id = b.item_id
            where abs(coalesce(a.qty, 0) - coalesce(b.qty, 0))
                  > greatest(v_camp.tolerance_qty, v_camp.tolerance_pct / 100.0 * greatest(coalesce(a.qty, 0), coalesce(b.qty, 0)))
          ) then
      v_reason := 'DIVERGENCIA_ESPERADO';
    end if;
  elsif p_round < 3 and public.wh_totals_diverge(p_campaign, p_location, (p_round - 1)::smallint, p_round) then
    v_reason := 'DIVERGENCIA';
  end if;

  if v_reason is not null then
    select a.team_id into v_team
      from public.wh_campaign_assignments a
      join public.wh_locations l on l.id = p_location
     where a.campaign_id = p_campaign and a.round = p_round + 1 and a.location_id = any (l.path)
     limit 1;
    insert into public.wh_recount_tasks (site_key, campaign_id, location_id, round, reason, assigned_team_id)
    select v_camp.site_key, p_campaign, p_location, p_round + 1, v_reason, v_team
    on conflict do nothing;
  end if;
end;
$$;

create or replace function public.wh_count_closures_after()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.wh_evaluate_location(new.campaign_id, new.location_id, new.round);
  return null;
end;
$$;
drop trigger if exists trg_wh_count_closures_after on public.wh_count_closures;
create trigger trg_wh_count_closures_after after insert on public.wh_count_closures
for each row execute function public.wh_count_closures_after();

-- Decisão do supervisor: valida que o valor aprovado bate com a rodada
-- escolhida e exige dupla conferência pra item crítico/alto valor.
create or replace function public.wh_count_decisions_before()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_camp public.wh_campaigns;
  v_item public.wh_items;
  v_round smallint;
  v_total numeric;
  v_counters int;
begin
  if auth.uid() is not null then new.decided_by := auth.uid(); end if;
  new.decided_by_label := (select name from public.profiles where id = new.decided_by);
  new.decided_at := now();

  select * into v_camp from public.wh_campaigns where id = new.campaign_id and site_key = new.site_key;
  if not found or v_camp.status <> 'ATIVA' then
    raise exception 'Só é possível decidir enquanto a campanha está ativa.';
  end if;
  select * into v_item from public.wh_items where id = new.item_id and site_key = new.site_key;

  select count(distinct e.counted_by) into v_counters
    from public.wh_count_events e
   where e.campaign_id = new.campaign_id and e.location_id = new.location_id and e.item_id = new.item_id;
  if v_counters = 0 then
    raise exception 'Este item não tem nenhuma contagem neste endereço.';
  end if;
  if v_item.criticality <> 'NORMAL' and v_counters < 2 then
    raise exception 'Item % (%) exige dupla conferência: precisa de contagens de duas pessoas diferentes.', v_item.code, v_item.criticality;
  end if;

  if new.decision <> 'AJUSTE_MANUAL' then
    v_round := right(new.decision, 1)::smallint;
    select coalesce(sum(e.qty), 0) into v_total
      from public.wh_count_events e
     where e.campaign_id = new.campaign_id and e.location_id = new.location_id and e.item_id = new.item_id
       and e.round = v_round
       and not exists (select 1 from public.wh_count_events s where s.supersedes_id = e.id);
    if not exists (
      select 1 from public.wh_count_closures c
       where c.campaign_id = new.campaign_id and c.location_id = new.location_id and c.round = v_round
    ) then
      raise exception 'A rodada % deste endereço não foi finalizada.', v_round;
    end if;
    if v_total <> new.final_qty then
      raise exception 'O valor aprovado (%) não bate com a contagem da rodada % (%). Para outro valor use AJUSTE_MANUAL com justificativa.', new.final_qty, v_round, v_total;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_wh_count_decisions_before on public.wh_count_decisions;
create trigger trg_wh_count_decisions_before before insert on public.wh_count_decisions
for each row execute function public.wh_count_decisions_before();

-- ---------- Auditoria genérica das tabelas de cadastro ----------
create or replace function public.wh_audit_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new jsonb;
  v_old jsonb;
  v_row jsonb;
begin
  v_new := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_old := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_row := coalesce(v_new, v_old);
  insert into public.wh_audit_log (site_key, table_name, row_id, action, old_data, new_data, actor, actor_label)
  values (
    v_row ->> 'site_key', tg_table_name,
    coalesce(
      v_row ->> 'id',
      nullif(concat_ws(':', v_row ->> 'item_id', v_row ->> 'team_id', v_row ->> 'profile_id', v_row ->> 'campaign_id', v_row ->> 'location_id'), ''),
      v_row ->> 'site_key'
    ),
    tg_op, v_old, v_new, auth.uid(),
    (select name from public.profiles where id = auth.uid())
  );
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'wh_site_settings','wh_locations','wh_items','wh_item_costs','wh_item_barcodes','wh_teams',
    'wh_team_members','wh_campaigns','wh_campaign_assignments','wh_expected_stock',
    'wh_unidentified_items','wh_recount_tasks'
  ] loop
    execute format('drop trigger if exists trg_wh_audit on public.%I', t);
    execute format('create trigger trg_wh_audit after insert or update or delete on public.%I for each row execute function public.wh_audit_trigger()', t);
  end loop;

  -- Imutabilidade + cadeia de hashes nas tabelas de evidência.
  foreach t in array array['wh_count_events','wh_count_closures','wh_count_decisions','wh_audit_log','wh_item_cost_history'] loop
    execute format('drop trigger if exists trg_wh_immutable on public.%I', t);
    execute format('create trigger trg_wh_immutable before update or delete on public.%I for each row execute function public.wh_block_mutation()', t);
    execute format('drop trigger if exists trg_wh_immutable_truncate on public.%I', t);
    execute format('create trigger trg_wh_immutable_truncate before truncate on public.%I for each statement execute function public.wh_block_mutation()', t);
  end loop;
  foreach t in array array['wh_count_events','wh_count_closures','wh_count_decisions','wh_audit_log'] loop
    execute format('drop trigger if exists zz_wh_chain on public.%I', t);
    execute format('create trigger zz_wh_chain before insert on public.%I for each row execute function public.wh_chain_before_insert()', t);
  end loop;
end $$;

-- ============================================================
-- 6. VIEWS (security_invoker = true: a RLS do USUÁRIO que consulta continua
-- valendo. Sem isso, uma view roda com os direitos do dono e ignora a RLS.)
-- ============================================================
drop view if exists public.v_wh_item_whereabouts;
drop view if exists public.v_wh_campaign_progress;
drop view if exists public.v_wh_count_consolidated;

-- Uma linha por campanha + endereço + item, com as 3 rodadas lado a lado e
-- o status. O operador só enxerga as próprias contagens (RLS), então pra ele
-- essa view mostra só o que ele mesmo contou.
create view public.v_wh_count_consolidated with (security_invoker = true) as
select
  c.site_key, c.id as campaign_id, g.location_id, loc.full_code as location_code,
  g.item_id, i.code as item_code, i.description as item_description, i.criticality,
  g.r1, g.r2, g.r3, g.counters,
  d.final_qty, d.decision, d.decided_at,
  case
    when d.decision is not null then 'APROVADO'
    when i.criticality <> 'NORMAL' and g.counters < 2 then 'PENDENTE_2A_CONTAGEM'
    -- 3ª contagem: vale o desempate (confere se bate com uma das duas anteriores).
    when cl.has3 then
      case when abs(coalesce(g.r3, 0) - coalesce(g.r1, 0))
                <= greatest(c.tolerance_qty, c.tolerance_pct / 100.0 * greatest(coalesce(g.r3, 0), coalesce(g.r1, 0)))
             or abs(coalesce(g.r3, 0) - coalesce(g.r2, 0))
                <= greatest(c.tolerance_qty, c.tolerance_pct / 100.0 * greatest(coalesce(g.r3, 0), coalesce(g.r2, 0)))
           then 'CONFERE' else 'DIVERGENTE' end
    when cl.has2 then
      case when abs(coalesce(g.r1, 0) - coalesce(g.r2, 0))
                <= greatest(c.tolerance_qty, c.tolerance_pct / 100.0 * greatest(coalesce(g.r1, 0), coalesce(g.r2, 0)))
           then 'CONFERE' else 'DIVERGENTE' end
    when exists (select 1 from public.wh_recount_tasks t
                  where t.campaign_id = c.id and t.location_id = g.location_id and t.status = 'ABERTA') then 'RECONTAGEM'
    else 'CONTADO'
  end as status
from public.wh_campaigns c
join (
  select e.campaign_id, e.location_id, e.item_id,
         sum(e.qty) filter (where e.round = 1) as r1,
         sum(e.qty) filter (where e.round = 2) as r2,
         sum(e.qty) filter (where e.round = 3) as r3,
         count(distinct e.counted_by) as counters
  from public.wh_count_events e
  where e.item_id is not null
    and not exists (select 1 from public.wh_count_events s where s.supersedes_id = e.id)
  group by e.campaign_id, e.location_id, e.item_id
) g on g.campaign_id = c.id
join public.wh_items i on i.id = g.item_id
join public.wh_locations loc on loc.id = g.location_id
left join lateral (
  select coalesce(bool_or(k.round = 2), false) as has2, coalesce(bool_or(k.round = 3), false) as has3
  from public.wh_count_closures k where k.campaign_id = g.campaign_id and k.location_id = g.location_id
) cl on true
left join lateral (
  select dd.final_qty, dd.decision, dd.decided_at
  from public.wh_count_decisions dd
  where dd.campaign_id = g.campaign_id and dd.location_id = g.location_id and dd.item_id = g.item_id
  order by dd.chain_seq desc limit 1
) d on true;

-- Progresso por rua atribuída: quantos endereços contáveis debaixo dela já
-- foram finalizados na rodada da atribuição.
create view public.v_wh_campaign_progress with (security_invoker = true) as
select
  a.site_key, a.campaign_id, a.location_id as assigned_location_id, loc.full_code as assigned_code,
  a.team_id, t.name as team_name, a.round,
  count(l.id) as total_addresses,
  count(l.id) filter (where exists (
    select 1 from public.wh_count_closures k
     where k.campaign_id = a.campaign_id and k.location_id = l.id and k.round = a.round)) as counted_addresses,
  round(100.0 * count(l.id) filter (where exists (
    select 1 from public.wh_count_closures k
     where k.campaign_id = a.campaign_id and k.location_id = l.id and k.round = a.round))
    / nullif(count(l.id), 0), 1) as pct_done
from public.wh_campaign_assignments a
join public.wh_locations loc on loc.id = a.location_id
join public.wh_teams t on t.id = a.team_id
left join public.wh_locations l on a.location_id = any (l.path) and l.is_countable and l.active
group by a.site_key, a.campaign_id, a.location_id, loc.full_code, a.team_id, t.name, a.round;

-- "Onde está o item X?": última decisão aprovada de cada item em cada endereço.
create view public.v_wh_item_whereabouts with (security_invoker = true) as
select * from (
  select distinct on (d.site_key, d.location_id, d.item_id)
    d.site_key, d.location_id, loc.full_code as location_code, d.item_id,
    i.code as item_code, i.vale_material_code, i.description as item_description,
    d.final_qty, d.campaign_id, d.decided_at
  from public.wh_count_decisions d
  join public.wh_locations loc on loc.id = d.location_id
  join public.wh_items i on i.id = d.item_id
  order by d.site_key, d.location_id, d.item_id, d.chain_seq desc
) x
where x.final_qty > 0;

-- ============================================================
-- 7. RLS -- ligada em TODAS as tabelas, nenhuma sem política
-- ============================================================
alter table public.wh_site_settings enable row level security;
alter table public.wh_locations enable row level security;
alter table public.wh_items enable row level security;
alter table public.wh_item_costs enable row level security;
alter table public.wh_item_cost_history enable row level security;
alter table public.wh_item_barcodes enable row level security;
alter table public.wh_teams enable row level security;
alter table public.wh_team_members enable row level security;
alter table public.wh_campaigns enable row level security;
alter table public.wh_campaign_assignments enable row level security;
alter table public.wh_expected_stock enable row level security;
alter table public.wh_unidentified_items enable row level security;
alter table public.wh_count_events enable row level security;
alter table public.wh_count_closures enable row level security;
alter table public.wh_recount_tasks enable row level security;
alter table public.wh_count_decisions enable row level security;
alter table public.wh_audit_log enable row level security;

-- Parâmetros: leem Supervisor/Gestor Vale/Admin; escreve Supervisor/Admin.
drop policy if exists "wh_settings_select" on public.wh_site_settings;
create policy "wh_settings_select" on public.wh_site_settings for select using (public.wh_site_viewer_all(site_key));
drop policy if exists "wh_settings_write" on public.wh_site_settings;
create policy "wh_settings_write" on public.wh_site_settings for all
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));

-- Endereços, itens, códigos de barras: todos os papéis leem (o operador
-- precisa pra bipar); escreve Supervisor/Admin.
drop policy if exists "wh_locations_select" on public.wh_locations;
create policy "wh_locations_select" on public.wh_locations for select using (public.wh_site_reader(site_key));
drop policy if exists "wh_locations_write" on public.wh_locations;
create policy "wh_locations_write" on public.wh_locations for all
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));

drop policy if exists "wh_items_select" on public.wh_items;
create policy "wh_items_select" on public.wh_items for select using (public.wh_site_reader(site_key));
drop policy if exists "wh_items_write" on public.wh_items;
create policy "wh_items_write" on public.wh_items for all
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));

drop policy if exists "wh_barcodes_select" on public.wh_item_barcodes;
create policy "wh_barcodes_select" on public.wh_item_barcodes for select using (public.wh_site_reader(site_key));
drop policy if exists "wh_barcodes_write" on public.wh_item_barcodes;
create policy "wh_barcodes_write" on public.wh_item_barcodes for all
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));

-- Custos: o operador NÃO lê (não deve saber quanto vale o que conta).
drop policy if exists "wh_costs_select" on public.wh_item_costs;
create policy "wh_costs_select" on public.wh_item_costs for select using (public.wh_site_viewer_all(site_key));
drop policy if exists "wh_costs_write" on public.wh_item_costs;
create policy "wh_costs_write" on public.wh_item_costs for all
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));
drop policy if exists "wh_cost_history_select" on public.wh_item_cost_history;
create policy "wh_cost_history_select" on public.wh_item_cost_history for select using (public.wh_site_viewer_all(site_key));

-- Equipes: o operador vê as equipes de que participa.
drop policy if exists "wh_team_members_select" on public.wh_team_members;
create policy "wh_team_members_select" on public.wh_team_members for select
  using (public.wh_site_viewer_all(site_key) or (public.wh_site_reader(site_key) and profile_id = auth.uid()));
drop policy if exists "wh_team_members_write" on public.wh_team_members;
create policy "wh_team_members_write" on public.wh_team_members for all
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));

drop policy if exists "wh_teams_select" on public.wh_teams;
create policy "wh_teams_select" on public.wh_teams for select
  using (
    public.wh_site_viewer_all(site_key)
    or (public.wh_site_reader(site_key)
        and exists (select 1 from public.wh_team_members m where m.team_id = wh_teams.id and m.profile_id = auth.uid()))
  );
drop policy if exists "wh_teams_write" on public.wh_teams;
create policy "wh_teams_write" on public.wh_teams for all
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));

-- Campanhas: todos leem (o operador escolhe a campanha ativa); escreve Supervisor/Admin.
drop policy if exists "wh_campaigns_select" on public.wh_campaigns;
create policy "wh_campaigns_select" on public.wh_campaigns for select using (public.wh_site_reader(site_key));
drop policy if exists "wh_campaigns_write" on public.wh_campaigns;
create policy "wh_campaigns_write" on public.wh_campaigns for all
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));

drop policy if exists "wh_assignments_select" on public.wh_campaign_assignments;
create policy "wh_assignments_select" on public.wh_campaign_assignments for select
  using (
    public.wh_site_viewer_all(site_key)
    or (public.wh_site_reader(site_key)
        and exists (select 1 from public.wh_team_members m
                     where m.team_id = wh_campaign_assignments.team_id and m.profile_id = auth.uid()))
  );
drop policy if exists "wh_assignments_write" on public.wh_campaign_assignments;
create policy "wh_assignments_write" on public.wh_campaign_assignments for all
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));

-- Saldo esperado: NENHUMA política para o operador = contagem cega.
drop policy if exists "wh_expected_select" on public.wh_expected_stock;
create policy "wh_expected_select" on public.wh_expected_stock for select using (public.wh_site_viewer_all(site_key));
drop policy if exists "wh_expected_write" on public.wh_expected_stock;
create policy "wh_expected_write" on public.wh_expected_stock for all
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));

-- Contagens: o operador lê só as próprias; supervisor/gestor/admin leem tudo.
-- NÃO existe política de UPDATE nem DELETE (e há trigger bloqueando também).
drop policy if exists "wh_events_select" on public.wh_count_events;
create policy "wh_events_select" on public.wh_count_events for select
  using (public.wh_site_viewer_all(site_key) or (public.wh_site_reader(site_key) and counted_by = auth.uid()));
drop policy if exists "wh_events_insert" on public.wh_count_events;
create policy "wh_events_insert" on public.wh_count_events for insert
  with check (public.wh_site_counter(site_key) and counted_by = auth.uid());

drop policy if exists "wh_closures_select" on public.wh_count_closures;
create policy "wh_closures_select" on public.wh_count_closures for select
  using (public.wh_site_viewer_all(site_key) or (public.wh_site_reader(site_key) and counted_by = auth.uid()));
drop policy if exists "wh_closures_insert" on public.wh_count_closures;
create policy "wh_closures_insert" on public.wh_count_closures for insert
  with check (public.wh_site_counter(site_key) and counted_by = auth.uid());

drop policy if exists "wh_unid_select" on public.wh_unidentified_items;
create policy "wh_unid_select" on public.wh_unidentified_items for select
  using (public.wh_site_viewer_all(site_key) or (public.wh_site_reader(site_key) and reported_by = auth.uid()));
drop policy if exists "wh_unid_insert" on public.wh_unidentified_items;
create policy "wh_unid_insert" on public.wh_unidentified_items for insert
  with check (public.wh_site_counter(site_key) and reported_by = auth.uid());
drop policy if exists "wh_unid_update" on public.wh_unidentified_items;
create policy "wh_unid_update" on public.wh_unidentified_items for update
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));

-- Recontagens: o operador vê as tarefas da própria equipe (ou sem equipe definida).
drop policy if exists "wh_tasks_select" on public.wh_recount_tasks;
create policy "wh_tasks_select" on public.wh_recount_tasks for select
  using (
    public.wh_site_viewer_all(site_key)
    or (public.wh_site_reader(site_key) and (
          assigned_team_id is null
          or exists (select 1 from public.wh_team_members m
                      where m.team_id = wh_recount_tasks.assigned_team_id and m.profile_id = auth.uid())))
  );
drop policy if exists "wh_tasks_write" on public.wh_recount_tasks;
create policy "wh_tasks_write" on public.wh_recount_tasks for all
  using (public.wh_site_supervisor(site_key)) with check (public.wh_site_supervisor(site_key));

-- Decisões: leem Supervisor/Gestor Vale/Admin; só Supervisor/Admin decidem.
drop policy if exists "wh_decisions_select" on public.wh_count_decisions;
create policy "wh_decisions_select" on public.wh_count_decisions for select using (public.wh_site_viewer_all(site_key));
drop policy if exists "wh_decisions_insert" on public.wh_count_decisions;
create policy "wh_decisions_insert" on public.wh_count_decisions for insert
  with check (public.wh_site_supervisor(site_key) and decided_by = auth.uid());

-- Auditoria: só leitura (a escrita vem dos triggers `security definer`).
drop policy if exists "wh_audit_select" on public.wh_audit_log;
create policy "wh_audit_select" on public.wh_audit_log for select using (public.wh_site_viewer_all(site_key));

-- ============================================================
-- 8. STORAGE: fotos do armazém (bucket PRIVADO, ao contrário do
-- `closure-photos`, que é público). Caminho do arquivo:
--   <site_key>/<campaign_id>/<id_do_evento>.jpg
-- A primeira pasta é o site e é ela que a política confere.
-- Sem política de UPDATE/DELETE: foto é evidência.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('warehouse-photos', 'warehouse-photos', false)
on conflict (id) do update set public = false;

drop policy if exists "wh_photos_insert" on storage.objects;
create policy "wh_photos_insert" on storage.objects for insert
  with check (bucket_id = 'warehouse-photos' and public.wh_site_counter((storage.foldername(name))[1]));

drop policy if exists "wh_photos_select" on storage.objects;
create policy "wh_photos_select" on storage.objects for select
  using (
    bucket_id = 'warehouse-photos'
    and (
      public.wh_site_viewer_all((storage.foldername(name))[1])
      or (public.wh_site_reader((storage.foldername(name))[1]) and owner = auth.uid())
    )
  );

-- ============================================================
-- PRÓXIMOS PASSOS (manuais, uma vez):
--  1. Cadastrar usuários com os perfis "ARM_*" (pela tela de Usuários do app
--     principal) e liberar o site "VGR - Armazém" pra cada um (profile_sites).
--  2. Conferir a trilha de tempos em tempos:
--       select * from wh_verify_chain('VGR_ARMAZEM', 'wh_count_events');
--       select * from wh_verify_chain('VGR_ARMAZEM', 'wh_count_closures');
--       select * from wh_verify_chain('VGR_ARMAZEM', 'wh_count_decisions');
--       select * from wh_verify_chain('VGR_ARMAZEM', 'wh_audit_log');
-- ============================================================
