'use strict';
/* Coletor do Magazine Luiza, pelo navegador local.
   Muitos anuncios sao de vendedores parceiros (marketplace): guardamos quem vende. */

const navegador = require('./navegador.js');

const NOME = 'Magazine Luiza';
const LIMITE = Number(process.env.MAGALU_LIMITE) || 12;

// A Magalu bloqueia acesso automatizado mesmo com navegador real ("Nao e possivel
// acessar a pagina"). Fica desligada ate existir um caminho legitimo; ative com
// MAGALU_ATIVO=1 para testar.
const configurado = () => process.env.MAGALU_ATIVO === '1' && navegador.disponivel();

const SCRIPT = `(() => {
  const links = [...document.querySelectorAll('a[href*="/p/"]')];
  const vistos = new Set();
  const itens = [];

  for (const a of links) {
    const href = a.getAttribute('href');
    if (!href || vistos.has(href)) continue;
    vistos.add(href);

    const texto = a.textContent.replace(/\\s+/g, ' ').trim();
    if (!/R\\$/.test(texto)) continue;

    // titulo: o trecho antes da nota/preco
    const titulo = (a.querySelector('h2, [data-testid="product-title"]') || {}).textContent
      || texto.split(/\\d,\\d\\(|Preço|R\\$/)[0];

    const precoMatch = texto.match(/R\\$\\s*([\\d.,]+)/);
    const vendedor = (href.match(/seller_id=([^&]+)/) || [])[1] || '';

    itens.push({
      titulo: String(titulo).replace(/^Full/, '').trim(),
      precoTexto: precoMatch ? precoMatch[1] : '',
      href: href.indexOf('http') === 0 ? href : 'https://www.magazineluiza.com.br' + href,
      vendedor,
      esgotado: /indispon|esgotad/i.test(texto),
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
  const url = 'https://www.magazineluiza.com.br/busca/' + encodeURIComponent(termo) + '/';
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 4500, visitarAntes: 'https://www.magazineluiza.com.br/' })) || [];

  return itens
    .filter((i) => !i.esgotado)
    .slice(0, LIMITE)
    .map((i) => {
      const preco = paraNumero(i.precoTexto);
      const proprio = !i.vendedor || i.vendedor === 'magazineluiza';
      return {
        loja: NOME,
        titulo: String(i.titulo || '').slice(0, 200),
        preco,
        frete: 0,
        preco_total: preco,
        frete_gratis: false,
        condicao: 'novo',
        vendedor: proprio ? NOME : i.vendedor,
        // vendedor parceiro nao tem a mesma garantia da loja: entra com reputacao neutra
        reputacao: proprio ? '5_green' : '3_yellow',
        vendidos: 0,
        parcelas: 0,
        url: i.href,
        id_externo: '',
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'magalu', configurado, buscar };
