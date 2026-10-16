-- ============================================================
-- TerraVia Ops — Armazém: cria um SITE DE TESTE isolado.
-- Cole no SQL Editor do Supabase e clique em "Run". Pode rodar de novo à vontade.
--
-- POR QUE UM SITE À PARTE: as contagens são imutáveis de propósito (é isso que
-- dá valor de prova à Vale). Testando num site separado, nada do inventário
-- real é tocado, e o site de teste pode ser limpo por completo depois (use o
-- arquivo teste_limpar_site.sql).
--
-- COMO USAR O SITE DE TESTE
--  1. Rode este script.
--  2. Na tela de Usuários do app principal, crie usuários de teste (um
--     Operador e um Supervisor, com e-mails de teste) e libere SÓ o site
--     "VGR - Armazém (TESTE)" para eles. O celular abre o primeiro site que
--     a pessoa tem; se o usuário de teste tiver só o site de teste, ele cai
--     direto nele.
--  3. O Admin vê os dois sites na Gestão (seletor "Site", no topo).
-- ============================================================
insert into public.sites (key, label, company_key, warehouse_module)
values ('VGR_TESTE', 'VGR - Armazém (TESTE)', 'SODEXO', true)
on conflict (key) do update set warehouse_module = true, label = excluded.label;

insert into public.wh_site_settings (site_key) values ('VGR_TESTE')
on conflict (site_key) do nothing;

select key, label, warehouse_module from public.sites where key = 'VGR_TESTE';
