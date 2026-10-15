# Prompt para o Claude Design — Módulo Armazém (TerraVia Ops)

Copie tudo abaixo da linha e cole no Claude Design.

---

Você é um designer de produto sênior, especialista em ferramentas operacionais industriais (SaaS B2B). Projete o layout **de alta fidelidade** do módulo **"Armazém"** do **TerraVia Ops**, um sistema de inventário e controle de estoque de um armazém da Vale, operado por equipes da Sodexo. Entregue telas navegáveis em **HTML + CSS estático** (sem framework), responsivas, prontas para eu implementar.

## 1. O produto, em uma frase
Hoje a Vale não tem controle estruturado do armazém. A Sodexo faz o inventário físico (rua → prateleira → nível → posição), e a Vale acompanha o resultado ao vivo, vê onde cada item está, mede acuracidade e valor de perdas. O resultado precisa ser **confiável, auditável e fácil de apresentar** a gestores da Vale.

## 2. Duas superfícies, dois dispositivos
**A) Notebook (desktop, 1366×768 em diante): o que a VALE e a gestão veem.** É a tela de apresentação, precisa causar boa impressão logo na primeira vista. Papéis: Gestor Vale (somente leitura), Supervisor Sodexo, Admin.

**B) Celular (360–430 px, uso com uma mão, em pé, no galpão): o que o OPERADOR usa para inventariar.** Por enquanto a entrada é **100% manual** (digitar código/descrição do item e a quantidade). Não há leitor de código de barras nesta fase, mas deixe um botão "Ler código" desativado/discreto, pois virá depois.

## 3. Identidade visual existente (manter coerência)
Tema escuro industrial, limpo, de alta legibilidade. Tokens atuais do produto:
- Fundo: `#0c1017` · barra lateral: `#131924` · cartão: `#18202c` · cabeçalho de cartão: `#202b3c` · hover: `#1c2533`
- Borda: `#2b394e` · texto: `#ffffff` · texto secundário: `#8a99ad` · texto apagado: `#5b6b82`
- Azul (ação/primário): `#2563eb` · Verde (concluído/OK): `#10b981` · Âmbar (atenção): `#f59e0b` · Vermelho (divergência/crítico): `#ef4444`
- Fonte: Segoe UI / system-ui. Cartões com raio 12px, borda 1px, faixa de cor de 4px à esquerda nos KPIs.
Você pode **refinar e elevar** (tipografia, espaçamento, hierarquia, microinterações), mas deve parecer da mesma família. Marca: "TerraVia Ops"; contexto "Sodexo × Vale"; nome do site: **VGR - Armazém**.

## 4. Superfície A: telas do notebook
Navegação lateral recolhível: **Visão geral · Mapa do galpão · Endereços · Itens · Campanhas · Divergências · Perdas e Acuracidade · Etiquetas · Auditoria**. Cabeçalho com seletor de site, campanha ativa, busca global ("onde está o item X?") e menu do usuário.

1. **Visão geral (a tela de impacto):** KPIs (endereços contados / total, itens contados, acuracidade %, divergências abertas, % de conclusão da campanha), progresso por rua (barras), produtividade por equipe, últimas contagens em tempo real, alertas pendentes.
2. **Mapa do galpão:** planta esquemática com as ruas como retângulos. Duas camadas alternáveis: **% concluído** (escala sequencial de uma só cor) e **divergência** (contorno/ícone de alerta). Clicar numa rua abre painel lateral com prateleiras e níveis.
3. **Endereços:** árvore (armazém > rua > prateleira > nível > posição) com busca; ação "Gerar em lote" (ex.: rua A–F, prateleiras 1–20, níveis 1–4) com **prévia** do que será criado; detalhe do endereço com QR.
4. **Itens:** catálogo com busca, código interno, código do material Vale, descrição, unidade, classe ABC, criticidade (normal / alto valor / crítico) e importação de planilha.
5. **Campanhas:** criar campanha, atribuir ruas a equipes, regra de recontagem, ativar/fechar. Estado visível do ciclo (rascunho → ativa → fechada).
6. **Divergências e aprovações:** tabela comparando 1ª × 2ª × 3ª contagem lado a lado, com status (confere / divergente / recontagem / aprovado) e ação "Aprovar" com justificativa.
7. **Perdas e Acuracidade (para a gestão da Vale; mostrar no layout mesmo que seja fase futura):** acuracidade % (por linha e por valor), valor em divergência por período (faltas e sobras **separadas**, em R$), ranking de itens e de endereços com mais ocorrências, saídas sem OM, tendência semanal.
8. **Etiquetas:** escolher escopo (rua/prateleira), modelo (A4 2×5, A4 2×4, térmica 100×50) e gerar PDF; prévia da etiqueta com QR grande, código legível em letras grandes e faixa de cor da rua.
9. **Auditoria:** linha do tempo imutável (quem, quando, onde, antes/depois) com selo "cadeia íntegra ✓".

