"""
app.py
======

Tela do sistema, feita com Streamlit. Este arquivo só cuida de
INTERFACE (o que aparece na tela e o que acontece quando você clica em
algo). Toda a parte de banco de dados fica em `database.py`. O visual
(tema escuro, cores, cards) fica em `style.py` + `.streamlit/config.toml`.

Como rodar:
    streamlit run app.py

Estrutura da tela (navegação lateral, 3 páginas):
    1) Calendário        -> grade por turno (A/B/C) x dia, colorida por status
    2) Novo / Editar      -> criar um bloqueio novo ou editar/encerrar um existente
    3) Histórico          -> log de tudo que já aconteceu (auditoria)
"""

import calendar
from datetime import date, datetime, time, timedelta

import streamlit as st

import database as db
from style import STATUS_STYLES, TURNOS, html, inject_css, logo_icone_svg

# ---------------------------------------------------------------------------
# Configuração inicial da página, do banco e do visual
# ---------------------------------------------------------------------------
st.set_page_config(
    page_title="Calendário PCM/PCO - Vale",
    layout="wide",
    initial_sidebar_state="expanded",
)

inject_css()

# `init_db()` usa "CREATE TABLE IF NOT EXISTS" + migração de colunas, então
# é seguro chamar em toda execução do script (o Streamlit reexecuta o
# arquivo inteiro a cada interação do usuário).
db.init_db()

DIAS_SEMANA_ABREV = ["SEG", "TER", "QUA", "QUI", "SEX", "SÁB", "DOM"]

PAGINAS = {
    "calendario": {"titulo": "Calendário", "subtitulo": "Grade por turno · Equipamentos"},
    "novo_editar": {"titulo": "Novo / Editar bloqueio", "subtitulo": "Criar, editar ou encerrar um bloqueio"},
    "historico": {"titulo": "Histórico", "subtitulo": "Auditoria completa de alterações"},
}


# ---------------------------------------------------------------------------
# Sidebar: marca, navegação, login, filtro e tags das correias
# ---------------------------------------------------------------------------
def sidebar_marca():
    html(
        f"""
        <div style="display:flex; align-items:center; gap:10px; padding-bottom:16px;
                    border-bottom:1px solid #29303b; margin-bottom:14px;">
          <div style="width:36px; height:36px; flex:none;">{logo_icone_svg()}</div>
          <div style="font-size:15px; font-weight:700; color:#fff; line-height:1.3; letter-spacing:.5px;">
            VALE SaaS<br/>
            <span style="font-weight:500; color:#9aa0a6; font-size:11px; letter-spacing:0;">Calendário PCM/PCO</span>
          </div>
        </div>
        """,
        container=st.sidebar,
    )


def sidebar_navegacao() -> str:
    """Navegação lateral. A página atual fica sincronizada com `?pagina=` na URL,
    então dá pra recarregar ou compartilhar um link direto para uma aba."""
    if "nav_pagina" not in st.session_state:
        pagina_url = st.query_params.get("pagina")
        if pagina_url in PAGINAS:
            st.session_state["nav_pagina"] = pagina_url

    escolha = st.sidebar.radio(
        "Navegação",
        list(PAGINAS.keys()),
        format_func=lambda k: PAGINAS[k]["titulo"],
        label_visibility="collapsed",
        key="nav_pagina",
    )
    st.query_params["pagina"] = escolha
    return escolha


def sidebar_login():
    st.sidebar.markdown("Identificação")
    usuarios = db.listar_usuarios()
    if not usuarios:
        st.sidebar.warning("Nenhum usuário cadastrado ainda.")
        return None

    opcoes = {f"{u['nome']} ({u['perfil']})": u["id"] for u in usuarios}
    escolha = st.sidebar.selectbox("Quem é você?", list(opcoes.keys()), label_visibility="collapsed")
    usuario_id = opcoes[escolha]

    st.session_state["usuario_id"] = usuario_id
    st.session_state["usuario_nome"] = escolha
    st.session_state["usuario_perfil"] = escolha.split("(")[-1].rstrip(")")

    return usuario_id


