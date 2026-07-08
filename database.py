"""
database.py
============

Este arquivo concentra TUDO que é acesso ao banco de dados do sistema:
- criação das tabelas (schema)
- funções para inserir, listar, editar e "arquivar" registros

Por que separar isso do app.py?
--------------------------------
Assim o código do Streamlit (app.py) só se preocupa com TELA, e este
arquivo só se preocupa com DADOS. Se um dia você trocar SQLite por
PostgreSQL, só precisa mexer aqui dentro (as funções continuam com o
mesmo nome e mesmo retorno).

Sobre o banco escolhido (SQLite)
---------------------------------
SQLite guarda tudo em um único arquivo (data/vale_calendario.db).
Não precisa instalar servidor nenhum, ótimo para MVP. Quando migrar
para PostgreSQL, o principal que muda é a função `get_connection()`
e alguns detalhes de sintaxe SQL (ex: AUTOINCREMENT vs SERIAL).

Sobre o "nunca apagar nada"
----------------------------
Você pediu histórico completo para indicadores futuros. Por isso:
1) A tabela `bloqueios` nunca tem uma linha DELETADA. Quando um
   bloqueio termina, ele é apenas marcado como `arquivado = 1`.
2) Toda criação/edição/arquivamento gera uma linha nova na tabela
   `historico_alteracoes`, que funciona como um "log" -- ela também
   nunca é apagada nem editada, só recebe novas linhas (append-only).
"""

import sqlite3
import json
from pathlib import Path
from datetime import datetime

# ---------------------------------------------------------------------------
# Configuração do caminho do banco
# ---------------------------------------------------------------------------
# Path(__file__).parent = pasta onde este arquivo está.
# Assim o caminho funciona em qualquer computador, sem depender de onde
# você roda o comando `streamlit run`.
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)  # cria a pasta "data" se ainda não existir
DB_PATH = DATA_DIR / "vale_calendario.db"


def get_connection() -> sqlite3.Connection:
    """
    Abre e devolve uma conexão com o banco SQLite.

    `row_factory = sqlite3.Row` faz cada linha retornada se comportar
    como um dicionário (dá pra fazer linha["nome"] em vez de linha[0]),
    o que deixa o código bem mais legível.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # PRAGMA foreign_keys liga a checagem de chaves estrangeiras no SQLite
    # (por padrão ela vem desligada).
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _now() -> str:
    """Retorna a data/hora atual como texto, no formato usado no banco."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# Criação das tabelas (schema)
