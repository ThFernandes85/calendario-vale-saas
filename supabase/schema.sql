-- ============================================================
-- TerraVia Ops — schema (Supabase / Postgres)
-- Cole este script INTEIRO no SQL Editor do Supabase e clique em "Run".
--
-- Este script é SEGURO de rodar quantas vezes precisar em produção: ele
-- só cria o que ainda não existe (tabelas, colunas, políticas, bucket)
-- e nunca apaga tabelas nem dados. Rodar de novo para aplicar uma
-- atualização (ex: uma coluna nova) não afeta sites, áreas, equipamentos,
-- usuários, agendamentos ou histórico já cadastrados.
-- ============================================================

create extension if not exists "pgcrypto";

-- ============================================================
-- MULTI-EMPRESA (Fase 1 -- fundação de isolamento entre empresas)
-- Hoje só existe a empresa "Sodexo", mas a plataforma foi pensada pra um
-- dia atender mais de uma empresa ao mesmo tempo (cada uma com seus
-- próprios sites/usuários/dados, sem nenhuma enxergar a outra). "Sodexo"
-- continua sendo o nome fixo da empresa operadora da plataforma -- é o
-- lado "cliente" de cada site (hoje "Vale") que no futuro varia por
-- empresa; essa parte de marca/rótulo fica pra uma fase posterior, esta
-- aqui é só o isolamento de dados no banco.
-- ---------- COMPANIES ----------
create table if not exists public.companies (
  key text primary key,
  label text not null,
  created_at timestamptz default now()
);

-- ---------- SITES ----------
create table if not exists public.sites (
  key text primary key,
  label text not null,
  created_at timestamptz default now()
);

-- ---------- AREAS ----------
create table if not exists public.areas (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key) on delete cascade,
  code text not null,
  label text not null,
  created_at timestamptz default now(),
  unique (site_key, code)
);

-- ---------- EQUIPMENT ----------
create table if not exists public.equipment (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key) on delete cascade,
  area_code text not null,
  tag text not null,
  created_at timestamptz default now(),
  unique (site_key, tag)
);

-- ---------- PROFILES (estende auth.users) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null check (role in ('ADMIN','PCM','PCO','PCM_PCO','ENG_CONF','ENG_EST','ENCARREGADO')),
  can_export boolean not null default false,
  active boolean not null default true,
  created_at timestamptz default now()
);
-- Libera roles novas em bancos criados antes delas existirem (tabela já
-- existente não ganha a nova lista do "check" acima sozinha). CLIENTE_VALE
-- é o contato da Vale que aprova/reprova as limpezas do S11D.
-- TECNICO_PLANEJAMENTO é o técnico de Planejamento e GU do S11D (agenda e
-- acompanha o valor das limpezas do site).
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
    check (role in ('ADMIN','PCM','PCO','PCM_PCO','ENG_CONF','ENG_EST','ENCARREGADO','CLIENTE_VALE','TECNICO_PLANEJAMENTO'));
end $$;

-- WhatsApp do Encarregado (opcional -- nem todo mundo vai ter cadastrado de
-- cara). Usado pra alertas automáticos (ver WHATSAPP ALERTS mais abaixo).
alter table public.profiles add column if not exists whatsapp text;

-- ---------- PROFILE_SITES (quais sites cada perfil acessa) ----------
create table if not exists public.profile_sites (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  site_key text not null references public.sites(key) on delete cascade,
  primary key (profile_id, site_key)
);

-- ---------- BOOKINGS (agendamentos) ----------
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key) on delete cascade,
  tag text not null,
  area_code text not null,
  date date not null,
  start_min int not null,
  end_min int not null,
  type text not null,
  emergencial boolean not null default false,
  om text,
  justification text not null,
  operator_id uuid references public.profiles(id) on delete set null,
  operator_label text not null,
  created_at timestamptz default now()
);
-- Colunas de encerramento (adicionadas depois da criação inicial da tabela
-- em algumas instalações -- "add column if not exists" cobre os dois casos:
-- tabela nova, que já nasce com elas, e tabela existente, que só ganha o que falta).
alter table public.bookings add column if not exists closure_status text;
alter table public.bookings add column if not exists closure_reason text;
alter table public.bookings add column if not exists closure_photo_before text;
alter table public.bookings add column if not exists closure_photo_after text;
alter table public.bookings add column if not exists closed_at timestamptz;
alter table public.bookings add column if not exists closed_by uuid references public.profiles(id) on delete set null;
-- ============================================================
-- S11D — workflow de aprovação do cliente (Vale)
-- Site com sistemática própria (limpeza predial, sem OM): o encarregado
-- encerra com fotos mas fica "Aguardando Aprovação Vale" -- só conta na
-- nota depois que o cliente aprova/reprova/marca pendência, com
-- justificativa. Ver sites.client_approval_workflow mais abaixo.
-- ============================================================
alter table public.sites add column if not exists client_approval_workflow boolean not null default false;

