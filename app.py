"""
app.py
======

Tela do sistema, feita com Streamlit. Este arquivo só cuida de
INTERFACE (o que aparece na tela e o que acontece quando você clica em
algo). Toda a parte de banco de dados fica em `database.py`.

Como rodar:
    streamlit run app.py

Estrutura da tela (3 abas):
    1) Calendário       -> visão mensal/semanal, colorida por status
    2) Novo / Editar     -> criar um bloqueio novo ou editar/encerrar um existente
    3) Histórico         -> log de tudo que já aconteceu (auditoria)
"""

import calendar
from datetime import date, datetime, timedelta

import streamlit as st

import database as db

# ---------------------------------------------------------------------------
# Configuração inicial da página e do banco
# ---------------------------------------------------------------------------
st.set_page_config(
    page_title="Calendário PCM/PCO - Vale",
    layout="wide",
)

# `init_db()` usa "CREATE TABLE IF NOT EXISTS", então é seguro chamar
# em toda execução do script (o Streamlit reexecuta o arquivo inteiro
# a cada interação do usuário).
db.init_db()

# Cores usadas em todo o app (fica fácil mudar o esquema de cores aqui).
COR_LIVRE = "#28a745"      # verde
COR_AGENDADO = "#fd7e14"   # laranja
COR_OCUPADO = "#dc3545"    # vermelho
COR_TEXTO_CLARO = "#ffffff"


# ---------------------------------------------------------------------------
# Login simples (sem senha, só identificação de quem está mexendo)
# ---------------------------------------------------------------------------
def tela_login_sidebar():
    """
    Desenha o "login" na barra lateral. No MVP não existe senha: o
    usuário só se identifica escolhendo o nome dele numa lista. Isso já
    é suficiente para registrar "quem fez o quê" no histórico.
    """
    st.sidebar.header("Identificação")

    usuarios = db.listar_usuarios()
    if not usuarios:
        st.sidebar.warning("Nenhum usuário cadastrado ainda.")
        return None

    opcoes = {f"{u['nome']} ({u['perfil']})": u["id"] for u in usuarios}
    escolha = st.sidebar.selectbox("Quem é você?", list(opcoes.keys()))
    usuario_id = opcoes[escolha]

    # Guarda o usuário escolhido na "memória da sessão" do Streamlit,
    # para outras partes do app saberem quem está logado.
    st.session_state["usuario_id"] = usuario_id
    st.session_state["usuario_nome"] = escolha

    return usuario_id


usuario_id = tela_login_sidebar()

if usuario_id is None:
    st.stop()  # não dá pra continuar sem usuário cadastrado


# ---------------------------------------------------------------------------
# Filtro de área (barra lateral) -- usado tanto no calendário quanto nos forms
# ---------------------------------------------------------------------------
st.sidebar.header("Filtro")
areas_disponiveis = db.listar_areas()
area_selecionada = st.sidebar.selectbox(
    "Área", ["Todas"] + areas_disponiveis
)
area_filtro = None if area_selecionada == "Todas" else area_selecionada


# ---------------------------------------------------------------------------
# Funções auxiliares de data
# ---------------------------------------------------------------------------
DIAS_SEMANA_ABREV = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]


def dias_do_mes(ano: int, mes: int) -> list[date]:
    """Retorna a lista de todos os dias (objetos `date`) de um mês."""
    _, ultimo_dia = calendar.monthrange(ano, mes)
    return [date(ano, mes, dia) for dia in range(1, ultimo_dia + 1)]


def dias_da_semana(data_referencia: date) -> list[date]:
    """Retorna a lista de segunda a domingo da semana que contém `data_referencia`."""
    segunda = data_referencia - timedelta(days=data_referencia.weekday())
    return [segunda + timedelta(days=i) for i in range(7)]


