@echo off
rem Roda o transcritor no seu PC para testes (o site de verdade fica no Render).
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" python -m venv .venv
.venv\Scripts\python -m pip install -q -r requirements.txt
if not exist ".env" (
  copy .env.exemplo .env >nul
  echo Preencha GROQ_API_KEY e APP_SENHA no arquivo .env e rode de novo.
  notepad .env
  exit /b
)
start "" http://localhost:5050
.venv\Scripts\python app.py
pause
