"""Transcritor web: transcreve audios/videos e compacta para o WhatsApp.

Arquitetura (pensada para o plano gratis do Render):
  - O NAVEGADOR faz o trabalho pesado com ffmpeg.wasm: compacta video/audio e,
    para transcrever, extrai o audio, reduz para ~24 kbps e corta em pedacos de 10 min.
  - Este SERVIDOR so faz login por senha e repassa cada pedaco para a API da Groq
    (Whisper large-v3), sem guardar nada em disco.
  - Resumos: /api/resumir chama um modelo de texto da Groq. Textos longos sao resumidos
    em partes ("notas", uma requisicao por parte, conduzidas pelo navegador) e depois
    juntados num resumo final. Assim nenhuma requisicao estoura o limite gratuito
    (8 mil tokens/minuto por modelo) nem o timeout do servidor.

Variaveis de ambiente (no Render: painel > Environment; local: arquivo .env):
  GROQ_API_KEY  chave da API da Groq (https://console.groq.com/keys)
  APP_SENHA     senha para entrar no site
  SECRET_KEY    qualquer texto longo e aleatorio (assina o cookie de login)
"""
import hashlib
import hmac
import os
import time
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_from_directory, session

BASE = Path(__file__).resolve().parent

# carrega .env local (no Render as variaveis ja vem do painel)
_env = BASE / ".env"
if _env.exists():
    for linha in _env.read_text(encoding="utf-8").splitlines():
        if "=" in linha and not linha.lstrip().startswith("#"):
            k, v = linha.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

GROQ_URL = os.environ.get("GROQ_URL", "https://api.groq.com/openai/v1/audio/transcriptions")
MODELOS = {"whisper-large-v3", "whisper-large-v3-turbo"}
IDIOMAS = {"auto", "pt", "en", "es"}

# ---------------------------------------------------------------- resumo (LLM)
CHAT_URL = os.environ.get("GROQ_CHAT_URL", "https://api.groq.com/openai/v1/chat/completions")
MODELO_RESUMO = "openai/gpt-oss-120b"
# cada modelo tem sua propria cota por minuto; alternar entre eles acelera textos longos
MODELOS_NOTAS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]
MAX_CHARS_PEDIDO = 16000   # ~4-5 mil tokens: cabe com folga em 8 mil tokens/minuto

SISTEMA_RESUMO = (
    "Você resume transcrições de áudio para um usuário brasileiro. A transcrição foi gerada "
    "automaticamente e pode ter erros de reconhecimento (palavras trocadas, nomes escritos errado): "
    "corrija pelo contexto quando for óbvio, mas nunca invente fatos, nomes, números ou datas que não "
    "estejam no texto, nem atribua cargos, papéis ou intenções que não foram ditos. Escreva sempre em português do Brasil, mesmo que o áudio esteja em outro idioma. "
    "Responda só com o resumo, sem frases de introdução como 'Aqui está o resumo'. "
    "Formato: títulos com '## ', tópicos com '- ', **negrito** só para o que for essencial. "
    "Se o conteúdo for curto, o resumo também deve ser curto."
)
ESTILOS = {
    "rapido": "Escreva um resumo rápido: uma frase de visão geral e, em seguida, de 3 a 6 tópicos com o essencial.",
    "detalhado": (
        "Escreva um resumo detalhado com estas seções, omitindo as que não se aplicarem:\n"
        "## Visão geral (2 a 4 frases)\n## Pontos principais (tópicos)\n"
        "## Decisões e próximos passos\n## Nomes, datas e números citados"
    ),
    "ata": (
        "Escreva uma ata objetiva, omitindo as seções que não se aplicarem:\n"
        "## Assunto (1 frase)\n## Participantes citados\n## O que foi discutido (tópicos)\n"
        "## Decisões\n## Tarefas (formato: - tarefa — responsável — prazo, quando citados)"
    ),
}


PRAZO_REQUISICAO = 240   # s: fica abaixo do timeout do gunicorn (330 s) mesmo com novas tentativas


