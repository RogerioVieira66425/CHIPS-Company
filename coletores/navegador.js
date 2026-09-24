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
  abrindo = comSegundaChance().finally(() => { abrindo = null; });
  return abrindo;
}

/* A primeira abertura as vezes morre no meio do caminho - antivirus olhando o
   processo, uma instancia anterior ainda encerrando. Como isso derrubaria as
   cinco lojas que dependem do navegador, vale uma segunda tentativa. */
async function comSegundaChance() {
  try {
    return await abrirDeVerdade();
  } catch (e) {
    navegador = null;
    await esperar(1500);
    return abrirDeVerdade();
  }
}

async function abrirDeVerdade() {
  if (navegador) return navegador;
  if (!CHROME) throw new Error('Chrome nao encontrado nesta maquina (defina CHROME_PATH).');

  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'coletor-chrome-'));
  // Sem --headless: varias lojas detectam o modo headless e devolvem pagina de
  // manutencao. A janela abre fora da tela, entao nao atrapalha quem esta usando o PC.
  const processo = spawn(CHROME, [
    process.env.JANELA_VISIVEL === '1' ? '--window-position=40,40' : '--window-position=-32000,-32000',
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
    processo.on('exit', (codigo) => {
      clearTimeout(tempo);
      // o que o Chrome escreveu antes de sair explica a causa
      const motivo = saida.trim().split(/\r?\n/).pop();
      reject(new Error('Chrome encerrou sozinho (codigo ' + codigo + ')' + (motivo ? ': ' + motivo.slice(0, 120) : '.')));
    });
  });

  navegador = { processo, endereco, perfil };

  // se o Chrome cair ou for fechado a mao, a proxima consulta abre outro em
  // vez de insistir num endereco morto
  processo.once('exit', () => {
    if (navegador && navegador.processo === processo) navegador = null;
  });

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
function comAba(wsUrl, url, script, esperaMs, visitarAntes, interacao) {
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

          /* Interacao opcional: digitar de verdade num campo (CEP, por exemplo).
             Eventos sinteticos de teclado sao ignorados por varias lojas; aqui
             o texto entra pelo proprio Chrome, como se a pessoa tivesse digitado. */
          if (interacao) {
            const foco = await enviar('Runtime.evaluate', {
              expression: interacao.preparar,
              returnByValue: true,
              awaitPromise: true,
            });
            const achou = foco && foco.result && foco.result.value;
            if (achou) {
              /* Digita caractere por caractere, como uma pessoa: varias lojas so
                 calculam o frete quando recebem os eventos de tecla de verdade. */
              for (const ch of String(interacao.texto || '')) {
                await enviar('Input.dispatchKeyEvent', {
                  type: 'keyDown', text: ch, unmodifiedText: ch, key: ch,
                  windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0),
                });
                await enviar('Input.dispatchKeyEvent', {
                  type: 'keyUp', key: ch,
                  windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0),
                });
                await esperar(60);
              }
              await esperar(600);
              if (interacao.enter) {
                for (const tipo of ['keyDown', 'keyUp']) {
                  await enviar('Input.dispatchKeyEvent', {
                    type: tipo, key: 'Enter', code: 'Enter',
                    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
                  });
                }
              }
              await esperar(interacao.esperaDepoisMs || 1500);

              /* Clique real (mouse do proprio Chrome): varias lojas ignoram
                 element.click() feito por JavaScript, mas obedecem este. */
              if (interacao.clicar) {
                const pos = await enviar('Runtime.evaluate', {
                  expression: interacao.clicar,
                  returnByValue: true,
                  awaitPromise: true,
                });
                const p = pos && pos.result && pos.result.value;
                if (p && typeof p.x === 'number') {
                  for (const tipo of ['mousePressed', 'mouseReleased']) {
                    await enviar('Input.dispatchMouseEvent', {
                      type: tipo, x: Math.round(p.x), y: Math.round(p.y),
                      button: 'left', clickCount: 1,
                    });
                  }
                  await esperar(1200);
                }
              }

              if (interacao.depois) {
                await enviar('Runtime.evaluate', { expression: interacao.depois, returnByValue: true, awaitPromise: true });
              }
            }
          }

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

/* Abre uma aba nova no Chrome ja em execucao. */
async function novaAba(endereco) {
  const alvo = endereco + '/json/new?' + encodeURIComponent('about:blank');
  const r = await fetch(alvo, { method: 'PUT' }).catch(() => fetch(alvo));
  return r.json();
}

/* API publica: abre a url e devolve o que o script coletar. */
async function extrair(url, script, opcoes) {
  const o = opcoes || {};
  let sessao = await abrirNavegador();
  let aba = await novaAba(sessao.endereco).catch(() => null);

  // o Chrome pode ter sido fechado entre uma coleta e outra: descarta o que
  // ficou para tras e abre um novo antes de desistir
  if (!aba || !aba.webSocketDebuggerUrl) {
    fechar();
    sessao = await abrirNavegador();
    aba = await novaAba(sessao.endereco).catch(() => null);
  }
  if (!aba || !aba.webSocketDebuggerUrl) throw new Error('Nao consegui abrir uma aba no navegador.');
  const endereco = sessao.endereco;

  try {
    return await comAba(aba.webSocketDebuggerUrl, url, script, o.esperaMs, o.visitarAntes, o.interacao);
  } finally {
    fetch(endereco + '/json/close/' + aba.id).catch(() => {});
  }
}

module.exports = { disponivel, extrair, fechar, caminhoChrome: () => CHROME };
