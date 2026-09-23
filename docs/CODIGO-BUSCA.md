# Codigo de busca e consulta de produtos
Anexo tecnico do TCC — Comparador de Precos de Equipamentos Gamer.
Gerado a partir do codigo em producao.

## Fluxo geral

```
visitante digita o termo
        |
        v
POST /api/buscas  ---->  servidor registra a busca
        |
        +-- servidor alcanca as lojas?  --SIM-->  consulta em paralelo e responde
        |
        +-- NAO (bloqueio de IP) -->  a busca entra na fila
                                          |
                                          v
                        agente local (rede brasileira) le a fila,
                        consulta as 6 lojas em paralelo e devolve
                                          |
                                          v
                    filtro de relevancia -> comparacao -> resposta ao visitante
```

---

## 1. Interface comum dos coletores

Todo coletor exporta a mesma interface, o que permite trocar ou acrescentar lojas sem mexer no restante do sistema:

```js
module.exports = {
  nome: 'KaBuM!',          // nome exibido na tela
  chave: 'kabum',          // identificador interno
  configurado,             // () => boolean: a fonte esta pronta para uso?
  buscar,                  // async (termo) => [oferta]
};
```

Cada oferta devolvida segue sempre o mesmo formato:

```js
{
  loja, titulo, preco, frete, preco_total,
  condicao,      // 'novo' | 'usado'
  vendedor, reputacao, parcelas,
  url,           // link direto para comprar
  id_externo
}
```


---

## 2. Coletor por API — KaBuM!

A unica loja com API publica. E o caminho mais rapido (~0,5s) e estavel.

Arquivo: `coletores/kabum.js` (80 linhas)

```js
'use strict';
/* Coletor da KaBuM! usando a API publica do catalogo (a mesma que o site consome).
   Nao exige credenciais. */

const NOME = 'KaBuM!';
const BASE = 'https://servicespub.prod.api.aws.grupokabum.com.br/catalog/v2/products';
const LIMITE = Number(process.env.KABUM_LIMITE) || 12;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// A API é aberta: nada para configurar.
function configurado() {
  return true;
}

function normalizar(item) {
  const a = item.attributes || {};
  // price_with_discount é o preço à vista (boleto/pix); price é o "de".
  const preco = Number(a.price_with_discount) > 0 ? Number(a.price_with_discount) : Number(a.price) || 0;
  // product_link e apenas o "slug" do produto: a URL valida e /produto/{id}/{slug}
  const slug = String(a.product_link || '').replace(/^\//, '');
  const url = 'https://www.kabum.com.br/produto/' + item.id + (slug ? '/' + slug : '');

  return {
    loja: NOME,
    titulo: String(a.title || ''),
    preco,
    // A KaBuM! só calcula o frete no carrinho, com CEP. Registramos 0 e deixamos
    // o ajuste manual a cargo de quem compara.
    frete: 0,
    preco_total: preco,
    frete_gratis: Boolean(a.has_free_shipping),
    condicao: a.is_openbox ? 'usado' : 'novo',
    vendedor: a.is_marketplace && a.marketplace ? String(a.marketplace.name || 'marketplace') : NOME,
    reputacao: a.is_marketplace ? '' : '5_green', // venda direta da loja: risco baixo
    vendidos: 0,
    parcelas: Number(a.max_installment) || 0,
    url,
    id_externo: String(item.id || ''),
  };
}

async function buscar(termo) {
  const url = BASE + '?query=' + encodeURIComponent(termo) + '&limit=' + LIMITE;
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Origin: 'https://www.kabum.com.br',
      Referer: 'https://www.kabum.com.br/busca/' + encodeURIComponent(termo),
      'sec-ch-ua': '\"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '\"Windows\"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    },
  });

  // A KaBuM! responde 404 quando a busca nao encontra nada: isso e resultado vazio, nao falha.
  if (r.status === 404) return [];

  if (r.status === 403) {
    throw new Error(
      'A KaBuM! recusou a consulta (403). A API funciona a partir de uma rede brasileira, mas ' +
      'costuma bloquear servidores de nuvem no exterior. Rode o coletor local (npm run coletar) ' +
      'ou lance a oferta manualmente.'
    );
  }
  if (!r.ok) throw new Error('KaBuM! respondeu HTTP ' + r.status + '.');

  const dados = await r.json().catch(() => ({}));
  const itens = Array.isArray(dados.data) ? dados.data : [];
  return itens
    .filter((i) => i.attributes && i.attributes.available)
    .map(normalizar)
    .filter((o) => o.preco > 0);
}

module.exports = { nome: NOME, chave: 'kabum', configurado, buscar };
```