## 5. Superfície B: fluxo do celular (entrada manual)
Pense em **poucos toques, botões grandes (mín. 56 px), contraste alto, legível sob luz forte, com luva**.
1. **Login** simples.
2. **Campanha** (lista de campanhas ativas atribuídas ao operador).
3. **Escolher endereço:** seletor em cascata (Rua → Prateleira → Nível) com chips grandes **ou** campo para digitar o código (ex.: `VGR-A-03-2`); mostra o progresso da rua e destaca endereços ainda não contados.
4. **Lançar itens no endereço:** campo de busca/autocomplete por **código ou descrição**; ao escolher, mostra a descrição e a unidade; **quantidade** com teclado numérico grande e botões −/+; botão primário "Adicionar". Lista dos itens já lançados naquele endereço (editar/desfazer o último). Atalhos: "Endereço vazio" e "Item sem cadastro / sem etiqueta" (descrição + foto + quantidade).
5. **Finalizar endereço:** resumo (n itens) e confirmação; volta para escolher o próximo endereço sugerido.
6. **Indicador permanente** de sincronização ("● 3 pendentes" / "Tudo enviado") e estado **sem sinal** (o app continua funcionando e envia depois).
Importante: o operador **não vê saldo esperado nem contagens de outras pessoas** (contagem cega). Não exiba nenhum "valor esperado".

## 6. Dados de exemplo (use nos mockups, nada de "Lorem ipsum")
- Site: VGR - Armazém · 6 ruas (A–F) · 1.248 endereços · campanha "Inventário Inicial 2026" (68% concluída).
- Endereços: `VGR-A-03-2`, `VGR-B-12-1`, `VGR-F-20-4`.
- Itens: `MAT-004512` Rolamento autocompensador 22218 E (UN) · `MAT-001873` Correia transportadora EP 400, 1200 mm (M) · `MAT-009021` Luva de raspa cano longo (PAR) · `MAT-000342` Parafuso sextavado M16 × 80 (UN).
- Equipes: Equipe 1 (3 pessoas), Equipe 2 (4 pessoas). Acuracidade 97,4%. Divergência do período: faltas R$ 18.420, sobras R$ 3.150.

## 7. Estados que precisam aparecer
Carregando (skeleton), vazio (com chamada para ação), erro, sem permissão, offline/pendente de envio, sucesso (toast discreto), divergência (vermelho/âmbar com ícone, **nunca só cor**), item crítico (selo "dupla conferência").

## 8. Requisitos de design
- **Notebook primeiro** para a superfície A e **celular primeiro** para a B; ambas funcionam nos dois tamanhos, mas otimize cada uma para seu dispositivo.
- Acessibilidade: contraste AA, alvos de toque ≥ 56 px no celular, foco visível, sem depender só de cor.
- Hierarquia clara: o número mais importante de cada tela deve ser lido em 2 segundos.
- Gráficos limpos (poucas cores, rótulos diretos, sem 3D, sem decoração).
- Português do Brasil, formatos pt-BR (1.248 · R$ 18.420,00 · 97,4%).
- Densidade confortável no notebook (tabelas escaneáveis), generosa no celular.

## 9. O que entregar
1. Sistema de design resumido (cores, tipografia, espaçamentos, componentes: botão, input, chip, badge, cartão, KPI, tabela, modal, toast, barra de progresso, mapa de rua).
2. Telas da superfície A (1 a 9) e do fluxo da superfície B (1 a 6), em HTML/CSS estático navegável.
3. Variações dos estados da seção 7 nas telas principais.
4. Notas de implementação: tokens CSS (variáveis), grid, breakpoints e comportamento responsivo.

**Restrições técnicas:** HTML/CSS/JS puro (sem React, sem build, sem dependências pesadas), ícones em SVG inline, sem imagens externas. Deve ser fácil de portar para arquivos estáticos que já usam variáveis CSS (`--bg-main`, `--bg-card`, `--border-color` etc.).