-- m² e R$/m² -- ficam no ATIVO (sub-área, ex: STAFF01), não na área "mãe"
-- (ex: TAMANDUÁ), já que cada sub-área tem sua própria metragem. Só pra
-- exibir o valor calculado (m² × R$/m²) da limpeza daquele ativo; não é um
-- motor de faturamento.
alter table public.equipment add column if not exists m2 numeric;
alter table public.equipment add column if not exists valor_m2 numeric;

-- Decisão MAIS RECENTE do Cliente Vale sobre um bloqueio (o histórico
-- completo de decisões/reclassificações fica registrado no audit_log, uma
-- linha por decisão -- essas colunas só guardam o estado atual).
alter table public.bookings add column if not exists vale_decision_reason text;
alter table public.bookings add column if not exists vale_decided_at timestamptz;
alter table public.bookings add column if not exists vale_decided_by uuid references public.profiles(id) on delete set null;
-- Fotos além de antes/depois (ex: "durante", do workflow S11D). Formato:
-- [{"tipo":"durante","url":"..."}]. As colunas closure_photo_before/after
-- continuam existindo e sem uso alterado.
alter table public.bookings add column if not exists closure_photos_extra jsonb not null default '[]'::jsonb;

-- Recria o check de closure_status pra incluir os 4 status novos do
-- workflow S11D, sem perder nenhum dos 5 originais.
do $$
begin
  if exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where c.conname = 'bookings_closure_status_check' and t.relname = 'bookings'
  ) then
    alter table public.bookings drop constraint bookings_closure_status_check;
  end if;
  alter table public.bookings add constraint bookings_closure_status_check
    check (closure_status in (
      'ENCERRADA','REPROGRAMADA','PENDENTE','PENDENTE_VALE','PENDENTE_SODEXO',
      'AGUARDANDO_APROVACAO_VALE','APROVADO_VALE','REPROVADO_VALE','PENDENCIA_VALE'
    ));
end $$;

-- ---------- COLLABORATORS (quadro de colaboradores do S11D) ----------
-- Cadastro simples por site (nome + cargo): o Encarregado marca quem
-- executou cada limpeza ao encerrar no Mobile -- pode ser mais de um (áreas
-- maiores têm 3+ executantes). A coluna nova em `bookings` guarda a lista
-- DENORMALIZADA ([{"name":...,"role":...}, ...], copiada na hora do
-- encerramento, como já acontece com operator_label) -- assim o histórico
-- não muda se algum colaborador for depois renomeado ou excluído do cadastro.
create table if not exists public.collaborators (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key) on delete cascade,
  name text not null,
  role text not null,
  created_at timestamptz default now()
);
-- collaborator_name/collaborator_role (colunas singulares antigas) foram
-- substituídas por `collaborators` (lista) antes de irem pra produção.
alter table public.bookings drop column if exists collaborator_name;
alter table public.bookings drop column if exists collaborator_role;
alter table public.bookings add column if not exists collaborators jsonb not null default '[]'::jsonb;

