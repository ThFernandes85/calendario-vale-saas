-- ============================================================
-- SaaS VALE — schema (Supabase / Postgres)
-- Cole este script INTEIRO no SQL Editor do Supabase e clique em "Run".
--
-- Este script é SEGURO de rodar quantas vezes precisar em produção: ele
-- só cria o que ainda não existe (tabelas, colunas, políticas, bucket)
-- e nunca apaga tabelas nem dados. Rodar de novo para aplicar uma
-- atualização (ex: uma coluna nova) não afeta sites, áreas, equipamentos,
-- usuários, agendamentos ou histórico já cadastrados.
-- ============================================================

create extension if not exists "pgcrypto";

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
  role text not null check (role in ('ADMIN','PCM','PCO','PCM_PCO','ENG_CONF','ENG_EST')),
  can_export boolean not null default false,
  active boolean not null default true,
  created_at timestamptz default now()
);

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
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where c.conname = 'bookings_closure_status_check' and t.relname = 'bookings'
  ) then
    alter table public.bookings add constraint bookings_closure_status_check
      check (closure_status in ('ENCERRADA','REPROGRAMADA','PENDENTE','PENDENTE_VALE','PENDENTE_SODEXO'));
  end if;
end $$;

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

create or replace function public.has_site_access(p_site_key text)
returns boolean language sql stable security definer as $$
  select
    public.is_admin()
    or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)  -- Visitante: leitura em todos os sites
    or exists (
      select 1 from public.profile_sites ps
      join public.profiles p on p.id = ps.profile_id
      where ps.profile_id = auth.uid() and ps.site_key = p_site_key and p.active = true
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
alter table public.sites enable row level security;
alter table public.areas enable row level security;
alter table public.equipment enable row level security;
alter table public.profiles enable row level security;
alter table public.profile_sites enable row level security;
alter table public.bookings enable row level security;
alter table public.audit_log enable row level security;

-- Toda política abaixo é recriada com "drop policy if exists" + "create
-- policy" -- assim, rodar o script de novo para ajustar uma regra nunca
-- dá erro de "política já existe" nem precisa apagar a tabela.

-- SITES: leitura para quem tem acesso; escrita só Admin
drop policy if exists "sites_select" on public.sites;
create policy "sites_select" on public.sites for select
  using (public.has_site_access(key));
drop policy if exists "sites_admin_write" on public.sites;
create policy "sites_admin_write" on public.sites for all
  using (public.is_admin()) with check (public.is_admin());

-- AREAS
drop policy if exists "areas_select" on public.areas;
create policy "areas_select" on public.areas for select
  using (public.has_site_access(site_key));
drop policy if exists "areas_admin_write" on public.areas;
create policy "areas_admin_write" on public.areas for all
  using (public.is_admin()) with check (public.is_admin());

-- EQUIPMENT
drop policy if exists "equipment_select" on public.equipment;
create policy "equipment_select" on public.equipment for select
  using (public.has_site_access(site_key));
drop policy if exists "equipment_admin_write" on public.equipment;
create policy "equipment_admin_write" on public.equipment for all
  using (public.is_admin()) with check (public.is_admin());

-- PROFILES: cada um vê o próprio perfil; Admin vê/edita todos
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles for select
  using (id = auth.uid() or public.is_admin());
drop policy if exists "profiles_admin_write" on public.profiles;
create policy "profiles_admin_write" on public.profiles for all
  using (public.is_admin()) with check (public.is_admin());

-- PROFILE_SITES
drop policy if exists "profile_sites_select" on public.profile_sites;
create policy "profile_sites_select" on public.profile_sites for select
  using (profile_id = auth.uid() or public.is_admin());
drop policy if exists "profile_sites_admin_write" on public.profile_sites;
create policy "profile_sites_admin_write" on public.profile_sites for all
  using (public.is_admin()) with check (public.is_admin());

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
      or (public.current_role_key() = 'PCM_PCO' and type in ('Manutenção Preventiva','Manutenção Corretiva','Limpeza Sodexo','Limpeza Mecanizada'))
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
      or (public.current_role_key() = 'PCM_PCO' and type in ('Manutenção Preventiva','Manutenção Corretiva','Limpeza Sodexo','Limpeza Mecanizada'))
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
      or (public.current_role_key() = 'PCM_PCO' and type in ('Manutenção Preventiva','Manutenção Corretiva','Limpeza Sodexo','Limpeza Mecanizada'))
    )
  )
  with check (
    public.has_site_access(site_key)
    and (
      public.is_admin()
      or (public.current_role_key() = 'PCM' and type in ('Manutenção Preventiva','Manutenção Corretiva'))
      or (public.current_role_key() = 'PCO' and type in ('Limpeza Sodexo','Limpeza Mecanizada'))
      or (public.current_role_key() = 'PCM_PCO' and type in ('Manutenção Preventiva','Manutenção Corretiva','Limpeza Sodexo','Limpeza Mecanizada'))
    )
  );