def espera_sugerida(r, padrao):
    """Segundos do cabecalho Retry-After; aceita numero ou data HTTP."""
    valor = r.headers.get("retry-after", "")
    try:
        return max(0.0, float(valor))
    except ValueError:
        try:
            from email.utils import parsedate_to_datetime
            return max(0.0, parsedate_to_datetime(valor).timestamp() - time.time())
        except (TypeError, ValueError, IndexError):
            return padrao


def limpar_raciocinio(txt):
    import re
    return re.sub(r"<think>.*?</think>", "", txt or "", flags=re.S).strip()


def chamar_llm(modelo, sistema, usuario, max_tokens):
    chave = os.environ.get("GROQ_API_KEY")
    extra = ({"reasoning_effort": "low", "include_reasoning": False} if modelo.startswith("openai/gpt-oss")
             else {"reasoning_effort": "none"})
    corpo = {"model": modelo, "max_tokens": max_tokens, "temperature": 0.3, **extra,
             "messages": [{"role": "system", "content": sistema}, {"role": "user", "content": usuario}]}
    inicio = time.time()
    for tentativa in range(4):
        restante = PRAZO_REQUISICAO - (time.time() - inicio)
        try:
            r = requests.post(CHAT_URL, headers={"Authorization": f"Bearer {chave}"}, json=corpo,
                              timeout=max(10, min(120, restante)))
        except requests.RequestException:
            if tentativa == 3 or restante < 20:
                raise RuntimeError("Não consegui falar com o serviço de resumo. Tente de novo.")
            time.sleep(3)
            continue
        espera = min(espera_sugerida(r, 15) + 1, 40)
        if r.status_code == 429 and tentativa < 3 and (time.time() - inicio) + espera < PRAZO_REQUISICAO - 30:
            time.sleep(espera)                                # cota por minuto: espera e tenta de novo
            continue
        break
    if r.status_code == 429:
        raise RuntimeError("Limite gratuito de resumos atingido por agora. Tente de novo em alguns minutos.")
    if r.status_code in (401, 403):
        raise RuntimeError("A chave da Groq foi recusada. Confira a GROQ_API_KEY no Render.")
    if r.status_code != 200:
        raise RuntimeError(f"Falha ao gerar o resumo (Groq {r.status_code}).")
    try:
        escolha = r.json()["choices"][0]
        texto = limpar_raciocinio(escolha["message"].get("content"))
    except (ValueError, KeyError, IndexError, TypeError, AttributeError):
        raise RuntimeError("O serviço de resumo respondeu de um jeito inesperado. Tente de novo.")
    if not texto:
        raise RuntimeError("O resumo veio vazio. Tente de novo.")
    return texto, escolha.get("finish_reason") == "length"

app = Flask(__name__, static_folder=None)
app.secret_key = os.environ.get("SECRET_KEY") or os.urandom(32)
app.config.update(
    MAX_CONTENT_LENGTH=25 * 1024 * 1024,   # limite da Groq por arquivo
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER")),
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,
)

TENTATIVAS = {}   # ip -> [timestamps de senhas erradas], freio contra chute de senha
ERROS_GERAIS = []  # todas as senhas erradas (o IP pode ser forjado, entao ha um limite global)
LIMITE_IP, LIMITE_GERAL, JANELA = 5, 30, 600


def versao_senha():
    """Muda quando a APP_SENHA muda: trocar a senha desconecta todo mundo."""
    return hashlib.sha256(("v1:" + os.environ.get("APP_SENHA", "")).encode()).hexdigest()[:16]


def logado():
    return session.get("ok") is True and session.get("v") == versao_senha()


@app.errorhandler(413)
def grande_demais(_e):
    return jsonify(erro="Arquivo grande demais para enviar (limite de 25 MB por parte)."), 413


