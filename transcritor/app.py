"""Transcritor web: transcreve audios/videos e compacta para o WhatsApp.

Arquitetura (pensada para o plano gratis do Render):
  - O NAVEGADOR faz o trabalho pesado com ffmpeg.wasm: compacta video/audio e,
    para transcrever, extrai o audio, reduz para ~24 kbps e corta em pedacos de 10 min.
  - Este SERVIDOR so faz login por senha e repassa cada pedaco para a API da Groq
    (Whisper large-v3), sem guardar nada em disco.

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
    if not hmac.compare_digest(senha.encode(), senha_certa.encode()):
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
    for tentativa in range(3):
        try:
            r = requests.post(GROQ_URL, headers={"Authorization": f"Bearer {chave}"},
                              data=dados, timeout=300,
                              files={"file": (f.filename or "audio.ogg", f.stream,
                                              f.mimetype or "audio/ogg")})
        except requests.RequestException:
            return jsonify(erro="Não consegui falar com o serviço de transcrição. Tente de novo."), 502
        if r.status_code == 429 and tentativa < 2:      # limite por minuto: espera e tenta de novo
            time.sleep(min(float(r.headers.get("retry-after", 10)), 30))
            f.stream.seek(0)
            continue
        break
    if r.status_code == 429:
        return jsonify(erro="Limite gratuito de transcrição atingido por agora. Tente de novo em alguns minutos."), 429
    if r.status_code in (401, 403):
        return jsonify(erro="A chave da Groq foi recusada. Confira a GROQ_API_KEY no Render."), 502
    if r.status_code != 200:
        try:
            msg = r.json().get("error", {}).get("message", r.text)
        except ValueError:
            msg = r.text
        return jsonify(erro=f"Groq ({r.status_code}): {msg[:300]}"), 502
    j = r.json()
    segs = j.get("segments")
    if segs is None:
        segs = [{"start": 0, "end": j.get("duration") or 0, "text": j.get("text", "")}]
    return jsonify(
        idioma=(j.get("language") or "").capitalize(),
        duracao=j.get("duration"),
        segmentos=[{"inicio": s["start"], "fim": s["end"], "texto": s["text"].strip()}
                   for s in segs if not alucinacao(s)],
    )


# Frases que o Whisper costuma "inventar" em trechos de silencio ou musica
ALUCINACOES = ("amara.org", "legendas pela comunidade", "legendado por", "legenda adriana",
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