# ---------------------------------------------------------------------------
def init_db() -> None:
    """
    Cria as tabelas do zero, caso ainda não existam.

    `CREATE TABLE IF NOT EXISTS` é seguro de rodar toda vez que o app
    inicia: se a tabela já existe, o comando simplesmente não faz nada.
    """
    conn = get_connection()
    cur = conn.cursor()

    # --- usuarios ------------------------------------------------------
    # Cada pessoa que usa o sistema. `perfil` define se ela é da equipe
    # de Manutenção (PCM) ou de Operação (PCO). No MVP não tem senha:
    # é só uma identificação de "quem está mexendo", para o histórico.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS usuarios (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            nome        TEXT NOT NULL,
            perfil      TEXT NOT NULL CHECK (perfil IN ('PCM', 'PCO')),
            ativo       INTEGER NOT NULL DEFAULT 1,
            criado_em   TEXT NOT NULL
        )
    """)

    # --- equipamentos ----------------------------------------------------
    # As "coisas" que aparecem no calendário: correias, britadores,
    # peneiras, pátios etc. `area` agrupa equipamentos (ex: "Britagem 1"),
    # útil pra filtrar o calendário depois.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS equipamentos (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            nome        TEXT NOT NULL,
            area        TEXT NOT NULL,
            tipo        TEXT,
            ativo       INTEGER NOT NULL DEFAULT 1,
            criado_em   TEXT NOT NULL
        )
    """)

    # --- bloqueios -------------------------------------------------------
    # O coração do sistema. Cada linha é um período em que um equipamento
    # NÃO está livre. Se não existe nenhum bloqueio cobrindo uma data,
    # o equipamento é considerado "livre" (verde) naquele dia -- ou seja,
    # a gente não guarda linha nenhuma pros dias livres, só pros dias
    # ocupados/agendados. Isso evita um banco gigante sem necessidade.
    #
    # status:
    #   'agendado' (laranja) -> programado na reunião de quarta (S-1),
    #                            ainda não começou ou está em andamento
    #                            planejado.
    #   'ocupado'  (vermelho) -> equipamento parado/em manutenção AGORA,
    #                            geralmente uma corretiva emergencial.
    #
    # origem:
    #   'programacao_s1'       -> veio da reunião semanal de programação.
    #   'corretiva_emergencial' -> mudança de última hora (o problema que
    #                              hoje é resolvido por e-mail/WhatsApp).
    #
    # arquivado:
    #   0 = bloqueio ativo (aparece no calendário)
    #   1 = já terminou / foi cancelado -> vira histórico, mas a linha
    #       continua no banco para sempre (não é apagada).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS bloqueios (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            equipamento_id       INTEGER NOT NULL REFERENCES equipamentos(id),
            status               TEXT NOT NULL CHECK (status IN ('agendado', 'ocupado')),
            origem               TEXT CHECK (origem IN ('programacao_s1', 'corretiva_emergencial')),
            tecnico_responsavel  TEXT,
            data_inicio          TEXT NOT NULL,
            data_fim_previsto    TEXT,
            data_fim_real        TEXT,
            observacoes          TEXT,
            criado_por           INTEGER REFERENCES usuarios(id),
            criado_em            TEXT NOT NULL,
            atualizado_por       INTEGER REFERENCES usuarios(id),
            atualizado_em        TEXT,
            arquivado            INTEGER NOT NULL DEFAULT 0
        )
    """)

    # --- historico_alteracoes --------------------------------------------
    # Log de auditoria: uma linha nova para cada criação, edição ou
    # arquivamento de bloqueio. `dados_anteriores` e `dados_novos` guardam
    # um "retrato" (snapshot) do registro em formato JSON, para você
    # conseguir reconstruir exatamente o que mudou, quando e por quem --
    # sem depender de guardar o texto solto.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS historico_alteracoes (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            bloqueio_id       INTEGER NOT NULL,
            acao              TEXT NOT NULL CHECK (acao IN ('criacao', 'edicao', 'arquivamento')),
            usuario_id        INTEGER REFERENCES usuarios(id),
            dados_anteriores  TEXT,
            dados_novos       TEXT,
            data_hora         TEXT NOT NULL
        )
    """)

    conn.commit()
    conn.close()

    # Popula dados de exemplo na primeira execução (banco vazio).
    _seed_dados_exemplo()