-- AUDIT LOG: entradas de um site exigem acesso ao site; entradas globais
-- (login/logout, gestão de usuários) só o Admin vê. Inserção liberada a
-- qualquer usuário autenticado (é o próprio app que decide o conteúdo).
drop policy if exists "audit_select" on public.audit_log;
create policy "audit_select" on public.audit_log for select
  using (
    (site_key is not null and public.has_site_access(site_key))
    or (site_key is null and public.is_admin())
  );
drop policy if exists "audit_insert" on public.audit_log;
create policy "audit_insert" on public.audit_log for insert
  with check (auth.uid() is not null);
drop policy if exists "audit_admin_delete" on public.audit_log;
create policy "audit_admin_delete" on public.audit_log for delete
  using (public.is_admin());

-- ============================================================
-- STORAGE: fotos de antes/depois anexadas ao encerrar um bloqueio
-- (bucket público — a URL fica salva em bookings.closure_photo_before/after)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('closure-photos', 'closure-photos', true)
on conflict (id) do update set public = true;

drop policy if exists "closure_photos_insert" on storage.objects;
create policy "closure_photos_insert" on storage.objects for insert
  with check (bucket_id = 'closure-photos' and auth.uid() is not null);

drop policy if exists "closure_photos_select" on storage.objects;
create policy "closure_photos_select" on storage.objects for select
  using (bucket_id = 'closure-photos');

drop policy if exists "closure_photos_admin_delete" on storage.objects;
create policy "closure_photos_admin_delete" on storage.objects for delete
  using (bucket_id = 'closure-photos' and public.is_admin());

-- ============================================================
-- MIGRAÇÃO: renomeia o tipo 'Limpeza' para 'Limpeza Sodexo'
-- (deixa claro que é a limpeza feita pela própria Sodexo, em contraste
-- com 'Limpeza Mecanizada', prestada por outra empresa). Idempotente:
-- depois da primeira vez que rodar, não sobra nenhuma linha 'Limpeza'
-- para o UPDATE pegar, então rodar de novo não faz nada.
-- ============================================================
update public.bookings set type = 'Limpeza Sodexo' where type = 'Limpeza';

-- ============================================================
-- DADOS INICIAIS: site Mutuca (áreas + 93 equipamentos)
-- "on conflict do nothing" -- roda só uma vez de verdade: se o site/área/
-- equipamento já existir (mesma chave), o insert simplesmente não faz nada,
-- em vez de duplicar ou dar erro.
-- ============================================================
insert into public.sites (key, label) values ('MUTUCA', 'Mutuca')
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
  '40AL02','40EM01','40MG02','40SL01','40TC02','40TC03','40TC04','40TC05','CARREGAMENTO'
])
union all
select 'MUTUCA', 'TCLD', unnest(array[
  '27TC15','27TC15A','27TC16B','27TC16A','33AL03','33TC17','27MG01','27MG02','27MG03','27MG04',
  '33TC18','33TC19','33TC20','GROTA ZERO','33SL02','40MG01','27TC16'
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
-- insert into public.profiles (id, name, email, role, can_export, active)
-- values ('SEU_UUID_AQUI', 'Thiago Fernandes', 'seu.email@empresa.com', 'ADMIN', true, true)
-- on conflict (id) do update set role = 'ADMIN', active = true;

-- ============================================================
-- ZONA DE PERIGO: reset completo (NÃO faz parte do run normal)
-- Só descomente e rode isto isoladamente se você quiser mesmo apagar
-- TODOS os dados (sites, áreas, equipamentos, perfis, agendamentos,
-- histórico) e recomeçar do zero. Não existe undo depois de rodar.
-- ============================================================
-- drop table if exists public.audit_log cascade;
-- drop table if exists public.bookings cascade;
-- drop table if exists public.profile_sites cascade;
-- drop table if exists public.profiles cascade;
-- drop table if exists public.equipment cascade;
-- drop table if exists public.areas cascade;
-- drop table if exists public.sites cascade;