def status_do_dia(bloqueios_do_equipamento: list, dia: date):
    """
    Dado os bloqueios de UM equipamento (já carregados) e um dia
    específico, decide a cor/status daquele dia.

    Prioridade: 'ocupado' > 'agendado' > livre (nenhum bloqueio).
    Isso cobre o caso raro de dois bloqueios se sobreporem no mesmo dia.
    """
    dia_str = dia.strftime("%Y-%m-%d")
    candidatos = [
        b for b in bloqueios_do_equipamento
        if b["data_inicio"] <= dia_str
        and (b["data_fim_previsto"] is None or b["data_fim_previsto"] >= dia_str)
    ]
    if not candidatos:
        return None  # livre

    for status in ("ocupado", "agendado"):
        for b in candidatos:
            if b["status"] == status:
                return b
    return candidatos[0]


# ---------------------------------------------------------------------------
# Aba 1: Calendário
# ---------------------------------------------------------------------------
def render_calendario():
    st.subheader("Calendário de equipamentos")

    col_visao, col_data = st.columns([1, 2])
    with col_visao:
        visao = st.radio("Visão", ["Mensal", "Semanal"], horizontal=True)
    with col_data:
        data_referencia = st.date_input("Data de referência", value=date.today())

    if visao == "Mensal":
        dias = dias_do_mes(data_referencia.year, data_referencia.month)
    else:
        dias = dias_da_semana(data_referencia)

    equipamentos = db.listar_equipamentos(area=area_filtro)
    if not equipamentos:
        st.info("Nenhum equipamento cadastrado para essa área.")
        return

    # Busca UMA vez todos os bloqueios que tocam o período mostrado,
    # em vez de fazer uma consulta por equipamento/dia (bem mais rápido).
    bloqueios = db.listar_bloqueios_periodo(
        data_inicio=dias[0].strftime("%Y-%m-%d"),
        data_fim=dias[-1].strftime("%Y-%m-%d"),
        area=area_filtro,
    )
    bloqueios_por_equipamento: dict[int, list] = {}
    for b in bloqueios:
        bloqueios_por_equipamento.setdefault(b["equipamento_id"], []).append(b)

    # --- Legenda --------------------------------------------------------
    st.markdown(
        f"""
        <div style="display:flex; gap:24px; margin-bottom:12px; font-size:14px;">
            <span><span style="display:inline-block;width:14px;height:14px;background:{COR_LIVRE};border-radius:3px;"></span> Livre</span>
            <span><span style="display:inline-block;width:14px;height:14px;background:{COR_AGENDADO};border-radius:3px;"></span> Agendado</span>
            <span><span style="display:inline-block;width:14px;height:14px;background:{COR_OCUPADO};border-radius:3px;"></span> Ocupado</span>
        </div>
        """,
        unsafe_allow_html=True,
    )

    # --- Monta a tabela HTML ---------------------------------------------
    # Streamlit não tem um componente nativo de "grade colorida", então
    # a forma mais simples pro MVP é montar uma tabela HTML na mão e
    # mandar renderizar com st.markdown(unsafe_allow_html=True).
    linhas_html = []

    cabecalho = "<th style='text-align:left;padding:6px;min-width:160px;'>Equipamento</th>"
    for dia in dias:
        cabecalho += (
            f"<th style='padding:4px;font-size:12px;'>"
            f"{DIAS_SEMANA_ABREV[dia.weekday()]}<br>{dia.strftime('%d/%m')}</th>"
        )
    linhas_html.append(f"<tr>{cabecalho}</tr>")

    for eq in equipamentos:
        bloqueios_eq = bloqueios_por_equipamento.get(eq["id"], [])
        celula_nome = f"<td style='padding:6px;font-weight:600;white-space:nowrap;'>{eq['nome']}<br><span style='font-weight:400;font-size:11px;color:#888;'>{eq['area']}</span></td>"
        celulas = [celula_nome]

        for dia in dias:
            bloqueio = status_do_dia(bloqueios_eq, dia)
            if bloqueio is None:
                cor = COR_LIVRE
                titulo = "Livre"
                texto_celula = ""
            elif bloqueio["status"] == "agendado":
                cor = COR_AGENDADO
                titulo = f"Agendado - {bloqueio['tecnico_responsavel'] or 'sem técnico definido'}"
                texto_celula = (bloqueio["tecnico_responsavel"] or "")[:10]
            else:  # ocupado
                cor = COR_OCUPADO
                previsao = bloqueio["data_fim_previsto"] or "sem previsão"
                titulo = f"Ocupado - {bloqueio['tecnico_responsavel'] or 'sem técnico'} - previsão liberação: {previsao}"
                texto_celula = (bloqueio["tecnico_responsavel"] or "")[:10]

            celulas.append(
                f"<td title='{titulo}' style='background:{cor};color:{COR_TEXTO_CLARO};"
                f"text-align:center;padding:4px;font-size:10px;border:1px solid #fff;'>"
                f"{texto_celula}</td>"
            )
        linhas_html.append(f"<tr>{''.join(celulas)}</tr>")

    tabela_html = f"""
    <div style="overflow-x:auto;">
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;">
        {''.join(linhas_html)}
    </table>
    </div>
    """
    st.markdown(tabela_html, unsafe_allow_html=True)

    st.caption(
        "Passe o mouse sobre uma célula colorida para ver o técnico responsável "
        "e a previsão de liberação. Para editar um bloqueio, use a aba "
        "'Novo / Editar bloqueio'."
    )


