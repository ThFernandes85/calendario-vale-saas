-- ============================================================
-- TerraVia Ops — Armazém: FOTO DO ITEM no catálogo.
-- Cole no SQL Editor do Supabase e clique em "Run". Pode rodar de novo à vontade.
-- (Já está dentro de armazem.sql; este arquivo é só o pedaço novo, para rodar rápido.)
--
-- O que faz:
--  1. Cria a coluna photo_path em wh_items (caminho da foto do item).
--  2. Libera o envio das fotos do catálogo para Supervisor e Admin, e a leitura
--     para quem trabalha no armazém (inclusive o operador, no celular).
--     As fotos de contagem (item sem cadastro) continuam com as regras de antes.
-- ============================================================
alter table public.wh_items add column if not exists photo_path text;

-- Fecha o buraco: a política de envio das fotos de contagem não pode valer para a pasta do catálogo.
drop policy if exists "wh_photos_insert" on storage.objects;
create policy "wh_photos_insert" on storage.objects for insert
  with check (bucket_id = 'warehouse-photos' and public.wh_site_counter((storage.foldername(name))[1])
              and (storage.foldername(name))[2] is distinct from 'catalogo');

drop policy if exists "wh_photos_catalog_insert" on storage.objects;
create policy "wh_photos_catalog_insert" on storage.objects for insert
  with check (bucket_id = 'warehouse-photos' and (storage.foldername(name))[2] = 'catalogo'
              and public.wh_site_supervisor((storage.foldername(name))[1]));

drop policy if exists "wh_photos_catalog_select" on storage.objects;
create policy "wh_photos_catalog_select" on storage.objects for select
  using (bucket_id = 'warehouse-photos' and (storage.foldername(name))[2] = 'catalogo'
         and public.wh_site_reader((storage.foldername(name))[1]));

select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'wh_items' and column_name = 'photo_path';