---

## 3. Motor de navegador — Chrome via DevTools Protocol

Pichau, Terabyte, Patoloco, Setup Ninja e Amazon recusam requisicoes HTTP simples (403/503). Este modulo controla o Chrome ja instalado na maquina pelo protocolo DevTools, usando o WebSocket nativo do Node — sem instalar nenhuma biblioteca.

Arquivo: `coletores/navegador.js` (263 linhas)

```js
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
    return await comAba(aba.webSocketDebuggerUrl, url, script, o.esperaMs, o.visitarAntes, o.interacao);
  } finally {
    fetch(endereco + '/json/close/' + aba.id).catch(() => {});
  }
}

module.exports = { disponivel, extrair, fechar, caminhoChrome: () => CHROME };
```

---

## 4. Coletor por navegador — Pichau

Exemplo de coletor que roda um script dentro da pagina da loja para extrair os anuncios.

Arquivo: `coletores/pichau.js` (83 linhas)

```js
'use strict';
/* Coletor da Pichau. A loja recusa requisicoes simples (403), entao a pagina de
   busca e aberta no navegador local (coletores/navegador.js). */

const navegador = require('./navegador.js');

const NOME = 'Pichau';
const LIMITE = Number(process.env.PICHAU_LIMITE) || 12;

const configurado = () => navegador.disponivel();

/* Script executado dentro da pagina da loja. */
const SCRIPT = `(() => {
  const textoDe = (el) => (el && el.textContent ? el.textContent.trim() : '');
  const acharPorClasse = (raiz, parte) =>
    [...raiz.querySelectorAll('*')].find((e) => String(e.className || '').indexOf(parte) !== -1);

  const cartoes = [...document.querySelectorAll('a')]
    .filter((a) => a.querySelector('img') && /R\\$/.test(a.textContent) && a.getAttribute('href'));

  const vistos = new Set();
  const itens = [];

  for (const a of cartoes) {
    const href = a.getAttribute('href');
    if (!href || vistos.has(href)) continue;
    vistos.add(href);

    const titulo = textoDe(a.querySelector('.MuiTypography-h6')) ||
                   textoDe(a.querySelector('h2')) ||
                   textoDe(a.querySelector('img') && a.querySelector('img').getAttribute ? null : null);

    const vista = textoDe(acharPorClasse(a, 'price_vista'));
    const total = textoDe(acharPorClasse(a, 'price_total'));
    const precoTexto = vista || total;
    if (!precoTexto) continue;

    itens.push({
      titulo,
      precoTexto,
      href: href.indexOf('http') === 0 ? href : 'https://www.pichau.com.br' + href,
      esgotado: /indispon|esgotad/i.test(a.textContent),
    });
  }
  return itens;
})()`;

function paraNumero(texto) {
  const limpo = String(texto || '').replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}

async function buscar(termo) {
  const url = 'https://www.pichau.com.br/search?q=' + encodeURIComponent(termo);
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 4000 })) || [];

  return itens
    .filter((i) => !i.esgotado)
    .slice(0, LIMITE)
    .map((i) => {
      const preco = paraNumero(i.precoTexto);
      return {
        loja: NOME,
        titulo: String(i.titulo || '').slice(0, 200),
        preco,
        frete: 0, // a Pichau so calcula o frete com o CEP, no carrinho
        preco_total: preco,
        frete_gratis: false,
        // a Pichau marca no titulo os produtos de mostruario
        condicao: /openbox/i.test(i.titulo) ? 'usado' : 'novo',
        vendedor: NOME,
        reputacao: '5_green', // venda direta da loja
        vendidos: 0,
        parcelas: 0,
        url: i.href,
        id_externo: '',
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'pichau', configurado, buscar };
```