# ---------------------------------------------------------------------------
# Aba 2: Novo / Editar bloqueio
# ---------------------------------------------------------------------------
def render_novo_editar():
    st.subheader("Criar novo bloqueio")

    equipamentos = db.listar_equipamentos(area=area_filtro)
    if not equipamentos:
        st.info("Cadastre um equipamento antes de criar bloqueios.")
        return

    opcoes_equip = {f"{e['nome']} ({e['area']})": e["id"] for e in equipamentos}

    with st.form("form_novo_bloqueio", clear_on_submit=True):
        col1, col2 = st.columns(2)
        with col1:
            equip_escolha = st.selectbox("Equipamento", list(opcoes_equip.keys()))
            status = st.selectbox(
                "Status",
                ["agendado", "ocupado"],
                format_func=lambda s: "Agendado (laranja)" if s == "agendado" else "Ocupado (vermelho)",
            )
            origem = st.selectbox(
                "Origem",
                ["programacao_s1", "corretiva_emergencial"],
                format_func=lambda o: "Programação S-1 (reunião de quarta)" if o == "programacao_s1" else "Corretiva emergencial",
            )
        with col2:
            tecnico = st.text_input("Técnico responsável")
            data_inicio = st.date_input("Início", value=date.today())
            tem_previsao = st.checkbox("Tem previsão de término?", value=True)
            data_fim = st.date_input("Previsão de liberação", value=date.today()) if tem_previsao else None

        observacoes = st.text_area("Observações")

        enviado = st.form_submit_button("Criar bloqueio", type="primary")
        if enviado:
            equipamento_id = opcoes_equip[equip_escolha]
            db.criar_bloqueio(
                equipamento_id=equipamento_id,
                status=status,
                origem=origem,
                tecnico_responsavel=tecnico,
                data_inicio=data_inicio.strftime("%Y-%m-%d"),
                data_fim_previsto=data_fim.strftime("%Y-%m-%d") if data_fim else None,
                observacoes=observacoes,
                usuario_id=usuario_id,
            )
            st.success("Bloqueio criado com sucesso!")
            st.rerun()

    st.divider()
    st.subheader("Editar ou encerrar bloqueio existente")

    bloqueios_ativos = db.listar_bloqueios_periodo(
        data_inicio="1900-01-01",
        data_fim="2999-12-31",
        area=area_filtro,
        apenas_ativos=True,
    )
    if not bloqueios_ativos:
        st.info("Não há bloqueios ativos no momento.")
        return

    opcoes_bloqueio = {
        f"#{b['id']} - {b['equipamento_nome']} - {b['status']} - desde {b['data_inicio']}": b["id"]
        for b in bloqueios_ativos
    }
    escolha_bloqueio = st.selectbox("Selecione o bloqueio", list(opcoes_bloqueio.keys()))
    bloqueio_id = opcoes_bloqueio[escolha_bloqueio]
    bloqueio = db.obter_bloqueio(bloqueio_id)

    with st.form("form_editar_bloqueio"):
        col1, col2 = st.columns(2)
        with col1:
            novo_status = st.selectbox(
                "Status", ["agendado", "ocupado"],
                index=["agendado", "ocupado"].index(bloqueio["status"]),
            )
            novo_tecnico = st.text_input("Técnico responsável", value=bloqueio["tecnico_responsavel"] or "")
        with col2:
            fim_previsto_atual = (
                datetime.strptime(bloqueio["data_fim_previsto"], "%Y-%m-%d").date()
                if bloqueio["data_fim_previsto"] else date.today()
            )
            nova_previsao = st.date_input("Nova previsão de liberação", value=fim_previsto_atual)

        novas_observacoes = st.text_area("Observações", value=bloqueio["observacoes"] or "")

        col_a, col_b = st.columns(2)
        with col_a:
            salvar = st.form_submit_button("Salvar alterações")
        with col_b:
            encerrar = st.form_submit_button("Encerrar (liberar equipamento)", type="primary")

        if salvar:
            db.editar_bloqueio(
                bloqueio_id,
                usuario_id=usuario_id,
                status=novo_status,
                tecnico_responsavel=novo_tecnico,
                data_fim_previsto=nova_previsao.strftime("%Y-%m-%d"),
                observacoes=novas_observacoes,
            )
            st.success("Bloqueio atualizado!")
            st.rerun()

        if encerrar:
            db.encerrar_bloqueio(bloqueio_id, usuario_id=usuario_id)
            st.success("Equipamento liberado! O bloqueio foi arquivado (continua no histórico).")
            st.rerun()


