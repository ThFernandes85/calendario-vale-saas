# TerraVia Ops — guia para sessões futuras

Este arquivo é lido automaticamente no início de qualquer sessão do Claude
Code aberta nesta pasta (neste computador ou em outro). Serve pra uma sessão
nova (sem a memória acumulada desta máquina) entender rápido o que é este
projeto e como o usuário (Thiago) gosta de trabalhar.

## O que é este projeto

**TerraVia Ops** é um SaaS de monitoramento e agendamento de manutenção/
limpeza industrial, hoje usado pela Sodexo em contratos com a Vale (sites
como Mutuca, Fábrica/Viga Materiais, S11D, Sala de Controle de Correias).
Substitui planilha Excel + WhatsApp como fonte de verdade pra saber o status
de cada equipamento/área, agendar/encerrar OMs (ordens de manutenção), e
gerar o "Book de Aderência" (relatório de evidência fotográfica) pra Vale.

Usuários reais: Encarregados (fecham OM pelo celular, com fotos), Gerentes/
PCM/PCO/Admin Master (desktop, gerenciam agenda e relatórios), e alguns
perfis mobile dedicados (Inspeção de Ativo Vale, Liberação de Portaria pra
equipamento pesado, Técnico de Manutenção/Operação da Sala de Controle).

## Arquitetura

- **Frontend**: um único arquivo `docs/index.html` — HTML + CSS + JS vanilla,
  sem framework, sem build. `dashboard.html` na raiz é uma **cópia idêntica**
  (byte a byte) do mesmo arquivo — os dois **sempre têm que ficar iguais**.
- **Backend**: Supabase (Postgres + Auth + Storage + RLS). O usuário roda o
  SQL manualmente no SQL Editor do Supabase — não há acesso automatizado ao
  banco nesta sessão. `supabase/schema.sql` é o script idempotente
  (`create table if not exists`, `add column if not exists`) que o usuário
  cola inteiro sempre que precisa aplicar uma mudança de schema.
- **Hospedagem**: GitHub Pages (publica a partir de `docs/`) **e** Netlify
  (configurado via `netlify.toml`, publica a mesma pasta `docs/`) rodando em
  paralelo por enquanto — ainda não foi decidido aposentar o GitHub Pages.
- **PWA**: `docs/sw.js` (Service Worker, estratégia stale-while-revalidate,
  só cacheia o "shell" do app). Isso significa que toda atualização de
  código só aparece pra quem já tinha o app aberto depois de **dois reloads
  seguidos** (ou fechar/reabrir duas vezes) — é normal, não é bug.
- **Sem build step nenhum** — editar o HTML já é o deploy (depois do commit/
  push).

## Fluxo de trabalho obrigatório pra qualquer mudança de código

1. Editar `docs/index.html`.
2. `cp docs/index.html dashboard.html` e `diff` pra confirmar que ficaram
   idênticos.
3. Extrair o `<script>` inline pra um arquivo temporário e rodar
   `node --check` nele, pra pegar erro de sintaxe antes de qualquer outra
   coisa.
4. Testar de verdade: `preview_start` (nome `dashboard-static` no
   `.claude/launch.json`) + `javascript_tool`, mockando `sb.from`/
   `sb.storage`/`state` (não há banco real acessível). **Importante**: `sb`
   é uma constante léxica no `<script>` da página, **não** é
   `window.sb` — sobrescrever `window.sb.from = ...` não faz nada; tem que
   referenciar `sb` puro dentro do `javascript_exec`. E cuidado com testes em
   várias chamadas separadas: o polling de 20s do desktop
   (`backgroundRefreshTick`) roda de verdade em background mesmo no preview
   e pode sobrescrever `state` entre uma chamada de teste e outra se `sb.from`
   não estiver mockado corretamente.
5. Só depois de testar: **perguntar "posso commitar e enviar (push)?" e
   esperar um "sim" explícito** antes de rodar `git commit`/`git push`. Isso
   vale mesmo que o usuário pareça claramente querer — ele prefere confirmar
   cada vez.