---

## 5. Analise — relevancia e comparacao

Nucleo da decisao: descarta anuncios que nao correspondem a busca, identifica se as lojas trouxeram o mesmo produto e ordena por custo ajustado ao risco.

Arquivo: `analise.js` (204 linhas)

```js
'use strict';
/* Regra de decisao do sistema: dadas as ofertas coletadas e o historico de precos,
   responde "em qual loja compensa comprar" e "este e um bom momento". */

const PESO_REPUTACAO = { '5_green': 0, '4_light_green': 0.01, '3_yellow': 0.03, '2_orange': 0.06, '1_red': 0.12 };
const PENALIDADE_USADO = 0.15;   // 15% de "custo de risco" para produto usado
const PENALIDADE_SEM_DADOS = 0.02;

/* Custo ajustado: preco final mais uma penalidade de risco.
   Serve para nao recomendar uma loja 2% mais barata com vendedor ruim. */
function custoAjustado(oferta) {
  let fator = 1;
  if (oferta.condicao === 'usado') fator += PENALIDADE_USADO;
  if (oferta.condicao === 'nao informado') fator += PENALIDADE_SEM_DADOS;
  const rep = oferta.reputacao ? PESO_REPUTACAO[oferta.reputacao] : PENALIDADE_SEM_DADOS;
  fator += rep === undefined ? PENALIDADE_SEM_DADOS : rep;
  return oferta.preco_total * fator;
}

/* ---------- relevancia ----------
   As lojas completam a busca com produtos parecidos: procurar "redragon kumara"
   traz teclados de outras marcas. Sem este filtro o sistema compararia produtos
   diferentes e recomendaria o mais barato de todos, que nao e o que a pessoa quer. */
const PALAVRAS_IGNORADAS = ['de', 'da', 'do', 'para', 'com', 'e', 'a', 'o', 'em', 'gamer'];

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function termosRelevantes(termo) {
  return normalizar(termo)
    .split(' ')
    .filter((t) => t.length >= 3 && PALAVRAS_IGNORADAS.indexOf(t) === -1);
}

/* Fracao dos termos da busca presentes no titulo do anuncio. */
function aderencia(titulo, termos) {
  if (!termos.length) return 1;
  const alvo = normalizar(titulo);
  const achados = termos.filter((t) => alvo.indexOf(t) !== -1).length;
  return achados / termos.length;
}

function filtrarRelevantes(ofertas, termo, minimo) {
  const termos = termosRelevantes(termo);
  if (!termos.length) return { ofertas, corte: 0 };

  const corte = typeof minimo === 'number' ? minimo : 0.7;
  const comNota = ofertas.map((o) => Object.assign({}, o, { aderencia: aderencia(o.titulo, termos) }));
  const aprovadas = comNota.filter((o) => o.aderencia >= corte);

  // se nada passou, devolve as mais parecidas em vez de uma lista vazia
  if (!aprovadas.length) {
    const melhores = comNota.sort((a, b) => b.aderencia - a.aderencia).slice(0, 5).filter((o) => o.aderencia > 0);
    return { ofertas: melhores, corte, poucasCorrespondencias: true };
  }
  return { ofertas: aprovadas, corte };
}

/* Dois anuncios falam do mesmo produto? Compara as palavras dos titulos.
   Serve para nao anunciar "economia" entre modelos diferentes. */
// palavras de categoria/marketing nao distinguem um modelo de outro
const PALAVRAS_GENERICAS = [
  'teclado', 'mouse', 'mousepad', 'headset', 'fone', 'monitor', 'cadeira', 'gabinete',
  'mecanico', 'mecanica', 'gamer', 'rgb', 'led', 'usb', 'fio', 'sem', 'com', 'wireless',
  'bluetooth', 'preto', 'branco', 'dpi', 'botoes', 'switch', 'anti', 'ghosting', 'abnt2',
  'pro', 'plus', 'rainbow', 'lightsync',
];

/* Codigo do modelo: token que mistura letra e numero (g502, k552, m724, k552rgb).
   E o que realmente identifica o produto entre lojas diferentes. */
function codigosDoTitulo(titulo) {
  return new Set(
    normalizar(titulo)
      .split(' ')
      .filter((t) => t.length >= 3 && /[a-z]/.test(t) && /\d/.test(t))
  );
}

function parecidos(a, b) {
  const ca = codigosDoTitulo(a);
  const cb = codigosDoTitulo(b);
  if (ca.size && cb.size) {
    // um dos codigos precisa aparecer nos dois (ou um conter o outro: k552 e k552rgb)
    for (const x of ca) {
      for (const y of cb) {
        if (x === y || x.indexOf(y) === 0 || y.indexOf(x) === 0) return true;
      }
    }
    return false;
  }

  const palavras = (t) => new Set(
    normalizar(t).split(' ').filter((x) =>
      x.length >= 3 &&
      PALAVRAS_IGNORADAS.indexOf(x) === -1 &&
      PALAVRAS_GENERICAS.indexOf(x) === -1
    )
  );
  const A = palavras(a);
  const B = palavras(b);
  if (!A.size || !B.size) return false;
  let comuns = 0;
  A.forEach((x) => { if (B.has(x)) comuns += 1; });
  return comuns / Math.min(A.size, B.size) >= 0.6;
}

function mediana(valores) {
  if (!valores.length) return 0;
  const v = valores.slice().sort((a, b) => a - b);
  const meio = Math.floor(v.length / 2);
  return v.length % 2 ? v[meio] : (v[meio - 1] + v[meio]) / 2;
}

/* Compara as ofertas da coleta mais recente e devolve o ranking por loja. */
function compararLojas(ofertas, opcoes) {
  const o = opcoes || {};
  let lista = ofertas.slice();
  if (o.somenteNovos !== false) {
    const novos = lista.filter((x) => x.condicao === 'novo');
    if (novos.length) lista = novos;
  }
  if (!lista.length) return { ranking: [], melhor: null, economia: 0, economia_pct: 0 };

  // melhor oferta de cada loja
  const porLoja = new Map();
  lista.forEach((oferta) => {
    const atual = porLoja.get(oferta.loja);
    if (!atual || oferta.preco_total < atual.preco_total) porLoja.set(oferta.loja, oferta);
  });

  const ranking = [...porLoja.values()]
    .map((oferta) => Object.assign({}, oferta, { custo_ajustado: custoAjustado(oferta) }))
    .sort((a, b) => a.custo_ajustado - b.custo_ajustado);

  const melhor = ranking[0];
  const pior = ranking[ranking.length - 1];
  const economia = pior.preco_total - melhor.preco_total;

  // As lojas podem ter devolvido modelos diferentes (comum em busca generica).
  // Nesse caso nao faz sentido falar em "economia": seria comparar produtos distintos.
  const mesmoProduto = ranking.length < 2 || ranking.every((o) => parecidos(melhor.titulo, o.titulo));

  return {
    ranking,
    melhor,
    economia: mesmoProduto ? economia : 0,
    economia_pct: mesmoProduto && pior.preco_total > 0 ? (economia / pior.preco_total) * 100 : 0,
    mesmo_produto: mesmoProduto,
    // o mais barato nem sempre e o recomendado: avisamos quando diferem
    mais_barato: ranking.slice().sort((a, b) => a.preco_total - b.preco_total)[0],
  };
}

/* Compara o preco de hoje com o historico do proprio produto. */
function avaliarMomento(precoAtual, historico) {
  const valores = historico.map((h) => h.minimo).filter((v) => v > 0);
  if (!precoAtual || valores.length < 2) {
    return {
      status: 'sem_historico',
      titulo: 'Ainda sem histórico',
      texto: 'Atualize os preços por alguns dias para o sistema avaliar se o momento é bom.',
      minimo: valores.length ? Math.min(...valores) : precoAtual,
      maximo: valores.length ? Math.max(...valores) : precoAtual,
      mediana: valores.length ? mediana(valores) : precoAtual,
      variacao_pct: 0,
      dias: valores.length,
    };
  }

  const minimo = Math.min(...valores);
  const maximo = Math.max(...valores);
  const med = mediana(valores);
  const variacao = med > 0 ? ((precoAtual - med) / med) * 100 : 0;

  let status, titulo, texto;
  if (precoAtual <= minimo) {
    status = 'otimo';
    titulo = 'Melhor preço já registrado';
    texto = 'É o menor valor desde que você começou a monitorar este produto.';
  } else if (variacao <= -5) {
    status = 'bom';
    titulo = 'Bom momento para comprar';
    texto = 'Está ' + Math.abs(variacao).toFixed(1).replace('.', ',') + '% abaixo da mediana do período.';
  } else if (variacao < 5) {
    status = 'neutro';
    titulo = 'Preço na média';
    texto = 'Está próximo da mediana histórica. Comprar agora não é vantagem nem prejuízo claro.';
  } else {
    status = 'ruim';
    titulo = 'Vale esperar';
    texto = 'Está ' + variacao.toFixed(1).replace('.', ',') + '% acima da mediana. Já esteve por ' +
      minimo.toFixed(2).replace('.', ',') + '.';
  }

  return { status, titulo, texto, minimo, maximo, mediana: med, variacao_pct: variacao, dias: valores.length };
}

module.exports = { compararLojas, avaliarMomento, custoAjustado, mediana, filtrarRelevantes, aderencia, termosRelevantes, parecidos };
```