-- ---------- WHATSAPP ALERTS (fila) ----------
-- Fase de "encanamento": monta a fila de alertas certinha (quem recebe,
-- quando, com qual texto) mas ainda NÃO manda mensagem nenhuma de verdade --
-- falta você criar/contratar uma conta de WhatsApp Business API (Meta Cloud
-- API direto, ou um provedor como Twilio/Z-API). Só a Edge Function
-- `whatsapp-alerts-worker` e o trigger abaixo escrevem/leem aqui -- não tem
-- política de RLS pra "anon"/"authenticated" de propósito, ninguém logado
-- no app lê ou escreve nessa tabela direto.
create table if not exists public.whatsapp_alerts_queue (
  id uuid primary key default gen_random_uuid(),
  site_key text references public.sites(key) on delete cascade,
  company_key text references public.companies(key),
  booking_id uuid references public.bookings(id) on delete cascade,
  event_type text not null check (event_type in ('UPCOMING_BOOKING','OVERDUE_BOOKING','VALE_DECISION_MADE')),
  recipient_profile_id uuid references public.profiles(id) on delete set null,
  recipient_phone text not null,
  message_body text not null,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  error_message text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- Dispara quando a Vale aprova/reprova/marca pendência num S11D -- avisa o
-- Encarregado que fez o serviço (bookings.closed_by), não quem decidiu.
-- UPCOMING_BOOKING/OVERDUE_BOOKING não têm gatilho de linha (dependem do
-- relógio, não de uma mudança no banco) -- são varridos periodicamente pela
-- mesma Edge Function, agendada via Cron Jobs do Supabase.
create or replace function public.enqueue_vale_decision_alert()
returns trigger language plpgsql security definer as $$
declare
  v_company_key text;
  v_phone text;
  v_msg text;
begin
  if new.closure_status not in ('APROVADO_VALE','REPROVADO_VALE','PENDENCIA_VALE') then
    return new;
  end if;
  if old.closure_status is not distinct from new.closure_status then
    return new;
  end if;
  if new.closed_by is null then
    return new;
  end if;
  select company_key, whatsapp into v_company_key, v_phone
    from public.profiles where id = new.closed_by;
  if v_phone is null or v_phone = '' then
    return new; -- Encarregado sem WhatsApp cadastrado: não tem pra quem mandar
  end if;
  v_msg := case new.closure_status
    when 'APROVADO_VALE' then 'Vale APROVOU a limpeza ' || new.tag || ' (OM ' || coalesce(new.om, '—') || ').'
    when 'REPROVADO_VALE' then 'Vale REPROVOU a limpeza ' || new.tag || ' (OM ' || coalesce(new.om, '—') || '). Motivo: ' || coalesce(new.vale_decision_reason, '—')
    else 'Vale marcou PENDÊNCIA na limpeza ' || new.tag || ' (OM ' || coalesce(new.om, '—') || '). Motivo: ' || coalesce(new.vale_decision_reason, '—')
  end;
  insert into public.whatsapp_alerts_queue
    (site_key, company_key, booking_id, event_type, recipient_profile_id, recipient_phone, message_body)
  values
    (new.site_key, v_company_key, new.id, 'VALE_DECISION_MADE', new.closed_by, v_phone, v_msg);
  return new;
end;
$$;
drop trigger if exists trg_enqueue_vale_decision_alert on public.bookings;
create trigger trg_enqueue_vale_decision_alert after update on public.bookings
for each row execute function public.enqueue_vale_decision_alert();

-- ---------- AUDIT LOG ----------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  site_key text references public.sites(key) on delete cascade,
  tag text,
  area_code text,
  acao text not null,
  justificativa text,
  operador_label text,
  role text,
  username text,
  om text,
  agendamento_data date,
  agendamento_horario text,
  data_hora timestamptz not null default now(),
  profile_id uuid references public.profiles(id) on delete set null
);

-- ---------- MULTI-EMPRESA: colunas de empresa + dado inicial ----------
-- site e usuário sempre pertencem a exatamente uma empresa; audit_log
-- também guarda a empresa (inclusive nas linhas "globais", sem site_key,
-- como login/logout) pra dar pra filtrar por empresa sem depender do site.
alter table public.sites    add column if not exists company_key text references public.companies(key);
alter table public.profiles add column if not exists company_key text references public.companies(key);
alter table public.audit_log add column if not exists company_key text references public.companies(key);

-- Empresa única de hoje -- todo dado que já existe fica associado a ela
-- (backfill idempotente: só preenche linhas que ainda estão null).
insert into public.companies (key, label) values ('SODEXO', 'Sodexo')
on conflict (key) do nothing;