def sidebar_filtro():
    st.sidebar.markdown("Filtro por área")
    areas_disponiveis = db.listar_areas()
    area_selecionada = st.sidebar.selectbox(
        "Área", ["Todas"] + areas_disponiveis, label_visibility="collapsed"
    )
    return None if area_selecionada == "Todas" else area_selecionada


def sidebar_tags_equipamentos(area_filtro: str | None):
    """Lista os equipamentos com um dot colorido pelo status AGORA (Correias · Tags)."""
    equipamentos = db.listar_equipamentos(area=area_filtro)
    if not equipamentos:
        return

    hoje_str = date.today().strftime("%Y-%m-%d")
    bloqueios_hoje = db.listar_bloqueios_periodo(data_inicio=hoje_str, data_fim=hoje_str, area=area_filtro)
    bloqueios_por_equip: dict[int, list] = {}
    for b in bloqueios_hoje:
        bloqueios_por_equip.setdefault(b["equipamento_id"], []).append(b)

    html(
        "<div style='font-size:12px; font-weight:600; text-transform:uppercase; "
        "letter-spacing:.05em; color:#9aa0a6; margin:14px 0 12px;'>Correias &middot; Tags</div>",
        container=st.sidebar,
    )

    linhas = []
    for eq in equipamentos[:12]:
        bloqueio = bloqueado_agora(bloqueios_por_equip.get(eq["id"], []))
        status_key = bloqueio["status"] if bloqueio else "livre"
        cor = STATUS_STYLES[status_key]["bg"]
        linhas.append(
            f"""<div class="vc-tag">
                  <span>{eq['nome']}</span>
                  <div class="vc-dot" style="background:{cor};"></div>
                </div>"""
        )
    html(
        f"<div style='max-height:280px; overflow-y:auto;'>{''.join(linhas)}</div>",
        container=st.sidebar,
    )


# ---------------------------------------------------------------------------
# Header (barra superior)
# ---------------------------------------------------------------------------
def render_header(pagina: str, area_filtro: str | None):
    info = PAGINAS[pagina]
    usuarios = db.listar_usuarios()
    total_pcm = sum(1 for u in usuarios if u["perfil"] == "PCM")
    total_pco = sum(1 for u in usuarios if u["perfil"] == "PCO")
    perfil_atual = st.session_state.get("usuario_perfil", "").strip()
    dot_cor = "#2ed573" if perfil_atual == "PCM" else "#38ef7d"
    agora = datetime.now()
    filtro_label = area_filtro if area_filtro else "Todas as áreas"

    col_titulo, col_badges = st.columns([2, 3])
    with col_titulo:
        html(
            f"""
            <div style="padding:6px 0 18px;">
              <div style="font-size:17px; font-weight:700; color:#fff;">{info['titulo']}</div>
              <div style="font-size:11.5px; color:#9aa0a6; margin-top:2px;">{info['subtitulo']}</div>
            </div>
            """
        )
    with col_badges:
        html(
            f"""
            <div style="display:flex; align-items:center; justify-content:flex-end; gap:10px; padding:6px 0 18px; flex-wrap:wrap;">
              <div class="vc-badge">
                <span class="vc-dot" style="background:{dot_cor};"></span>
                {st.session_state.get('usuario_nome', '')} <span style="opacity:.6;">(Online)</span>
              </div>
              <div class="vc-badge">{total_pcm} PCM &middot; {total_pco} PCO ativos</div>
              <div class="vc-badge">{agora.strftime('%d %b %Y')} &middot; {agora.strftime('%H:%M')}</div>
              <div class="vc-badge">Filtro: {filtro_label}</div>
            </div>
            """
        )


# ---------------------------------------------------------------------------
# Funções auxiliares de data / hora
# ---------------------------------------------------------------------------
def dias_do_mes(ano: int, mes: int) -> list[date]:
    """Retorna a lista de todos os dias (objetos `date`) de um mês."""
    _, ultimo_dia = calendar.monthrange(ano, mes)
    return [date(ano, mes, dia) for dia in range(1, ultimo_dia + 1)]


def dias_da_semana(data_referencia: date) -> list[date]:
    """Retorna a lista de segunda a domingo da semana que contém `data_referencia`."""
    segunda = data_referencia - timedelta(days=data_referencia.weekday())
    return [segunda + timedelta(days=i) for i in range(7)]


