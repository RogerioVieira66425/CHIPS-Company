@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Revisao do orientador (Isolation Forest, K-Means, TF-IDF e criterio de acerto)
echo.
set /p DATABASE_URL=Cole a string de conexao do Supabase e tecle Enter:
if "%DATABASE_URL%"=="" (
  echo Nenhuma string informada. Encerrando.
  pause
  exit /b 1
)

echo.
echo Rodando. Pode demorar alguns minutos...
python pipeline\revisao_orientador.py
if errorlevel 1 (
  echo.
  echo O script terminou com erro. Veja a mensagem acima.
  pause
  exit /b 1
)

echo.
echo Pronto. Resultado em: pipeline\saida\revisao\revisao.md
echo Amostras para conferencia manual na mesma pasta.
pause