-- "Cliente Integrado": nome do cliente final que essa empresa atende (ex:
-- hoje a Sodexo atende a Vale) -- mostrado no badge da barra lateral.
-- Editável só por SQL por enquanto (criar/editar empresa continua manual).
alter table public.companies add column if not exists client_label text;
update public.companies set client_label = 'Vale' where key = 'SODEXO' and client_label is null;

update public.sites     set company_key = 'SODEXO' where company_key is null;
update public.profiles  set company_key = 'SODEXO' where company_key is null;
update public.audit_log set company_key = 'SODEXO' where company_key is null;
-- "set not null" é idempotente -- não faz nada se a coluna já não aceita
-- null, então rodar o script de novo nunca dá erro aqui.
alter table public.sites    alter column company_key set not null;
alter table public.profiles alter column company_key set not null;

-- Carimba company_key em toda linha nova de audit_log no servidor (nunca
-- confiando em valor vindo do cliente) -- puxa do site quando a linha tem
-- site_key, ou do próprio perfil de quem está logado quando é uma entrada
-- global (site_key null, ex: login/logout).
create or replace function public.stamp_audit_company()
returns trigger language plpgsql security definer as $$
begin
  if new.site_key is not null then
    new.company_key := (select company_key from public.sites where key = new.site_key);
  else
    new.company_key := (select company_key from public.profiles where id = auth.uid());
  end if;
  return new;
end;
$$;
drop trigger if exists trg_stamp_audit_company on public.audit_log;
create trigger trg_stamp_audit_company before insert on public.audit_log
for each row execute function public.stamp_audit_company();

-- ============================================================
-- FUNÇÕES AUXILIARES (usadas nas políticas de segurança abaixo)
-- `create or replace` atualiza a função sem apagar tabelas nem dados.
-- ============================================================

create or replace function public.is_admin()
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'ADMIN' and active = true
  );
$$;

-- Empresa do usuário logado -- null pra quem não tem linha em `profiles`
-- (ex: sessão Visitante/anônima), tratado à parte dentro de has_site_access.
create or replace function public.my_company()
returns text language sql stable security definer as $$
  select company_key from public.profiles where id = auth.uid();
$$;

-- Pré-requisito de empresa: o site tem que pertencer à MESMA empresa do
-- usuário logado, sempre -- mesmo pro Admin (Admin de uma empresa nunca
-- enxerga site de outra). Essa checagem sozinha já isola quase todo o
-- resto do app, porque quase toda política de segurança abaixo passa por
-- esta função (áreas, ativos, agendamentos, colaboradores, auditoria).
create or replace function public.has_site_access(p_site_key text)
returns boolean language sql stable security definer as $$
  select
    exists (
      select 1 from public.sites s
      where s.key = p_site_key and s.company_key = public.my_company()
    )
    and (
      public.is_admin()
      or (
        -- Visitante (login anônimo) não tem linha em `profiles`, então
        -- my_company() acima dá null pra ele -- a empresa dele vem do
        -- token de login em vez disso (ver app: signInAnonymously com
        -- company_key nos metadados). Sem esse dado no token, não vê nada
        -- -- comportamento seguro por padrão, não um "vê tudo" acidental.
        coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
        and exists (
          select 1 from public.sites s
          where s.key = p_site_key
          and s.company_key = (auth.jwt() -> 'user_metadata' ->> 'company_key')
        )
      )
      or exists (
        select 1 from public.profile_sites ps
        join public.profiles p on p.id = ps.profile_id
        where ps.profile_id = auth.uid() and ps.site_key = p_site_key and p.active = true
      )
    );
$$;

create or replace function public.current_role_key()
returns text language sql stable security definer as $$
  select role from public.profiles where id = auth.uid();
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- (idempotente: "enable" de novo numa tabela que já tem RLS ligado não faz nada)
-- ============================================================
alter table public.companies enable row level security;
alter table public.sites enable row level security;
alter table public.areas enable row level security;
alter table public.equipment enable row level security;
alter table public.collaborators enable row level security;
alter table public.profiles enable row level security;
alter table public.profile_sites enable row level security;
alter table public.bookings enable row level security;
alter table public.audit_log enable row level security;
-- whatsapp_alerts_queue: RLS ligado, sem nenhuma política pra
-- anon/authenticated de propósito -- só a service_role key (Edge Function e
-- trigger `security definer`) toca nessa tabela; ninguém logado no app lê
-- ou escreve nela diretamente.
alter table public.whatsapp_alerts_queue enable row level security;