# ---------------------------------------------------------------------------
# Aba 3: Histórico
# ---------------------------------------------------------------------------
def render_historico():
    st.subheader("Histórico de alterações")
    st.caption("Nada é apagado: aqui fica registrado tudo que já foi criado, editado ou encerrado.")

    equipamentos = db.listar_equipamentos(area=area_filtro, apenas_ativos=False)
    opcoes_equip = {"Todos": None} | {f"{e['nome']} ({e['area']})": e["id"] for e in equipamentos}
    escolha = st.selectbox("Filtrar por equipamento", list(opcoes_equip.keys()))
    equipamento_id = opcoes_equip[escolha]

    historico = db.listar_historico(equipamento_id=equipamento_id)
    if not historico:
        st.info("Ainda não há histórico registrado.")
        return

    tabela = [
        {
            "Data/Hora": h["data_hora"],
            "Ação": h["acao"],
            "Usuário": h["usuario_nome"],
            "Equipamento": h["equipamento_nome"],
            "Área": h["equipamento_area"],
            "Bloqueio #": h["bloqueio_id"],
        }
        for h in historico
    ]
    st.dataframe(tabela, use_container_width=True, hide_index=True)

    st.divider()
    st.subheader("Bloqueios já encerrados")
    arquivados = db.listar_bloqueios_arquivados(equipamento_id=equipamento_id)
    if arquivados:
        tabela_arq = [
            {
                "Equipamento": a["equipamento_nome"],
                "Status final": a["status"],
                "Técnico": a["tecnico_responsavel"],
                "Início": a["data_inicio"],
                "Previsão": a["data_fim_previsto"],
                "Fim real": a["data_fim_real"],
                "Observações": a["observacoes"],
            }
            for a in arquivados
        ]
        st.dataframe(tabela_arq, use_container_width=True, hide_index=True)
    else:
        st.info("Nenhum bloqueio encerrado ainda.")


# ---------------------------------------------------------------------------
# Layout principal: título + abas
# ---------------------------------------------------------------------------
st.title("📅 Calendário Compartilhado PCM / PCO")
st.caption(f"Logado como: {st.session_state.get('usuario_nome', '')}")

aba_calendario, aba_novo, aba_historico = st.tabs(
    ["📅 Calendário", "➕ Novo / Editar bloqueio", "🗂️ Histórico"]
)

with aba_calendario:
    render_calendario()

with aba_novo:
    render_novo_editar()

with aba_historico:
    render_historico()
