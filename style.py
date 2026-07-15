"""
style.py
========

Design tokens e CSS do app, num arquivo separado para não poluir
app.py com um bloco gigante de <style>.

Os tokens (cores, fontes, radius) seguem o protótipo de referência
"Centro de Controle Operacional" (tema escuro). O tema base (dark) fica
em `.streamlit/config.toml`, que já deixa os widgets nativos do
Streamlit (selects, date/time picker, dataframe, botões) escuros -- este
arquivo só cobre o que o tema não alcança (sidebar, cards de evento,
badges, nav).
"""

import base64
from pathlib import Path

ASSETS_DIR = Path(__file__).parent / "assets"

# ---------------------------------------------------------------------------
# Tokens de cor (tema escuro "Centro de Controle Operacional")
# ---------------------------------------------------------------------------
BG_MAIN = "#14171c"
BG_CARD = "#1c2026"
BG_SIDEBAR = "#181b21"
BG_BADGE = "#242933"
BORDER = "#29303b"
TEXT_PRIMARIA = "#ffffff"
TEXT_SECUNDARIA = "#9aa0a6"
ACCENT = "#2ed573"
ACCENT_AZUL = "#2a6f97"

# Cores por status de bloqueio -- usadas nos cards "luminosos" da grade,
# na legenda e nos dots de status da sidebar.
STATUS_STYLES = {
    "livre": {"bg": "#2ed573", "texto": "#1a1e24", "label": "Livre e Disponível", "curto": "Livre"},
    "agendado": {"bg": "#ff9f43", "texto": "#1a1e24", "label": "Demanda Reservada / Agendada", "curto": "Agendado"},
    "ocupado": {"bg": "#ff4d4d", "texto": "#ffffff", "label": "Restrições Críticas", "curto": "Ocupado"},
}

# Turnos fixos de 8h que formam as linhas da grade do calendário.
TURNOS = [
    {"label": "Turno A", "faixa": "00–08h", "inicio": "00:00", "fim": "08:00"},
    {"label": "Turno B", "faixa": "08–16h", "inicio": "08:00", "fim": "16:00"},
    {"label": "Turno C", "faixa": "16–24h", "inicio": "16:00", "fim": "23:59"},
]


def logo_icone_svg() -> str:
    """Retorna o marcador (só o emblema, sem o texto) do logotipo, para uso na sidebar."""
    return (ASSETS_DIR / "logo-icone.svg").read_text(encoding="utf-8")


def favicon_data_uri() -> str:
    """Codifica o emblema do logotipo como data URI, para usar como favicon da aba."""
    dados = (ASSETS_DIR / "logo-icone.svg").read_bytes()
    return "data:image/svg+xml;base64," + base64.b64encode(dados).decode("ascii")


def html(bruto: str, container=None) -> None:
    """
    st.markdown(..., unsafe_allow_html=True) "seguro" para blocos HTML
    multi-linha escritos com indentação de código Python.

    Sem isso, o Markdown trata linhas indentadas com 4+ espaços como bloco
    de código e uma linha em branco encerra um bloco de HTML cru -- o
    resultado é o HTML aparecendo como texto literal na tela em vez de
    ser renderizado. Aqui cada linha tem sua indentação removida (não só a
    indentação comum -- blocos coladas de outro arquivo, como um SVG, têm
    indentação própria que confundiria um dedent comum) e as linhas vazias
    são removidas antes de virar uma única tag colada na coluna 0.

    `container`, se passado (ex: `st.sidebar`), é usado no lugar de `st`
    para renderizar dentro da sidebar em vez do corpo principal.
    """
    import streamlit as st

    alvo = container if container is not None else st
    limpo = "\n".join(
        linha.lstrip() for linha in bruto.splitlines() if linha.strip()
    )
    alvo.markdown(limpo, unsafe_allow_html=True)