def _seed_dados_exemplo() -> None:
    """
    Insere usuários e equipamentos de exemplo, só se as tabelas
    estiverem vazias. Isso permite testar o app imediatamente, sem
    precisar cadastrar nada na mão primeiro.
    """
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) AS total FROM usuarios")
    if cur.fetchone()["total"] == 0:
        usuarios_exemplo = [
            ("João Silva", "PCM"),
            ("Maria Souza", "PCO"),
            ("Carlos Lima", "PCM"),
            ("Ana Pereira", "PCO"),
        ]
        cur.executemany(
            "INSERT INTO usuarios (nome, perfil, ativo, criado_em) VALUES (?, ?, 1, ?)",
            [(nome, perfil, _now()) for nome, perfil in usuarios_exemplo],
        )

    cur.execute("SELECT COUNT(*) AS total FROM equipamentos")
    if cur.fetchone()["total"] == 0:
        equipamentos_exemplo = [
            ("Correia TC-01", "Britagem 1", "Correia Transportadora"),
            ("Correia TC-02", "Britagem 1", "Correia Transportadora"),
            ("Britador BR-01", "Britagem 1", "Britador"),
            ("Peneira PN-01", "Britagem 2", "Peneira"),
            ("Correia TC-10", "Pátio de Estocagem", "Correia Transportadora"),
            ("Empilhadeira EMP-01", "Pátio de Estocagem", "Empilhadeira"),
        ]
        cur.executemany(
            "INSERT INTO equipamentos (nome, area, tipo, ativo, criado_em) VALUES (?, ?, ?, 1, ?)",
            [(nome, area, tipo, _now()) for nome, area, tipo in equipamentos_exemplo],
        )

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Consultas simples (usuários / equipamentos)
# ---------------------------------------------------------------------------
def listar_usuarios(apenas_ativos: bool = True) -> list[sqlite3.Row]:
    """Lista usuários, para preencher o combo de 'login' no app."""
    conn = get_connection()
    query = "SELECT * FROM usuarios"
    if apenas_ativos:
        query += " WHERE ativo = 1"
    query += " ORDER BY nome"
    linhas = conn.execute(query).fetchall()
    conn.close()
    return linhas


def listar_equipamentos(area: str | None = None, apenas_ativos: bool = True) -> list[sqlite3.Row]:
    """Lista equipamentos, com filtro opcional por área."""
    conn = get_connection()
    query = "SELECT * FROM equipamentos WHERE 1=1"
    params: list = []
    if apenas_ativos:
        query += " AND ativo = 1"
    if area:
        query += " AND area = ?"
        params.append(area)
    query += " ORDER BY area, nome"
    linhas = conn.execute(query, params).fetchall()
    conn.close()
    return linhas


def listar_areas() -> list[str]:
    """Lista as áreas distintas cadastradas, para o filtro do calendário."""
    conn = get_connection()
    linhas = conn.execute(
        "SELECT DISTINCT area FROM equipamentos WHERE ativo = 1 ORDER BY area"
    ).fetchall()
    conn.close()
    return [linha["area"] for linha in linhas]


def criar_equipamento(nome: str, area: str, tipo: str) -> int:
    """Cadastra um novo equipamento. Retorna o id gerado."""
    conn = get_connection()
    cur = conn.execute(
        "INSERT INTO equipamentos (nome, area, tipo, ativo, criado_em) VALUES (?, ?, ?, 1, ?)",
        (nome, area, tipo, _now()),
    )
    conn.commit()
    novo_id = cur.lastrowid
    conn.close()
    return novo_id


# ---------------------------------------------------------------------------
# Bloqueios: criar, listar, editar, encerrar (arquivar)
# ---------------------------------------------------------------------------
def _linha_para_dict(linha: sqlite3.Row) -> dict:
    """Converte uma linha do sqlite3 (Row) em dict comum, para dar dump em JSON."""
    return {chave: linha[chave] for chave in linha.keys()}


