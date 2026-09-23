'use strict';
/* Navegador headless controlado pelo protocolo DevTools do Chrome.
   -------------------------------------------------------------------------
   Varias lojas (Pichau, Terabyte, Magalu) recusam requisicoes que nao venham
   de um navegador de verdade. Em vez de instalar um navegador proprio, este
   modulo usa o Chrome que ja existe na maquina e conversa com ele via CDP
   (Chrome DevTools Protocol), usando o WebSocket nativo do Node 22+.
   Zero dependencias externas.

   So e usado pelo agente local: o servidor publico nao abre navegador. */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CAMINHOS_CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function acharChrome() {
  for (const caminho of CAMINHOS_CHROME) {
    try { if (fs.existsSync(caminho)) return caminho; } catch { /* segue */ }
  }
  return '';
}

const CHROME = acharChrome();
const disponivel = () => Boolean(CHROME);

let navegador = null;     // { processo, endereco, perfil }
let abrindo = null;       // promessa em andamento: evita abrir varios Chromes de uma vez

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function abrirNavegador() {
  if (navegador) return navegador;
  // com consultas em paralelo, varias chamadas chegam juntas: todas esperam a mesma abertura
  if (abrindo) return abrindo;
  abrindo = abrirDeVerdade().finally(() => { abrindo = null; });
  return abrindo;
}

async function abrirDeVerdade() {
  if (navegador) return navegador;
  if (!CHROME) throw new Error('Chrome nao encontrado nesta maquina (defina CHROME_PATH).');

  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'coletor-chrome-'));
  // Sem --headless: varias lojas detectam o modo headless e devolvem pagina de
  // manutencao. A janela abre fora da tela, entao nao atrapalha quem esta usando o PC.
  const processo = spawn(CHROME, [
    '--window-position=-32000,-32000',
    '--remote-debugging-port=0',
    '--user-data-dir=' + perfil,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--mute-audio',
    '--window-size=1366,900',
    '--lang=pt-BR',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const endereco = await new Promise((resolve, reject) => {
    let saida = '';
    const tempo = setTimeout(() => reject(new Error('Chrome nao respondeu a tempo.')), 20000);
    processo.stderr.on('data', (c) => {
      saida += c.toString();
      const m = saida.match(/ws:\/\/([^\/]+)\//);
      if (m) { clearTimeout(tempo); resolve('http://' + m[1]); }
    });
    processo.on('error', (e) => { clearTimeout(tempo); reject(e); });
    processo.on('exit', () => { clearTimeout(tempo); reject(new Error('Chrome encerrou sozinho.')); });
  });

  navegador = { processo, endereco, perfil };

  const encerrar = () => fechar();
  process.once('exit', encerrar);
  process.once('SIGINT', () => { encerrar(); process.exit(0); });

  return navegador;
}

function fechar() {
  if (!navegador) return;
  try { navegador.processo.kill(); } catch { /* ja morreu */ }
  try { fs.rmSync(navegador.perfil, { recursive: true, force: true }); } catch { /* sem problema */ }
  navegador = null;
}

/* Conversa CDP com uma aba: navega ate a url e roda o script de extracao. */
function comAba(wsUrl, url, script, esperaMs, visitarAntes) {
  return new Promise((resolve, reject) => {
    let visitaPendente = Boolean(visitarAntes);
    const socket = new WebSocket(wsUrl);
    const pendentes = new Map();
    let proximoId = 1;
    let terminou = false;

    const limite = setTimeout(() => {
      if (!terminou) { terminou = true; try { socket.close(); } catch {} reject(new Error('Tempo esgotado ao carregar a pagina.')); }
    }, 45000);

    const enviar = (metodo, params) => new Promise((ok, falha) => {
      const id = proximoId++;
      pendentes.set(id, { ok, falha });
      socket.send(JSON.stringify({ id, method: metodo, params: params || {} }));
    });

    socket.addEventListener('message', async (evento) => {
      let msg;
      try { msg = JSON.parse(evento.data); } catch { return; }

      if (msg.id && pendentes.has(msg.id)) {
        const { ok, falha } = pendentes.get(msg.id);
        pendentes.delete(msg.id);
        if (msg.error) falha(new Error(msg.error.message || 'erro do navegador'));
        else ok(msg.result);
        return;
      }

      if (msg.method === 'Page.loadEventFired' && !terminou) {
        // quando pedido, a primeira carga e so a "visita previa" (pega cookies da loja)
        if (visitaPendente) {
          visitaPendente = false;
          await esperar(2000);
          enviar('Page.navigate', { url }).catch(() => {});
          return;
        }
        try {
          await esperar(esperaMs || 2500); // deixa o JS da loja montar a lista
          const r = await enviar('Runtime.evaluate', {
            expression: script,
            returnByValue: true,
            awaitPromise: true,
          });
          terminou = true;
          clearTimeout(limite);
          try { socket.close(); } catch {}
          if (r && r.exceptionDetails) reject(new Error('Script falhou na pagina.'));
          else resolve(r && r.result ? r.result.value : null);
        } catch (e) {
          terminou = true;
          clearTimeout(limite);
          try { socket.close(); } catch {}
          reject(e);
        }
      }
    });

    socket.addEventListener('error', () => {
      if (!terminou) { terminou = true; clearTimeout(limite); reject(new Error('Falha na conexao com o navegador.')); }
    });

    socket.addEventListener('open', async () => {
      try {
        await enviar('Page.enable');
        await enviar('Emulation.setUserAgentOverride', {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          acceptLanguage: 'pt-BR,pt;q=0.9',
        });
        await enviar('Page.navigate', { url: visitaPendente ? visitarAntes : url });
      } catch (e) {
        if (!terminou) { terminou = true; clearTimeout(limite); reject(e); }
      }
    });
  });
}

/* API publica: abre a url e devolve o que o script coletar. */
async function extrair(url, script, opcoes) {
  const o = opcoes || {};
  const { endereco } = await abrirNavegador();

  // cria uma aba nova
  const r = await fetch(endereco + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })
    .catch(() => fetch(endereco + '/json/new?' + encodeURIComponent('about:blank')));
  const aba = await r.json();
  if (!aba || !aba.webSocketDebuggerUrl) throw new Error('Nao consegui abrir uma aba no navegador.');

  try {
    return await comAba(aba.webSocketDebuggerUrl, url, script, o.esperaMs, o.visitarAntes);
  } finally {
    fetch(endereco + '/json/close/' + aba.id).catch(() => {});
  }
}

module.exports = { disponivel, extrair, fechar, caminhoChrome: () => CHROME };
