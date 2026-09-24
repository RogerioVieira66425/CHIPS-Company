'use strict';
/* Coletor da Amazon BR, pelo navegador local.
   A Amazon recusa requisicoes simples (503) mas responde normalmente a um navegador. */

const navegador = require('./navegador.js');

const NOME = 'Amazon';
const LIMITE = Number(process.env.AMAZON_LIMITE) || 12;

const configurado = () => navegador.disponivel();

const SCRIPT = `(() => {
  const itens = [];
  const cartoes = [...document.querySelectorAll('div[data-asin]')].filter((c) => c.getAttribute('data-asin'));

  for (const c of cartoes) {
    const asin = c.getAttribute('data-asin');
    if (!asin) continue;

    const tituloEl = c.querySelector('h2');
    const titulo = tituloEl ? tituloEl.textContent.replace(/\\s+/g, ' ').trim() : '';
    if (!titulo) continue;

    const precoEl = c.querySelector('.a-price .a-offscreen');
    if (!precoEl) continue;

    // preco "de": a Amazon marca o valor cheio como a-text-price
    const deEl = c.querySelector('.a-price.a-text-price .a-offscreen, .a-text-price .a-offscreen');

    const texto = c.textContent;
    itens.push({
      asin,
      titulo,
      precoTexto: precoEl.textContent.trim(),
      precoDeTexto: deEl ? deEl.textContent.trim() : '',
      patrocinado: /patrocinado|sponsored/i.test(texto),
      usado: /usado|recondicionado|renewed/i.test(texto),
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
  const url = 'https://www.amazon.com.br/s?k=' + encodeURIComponent(termo);
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 4000 })) || [];

  const vistos = new Set();
  return itens
    .filter((i) => {
      if (vistos.has(i.asin)) return false;
      vistos.add(i.asin);
      return true;
    })
    .slice(0, LIMITE)
    .map((i) => {
      const preco = paraNumero(i.precoTexto);
      const precoDe = paraNumero(i.precoDeTexto);
      return {
        loja: NOME,
        titulo: String(i.titulo || '').slice(0, 200),
        preco,
        preco_de: precoDe > preco ? precoDe : 0,
        frete: 0, // o frete depende do CEP e do Prime
        preco_total: preco,
        frete_gratis: false,
        condicao: i.usado ? 'usado' : 'novo',
        // a Amazon tambem vende por terceiros; sem essa informacao na busca,
        // fica como reputacao neutra em vez de maxima
        vendedor: NOME,
        reputacao: '4_light_green',
        vendidos: 0,
        parcelas: 0,
        url: 'https://www.amazon.com.br/dp/' + i.asin,
        id_externo: i.asin,
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'amazon', configurado, buscar };