def _intervalo_bloqueio(bloqueio) -> tuple[datetime, datetime | None]:
    """Combina data+hora de início/fim do bloqueio num intervalo [inicio, fim-ou-None-se-em-aberto)."""
    inicio = datetime.strptime(f"{bloqueio['data_inicio']} {bloqueio['hora_inicio']}", "%Y-%m-%d %H:%M")
    if bloqueio["data_fim_previsto"]:
        fim = datetime.strptime(f"{bloqueio['data_fim_previsto']} {bloqueio['hora_fim']}", "%Y-%m-%d %H:%M")
    else:
        fim = None
    return inicio, fim


def bloqueado_agora(bloqueios_do_equipamento: list):
    """
    Dado os bloqueios de UM equipamento (já carregados), devolve o
    bloqueio que está valendo neste exato instante (ou None se livre).

    Prioridade: 'ocupado' > 'agendado', para o caso raro de dois
    bloqueios se sobreporem.
    """
    agora = datetime.now()
    candidatos = []
    for b in bloqueios_do_equipamento:
        inicio, fim = _intervalo_bloqueio(b)
        if inicio <= agora and (fim is None or fim >= agora):
            candidatos.append(b)
    if not candidatos:
        return None
    for status in ("ocupado", "agendado"):
        for b in candidatos:
            if b["status"] == status:
                return b
    return candidatos[0]


def eventos_do_turno(bloqueios_por_equipamento: dict, equipamentos: list, dia: date, turno: dict):
    """
    Devolve a lista de (equipamento, bloqueio) cujo intervalo encosta na
    janela do turno naquele dia -- usada para desenhar os cards
    empilhados de cada célula da grade.
    """
    turno_inicio = datetime.combine(dia, datetime.strptime(turno["inicio"], "%H:%M").time())
    turno_fim = datetime.combine(dia, datetime.strptime(turno["fim"], "%H:%M").time())

    eventos = []
    for eq in equipamentos:
        for b in bloqueios_por_equipamento.get(eq["id"], []):
            inicio, fim = _intervalo_bloqueio(b)
            if inicio < turno_fim and (fim is None or fim > turno_inicio):
                eventos.append((eq, b))

    prioridade = {"ocupado": 0, "agendado": 1}
    eventos.sort(key=lambda par: (prioridade.get(par[1]["status"], 2), par[0]["nome"]))
    return eventos