-- Toda política abaixo é recriada com "drop policy if exists" + "create
-- policy" -- assim, rodar o script de novo para ajustar uma regra nunca
-- dá erro de "política já existe" nem precisa apagar a tabela.

-- COMPANIES: cada empresa só enxerga a própria linha (não tem "escrita"
-- por RLS -- criar empresa nova é feito manualmente pelo dono da
-- plataforma, direto no SQL Editor, igual já é feito pro primeiro Admin).
-- O Visitante (anônimo) não tem linha em `profiles`, então `my_company()`
-- não funciona pra ele -- mesmo tratamento especial que `has_site_access`
-- já dá, olhando a empresa direto no token de login.
drop policy if exists "companies_select" on public.companies;
create policy "companies_select" on public.companies for select
  using (
    key = public.my_company()
    or (
      coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
      and key = (auth.jwt() -> 'user_metadata' ->> 'company_key')
    )
  );

-- SITES: leitura para quem tem acesso; escrita só Admin DA MESMA EMPRESA
-- do site (nunca de outra).
drop policy if exists "sites_select" on public.sites;
create policy "sites_select" on public.sites for select
  using (public.has_site_access(key));
drop policy if exists "sites_admin_write" on public.sites;
create policy "sites_admin_write" on public.sites for all
  using (public.is_admin() and company_key = public.my_company())
  with check (public.is_admin() and company_key = public.my_company());

-- AREAS
drop policy if exists "areas_select" on public.areas;
create policy "areas_select" on public.areas for select
  using (public.has_site_access(site_key));
-- Técnico de Planejamento e GU também cria/gerencia áreas -- só nos sites
-- em que tem acesso (profile_sites), diferente do Admin, que gerencia
-- qualquer site DA PRÓPRIA EMPRESA. has_site_access já exige que o site
-- pertença à empresa de quem está logado (inclusive pro Admin) -- por
-- isso ele entra como pré-requisito único, em vez de is_admin() solto.
drop policy if exists "areas_admin_write" on public.areas;
create policy "areas_admin_write" on public.areas for all
  using (public.has_site_access(site_key) and (public.is_admin() or public.current_role_key() = 'TECNICO_PLANEJAMENTO'))
  with check (public.has_site_access(site_key) and (public.is_admin() or public.current_role_key() = 'TECNICO_PLANEJAMENTO'));

-- EQUIPMENT
drop policy if exists "equipment_select" on public.equipment;
create policy "equipment_select" on public.equipment for select
  using (public.has_site_access(site_key));
drop policy if exists "equipment_admin_write" on public.equipment;
create policy "equipment_admin_write" on public.equipment for all
  using (public.has_site_access(site_key) and (public.is_admin() or public.current_role_key() = 'TECNICO_PLANEJAMENTO'))
  with check (public.has_site_access(site_key) and (public.is_admin() or public.current_role_key() = 'TECNICO_PLANEJAMENTO'));

-- COLLABORATORS (quadro de colaboradores do S11D)
drop policy if exists "collaborators_select" on public.collaborators;
create policy "collaborators_select" on public.collaborators for select
  using (public.has_site_access(site_key));
drop policy if exists "collaborators_admin_write" on public.collaborators;
create policy "collaborators_admin_write" on public.collaborators for all
  using (public.has_site_access(site_key) and (public.is_admin() or public.current_role_key() = 'TECNICO_PLANEJAMENTO'))
  with check (public.has_site_access(site_key) and (public.is_admin() or public.current_role_key() = 'TECNICO_PLANEJAMENTO'));

-- PROFILES: cada um vê o próprio perfil; Admin vê/edita todos DA MESMA
-- EMPRESA (nunca de outra -- profiles não tem site_key, então o recorte
-- de empresa é feito direto pela coluna company_key da própria tabela).
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles for select
  using (id = auth.uid() or (public.is_admin() and company_key = public.my_company()));