@app.after_request
def cabecalhos(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
    return resp


@app.get("/")
def index():
    return send_from_directory(BASE, "index.html")


@app.get("/static/<path:arq>")
def estaticos(arq):
    resp = send_from_directory(BASE / "static", arq)
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.get("/api/eu")
def eu():
    return jsonify(logado=logado(), configurado=bool(os.environ.get("GROQ_API_KEY")))


@app.post("/api/login")
def login():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()
    agora = time.time()
    recentes = [t for t in TENTATIVAS.get(ip, []) if agora - t < JANELA]
    ERROS_GERAIS[:] = [t for t in ERROS_GERAIS if agora - t < JANELA]
    if len(recentes) >= LIMITE_IP or len(ERROS_GERAIS) >= LIMITE_GERAL:
        return jsonify(erro="Muitas tentativas. Espere 10 minutos."), 429
    senha_certa = os.environ.get("APP_SENHA", "")
    senha = str((request.get_json(silent=True) or {}).get("senha", ""))
    if not senha_certa:
        return jsonify(erro="APP_SENHA não configurada no servidor."), 500
    # compara resumos de tamanho fixo: o tempo de resposta não revela o tamanho da senha
    if not hmac.compare_digest(hashlib.sha256(senha.encode()).digest(), hashlib.sha256(senha_certa.encode()).digest()):
        recentes.append(agora)
        TENTATIVAS[ip] = recentes
        ERROS_GERAIS.append(agora)
        restantes = LIMITE_IP - len(recentes)
        msg = "Senha incorreta." + (f" Mais {restantes} tentativa(s) antes do bloqueio." if restantes <= 2 else "")
        return jsonify(erro=msg), 401
    TENTATIVAS.pop(ip, None)
    session.permanent = True
    session["ok"] = True
    session["v"] = versao_senha()
    return jsonify(ok=True)


@app.post("/api/sair")
def sair():
    session.clear()
    return jsonify(ok=True)


@app.post("/api/transcrever")
def transcrever():
    """Recebe UM pedaco de audio ja compactado pelo navegador e devolve os segmentos."""
    if not logado():
        return jsonify(erro="Faça login."), 401
    chave = os.environ.get("GROQ_API_KEY")
    if not chave:
        return jsonify(erro="GROQ_API_KEY não configurada no servidor."), 500
    f = request.files.get("arquivo")
    if not f:
        return jsonify(erro="Envie o áudio."), 400
    modelo = request.form.get("modelo", "whisper-large-v3")
    idioma = request.form.get("idioma", "pt")
    if modelo not in MODELOS or idioma not in IDIOMAS:
        return jsonify(erro="Parâmetros inválidos."), 400

    dados = {"model": modelo, "response_format": "verbose_json", "temperature": "0"}
    if idioma != "auto":
        dados["language"] = idioma
    inicio = time.time()
    for tentativa in range(3):
        try:
            r = requests.post(GROQ_URL, headers={"Authorization": f"Bearer {chave}"},
                              data=dados, timeout=max(10, PRAZO_REQUISICAO - (time.time() - inicio)),
                              files={"file": (f.filename or "audio.ogg", f.stream,
                                              f.mimetype or "audio/ogg")})
        except requests.RequestException:
            return jsonify(erro="Não consegui falar com o serviço de transcrição. Tente de novo."), 502
        espera = espera_sugerida(r, 10)
        if r.status_code == 429 and tentativa < 2 and espera <= 30 and (time.time() - inicio) + espera < PRAZO_REQUISICAO - 60:
            time.sleep(espera)                          # limite por minuto: espera e tenta de novo
            f.stream.seek(0)
            continue
        break
    if r.status_code == 429:                            # cota maior (por hora/dia): o navegador espera e tenta
        return jsonify(erro="Limite gratuito de transcrição atingido por agora.",
                       espera=round(espera_sugerida(r, 60))), 429
    if r.status_code in (401, 403):
        return jsonify(erro="A chave da Groq foi recusada. Confira a GROQ_API_KEY no Render."), 502
    if r.status_code != 200:
        try:
            msg = r.json().get("error", {}).get("message", r.text)
        except ValueError:
            msg = r.text
        return jsonify(erro=f"Groq ({r.status_code}): {msg[:300]}"), 502
    try:
        j = r.json()
        duracao = float(j.get("duration") or 0)
        segs = j.get("segments")
        if segs is None:
            segs = [{"start": 0, "end": duracao, "text": j.get("text", "")}]
        segmentos = []
        for s in segs:
            ini, fim = float(s.get("start") or 0), float(s.get("end") or 0)
            # tempo impossivel (alem do fim do audio) = frase inventada pelo Whisper
            if alucinacao(s) or (duracao and ini >= duracao) or (duracao and fim > duracao + 1.5):
                continue
            segmentos.append({"inicio": ini, "fim": min(fim, duracao) if duracao else fim,
                              "texto": str(s.get("text") or "").strip()})
    except (ValueError, TypeError, AttributeError):
        return jsonify(erro="O serviço de transcrição respondeu de um jeito inesperado. Tente de novo."), 502
    return jsonify(idioma=(j.get("language") or "").capitalize(), duracao=duracao or None, segmentos=segmentos)


@app.post("/api/resumir")
def resumir():
    """Uma etapa do resumo. fase: 'direto' (texto curto), 'notas' (uma parte de texto longo)
    ou 'final' (junta as notas de todas as partes)."""
    if not logado():
        return jsonify(erro="Faça login."), 401
    if not os.environ.get("GROQ_API_KEY"):
        return jsonify(erro="GROQ_API_KEY não configurada no servidor."), 500
    d = request.get_json(silent=True) or {}
    fase, estilo = d.get("fase", "direto"), d.get("estilo", "rapido")
    texto = str(d.get("texto", "")).strip()
    if fase not in ("direto", "notas", "final") or estilo not in ESTILOS:
        return jsonify(erro="Parâmetros inválidos."), 400
    if not texto:
        return jsonify(erro="Não há texto para resumir."), 400
    if len(texto) > MAX_CHARS_PEDIDO + 2000:
        return jsonify(erro="Texto grande demais para uma etapa (o navegador deve dividir)."), 413
    try:
        parte, total = int(d.get("parte", 1)), int(d.get("total", 1))
    except (TypeError, ValueError):
        parte, total = 1, 1

    try:
        if fase == "notas":
            pedido = (f"Esta é a parte {parte} de {total} de uma transcrição longa. Extraia notas fiéis "
                      "e completas desta parte: assuntos, fatos, nomes, números, datas, decisões e tarefas, "
                      "em tópicos curtos, na ordem em que aparecem. Sem introdução.\n\n"
                      f"Transcrição (parte {parte}/{total}):\n\"\"\"\n{texto}\n\"\"\"")
            resumo, cortado = chamar_llm(MODELOS_NOTAS[(parte - 1) % len(MODELOS_NOTAS)],
                                         SISTEMA_RESUMO, pedido, 1500)
        elif fase == "final":
            pedido = ("Abaixo estão notas, em ordem, de todas as partes de uma transcrição longa. "
                      f"Com base apenas nelas: {ESTILOS[estilo]}\n\nNotas:\n\"\"\"\n{texto}\n\"\"\"")
            resumo, cortado = chamar_llm(MODELO_RESUMO, SISTEMA_RESUMO, pedido, 3000)
        else:
            pedido = f"{ESTILOS[estilo]}\n\nTranscrição:\n\"\"\"\n{texto}\n\"\"\""
            resumo, cortado = chamar_llm(MODELO_RESUMO, SISTEMA_RESUMO, pedido, 3000)
    except RuntimeError as e:
        return jsonify(erro=str(e)), 502
    return jsonify(resumo=resumo, cortado=cortado)


# Frases que o Whisper costuma "inventar" em trechos de silencio ou musica
ALUCINACOES = ("amara.org", "legendas pela comunidade", "legendado por", "legenda por", "legendas por",
               "legenda adriana", "transcrição e legendas", "tradução e legendas", "legendas: ",
               "obrigado por assistir", "inscreva-se no canal", "e deixe seu like",
               "thanks for watching", "subtitles by")


def alucinacao(s):
    texto = (s.get("text") or "").strip().lower()
    if not texto:
        return True
    sem_fala = s.get("no_speech_prob", 0) or 0
    if sem_fala > 0.85 and (s.get("avg_logprob", 0) or 0) < -0.6:
        return True
    return sem_fala > 0.3 and any(a in texto for a in ALUCINACOES)


if __name__ == "__main__":
    porta = int(os.environ.get("PORT", "5050"))
    print(f"\n  Transcritor rodando em http://localhost:{porta}\n")
    app.run(host="127.0.0.1", port=porta, threaded=True)