# ---------------------------------------------------------------------------
# Página: Calendário
# ---------------------------------------------------------------------------
def render_calendario(area_filtro: str | None):
    col_visao, col_data, _ = st.columns([1, 1, 2])
    with col_visao:
        visao = st.radio("Visão", ["Semanal", "Mensal"], horizontal=True)
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

    bloqueios = db.listar_bloqueios_periodo(
        data_inicio=dias[0].strftime("%Y-%m-%d"),
        data_fim=dias[-1].strftime("%Y-%m-%d"),
        area=area_filtro,
    )
    bloqueios_por_equipamento: dict[int, list] = {}
    for b in bloqueios:
        bloqueios_por_equipamento.setdefault(b["equipamento_id"], []).append(b)

    hoje = date.today()
    col_widths = "80px " + " ".join(["1fr"] * len(dias))
    borda_celula = "border-bottom:1px solid #29303b; border-right:1px solid #29303b;"

    cabecalho = [f'<div style="{borda_celula} padding:15px 10px; background:#20262e; '
                 f'font-weight:600; color:#e2e8f0; text-align:center; font-size:13px;">Turno</div>']
    for dia in dias:
        destaque = dia == hoje
        cor_txt = "#2ed573" if destaque else "#e2e8f0"
        cabecalho.append(
            f"""<div style="{borda_celula} padding:15px 10px; background:#20262e; font-weight:600;
                        color:{cor_txt}; text-align:center; font-size:13px;">
                  {DIAS_SEMANA_ABREV[dia.weekday()]} {dia.strftime('%d')}
                </div>"""
        )

    linhas_html = [f'<div style="display:grid; grid-template-columns:{col_widths};">{"".join(cabecalho)}</div>']

    for turno in TURNOS:
        celulas = [
            f"""<div style="{borda_celula} padding:15px 10px; font-weight:bold; color:#9aa0a6;
                        background:#1a1e24; display:flex; flex-direction:column; align-items:center;
                        justify-content:center; text-align:center; font-size:13px;">
                  {turno['label']}<br><span style="font-size:10px; font-weight:500;">{turno['faixa']}</span>
                </div>"""
        ]
        for dia in dias:
            eventos = eventos_do_turno(bloqueios_por_equipamento, equipamentos, dia, turno)
            cards = []
            for eq, bloqueio in eventos:
                estilo = STATUS_STYLES[bloqueio["status"]]
                tecnico = bloqueio["tecnico_responsavel"] or "sem técnico"
                cards.append(
                    f"""<div class="vc-evento" style="background:{estilo['bg']}; color:{estilo['texto']}; flex:1;">
                          <div>{estilo['curto']}</div>
                          <div>
                            <span class="vc-tag-info">{eq['nome']}</span>
                            <div style="font-size:10px; opacity:.85; margin-top:3px;">{tecnico}</div>
                          </div>
                        </div>"""
                )
            conteudo = "".join(cards)
            celulas.append(
                f"""<div style="{borda_celula} padding:2px; min-height:76px; display:flex;
                            flex-direction:column; gap:2px;">{conteudo}</div>"""
            )
        linhas_html.append(f'<div style="display:grid; grid-template-columns:{col_widths};">{"".join(celulas)}</div>')

    html(
        f"""<div style="background:#1c2026; border:1px solid #29303b; border-radius:8px; overflow-x:auto;
                    box-shadow:0 24px 60px rgba(0,0,0,.45), 0 2px 0 rgba(255,255,255,.03) inset;">
              <div style="min-width:{80 + 130 * len(dias)}px;">{''.join(linhas_html)}</div>
            </div>"""
    )
    st.caption(
        "Células vazias = sem restrição no turno. Para editar um bloqueio, use "
        "'Novo / Editar bloqueio' na navegação lateral."
    )

    legenda_itens = "".join(
        f"""<div style="display:flex; align-items:center; gap:8px; font-size:13px; color:#9aa0a6;">
              <div style="width:16px; height:16px; border-radius:4px; background:{v['bg']};"></div>
              <span>{v['label']}</span>
            </div>"""
        for v in STATUS_STYLES.values()
    )
    html(
        f"""<div style="display:flex; gap:20px; margin-top:20px; padding:15px; background:#181b21;
                    border:1px solid #29303b; border-radius:6px; flex-wrap:wrap;">
              {legenda_itens}
            </div>"""
    )


# ---------------------------------------------------------------------------
# Página: Novo / Editar bloqueio
# ---------------------------------------------------------------------------
def render_novo_editar(area_filtro: str | None, usuario_id: int):
    equipamentos = db.listar_equipamentos(area=area_filtro)
    if not equipamentos:
        st.info("Cadastre um equipamento antes de criar bloqueios.")
        return

    opcoes_equip = {f"{e['nome']} ({e['area']})": e["id"] for e in equipamentos}

    with st.container(border=True):
        st.markdown("<div style='font-size:14px; font-weight:700; color:#fff; margin-bottom:8px;'>Criar novo bloqueio</div>", unsafe_allow_html=True)
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
                tecnico = st.text_input("Técnico responsável")
            with col2:
                data_inicio = st.date_input("Início", value=date.today())
                hora_inicio = st.time_input("Hora de início", value=time(8, 0))
                tem_previsao = st.checkbox("Tem previsão de término?", value=True)
                data_fim = st.date_input("Previsão de liberação", value=date.today()) if tem_previsao else None
                hora_fim = st.time_input("Hora de liberação", value=time(16, 0)) if tem_previsao else None

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
                    hora_inicio=hora_inicio.strftime("%H:%M"),
                    data_fim_previsto=data_fim.strftime("%Y-%m-%d") if data_fim else None,
                    hora_fim=hora_fim.strftime("%H:%M") if hora_fim else "23:59",
                    observacoes=observacoes,
                    usuario_id=usuario_id,
                )
                st.success("Bloqueio criado com sucesso!")
                st.rerun()

    st.markdown("<div style='height:16px;'></div>", unsafe_allow_html=True)

    bloqueios_ativos = db.listar_bloqueios_periodo(
        data_inicio="1900-01-01",
        data_fim="2999-12-31",
        area=area_filtro,
        apenas_ativos=True,
    )
    with st.container(border=True):
        st.markdown("<div style='font-size:14px; font-weight:700; color:#fff; margin-bottom:8px;'>Editar ou encerrar bloqueio existente</div>", unsafe_allow_html=True)

        if not bloqueios_ativos:
            st.info("Não há bloqueios ativos no momento.")
            return

        opcoes_bloqueio = {
            f"#{b['id']} - {b['equipamento_nome']} - {b['status']} - desde {b['data_inicio']} {b['hora_inicio']}": b["id"]
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
                nova_hora_fim = st.time_input(
                    "Nova hora de liberação",
                    value=datetime.strptime(bloqueio["hora_fim"], "%H:%M").time(),
                )

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
                    hora_fim=nova_hora_fim.strftime("%H:%M"),
                    observacoes=novas_observacoes,
                )
                st.success("Bloqueio atualizado!")
                st.rerun()

            if encerrar:
                db.encerrar_bloqueio(bloqueio_id, usuario_id=usuario_id)
                st.success("Equipamento liberado! O bloqueio foi arquivado (continua no histórico).")
                st.rerun()


