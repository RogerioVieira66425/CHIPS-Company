'use strict';
/* Coletor da Terabyte Shop, pelo navegador local (a loja recusa requisicoes simples). */

const navegador = require('./navegador.js');

const NOME = 'Terabyte';
const LIMITE = Number(process.env.TERABYTE_LIMITE) || 12;

const configurado = () => navegador.disponivel();

const SCRIPT = `(() => {
  const cartoes = [...document.querySelectorAll('.product-item__box, .commerce_columns_item')];
  const itens = [];

  for (const c of cartoes) {
    const a = c.querySelector('a[href*="/produto/"]');
    if (!a) continue;

    const texto = c.textContent.replace(/\\s+/g, ' ').trim();
    const titulo = (c.querySelector('.product-item__name, h2, .prod-name') || {}).textContent
      || texto.split(/De:|R\\$/)[0];

    // "De: R$ 305,87 por: R$ 259,99 a vista" -> queremos o "por"
    const porMatch = texto.match(/por:?\\s*R\\$\\s*([\\d.,]+)/i);
    const deMatch = texto.match(/de:?\\s*R\\$\\s*([\\d.,]+)/i);
    const todos = texto.match(/R\\$\\s*[\\d.,]+/g) || [];
    const precoTexto = porMatch ? porMatch[1] : (todos.length > 1 ? todos[1] : (todos[0] || ''));

    const href = a.getAttribute('href');
    itens.push({
      titulo: String(titulo).trim(),
      precoTexto,
      precoDeTexto: deMatch ? deMatch[1] : '',
      href: href.indexOf('http') === 0 ? href : 'https://www.terabyteshop.com.br' + href,
      esgotado: /indispon|avise-me|esgotad/i.test(texto),
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
  const url = 'https://www.terabyteshop.com.br/busca?str=' + encodeURIComponent(termo);
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 3500 })) || [];

  return itens
    .filter((i) => !i.esgotado)
    .slice(0, LIMITE)
    .map((i) => {
      const preco = paraNumero(i.precoTexto);
      const precoDe = paraNumero(i.precoDeTexto);
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
        url: i.href,
        id_externo: '',
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'terabyte', configurado, buscar };