drop policy if exists "profiles_admin_write" on public.profiles;
create policy "profiles_admin_write" on public.profiles for all
  using (public.is_admin() and company_key = public.my_company())
  with check (public.is_admin() and company_key = public.my_company());

-- PROFILE_SITES (não tem company_key própria -- alcança a empresa via
-- profiles/sites; a escrita confere os DOIS lados do vínculo, pra não
-- deixar ligar um perfil de uma empresa a um site de outra por engano).
drop policy if exists "profile_sites_select" on public.profile_sites;
create policy "profile_sites_select" on public.profile_sites for select
  using (
    profile_id = auth.uid()
    or (
      public.is_admin()
      and exists (select 1 from public.profiles p where p.id = profile_sites.profile_id and p.company_key = public.my_company())
    )
  );
drop policy if exists "profile_sites_admin_write" on public.profile_sites;
create policy "profile_sites_admin_write" on public.profile_sites for all
  using (
    public.is_admin()
    and exists (select 1 from public.profiles p where p.id = profile_sites.profile_id and p.company_key = public.my_company())
    and exists (select 1 from public.sites    s where s.key = profile_sites.site_key   and s.company_key = public.my_company())
  )
  with check (
    public.is_admin()
    and exists (select 1 from public.profiles p where p.id = profile_sites.profile_id and p.company_key = public.my_company())
    and exists (select 1 from public.sites    s where s.key = profile_sites.site_key   and s.company_key = public.my_company())
  );

-- BOOKINGS: leitura restrita ao site; criação/exclusão restrita por perfil + tipo
drop policy if exists "bookings_select" on public.bookings;
create policy "bookings_select" on public.bookings for select
  using (public.has_site_access(site_key));
