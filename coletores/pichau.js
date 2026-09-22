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
