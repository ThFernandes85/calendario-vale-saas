-- ============================================================
-- TerraVia Ops — Armazém: LIMPA POR COMPLETO os dados de um site de teste.
-- Apaga endereços, itens, equipes, campanhas, contagens, decisões e auditoria
-- DESSE site. Por padrão o cadastro do site em si (e os usuários) continua, para
-- você poder reutilizar o site de teste. Para APAGAR O SITE de vez, mude
-- v_remover_site para true (os usuários continuam existindo, só perdem o acesso a ele).
--
-- !!! DESTRUTIVO E SEM DESFAZER !!!
-- Só rode isto em site de TESTE. Por segurança, o script RECUSA rodar no site
-- real (VGR_ARMAZEM) a menos que você mude "v_permitir_real" para true de
-- propósito. Se for limpar o site real, faça isso UMA ÚNICA VEZ, antes de a
-- Vale começar a usar, e nunca depois (apagaria a prova do inventário).
--
-- COMO FUNCIONA: as contagens são imutáveis por trigger, então o script
-- desliga os triggers só dentro desta execução, apaga e religa. Tudo roda
-- numa transação: se algo falhar, NADA é apagado e os triggers continuam
-- ligados. A cadeia de hashes é por site, então apagar o site inteiro mantém
-- a cadeia consistente (a próxima contagem começa uma cadeia nova).
--
-- FOTOS: as fotos de "item sem cadastro" ficam no Storage (bucket
-- warehouse-photos, pasta com o código do site). Apague-as pelo painel do
-- Supabase > Storage, se quiser. Elas não afetam nada.
--
-- Cole no SQL Editor do Supabase, confira o site abaixo e clique em "Run".
-- ============================================================
do $$
declare
  v_site text := 'VGR_TESTE';             -- <<< site a limpar
  v_permitir_real boolean := false;       -- <<< só mude para true sabendo o que está fazendo
  v_remover_site boolean := false;        -- <<< true = depois de limpar, APAGA o próprio site (e o acesso dos usuários a ele)
  t text;
  n bigint;
begin
  if not exists (select 1 from public.sites where key = v_site and warehouse_module) then
    raise exception 'Site % não existe ou não é um site do módulo Armazém.', v_site;
  end if;
  if v_site = 'VGR_ARMAZEM' and not v_permitir_real then
    raise exception 'Recusado: % é o site REAL. Se for mesmo limpar o site real (antes de a Vale usar), mude v_permitir_real para true.', v_site;
  end if;

  -- desliga imutabilidade e auditoria (só nesta transação)
  foreach t in array array['wh_count_events','wh_count_closures','wh_count_decisions','wh_audit_log','wh_item_cost_history'] loop
    execute format('alter table public.%I disable trigger trg_wh_immutable', t);
  end loop;
  foreach t in array array[
    'wh_site_settings','wh_locations','wh_items','wh_item_costs','wh_item_barcodes','wh_teams','wh_team_members',
    'wh_campaigns','wh_campaign_assignments','wh_expected_stock','wh_unidentified_items','wh_recount_tasks'
  ] loop
    execute format('alter table public.%I disable trigger trg_wh_audit', t);
  end loop;

  -- apaga dos "filhos" para os "pais"
  foreach t in array array[
    'wh_count_decisions','wh_count_events','wh_count_closures','wh_recount_tasks','wh_unidentified_items',
    'wh_expected_stock','wh_campaign_assignments','wh_campaigns','wh_team_members','wh_teams',
    'wh_item_barcodes','wh_item_cost_history','wh_item_costs','wh_items','wh_locations','wh_audit_log'
  ] loop
    execute format('delete from public.%I where site_key = $1', t) using v_site;
    get diagnostics n = row_count;
    raise notice '% : % linhas apagadas', t, n;
  end loop;

  -- remover o site de vez: apaga os parâmetros e o cadastro do site. Os vínculos de
  -- usuários com o site (profile_sites) saem junto, automaticamente; os usuários em si ficam.
  if v_remover_site then
    delete from public.wh_site_settings where site_key = v_site;
    delete from public.sites where key = v_site;
    raise notice 'Site % removido.', v_site;
  end if;

  -- religa tudo
  foreach t in array array['wh_count_events','wh_count_closures','wh_count_decisions','wh_audit_log','wh_item_cost_history'] loop
    execute format('alter table public.%I enable trigger trg_wh_immutable', t);
  end loop;
  foreach t in array array[
    'wh_site_settings','wh_locations','wh_items','wh_item_costs','wh_item_barcodes','wh_teams','wh_team_members',
    'wh_campaigns','wh_campaign_assignments','wh_expected_stock','wh_unidentified_items','wh_recount_tasks'
  ] loop
    execute format('alter table public.%I enable trigger trg_wh_audit', t);
  end loop;

  raise notice 'Site % limpo.', v_site;
end $$;
