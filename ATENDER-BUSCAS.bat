@echo off
cd /d "%~dp0"
set SERVIDOR=https://meus-investimentos-x7dn.onrender.com
set COLETOR_TOKEN=dd56e2fef54432d44cb65df7c9e23eec17f77162a4ee9ba6
node agente.js --servico
