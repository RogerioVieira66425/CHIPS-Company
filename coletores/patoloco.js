'use strict';
/* Coletor da Patoloco, pelo navegador local. */

const navegador = require('./navegador.js');

const NOME = 'Patoloco';
const LIMITE = Number(process.env.PATOLOCO_LIMITE) || 12;

const configurado = () => navegador.disponivel();

const SCRIPT = `(() => {
  const itens = [];
  const caixas = [...document.querySelectorAll('.wapper-product-price')];

  for (const caixa of caixas) {
    // sobe ate o cartao do produto (o que tem link e titulo)
    let cartao = caixa;
    for (let i = 0; i < 6 && cartao; i++) {
      cartao = cartao.parentElement;
      if (cartao && cartao.querySelector('a[href]') && cartao.textContent.length > 80) break;
    }
    if (!cartao) continue;

    const a = cartao.querySelector('a[href]');
    if (!a) continue;

    const titulos = [...cartao.querySelectorAll('h1,h2,h3,h4,a,span')]
      .map((e) => e.textContent.replace(/\\s+/g, ' ').trim())
      // descarta textos de promocao e contador, que ficam no mesmo cartao
      .filter((t) => t.length > 20 && t.length < 200 && !/R\\$/.test(t)
        && !/promo|acaba em|desconto|comprar|frete|parcel|avise|estoque|cupom|adicionar/i.test(t));
    const titulo = titulos.sort((x, y) => x.length - y.length)[0] || '';

    const textoPreco = caixa.textContent.replace(/\\s+/g, ' ').trim();
    // "10% DE DESCONTO R$ 109,57 R$ 83,82 a vista no PIX" -> queremos o segundo
    const valores = textoPreco.match(/R\\$\\s*[\\d.,]+/g) || [];
    const precoTexto = valores.length > 1 ? valores[1] : (valores[0] || '');
    const precoDeTexto = valores.length > 1 ? valores[0] : '';

    const textoCartao = cartao.textContent;
    itens.push({
      titulo,
      precoTexto,
      precoDeTexto,
      href: a.getAttribute('href'),
      esgotado: /indispon|avise-me|esgotad/i.test(textoCartao),
      openbox: /open-?box/i.test(textoCartao),
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
  const url = 'https://patoloco.com.br/busca?buscar-por=' + encodeURIComponent(termo);
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 4000 })) || [];

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
        condicao: i.openbox ? 'usado' : 'novo',
        vendedor: NOME,
        reputacao: '5_green',
        vendidos: 0,
        parcelas: 0,
        url: href.indexOf('http') === 0 ? href : 'https://patoloco.com.br/' + href.replace(/^\//, ''),
        id_externo: '',
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'patoloco', configurado, buscar };
