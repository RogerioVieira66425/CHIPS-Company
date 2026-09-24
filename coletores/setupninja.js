'use strict';
/* Coletor da Setup Ninja, pelo navegador local. */

const navegador = require('./navegador.js');

const NOME = 'Setup Ninja';
const LIMITE = Number(process.env.SETUPNINJA_LIMITE) || 12;

const configurado = () => navegador.disponivel();

const SCRIPT = `(() => {
  const itens = [];
  const cartoes = [...document.querySelectorAll('.product-card')];

  for (const c of cartoes) {
    const a = c.querySelector('a[href]');
    if (!a) continue;

    const texto = c.textContent.replace(/\\s+/g, ' ').trim();

    // titulo: maior trecho sem preco nem porcentagem
    const titulo = [...c.querySelectorAll('h1,h2,h3,h4,p,span,div')]
      .map((e) => e.textContent.replace(/\\s+/g, ' ').trim())
      .filter((t) => t.length > 18 && t.length < 200 && !/R\\$|% OFF/.test(t))
      .sort((x, y) => x.length - y.length)[0] || '';

    // "price total" e o valor no pix (o que a loja destaca)
    const alvo = c.querySelector('.price.total') || c.querySelector('[class*="price"]');
    const antigo = c.querySelector('.discount');
    const precoTexto = alvo ? alvo.textContent.trim() : (texto.match(/R\\$\\s*[\\d.,]+/) || [''])[0];

    itens.push({
      titulo,
      precoTexto,
      precoDeTexto: antigo ? antigo.textContent.trim() : '',
      href: a.getAttribute('href'),
      esgotado: /indispon|esgotad|avise-me/i.test(texto),
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
  const url = 'https://www.setupninja.com.br/produtos?q=' + encodeURIComponent(termo);
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 5000 })) || [];

  const vistos = new Set();
  return itens
    .filter((i) => !i.esgotado)
    .filter((i) => {
      if (vistos.has(i.href)) return false;
      vistos.add(i.href);
      return true;
    })
    .slice(0, LIMITE)
    .map((i) => {
      const preco = paraNumero(i.precoTexto);
      const precoDe = paraNumero(i.precoDeTexto);
      const href = String(i.href || '');
      return {
        loja: NOME,
        titulo: String(i.titulo || '').slice(0, 200),
        preco,
        preco_de: precoDe > preco ? precoDe : 0,
        frete: 0,
        preco_total: preco,
        frete_gratis: false,
        condicao: 'novo',
        vendedor: NOME,
        reputacao: '5_green',
        vendidos: 0,
        parcelas: 0,
        url: href.indexOf('http') === 0 ? href : 'https://www.setupninja.com.br/' + href.replace(/^\//, ''),
        id_externo: '',
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'setupninja', configurado, buscar };
