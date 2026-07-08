# Calendário Compartilhado PCM / PCO — Vale

MVP de um calendário visual de equipamentos, compartilhado entre a
Manutenção (PCM) e a Operação (PCO), para substituir a planilha Excel
e as mensagens de WhatsApp/e-mail como fonte de verdade.

## Como rodar

1. Instale o Python 3.11+ (se ainda não tiver).
2. Crie um ambiente virtual e instale as dependências:

   ```
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. Rode o app:

   ```
   streamlit run app.py
   ```

4. O navegador abre automaticamente em `http://localhost:8501`.

Na primeira execução, o arquivo `data/vale_calendario.db` é criado
automaticamente, com usuários e equipamentos de exemplo (veja
`_seed_dados_exemplo()` em `database.py`) — assim dá pra testar o
app sem cadastrar nada na mão.

## Estrutura do projeto

```
Calendario online/
├── app.py           # Tela (Streamlit): calendário, formulários, histórico
├── database.py      # Banco de dados: schema + todas as funções de acesso
├── requirements.txt
├── data/
│   └── vale_calendario.db   # criado automaticamente (não vai pro git)
└── README.md
```

## Modelo de dados

### `usuarios`
Quem usa o sistema. Só tem nome e perfil (`PCM` ou `PCO`) — sem senha
no MVP, o "login" é só uma escolha de nome, suficiente para saber quem
fez cada alteração.

### `equipamentos`
As correias, britadores, peneiras etc. que aparecem no calendário.
Agrupados por `area`, o que permite filtrar o calendário (ex: só
"Britagem 1").

### `bloqueios`
A tabela principal. Cada linha é um período em que um equipamento
**não está livre**:

| Campo | Significado |
|---|---|
| `status` | `agendado` (laranja) ou `ocupado` (vermelho) |
| `origem` | `programacao_s1` (veio da reunião de quarta) ou `corretiva_emergencial` (mudança de última hora) |
| `tecnico_responsavel` | nome de quem está atuando no equipamento |
| `data_inicio` / `data_fim_previsto` | período planejado |
| `data_fim_real` | quando o equipamento foi de fato liberado |
| `arquivado` | `0` = ativo (aparece no calendário), `1` = encerrado |

Importante: **não existe status "livre" salvo no banco**. Se não há
nenhum bloqueio cobrindo uma data para um equipamento, ele é
considerado livre (verde) — isso evita gravar uma linha por dia por
equipamento à toa.

Quando um bloqueio termina, a linha **não é apagada**: ela é marcada
como `arquivado = 1` e ganha uma `data_fim_real`. Isso preserva o
histórico completo para análise de indicadores no futuro (ex: tempo
médio de parada, quantas corretivas emergenciais por mês, etc.).

### `historico_alteracoes`
Log de auditoria, só recebe linhas novas (nunca edita/apaga). Cada
criação, edição ou encerramento de bloqueio gera uma linha aqui, com um
"retrato" (JSON) de como o registro estava antes e depois da mudança —
e quem fez isso, e quando.

## Próximos passos sugeridos (pós-MVP)

- Autenticação de verdade (senha / SSO), em vez do combo de nome.
- Migração de SQLite para PostgreSQL (trocar `get_connection()` em
  `database.py` — o resto do código não precisa mudar).
- Alertas automáticos (e-mail/Teams) quando um bloqueio vira
  `corretiva_emergencial`.
- Dashboard de indicadores usando os dados de `historico_alteracoes`
  e bloqueios arquivados (ex: MTTR, nº de emergenciais por área).
- Edição direta clicando na célula do calendário (hoje é feita pela
  aba "Novo / Editar bloqueio"; um componente customizado do Streamlit
  permitiria clicar na célula colorida diretamente).