# ---------------------------------------------------------------------------
# Página: Histórico
# ---------------------------------------------------------------------------
def render_historico(area_filtro: str | None):
    equipamentos = db.listar_equipamentos(area=area_filtro, apenas_ativos=False)
    opcoes_equip = {"Todos": None} | {f"{e['nome']} ({e['area']})": e["id"] for e in equipamentos}

    with st.container(border=True):
        st.markdown("<div style='font-size:14px; font-weight:700; color:#fff; margin-bottom:4px;'>Histórico de alterações</div>", unsafe_allow_html=True)
        st.caption("Nada é apagado: aqui fica registrado tudo que já foi criado, editado ou encerrado.")

        escolha = st.selectbox("Filtrar por equipamento", list(opcoes_equip.keys()))
        equipamento_id = opcoes_equip[escolha]

        historico = db.listar_historico(equipamento_id=equipamento_id)
        if not historico:
            st.info("Ainda não há histórico registrado.")
        else:
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
            st.dataframe(tabela, width="stretch", hide_index=True)

    st.markdown("<div style='height:16px;'></div>", unsafe_allow_html=True)

    with st.container(border=True):
        st.markdown("<div style='font-size:14px; font-weight:700; color:#fff; margin-bottom:4px;'>Bloqueios já encerrados</div>", unsafe_allow_html=True)
        arquivados = db.listar_bloqueios_arquivados(equipamento_id=equipamento_id)
        if arquivados:
            tabela_arq = [
                {
                    "Equipamento": a["equipamento_nome"],
                    "Status final": a["status"],
                    "Técnico": a["tecnico_responsavel"],
                    "Início": f"{a['data_inicio']} {a['hora_inicio']}",
                    "Previsão": f"{a['data_fim_previsto']} {a['hora_fim']}" if a["data_fim_previsto"] else None,
                    "Fim real": a["data_fim_real"],
                    "Observações": a["observacoes"],
                }
                for a in arquivados
            ]
            st.dataframe(tabela_arq, width="stretch", hide_index=True)
        else:
            st.info("Nenhum bloqueio encerrado ainda.")


# ---------------------------------------------------------------------------
# Layout principal: sidebar + roteamento de página
# ---------------------------------------------------------------------------
sidebar_marca()
pagina_atual = sidebar_navegacao()

usuario_id = sidebar_login()
if usuario_id is None:
    st.stop()  # não dá pra continuar sem usuário cadastrado

area_filtro = sidebar_filtro()
sidebar_tags_equipamentos(area_filtro)

render_header(pagina_atual, area_filtro)

if pagina_atual == "calendario":
    render_calendario(area_filtro)
elif pagina_atual == "novo_editar":
    render_novo_editar(area_filtro, usuario_id)
elif pagina_atual == "historico":
    render_historico(area_filtro)