---

## 6. Orquestracao — agente coletor

Consulta todas as lojas em paralelo, mede o tempo de cada uma e devolve o resultado ao servidor.

Arquivo: `agente.js` (236 linhas)

```js
'use strict';
/* Agente coletor local.
   -------------------------------------------------------------------------
   Por que existe: as lojas respondem normalmente a partir de uma rede
   brasileira, mas bloqueiam servidores de nuvem no exterior (o Render fica
   nos EUA). Entao a coleta roda aqui, no seu computador, e so o resultado e
   enviado para o sistema publicado.

   Como usar (PowerShell):
     $env:SERVIDOR="http://localhost:3000,https://seu-site.onrender.com"
     $env:COLETOR_TOKEN="a-mesma-chave-configurada-no-servidor"
     node agente.js

   SERVIDOR aceita varios destinos separados por virgula: a coleta acontece
   uma unica vez e o resultado e enviado para todos. Assim o banco local
   guarda o historico completo e o site publico mostra os precos atuais.

   Para gerar um token novo:  node agente.js --token
   Para formar historico, agende este comando no Agendador de Tarefas do
   Windows (uma vez por dia ja e suficiente e evita incomodar as lojas).
   ------------------------------------------------------------------------- */

const crypto = require('node:crypto');

const SERVIDORES = String(process.env.SERVIDOR || 'http://localhost:3000')
  .split(',')
  .map((u) => u.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const TOKEN = String(process.env.COLETOR_TOKEN || '').trim();
// cada consulta vai para uma loja diferente, entao a pausa entre elas pode ser curta
const PAUSA_MS = Number(process.env.PAUSA_MS) || 600;

/* O agente roda na maquina do usuario: pode usar o navegador local para as lojas
   que recusam requisicoes simples. O servidor publico usa so as fontes por API. */
const coletores = [
  require('./coletores/kabum.js'),      // API publica
  require('./coletores/pichau.js'),     // navegador
  require('./coletores/terabyte.js'),   // navegador
  require('./coletores/patoloco.js'),   // navegador
  require('./coletores/setupninja.js'), // navegador
  require('./coletores/amazon.js'),     // navegador
  require('./coletores/magalu.js'),     // desligada: a loja bloqueia
  require('./coletores/mercadolivre.js'), // desligada: exige liberacao da API
];

if (process.argv.indexOf('--token') !== -1) {
  console.log('\nToken gerado (use o MESMO valor no servidor e no agente):\n');
  console.log('  ' + crypto.randomBytes(24).toString('hex') + '\n');
  process.exit(0);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const apelido = (url) => url.replace(/^https?:\/\//, '').split('/')[0];

async function pedir(servidor, caminho, opcoes) {
  const conf = Object.assign({ headers: {} }, opcoes);
  conf.headers['X-Coletor-Token'] = TOKEN;
  if (conf.body) {
    conf.headers['Content-Type'] = 'application/json';
    conf.body = JSON.stringify(conf.body);
  }
  const r = await fetch(servidor + caminho, conf);
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || ('HTTP ' + r.status));
  return dados;
}

async function principal() {
  if (!TOKEN) {
    console.error('\n' + 'Defina COLETOR_TOKEN antes de rodar. Gere um com:  node agente.js --token' + '\n');
    process.exit(1);
  }

  console.log('\n  Agente coletor');
  console.log('  destinos: ' + SERVIDORES.map(apelido).join(', '));
  console.log('  fontes:   ' + coletores.filter((c) => c.configurado()).map((c) => c.nome).join(', ') + '\n');

  // 1) cada destino tem os proprios produtos (e os proprios ids)
  const destinos = [];
  for (const servidor of SERVIDORES) {
    try {
      const produtos = await pedir(servidor, '/api/ingestao/pendentes');
      destinos.push({ servidor, produtos });
      console.log('  ' + apelido(servidor) + ': ' + produtos.length + ' produto(s) monitorado(s)');
    } catch (e) {
      console.log('  ' + apelido(servidor) + ': indisponivel (' + e.message + ')');
    }
  }
  if (!destinos.length) {
    console.log('\n  Nenhum destino respondeu. Verifique o COLETOR_TOKEN e os enderecos.\n');
    return;
  }

  // 2) o termo de busca e o que identifica o produto entre servidores diferentes
  const termos = [...new Set(destinos.flatMap((d) => d.produtos.map((p) => p.termo)))];

  // 2b) espelha: o que existe em um destino passa a existir nos outros
  const modelo = new Map();
  destinos.forEach((d) => d.produtos.forEach((p) => { if (!modelo.has(p.termo)) modelo.set(p.termo, p); }));

  for (const destino of destinos) {
    const faltando = termos.filter((t) => !destino.produtos.some((p) => p.termo === t));
    for (const termo of faltando) {
      const base = modelo.get(termo);
      try {
        const r = await pedir(destino.servidor, '/api/ingestao/produtos', {
          method: 'POST',
          body: { nome: base.nome, termo: base.termo },
        });
        destino.produtos.push({ id: r.produto.id, nome: r.produto.nome, termo: r.produto.termo });
        if (r.criado) console.log('  ' + apelido(destino.servidor) + ': produto "' + base.nome + '" criado');
      } catch (e) {
        console.log('  ' + apelido(destino.servidor) + ': nao consegui criar "' + base.nome + '" (' + e.message + ')');
      }
    }
  }
  if (!termos.length) {
    console.log('\n  Nenhum produto monitorado. Cadastre um produto no site e rode de novo.\n');
    return;
  }

  // 3) consulta cada termo uma unica vez, mesmo que va para varios destinos
  console.log('');
  const resultados = new Map();
  for (const termo of termos) {
    console.log('  "' + termo + '"');
    resultados.set(termo, await consultarTodas(termo));
    await espera(PAUSA_MS);
  }

  // 4) envia o mesmo resultado para cada destino, usando o id de produto de la
  console.log('');
  let gravadasTotal = 0;
  for (const destino of destinos) {
    let doDestino = 0;
    for (const produto of destino.produtos) {
      for (const r of resultados.get(produto.termo) || []) {
        try {
          const resp = await pedir(destino.servidor, '/api/ingestao', {
            method: 'POST',
            body: { produto_id: produto.id, fonte: r.fonte, ofertas: r.ofertas, erro: r.erro },
          });
          doDestino += resp.gravadas;
        } catch (e) {
          console.log('  ' + apelido(destino.servidor) + ' / ' + produto.nome + ': falhou (' + e.message + ')');
        }
      }
    }
    gravadasTotal += doDestino;
    console.log('  ' + apelido(destino.servidor) + ': ' + doDestino + ' oferta(s) gravada(s)');
  }

  console.log('\n  Concluido: ' + gravadasTotal + ' gravacao(oes) em ' + destinos.length + ' destino(s).\n');
}

/* Consulta todas as lojas EM PARALELO e mede quanto cada uma levou.
   Sao sites diferentes, entao a consulta simultanea nao sobrecarrega ninguem. */
async function consultarTodas(termo) {
  const tarefas = coletores.map(async (coletor) => {
    if (!coletor.configurado()) {
      return { fonte: coletor.nome, erro: 'Fonte nao configurada.', ofertas: [], ms: 0 };
    }
    const inicio = Date.now();
    try {
      const ofertas = await coletor.buscar(termo);
      const ms = Date.now() - inicio;
      console.log('      ' + coletor.nome.padEnd(15) + ofertas.length + ' oferta(s) em ' + (ms / 1000).toFixed(1) + 's');
      return { fonte: coletor.nome, erro: '', ofertas, ms };
    } catch (e) {
      const ms = Date.now() - inicio;
      console.log('      ' + coletor.nome.padEnd(15) + 'erro: ' + e.message.slice(0, 70));
      return { fonte: coletor.nome, erro: e.message, ofertas: [], ms };
    }
  });
  return Promise.all(tarefas);
}

/* ---------- modo servico: atende as buscas pedidas no site publico ---------- */
async function atenderBuscas() {
  for (const servidor of SERVIDORES) {
    let pendentes = [];
    try {
      pendentes = await pedir(servidor, '/api/ingestao/buscas');
    } catch (e) {
      continue; // servidor fora do ar ou sem token: tenta no proximo ciclo
    }

    for (const busca of pendentes) {
      console.log('  [' + new Date().toLocaleTimeString('pt-BR') + '] busca de visitante: "' + busca.termo + '"');
      const inicio = Date.now();
      const fontes = await consultarTodas(busca.termo);
      const duracao = Date.now() - inicio;
      console.log('      total: ' + fontes.reduce((t, f) => t + f.ofertas.length, 0) + ' oferta(s) em ' + (duracao / 1000).toFixed(1) + 's');

      try {
        await pedir(servidor, '/api/ingestao/buscas/' + busca.id, {
          method: 'POST',
          body: { fontes, duracao_ms: duracao },
        });
      } catch (e) {
        console.log('      nao consegui devolver o resultado: ' + e.message);
      }
    }
  }
}

async function servico() {
  const intervalo = Number(process.env.INTERVALO_MS) || 4000;
  console.log('');
  console.log('  Agente em modo servico');
  console.log('  destinos: ' + SERVIDORES.map(apelido).join(', '));
  console.log('  atendendo buscas do site a cada ' + (intervalo / 1000) + 's. Ctrl+C para parar.');
  console.log('');
  for (;;) {
    try {
      await atenderBuscas();
    } catch (e) {
      console.log('  erro no ciclo: ' + e.message);
    }
    await espera(intervalo);
  }
}

if (process.argv.indexOf('--servico') !== -1) {
  if (!TOKEN) {
    console.error('Defina COLETOR_TOKEN antes de rodar.');
    process.exit(1);
  }
  servico();
} else {

principal().catch((e) => {
  console.error('\n  Erro: ' + e.message + '\n');
  process.exit(1);
});
}
```