def _registrar_historico(conn, bloqueio_id: int, acao: str, usuario_id: int,
                          dados_anteriores: dict | None, dados_novos: dict | None) -> None:
    """
    Grava uma linha no log de auditoria. Função interna (por isso o "_"
    no início do nome) -- só é chamada pelas próprias funções deste arquivo.
    """
    conn.execute(
        """
        INSERT INTO historico_alteracoes
            (bloqueio_id, acao, usuario_id, dados_anteriores, dados_novos, data_hora)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            bloqueio_id,
            acao,
            usuario_id,
            json.dumps(dados_anteriores, ensure_ascii=False, default=str) if dados_anteriores else None,
            json.dumps(dados_novos, ensure_ascii=False, default=str) if dados_novos else None,
            _now(),
        ),
    )


def criar_bloqueio(equipamento_id: int, status: str, origem: str,
                    tecnico_responsavel: str, data_inicio: str,
                    data_fim_previsto: str | None, observacoes: str,
                    usuario_id: int) -> int:
    """
    Cria um novo bloqueio (equipamento agendado ou ocupado) e já registra
    a criação no histórico. Retorna o id do bloqueio criado.

    Datas são recebidas como texto no formato 'YYYY-MM-DD' (o app.py
    converte os `date`/`datetime` do Streamlit para essa string antes
    de chamar esta função).
    """
    conn = get_connection()
    agora = _now()
    cur = conn.execute(
        """
        INSERT INTO bloqueios
            (equipamento_id, status, origem, tecnico_responsavel,
             data_inicio, data_fim_previsto, data_fim_real, observacoes,
             criado_por, criado_em, arquivado)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0)
        """,
        (equipamento_id, status, origem, tecnico_responsavel,
         data_inicio, data_fim_previsto, observacoes, usuario_id, agora),
    )
    bloqueio_id = cur.lastrowid

    novo = conn.execute("SELECT * FROM bloqueios WHERE id = ?", (bloqueio_id,)).fetchone()
    _registrar_historico(conn, bloqueio_id, "criacao", usuario_id, None, _linha_para_dict(novo))

    conn.commit()
    conn.close()
    return bloqueio_id


def editar_bloqueio(bloqueio_id: int, usuario_id: int, **campos) -> None:
    """
    Atualiza um bloqueio existente. `**campos` aceita qualquer combinação
    de: status, origem, tecnico_responsavel, data_inicio,
    data_fim_previsto, observacoes.

    Exemplo de uso:
        editar_bloqueio(5, usuario_id=2, status="ocupado", observacoes="Piorou, virou corretiva")

    A função guarda o "antes" e o "depois" no histórico automaticamente.
    """
    campos_permitidos = {
        "status", "origem", "tecnico_responsavel",
        "data_inicio", "data_fim_previsto", "observacoes",
    }
    campos_validos = {k: v for k, v in campos.items() if k in campos_permitidos}
    if not campos_validos:
        return  # nada para atualizar

    conn = get_connection()
    antes = conn.execute("SELECT * FROM bloqueios WHERE id = ?", (bloqueio_id,)).fetchone()
    if antes is None:
        conn.close()
        raise ValueError(f"Bloqueio {bloqueio_id} não encontrado.")
    dados_antes = _linha_para_dict(antes)

    set_clause = ", ".join(f"{campo} = ?" for campo in campos_validos)
    valores = list(campos_validos.values())
    conn.execute(
        f"""
        UPDATE bloqueios
           SET {set_clause}, atualizado_por = ?, atualizado_em = ?
         WHERE id = ?
        """,
        (*valores, usuario_id, _now(), bloqueio_id),
    )

    depois = conn.execute("SELECT * FROM bloqueios WHERE id = ?", (bloqueio_id,)).fetchone()
    _registrar_historico(conn, bloqueio_id, "edicao", usuario_id, dados_antes, _linha_para_dict(depois))

    conn.commit()
    conn.close()


def encerrar_bloqueio(bloqueio_id: int, usuario_id: int, data_fim_real: str | None = None) -> None:
    """
    "Libera" o equipamento: marca o bloqueio como arquivado (some do
    calendário, equipamento volta a ficar verde) e registra a data real
    de liberação. A linha NUNCA é apagada -- só marcada.
    """
    conn = get_connection()
    antes = conn.execute("SELECT * FROM bloqueios WHERE id = ?", (bloqueio_id,)).fetchone()
    if antes is None:
        conn.close()
        raise ValueError(f"Bloqueio {bloqueio_id} não encontrado.")
    dados_antes = _linha_para_dict(antes)

    fim_real = data_fim_real or _now()
    conn.execute(
        """
        UPDATE bloqueios
           SET arquivado = 1, data_fim_real = ?, atualizado_por = ?, atualizado_em = ?
         WHERE id = ?
        """,
        (fim_real, usuario_id, _now(), bloqueio_id),
    )

    depois = conn.execute("SELECT * FROM bloqueios WHERE id = ?", (bloqueio_id,)).fetchone()
    _registrar_historico(conn, bloqueio_id, "arquivamento", usuario_id, dados_antes, _linha_para_dict(depois))

    conn.commit()
    conn.close()


def listar_bloqueios_periodo(data_inicio: str, data_fim: str,
                              area: str | None = None,
                              apenas_ativos: bool = True) -> list[sqlite3.Row]:
    """
    Lista bloqueios que TOCAM o período [data_inicio, data_fim] (formato
    'YYYY-MM-DD'), já trazendo o nome/área do equipamento e o nome de
    quem criou -- prontos para desenhar o calendário.

    Um bloqueio "toca" o período se ele começou antes do período acabar
    E (ainda não tem fim previsto OU o fim previsto é depois do período
    começar). É a lógica clássica de "intervalos que se sobrepõem".
    """
    conn = get_connection()
    query = """
        SELECT b.*, e.nome AS equipamento_nome, e.area AS equipamento_area,
               u.nome AS criado_por_nome
          FROM bloqueios b
          JOIN equipamentos e ON e.id = b.equipamento_id
          LEFT JOIN usuarios u ON u.id = b.criado_por
         WHERE b.data_inicio <= ?
           AND (b.data_fim_previsto IS NULL OR b.data_fim_previsto >= ?)
    """
    params: list = [data_fim, data_inicio]
    if apenas_ativos:
        query += " AND b.arquivado = 0"
    if area:
        query += " AND e.area = ?"
        params.append(area)
    query += " ORDER BY e.area, e.nome, b.data_inicio"

    linhas = conn.execute(query, params).fetchall()
    conn.close()
    return linhas


def obter_bloqueio(bloqueio_id: int) -> sqlite3.Row | None:
    """Busca um único bloqueio pelo id (usado na tela de edição)."""
    conn = get_connection()
    linha = conn.execute("SELECT * FROM bloqueios WHERE id = ?", (bloqueio_id,)).fetchone()
    conn.close()
    return linha


# ---------------------------------------------------------------------------
# Histórico / auditoria
# ---------------------------------------------------------------------------
def listar_historico(equipamento_id: int | None = None, limite: int = 200) -> list[sqlite3.Row]:
    """
    Lista o log de alterações (mais recentes primeiro), já com o nome
    do equipamento e do usuário responsável pela ação.
    """
    conn = get_connection()
    query = """
        SELECT h.*, b.equipamento_id, e.nome AS equipamento_nome, e.area AS equipamento_area,
               u.nome AS usuario_nome
          FROM historico_alteracoes h
          JOIN bloqueios b ON b.id = h.bloqueio_id
          JOIN equipamentos e ON e.id = b.equipamento_id
          LEFT JOIN usuarios u ON u.id = h.usuario_id
         WHERE 1=1
    """
    params: list = []
    if equipamento_id:
        query += " AND b.equipamento_id = ?"
        params.append(equipamento_id)
    query += " ORDER BY h.data_hora DESC LIMIT ?"
    params.append(limite)

    linhas = conn.execute(query, params).fetchall()
    conn.close()
    return linhas


def listar_bloqueios_arquivados(equipamento_id: int | None = None, limite: int = 200) -> list[sqlite3.Row]:
    """Lista bloqueios já encerrados/arquivados, para consulta de histórico."""
    conn = get_connection()
    query = """
        SELECT b.*, e.nome AS equipamento_nome, e.area AS equipamento_area
          FROM bloqueios b
          JOIN equipamentos e ON e.id = b.equipamento_id
         WHERE b.arquivado = 1
    """
    params: list = []
    if equipamento_id:
        query += " AND b.equipamento_id = ?"
        params.append(equipamento_id)
    query += " ORDER BY b.atualizado_em DESC LIMIT ?"
    params.append(limite)

    linhas = conn.execute(query, params).fetchall()
    conn.close()
    return linhas
