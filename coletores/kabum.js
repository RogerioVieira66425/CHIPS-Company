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
  const linkRelativo = a.product_link || '';
  const url = linkRelativo
    ? (linkRelativo.indexOf('http') === 0 ? linkRelativo : 'https://www.kabum.com.br' + (linkRelativo[0] === '/' ? '' : '/') + linkRelativo)
    : 'https://www.kabum.com.br/produto/' + item.id;

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