6. Commit com heredoc, mensagem explicando o *porquê* (não o *o quê* —
   isso já dá pra ver no diff), terminando com
   `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
7. Um aviso de `error: failed to delete '.git/worktrees/...': Permission
   denied` aparece em praticamente todo commit — é inofensivo (artefato de
   worktrees de sessões antigas do Claude Code), o commit/push funciona
   normalmente mesmo assim. Não tentar "corrigir" isso.
8. Se a mudança envolver `supabase/schema.sql`, sempre entregar pro usuário
   o trecho SQL novo pronto pra colar no SQL Editor do Supabase (ele não
   tem como rodar isso sozinho a partir do código).

## Padrões importantes do código

- **Tipo de Site** (`SITE_TYPE_OPTIONS`, `siteTypeFlags`/`siteTypeFromFlags`):
  3 sistemáticas mutuamente exclusivas — Industrial (tags = equipamento de
  verdade, ex: Mutuca), Predial (workflow de aprovação do cliente, ex: S11D,
  usa `isClientApprovalSite()`), Contrato de Materiais (tags = sub-áreas de
  armazém, ex: Fábrica/Viga Materiais, usa `isMaterialsContractSite()`).
  "Sala de Controle" (`correiasPanel`/`isCorreiasSite()`) é um **checkbox
  independente**, não faz parte dessa exclusividade — pode ligar em cima de
  qualquer um dos 3 tipos acima, porque é só um painel adicional lendo os
  mesmos dados, não uma sistemática nova.
- **Perfis mobile** (Encarregado, Inspeção, os 3 de Portaria, Técnico de
  Manutenção/Operação): nunca veem o shell desktop, cada um tem sua própria
  tela cheia (`#mobile-XXX-screen`, precisa da própria regra CSS
  `display:none; flex-direction:column; height:100vh;`) e ficam de fora do
  polling de 20s do desktop (lista `MOBILE_ONLY_ROLES`) — não têm nenhuma
  atualização automática de dados, só um botão manual de atualizar no
  cabeçalho (`MOBILE_REFRESH_ROLES`), sem gatilho automático nenhum (já
  tentamos um gatilho por `visibilitychange` e foi revertido — tirar foto
  pela câmera já dispara esse evento sozinho, e isso causava um bug real de
  corrida de dados no meio de um encerramento).
- **`reconcileBookings(rows)`**: sempre que `state.bookings` for atualizado a
  partir de uma busca no servidor (poll, refresh manual, `loadPersisted`),
  usar essa função — ela faz merge nos objetos **existentes** em vez de
  trocar a referência do array. Sem isso, qualquer operação em andamento que
  segura uma referência a um booking (ex: `confirmCloseBooking`, durante o
  upload de foto) fica órfã e a mudança dela nunca aparece na tela.
- **`mobileWriteInFlight`**: contador incrementado durante uma escrita em
  andamento no mobile (hoje só em `confirmCloseBooking`) — o botão de
  atualizar do mobile se recusa a rodar enquanto isso for `> 0`, pra nunca
  sobrescrever um encerramento no meio do envio.
- Terminologia (Equipamento/Sub-área/Área, Limpeza/Atividade) muda por tipo
  de site — sempre em `applyEquipTerminology()` e funções irmãs
  (`bookingTypeDisplayLabel`, etc.), nunca hardcoded na tela.

## Como o usuário gosta de trabalhar

- Sempre confirmar antes de commit/push, mesmo em mudanças pequenas.
- Testar de verdade (via preview + mock) antes de dizer que algo está
  pronto — não só ler o código e assumir que funciona.
- Prefere explicações diretas e concretas (números reais, causa raiz clara)
  em vez de genéricas.
- Prefere que eu tome a decisão técnica e explique o porquê, em vez de
  listar várias opções neutras — mas apresento o trade-off principal quando
  a decisão é dele (arquitetura, custo, prioridade).
- **Aviso de PWA em cache**: sempre que uma mudança for entregue, lembrar que
  precisa de dois reloads (ou fechar/reabrir duas vezes) pra aparecer —
  isso já causou confusão várias vezes ("não funcionou" quando na verdade só
  precisava recarregar de novo).

## Contexto de negócio (pode ficar desatualizado — confirmar se relevante)

- Piloto ativo com Vale/Sodexo, plano Supabase Pro e Netlify (free) já
  contratados.
- Usuário planeja eventualmente cobrar por esse sistema como produto — já
  discutimos riscos (repositório público/privado ainda não confirmado,
  versão do Supabase JS não travada, ausência de testes automatizados,
  "fator de ônibus 1" por ser mantido por uma única pessoa).
- Ideia em aberto, ainda não construída: uma "Central de Gestão de
  Contratos Vale" — visão gerencial pra Vale (dono do contrato) cruzar o
  desempenho de vários prestadores (Sodexo e futuros outros) nos mesmos
  sites, separada da tela operacional que a Sodexo já usa.
