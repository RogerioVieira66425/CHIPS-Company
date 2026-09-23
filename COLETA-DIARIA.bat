@echo off
REM Coleta diaria de precos dos produtos acompanhados.
REM Roda no seu computador (rede brasileira) e alimenta o historico do site.
cd /d "%~dp0"
set SERVIDOR=http://localhost:3000,https://meus-investimentos-x7dn.onrender.com
set COLETOR_TOKEN=dd56e2fef54432d44cb65df7c9e23eec17f77162a4ee9ba6
node agente.js >> coleta-diaria.log 2>&1
