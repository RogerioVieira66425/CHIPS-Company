@echo off
cd /d "%~dp0"
set SERVIDOR=https://meus-investimentos-x7dn.onrender.com
set COLETOR_TOKEN=COLE_O_TOKEN_AQUI
node agente.js --servico