drop policy if exists "bookings_insert" on public.bookings;
create policy "bookings_insert" on public.bookings for insert
  with check (
    public.has_site_access(site_key)
    and (
      public.is_admin()
      or (public.current_role_key() = 'PCM' and type in ('Manutenção Preventiva','Manutenção Corretiva'))
      or (public.current_role_key() = 'PCO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
      or (public.current_role_key() = 'ENCARREGADO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
      or (public.current_role_key() = 'PCM_PCO' and type in ('Manutenção Preventiva','Manutenção Corretiva','Limpeza Sodexo','Limpeza Mecanizada'))
      -- Técnico de Planejamento e GU (S11D) programa as limpezas do site.
      or (public.current_role_key() = 'TECNICO_PLANEJAMENTO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
    )
  );
drop policy if exists "bookings_delete" on public.bookings;
create policy "bookings_delete" on public.bookings for delete
  using (
    public.has_site_access(site_key)
    and (
      public.is_admin()
      or (public.current_role_key() = 'PCM' and type in ('Manutenção Preventiva','Manutenção Corretiva'))
      or (public.current_role_key() = 'PCO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
      -- ENCARREGADO só exclui o PRÓPRIO lançamento (autoatendimento de OM
      -- duplicada no app mobile) -- diferente de PCM/PCO/Admin, que podem
      -- excluir qualquer um do tipo que administram.
      or (public.current_role_key() = 'ENCARREGADO' and type in ('Limpeza Sodexo','Limpeza Mecanizada') and operator_id = auth.uid())
      or (public.current_role_key() = 'PCM_PCO' and type in ('Manutenção Preventiva','Manutenção Corretiva','Limpeza Sodexo','Limpeza Mecanizada'))
      or (public.current_role_key() = 'TECNICO_PLANEJAMENTO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
    )
  );
drop policy if exists "bookings_update" on public.bookings;
create policy "bookings_update" on public.bookings for update
  using (
    public.has_site_access(site_key)
    and (
      public.is_admin()
      or (public.current_role_key() = 'PCM' and type in ('Manutenção Preventiva','Manutenção Corretiva'))
      or (public.current_role_key() = 'PCO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
      or (public.current_role_key() = 'ENCARREGADO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
      or (public.current_role_key() = 'PCM_PCO' and type in ('Manutenção Preventiva','Manutenção Corretiva','Limpeza Sodexo','Limpeza Mecanizada'))
      -- Cliente Vale só aprova/reprova/marca pendência em Limpeza Sodexo
      -- (a decisão do workflow S11D) -- nunca em Manutenção.
      or (public.current_role_key() = 'CLIENTE_VALE' and type = 'Limpeza Sodexo')
      or (public.current_role_key() = 'TECNICO_PLANEJAMENTO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
    )
  )
  with check (
    public.has_site_access(site_key)
    and (
      public.is_admin()
      or (public.current_role_key() = 'PCM' and type in ('Manutenção Preventiva','Manutenção Corretiva'))
      or (public.current_role_key() = 'PCO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
      or (public.current_role_key() = 'ENCARREGADO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
      or (public.current_role_key() = 'PCM_PCO' and type in ('Manutenção Preventiva','Manutenção Corretiva','Limpeza Sodexo','Limpeza Mecanizada'))
      or (public.current_role_key() = 'CLIENTE_VALE' and type = 'Limpeza Sodexo')
      or (public.current_role_key() = 'TECNICO_PLANEJAMENTO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
    )
  );

-- AUDIT LOG: entradas de um site exigem acesso ao site; entradas globais
-- (login/logout, gestão de usuários) só o Admin vê. Inserção liberada a
-- qualquer usuário autenticado (é o próprio app que decide o conteúdo).
drop policy if exists "audit_select" on public.audit_log;
create policy "audit_select" on public.audit_log for select
  using (
    (site_key is not null and public.has_site_access(site_key))
    or (site_key is null and public.is_admin() and company_key = public.my_company())
  );
drop policy if exists "audit_insert" on public.audit_log;
create policy "audit_insert" on public.audit_log for insert
  with check (auth.uid() is not null);
drop policy if exists "audit_admin_delete" on public.audit_log;
create policy "audit_admin_delete" on public.audit_log for delete
  using (public.is_admin() and company_key = public.my_company());

-- ============================================================
-- STORAGE: fotos de antes/depois anexadas ao encerrar um bloqueio
-- (bucket público — a URL fica salva em bookings.closure_photo_before/after)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('closure-photos', 'closure-photos', true)
on conflict (id) do update set public = true;

-- O caminho do arquivo sempre começa com o site_key (ver uploadClosurePhoto
-- no app: `${state.currentSite}/${booking.id}/...`) -- storage.foldername
-- devolve os pedaços do caminho como array, então [1] é o site. Antes esta
-- política só conferia "está logado", sem checar sequer o site, e dava pra
-- subir arquivo em qualquer pasta -- agora reaproveita has_site_access, já
-- com o recorte de empresa embutido.
drop policy if exists "closure_photos_insert" on storage.objects;
create policy "closure_photos_insert" on storage.objects for insert
  with check (bucket_id = 'closure-photos' and public.has_site_access((storage.foldername(name))[1]));

drop policy if exists "closure_photos_select" on storage.objects;
create policy "closure_photos_select" on storage.objects for select
  using (bucket_id = 'closure-photos');

drop policy if exists "closure_photos_admin_delete" on storage.objects;
create policy "closure_photos_admin_delete" on storage.objects for delete
  using (
    bucket_id = 'closure-photos'
    and public.is_admin()
    and exists (
      select 1 from public.sites s
      where s.key = (storage.foldername(name))[1] and s.company_key = public.my_company()
    )
  );

-- ============================================================
-- MIGRAÇÃO: renomeia o tipo 'Limpeza' para 'Limpeza Sodexo'
-- (deixa claro que é a limpeza feita pela própria Sodexo, em contraste
-- com 'Limpeza Mecanizada', prestada por outra empresa). Idempotente:
-- depois da primeira vez que rodar, não sobra nenhuma linha 'Limpeza'
-- para o UPDATE pegar, então rodar de novo não faz nada.
-- ============================================================
update public.bookings set type = 'Limpeza Sodexo' where type = 'Limpeza';

-- ============================================================
-- MIGRAÇÃO: move o equipamento 40MG01 da área TCLD para a área TOD
-- (o insert de dados iniciais abaixo usa "on conflict do nothing", então
-- não moveria um 40MG01 que já existe cadastrado em TCLD -- este UPDATE
-- garante a correção mesmo assim. Idempotente: rodar de novo não faz nada
-- se o equipamento já estiver em TOD.)
-- ============================================================
update public.equipment set area_code = 'TOD'
 where site_key = 'MUTUCA' and tag = '40MG01' and area_code = 'TCLD';

-- ============================================================
-- DADOS INICIAIS: site Mutuca (áreas + 93 equipamentos)
-- "on conflict do nothing" -- roda só uma vez de verdade: se o site/área/
-- equipamento já existir (mesma chave), o insert simplesmente não faz nada,
-- em vez de duplicar ou dar erro.
-- ============================================================
insert into public.sites (key, label, company_key) values ('MUTUCA', 'Mutuca', 'SODEXO')
on conflict (key) do nothing;

insert into public.areas (site_key, code, label) values
  ('MUTUCA', 'TOD', 'TOD'),
  ('MUTUCA', 'TCLD', 'TCLD'),
  ('MUTUCA', 'USINA', 'USINA'),
  ('MUTUCA', 'SBR', 'SBR'),
  ('MUTUCA', 'ITMS', 'ITM-S')
on conflict (site_key, code) do nothing;

insert into public.equipment (site_key, area_code, tag)
select 'MUTUCA', 'TOD', unnest(array[
  '40AL02','40EM01','40MG02','40SL01','40TC02','40TC03','40TC04','40TC05','CARREGAMENTO','40MG01'
])
union all
select 'MUTUCA', 'TCLD', unnest(array[
  '27TC15','27TC15A','27TC16B','27TC16A','33AL03','33TC17','27MG01','27MG02','27MG03','27MG04',
  '33TC18','33TC19','33TC20','GROTA ZERO','33SL02','27TC16'
])
union all
select 'MUTUCA', 'USINA', unnest(array[
  '21AL02','21AL03','21TC03','22BR02','22BR03','22BR04','22PE01','22PE02','22PE02A','22PE02B',
  '22TC04','22TC05','22TC08','23CE01A','23CE01B','23CE01C','23PE04A','23PE04B','23PE04C',
  '24BP01A','24BP01B','24BP01C','25BP01A','25BP01B','25BP01C','25BV01A','25BV01B','25BV01C',
  '26EX01','27EM01','27TC06','27TC07','27TC09','27TC10','27TC11','27TC12','27TC13','27TC14',
  'FV01A','FV01B','FV01C','FV01D','27TC08'
])
union all
select 'MUTUCA', 'SBR', unnest(array[
  '12AL01','12BR01','12DV01','12DV02','12PE02A','12PE02B','12TC01A','12TC02','12TC08',
  '12TC10A','12TC10B','12TC11A','12TC11B','12TC9A','12TC9B','12TC01'
])
union all
select 'MUTUCA', 'ITMS', unnest(array[
  '65EM01','65TC01','65TC02','65TC03','65TC04A','65TC05','65TC06','65TC07'
])
on conflict (site_key, tag) do nothing;

-- ============================================================
-- PRIMEIRO ADMIN (rode manualmente, uma vez, fora do bloco acima)
-- Depois de criar o usuário (com seu e-mail real) em
-- Authentication > Users > Add user (no painel do Supabase),
-- copie o UUID dele e rode a linha abaixo trocando SEU_UUID_AQUI:
-- ============================================================
-- insert into public.profiles (id, name, email, role, can_export, active, company_key)
-- values ('SEU_UUID_AQUI', 'Thiago Fernandes', 'seu.email@empresa.com', 'ADMIN', true, true, 'SODEXO')
-- on conflict (id) do update set role = 'ADMIN', active = true;

-- ============================================================
-- ZONA DE PERIGO: reset completo (NÃO faz parte do run normal)
-- Só descomente e rode isto isoladamente se você quiser mesmo apagar
-- TODOS os dados (sites, áreas, equipamentos, perfis, agendamentos,
-- histórico) e recomeçar do zero. Não existe undo depois de rodar.
-- ============================================================
-- drop table if exists public.whatsapp_alerts_queue cascade;
-- drop table if exists public.audit_log cascade;
-- drop table if exists public.collaborators cascade;
-- drop table if exists public.bookings cascade;
-- drop table if exists public.profile_sites cascade;
-- drop table if exists public.profiles cascade;
-- drop table if exists public.equipment cascade;
-- drop table if exists public.areas cascade;
-- drop table if exists public.sites cascade;
-- drop table if exists public.companies cascade;
