'use strict';
/* Calculo de frete e prazo por CEP.
   -------------------------------------------------------------------------
   As lojas so revelam frete e prazo depois que o comprador informa o CEP, na
   pagina do produto. Este modulo abre a pagina da oferta no navegador local,
   preenche o CEP e le o resultado.

   E caro (uma pagina por oferta), entao o agente so calcula o frete das
   melhores ofertas de cada loja, que sao as que disputam a recomendacao. */

const navegador = require('./navegador.js');

const disponivel = () => navegador.disponivel();

/* Passo 1: abre a caixa de CEP e coloca o cursor no campo.
   Quem digita e o proprio Chrome (Input.insertText), nao o JavaScript. */
function scriptPreparar(seletorCampo) {
  return `(async () => {
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const visivel = (e) => e && e.offsetParent !== null;

    const abridor = [...document.querySelectorAll('button, a')].find((b) =>
      visivel(b) && /cep|calcular frete/i.test((b.getAttribute('aria-label') || '') + ' ' + b.textContent));
    if (abridor) { abridor.click(); await espera(1200); }

    const campo = ${seletorCampo ? `document.querySelector(${JSON.stringify(seletorCampo)}) || ` : ''}
      [...document.querySelectorAll('input')].filter(visivel).find((i) => /cep|zip|postal/i.test(
        (i.getAttribute('placeholder') || '') + (i.id || '') + (i.getAttribute('name') || '') +
        (i.getAttribute('aria-label') || '') + (i.className || '')));
    if (!campo) return false;

    campo.focus();
    campo.select && campo.select();
    return true;
  })()`;
}

/* Passo 2: devolve a posicao do botao de confirmar, para um clique real do mouse. */
const SCRIPT_POSICAO_BOTAO = `(() => {
  const visivel = (e) => e && e.offsetParent !== null;
  const rotulo = (b) => ((b.getAttribute('aria-label') || '') + ' ' + b.textContent).replace(/\s+/g, ' ').trim();
  const abridor = [...document.querySelectorAll('button')].find((b) => /abrir caixa/i.test(rotulo(b)));
  const botao = [...document.querySelectorAll('button')]
    .filter((b) => visivel(b) && b !== abridor)
    .find((b) => /inserir\s*cep|calcular frete|^calcular$/i.test(rotulo(b)));
  if (!botao) return null;
  const r = botao.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

/* Passo 3 (reserva): clique por JavaScript, quando o clique real nao se aplica. */
const SCRIPT_CONFIRMAR = `(() => {
  const visivel = (e) => e && e.offsetParent !== null;
  const rotulo = (b) => ((b.getAttribute('aria-label') || '') + ' ' + b.textContent).replace(/\\s+/g, ' ').trim();
  const botao = [...document.querySelectorAll('button')].filter(visivel)
    .find((b) => /inserir\\s*cep|calcular frete|calcular$/i.test(rotulo(b)));
  if (botao) botao.click();
  return true;
})()`;

/* Passo 3: le o bloco que mostra frete e prazo. */
const SCRIPT_LER = `(async () => {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const fora = (e) => !e.closest('header, nav, footer');
  const padrao = /(chegar[\u00e1a]|receba|entrega em|dias\\s*[\u00fau]teis|prazo de entrega|frete)/i;

  const procurar = () => {
    const candidatos = [...document.querySelectorAll('div, section, li, p, span, td')]
      .filter((e) => e.offsetParent !== null && fora(e))
      .filter((e) => {
        const t = e.textContent || '';
        return t.length < 300 && padrao.test(t) && /(R\\$\\s*[\\d.,]+|gr[\u00e1a]tis)/i.test(t);
      });
    candidatos.sort((a, b) => a.textContent.length - b.textContent.length);
    return candidatos[0] || null;
  };

  let bloco = null;
  for (let i = 0; i < 12 && !bloco; i++) {
    await espera(1000);
    bloco = procurar();
  }
  if (!bloco) return { erro: 'sem informacao de entrega' };
  return { trecho: bloco.textContent.replace(/\\s+/g, ' ').trim() };
})()`;

const SELETORES = {
  'KaBuM!': '#zipCodeInputField',
};

function valorDoTexto(trecho) {
  // "Chegara ate segunda-feira, 28/09 R$ 11,66" / "Frete gratis"
  if (/gr[aá]tis|gratuito/i.test(trecho)) return 0;
  const m = trecho.match(/R\$\s*([\d.]+,\d{2})/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function prazoDoTexto(trecho) {
  const ate = trecho.match(/(chegar[áa]\s+at[ée]|receba\s+at[ée]|entrega\s+at[ée])\s+([^R$|.]{3,40})/i);
  if (ate) return ate[0].replace(/\s+/g, ' ').trim().slice(0, 60);
  const dias = trecho.match(/(\d+)\s*(a\s*\d+\s*)?dias?\s*[úu]teis/i);
  if (dias) return dias[0].trim();
  return '';
}

/* Consulta o frete de UMA oferta. Devolve { frete, prazo } ou null. */
async function consultar(oferta, cep) {
  if (!disponivel() || !oferta.url) return null;
  try {
    const r = await navegador.extrair(oferta.url, SCRIPT_LER, {
      esperaMs: 2500,
      interacao: {
        preparar: scriptPreparar(SELETORES[oferta.loja]),
        texto: cep,
        enter: true,
        clicar: SCRIPT_POSICAO_BOTAO,
        depois: SCRIPT_CONFIRMAR,
        esperaDepoisMs: 1200,
      },
    });
    if (!r || r.erro || !r.trecho) return null;

    const frete = valorDoTexto(r.trecho);
    const prazo = prazoDoTexto(r.trecho);
    if (frete === null && !prazo) return null;
    return { frete: frete === null ? 0 : frete, prazo, frete_estimado: frete === null };
  } catch (e) {
    return null;
  }
}

/* Calcula o frete das melhores ofertas (uma por loja) em paralelo. */
async function calcularParaMelhores(ofertas, cep, limite) {
  if (!cep || !/^\d{8}$/.test(String(cep).replace(/\D/g, ''))) return ofertas;
  const cepLimpo = String(cep).replace(/\D/g, '');

  // melhor oferta de cada loja, as mais baratas primeiro
  const porLoja = new Map();
  ofertas.forEach((o) => {
    const atual = porLoja.get(o.loja);
    if (!atual || o.preco < atual.preco) porLoja.set(o.loja, o);
  });
  const alvos = [...porLoja.values()].sort((a, b) => a.preco - b.preco).slice(0, limite || 4);

  const resultados = await Promise.all(alvos.map(async (o) => ({ oferta: o, dados: await consultar(o, cepLimpo) })));

  resultados.forEach(({ oferta, dados }) => {
    if (!dados) return;
    oferta.frete = dados.frete;
    oferta.preco_total = oferta.preco + dados.frete;
    oferta.prazo = dados.prazo;
    oferta.frete_calculado = true;
  });

  return ofertas;
}

module.exports = { disponivel, consultar, calcularParaMelhores, valorDoTexto, prazoDoTexto };
