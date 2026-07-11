-- ============================================================
-- SaaS VALE — schema inicial (Supabase / Postgres)
-- Cole este script INTEIRO no SQL Editor do Supabase e clique em "Run".
-- Pode rodar quantas vezes precisar: ele apaga (se existirem) e recria
-- tudo do zero, então nunca vai dar erro de "já existe" ou de tabela faltando.
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- limpa qualquer tentativa anterior ----------
drop table if exists public.audit_log cascade;
drop table if exists public.bookings cascade;
drop table if exists public.profile_sites cascade;
drop table if exists public.profiles cascade;
drop table if exists public.equipment cascade;
drop table if exists public.areas cascade;
drop table if exists public.sites cascade;
drop function if exists public.is_admin();
drop function if exists public.has_site_access(text);
drop function if exists public.current_role_key();

-- ---------- SITES ----------
create table public.sites (
  key text primary key,
  label text not null,
  created_at timestamptz default now()
);

-- ---------- AREAS ----------
create table public.areas (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key) on delete cascade,
  code text not null,
  label text not null,
  created_at timestamptz default now(),
  unique (site_key, code)
);

-- ---------- EQUIPMENT ----------
create table public.equipment (
  id uuid primary key default gen_random_uuid(),
  site_key text not null references public.sites(key) on delete cascade,
  area_code text not null,
  tag text not null,
  created_at timestamptz default now(),
  unique (site_key, tag)
);

-- ---------- PROFILES (estende auth.users) ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null check (role in ('ADMIN','PCM','PCO','ENG_CONF','ENG_EST')),
  can_export boolean not null default false,
  active boolean not null default true,
  created_at timestamptz default now()
);

-- ---------- PROFILE_SITES (quais sites cada perfil acessa) ----------
create table public.profile_sites (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  site_key text not null references public.sites(key) on delete cascade,
  primary key (profile_id, site_key)
);

-- ---------- BOOKINGS (agendamentos) ----------
create table public.bookings (
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
  operator_id uuid references public.profiles(id),
  operator_label text not null,
  created_at timestamptz default now()
);

-- ---------- AUDIT LOG ----------
create table public.audit_log (
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
  profile_id uuid references public.profiles(id)
);

-- ============================================================
-- FUNÇÕES AUXILIARES (usadas nas políticas de segurança abaixo)
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
-- ============================================================
alter table public.sites enable row level security;
alter table public.areas enable row level security;
alter table public.equipment enable row level security;
alter table public.profiles enable row level security;
alter table public.profile_sites enable row level security;
alter table public.bookings enable row level security;
alter table public.audit_log enable row level security;

-- SITES: leitura para quem tem acesso; escrita só Admin
create policy "sites_select" on public.sites for select
  using (public.has_site_access(key));
create policy "sites_admin_write" on public.sites for all
  using (public.is_admin()) with check (public.is_admin());

-- AREAS
create policy "areas_select" on public.areas for select
  using (public.has_site_access(site_key));
create policy "areas_admin_write" on public.areas for all
  using (public.is_admin()) with check (public.is_admin());

-- EQUIPMENT
create policy "equipment_select" on public.equipment for select
  using (public.has_site_access(site_key));
create policy "equipment_admin_write" on public.equipment for all
  using (public.is_admin()) with check (public.is_admin());

-- PROFILES: cada um vê o próprio perfil; Admin vê/edita todos
create policy "profiles_select" on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy "profiles_admin_write" on public.profiles for all
  using (public.is_admin()) with check (public.is_admin());

-- PROFILE_SITES
create policy "profile_sites_select" on public.profile_sites for select
  using (profile_id = auth.uid() or public.is_admin());
create policy "profile_sites_admin_write" on public.profile_sites for all
  using (public.is_admin()) with check (public.is_admin());

-- BOOKINGS: leitura restrita ao site; criação/exclusão restrita por perfil + tipo
create policy "bookings_select" on public.bookings for select
  using (public.has_site_access(site_key));
create policy "bookings_insert" on public.bookings for insert
  with check (
    public.has_site_access(site_key)
    and (
      public.is_admin()
      or (public.current_role_key() = 'PCM' and type in ('Manutenção Preventiva','Manutenção Corretiva'))
      or (public.current_role_key() = 'PCO' and type in ('Limpeza','Limpeza Lokaminas'))
    )
  );
create policy "bookings_delete" on public.bookings for delete
  using (
    public.has_site_access(site_key)
    and (
      public.is_admin()
      or (public.current_role_key() = 'PCM' and type in ('Manutenção Preventiva','Manutenção Corretiva'))
      or (public.current_role_key() = 'PCO' and type in ('Limpeza','Limpeza Lokaminas'))
    )
  );

-- AUDIT LOG: entradas de um site exigem acesso ao site; entradas globais
-- (login/logout, gestão de usuários) só o Admin vê. Inserção liberada a
-- qualquer usuário autenticado (é o próprio app que decide o conteúdo).
create policy "audit_select" on public.audit_log for select
  using (
    (site_key is not null and public.has_site_access(site_key))
    or (site_key is null and public.is_admin())
  );
create policy "audit_insert" on public.audit_log for insert
  with check (auth.uid() is not null);
create policy "audit_admin_delete" on public.audit_log for delete
  using (public.is_admin());

-- ============================================================
-- DADOS INICIAIS: site Mutuca (áreas + 93 equipamentos)
-- ============================================================
insert into public.sites (key, label) values ('MUTUCA', 'Mutuca');

insert into public.areas (site_key, code, label) values
  ('MUTUCA', 'TOD', 'TOD'),
  ('MUTUCA', 'TCLD', 'TCLD'),
  ('MUTUCA', 'USINA', 'USINA'),
  ('MUTUCA', 'SBR', 'SBR'),
  ('MUTUCA', 'ITMS', 'ITM-S');

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
]);

-- ============================================================
-- PRIMEIRO ADMIN
-- Depois de criar o usuário (com seu e-mail real) em
-- Authentication > Users > Add user (no painel do Supabase),
-- copie o UUID dele e rode a linha abaixo trocando SEU_UUID_AQUI:
-- ============================================================
-- insert into public.profiles (id, name, email, role, can_export, active)
-- values ('SEU_UUID_AQUI', 'Thiago Fernandes', 'seu.email@empresa.com', 'ADMIN', true, true);
