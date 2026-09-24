'use strict';
/* Coletor da KaBuM!.
   -------------------------------------------------------------------------
   Duas portas para o mesmo catalogo:

   1. a pagina de busca do site, lida pelo navegador local. E o caminho
      preferido: devolve exatamente o que a loja mostra para o termo;
   2. a API publica do catalogo, sem credencial, para quando nao ha navegador
      (o servidor na nuvem). Ela responde bem a termos de duas palavras ou
      mais, mas erra feio em palavra unica - "teclado" traz fontes "Teclab" -,
      entao fica como reserva. */

const navegador = require('./navegador.js');

const NOME = 'KaBuM!';
const BASE = 'https://servicespub.prod.api.aws.grupokabum.com.br/catalog/v2/products';
const LIMITE = Number(process.env.KABUM_LIMITE) || 12;
const PRAZO_MS = Number(process.env.PRAZO_LOJA_MS) || 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Uma das duas portas sempre existe: nada para configurar.
function configurado() {
  return true;
}

/* A pagina de busca e um app Next.js: os produtos ja vem no __NEXT_DATA__,
   sem precisar ler o HTML montado. */
const SCRIPT = `(() => {
  const el = document.getElementById('__NEXT_DATA__');
  if (!el) return [];
  try {
    const dados = JSON.parse(el.textContent);
    const catalogo = dados.props.pageProps.data.catalogServer;
    return (catalogo.data || []).slice(0, 40);
  } catch (e) {
    return [];
  }
})()`;

function normalizar(item) {
  const a = item.attributes || {};
  // price_with_discount é o preço à vista (boleto/pix); price é o "de".
  const preco = Number(a.price_with_discount) > 0 ? Number(a.price_with_discount) : Number(a.price) || 0;
  const precoDe = Number(a.price) > preco ? Number(a.price) : 0;
  // product_link e apenas o "slug" do produto: a URL valida e /produto/{id}/{slug}
  const slug = String(a.product_link || '').replace(/^\//, '');
  const url = 'https://www.kabum.com.br/produto/' + item.id + (slug ? '/' + slug : '');

  return {
    loja: NOME,
    titulo: String(a.title || ''),
    preco,
    preco_de: precoDe,
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

/* A pagina entrega os mesmos produtos da API, mas com outros nomes de campo:
   name no lugar de title, priceWithDiscount no lugar de price_with_discount,
   e as parcelas como texto ("6x de R$ 27,44"). */
function normalizarDaPagina(item) {
  const preco = Number(item.priceWithDiscount) > 0 ? Number(item.priceWithDiscount) : Number(item.price) || 0;
  const cheio = Math.max(Number(item.oldPrice) || 0, Number(item.price) || 0);
  const slug = String(item.friendlyName || '').replace(/^\//, '');

  return {
    loja: NOME,
    titulo: String(item.name || ''),
    preco,
    preco_de: cheio > preco ? cheio : 0,
    frete: 0,
    preco_total: preco,
    frete_gratis: false,
    condicao: 'novo',
    vendedor: String(item.sellerName || NOME),
    reputacao: Number(item.offerIdMarketplace) ? '' : '5_green',
    vendidos: 0,
    parcelas: parseInt(String(item.maxInstallment || ''), 10) || 0,
    url: 'https://www.kabum.com.br/produto/' + item.code + (slug ? '/' + slug : ''),
    id_externo: String(item.code || ''),
  };
}

/* Porta 1: a pagina de busca, pelo navegador local. */
async function pelaPagina(termo) {
  const url = 'https://www.kabum.com.br/busca/' + encodeURIComponent(termo);
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 2500 })) || [];
  return itens
    .filter((i) => i.available !== false)
    .slice(0, LIMITE)
    .map(normalizarDaPagina)
    .filter((o) => o.preco > 0 && o.titulo);
}

/* Porta 2: a API do catalogo, com os mesmos parametros que o site usa. */
async function pelaApi(termo) {
  const url = BASE + '?query=' + encodeURIComponent(termo) +
    '&page_number=1&page_size=' + LIMITE +
    '&facet_filters=&sort=most_searched&variant=retail&is_prime=false';

  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Origin: 'https://www.kabum.com.br',
      Referer: 'https://www.kabum.com.br/busca/' + encodeURIComponent(termo),
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    },
    // o fetch do Node nao tem prazo proprio: sem isso, uma conexao pendurada
    // travaria a rodada inteira do agente
    signal: AbortSignal.timeout(PRAZO_MS),
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

/* Preferencia pela pagina; a API entra quando nao ha navegador ou quando a
   pagina nao rendeu nada. */
async function buscar(termo) {
  if (navegador.disponivel()) {
    try {
      const doSite = await pelaPagina(termo);
      if (doSite.length) return doSite;
    } catch (e) {
      // navegador ocupado, Chrome fechado ou pagina mudou: a API ainda responde
    }
  }
  return pelaApi(termo);
}

module.exports = { nome: NOME, chave: 'kabum', configurado, buscar };