def inject_css() -> None:
    """Injeta fontes + favicon + CSS global que dá o visual escuro ao app Streamlit."""
    bruto = f"""
        <link rel="icon" type="image/svg+xml" href="{favicon_data_uri()}">
        <style>
        @keyframes pulse-dot {{ 0%,100% {{ opacity: 1; }} 50% {{ opacity: .35; }} }}

        html, body, [class*="css"] {{
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }}

        /* ---- fundo geral / remove chrome padrão do Streamlit ---- */
        [data-testid="stAppViewContainer"] {{
            background: radial-gradient(circle at 20% 0%, #1a2029 0%, {BG_MAIN} 55%);
        }}
        [data-testid="stHeader"] {{ background: transparent; height: 0; }}
        #MainMenu, footer {{ visibility: hidden; }}
        [data-testid="stMainBlockContainer"] {{
            padding: 18px 30px 40px 30px;
            max-width: 100%;
        }}
        [data-testid="stDecoration"] {{ display: none; }}

        /* ---- sidebar ---- */
        [data-testid="stSidebar"] {{
            background: {BG_SIDEBAR};
            border-right: 1px solid {BORDER};
            min-width: 230px;
            box-shadow: 8px 0 24px rgba(0,0,0,.35);
        }}
        [data-testid="stSidebar"] [data-testid="stMarkdownContainer"] p {{
            color: {TEXT_SECUNDARIA};
        }}
        [data-testid="stSidebar"] hr {{
            border-color: {BORDER};
        }}
        [data-testid="stSidebar"] > div {{
            padding-top: 18px;
        }}

        /* nav (st.radio usado como lista de navegação) */
        .st-key-nav_pagina [data-testid="stRadioGroup"] {{ gap: 4px; }}
        .st-key-nav_pagina label[data-testid="stRadioOption"] {{
            padding: 10px 12px;
            border-radius: 6px;
            width: 100%;
            transition: background .15s ease;
        }}
        .st-key-nav_pagina label[data-testid="stRadioOption"]:hover {{
            background: rgba(255,255,255,.05);
        }}
        .st-key-nav_pagina label[data-testid="stRadioOption"][data-selected="true"] {{
            background: {BORDER};
        }}
        .st-key-nav_pagina label[data-testid="stRadioOption"][data-selected="true"] [data-testid="stMarkdownContainer"] p {{
            color: #ffffff;
            font-weight: 600;
        }}
        /* esconde o círculo do radio -- fica dois níveis abaixo do label,
           irmão do texto (nomes de classe são gerados e mudam a cada build
           do Streamlit, então miramos pela posição/estrutura, não a classe). */
        .st-key-nav_pagina label[data-testid="stRadioOption"] > div > div > div:first-child {{
            display: none;
        }}
        .st-key-nav_pagina [data-testid="stMarkdownContainer"] p {{
            font-size: 14px;
            font-weight: 500;
            color: {TEXT_SECUNDARIA};
            margin: 0;
        }}

        [data-testid="stSidebar"] label p {{
            font-size: 12px !important;
            font-weight: 600 !important;
            text-transform: uppercase;
            letter-spacing: .05em;
            color: {TEXT_SECUNDARIA} !important;
        }}

        /* ---- cards (st.container(border=True)) ---- */
        [data-testid="stVerticalBlockBorderWrapper"]:has(> div > [data-testid="stVerticalBlock"]) {{
            background: {BG_CARD};
            border: 1px solid {BORDER} !important;
            border-radius: 8px !important;
        }}

        /* ---- botões ---- */
        div.stButton > button[kind="primary"] {{
            font-weight: 600;
            border-radius: 6px;
        }}

        /* ---- tabelas ---- */
        [data-testid="stDataFrame"] {{
            border: 1px solid {BORDER};
            border-radius: 8px;
            overflow: hidden;
        }}

        /* ---- tipografia geral do corpo ---- */
        h1, h2, h3 {{ color: {TEXT_PRIMARIA}; font-weight: 700; }}

        /* ---- badges / chips usados no header e na sidebar ---- */
        .vc-badge {{
            font-size: 13px; background-color: {BG_BADGE}; padding: 6px 14px;
            border-radius: 20px; display: flex; align-items: center; gap: 8px;
            border: 1px solid {BORDER}; color: {TEXT_SECUNDARIA};
        }}
        .vc-tag {{
            background-color: {BG_BADGE}; border: 1px solid {BORDER};
            padding: 6px 12px; border-radius: 4px; margin-bottom: 8px;
            font-size: 13px; font-family: monospace; color: #cbd5e1;
            display: flex; align-items: center; justify-content: space-between; gap: 8px;
        }}
        .vc-dot {{
            width: 8px; height: 8px; border-radius: 50%; flex: none;
            animation: pulse-dot 2s ease-in-out infinite;
        }}
        .vc-pill {{
            font-size:11px; font-weight:600; padding:5px 10px;
            background:{BG_BADGE}; border-radius:999px; color:{TEXT_SECUNDARIA};
            display:inline-block; border: 1px solid {BORDER};
        }}

        /* ---- cards de evento "luminosos" na grade do calendário ---- */
        .vc-evento {{
            border-radius: 6px; padding: 10px; text-align: left; font-size: 12px;
            font-weight: 600; box-shadow: 0 4px 12px rgba(0,0,0,.15);
            display: flex; flex-direction: column; justify-content: space-between;
            transition: transform .25s ease, box-shadow .25s ease;
            transform: translateZ(0); position: relative;
        }}
        .vc-evento:hover {{
            transform: perspective(600px) rotateX(-8deg) rotateY(6deg) scale(1.08) translateZ(24px);
            box-shadow: 0 18px 30px rgba(0,0,0,.5);
            z-index: 5;
        }}
        .vc-evento .vc-tag-info {{
            font-family: monospace; background: rgba(255,255,255,.4); padding: 2px 5px;
            border-radius: 3px; display: inline-block; margin-top: 5px; font-size: 11px;
        }}
        </style>
        """
    html(bruto)
