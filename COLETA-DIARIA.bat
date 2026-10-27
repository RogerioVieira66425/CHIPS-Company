@echo off
REM Coleta diaria de precos dos produtos acompanhados.
REM Roda no seu computador (rede brasileira) e alimenta o historico do site.
cd /d "%~dp0"
set SERVIDOR=http://localhost:3000,https://meus-investimentos-x7dn.onrender.com
set COLETOR_TOKEN=COLE_O_TOKEN_AQUI
node agente.js >> coleta-diaria.log 2>&1
