'use strict';
/* Coletor do Mercado Livre usando a API oficial.
   Precisa de um aplicativo criado em https://developers.mercadolivre.com.br
   e das variaveis de ambiente ML_CLIENT_ID e ML_CLIENT_SECRET. */

const SITE = process.env.ML_SITE || 'MLB'; // MLB = Brasil
const CLIENT_ID = String(process.env.ML_CLIENT_ID || '').trim().replace(/^["']|["']$/g, '');
const CLIENT_SECRET = String(process.env.ML_CLIENT_SECRET || '').trim().replace(/^["']|["']$/g, '');
const LIMITE = Number(process.env.ML_LIMITE) || 20;

const NOME = 'Mercado Livre';

let cache = { token: '', expira: 0 };

function configurado() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

async function obterToken() {
  if (cache.token && Date.now() < cache.expira) return cache.token;

  const corpo = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: corpo,
  });
  const dados = await r.json().catch(() => ({}));

  if (!r.ok || !dados.access_token) {
    const detalhe = dados.message || dados.error || ('HTTP ' + r.status);
    throw new Error(
      'Nao foi possivel autenticar no Mercado Livre: ' + detalhe +
      ' (Client ID usado: ' + CLIENT_ID.slice(0, 6) + '...' + CLIENT_ID.slice(-4) + ', tamanho do secret: ' + CLIENT_SECRET.length + ' caracteres)'
    );
  }

  cache = {
    token: dados.access_token,
    // renova um minuto antes de expirar
    expira: Date.now() + (Number(dados.expires_in) || 21600) * 1000 - 60000,
  };
  return cache.token;
}

const CONDICAO = { new: 'novo', used: 'usado', not_specified: 'nao informado' };

function normalizar(item) {
  const preco = Number(item.price) || 0;
  const freteGratis = Boolean(item.shipping && item.shipping.free_shipping);
  // A API de busca nao devolve o frete exato (depende do CEP do comprador).
  // Guardamos 0 quando o frete e gratis e deixamos o ajuste manual para os demais.
  const frete = freteGratis ? 0 : 0;

  return {
    loja: NOME,
    titulo: String(item.title || ''),
    preco,
    frete,
    preco_total: preco + frete,
    frete_gratis: freteGratis,
    condicao: CONDICAO[item.condition] || 'nao informado',
    vendedor: String(
      (item.seller && (item.seller.nickname || item.seller.eshop && item.seller.eshop.nick_name)) ||
      (item.official_store_name || '')
    ),
    reputacao: String(
      (item.seller && item.seller.seller_reputation && item.seller.seller_reputation.level_id) || ''
    ),
    vendidos: Number(item.sold_quantity) || 0,
    parcelas: Number(item.installments && item.installments.quantity) || 0,
    url: String(item.permalink || ''),
    id_externo: String(item.id || ''),
  };
}

async function buscar(termo) {
  if (!configurado()) {
    throw new Error(
      'Mercado Livre nao configurado: defina ML_CLIENT_ID e ML_CLIENT_SECRET nas variaveis de ambiente.'
    );
  }
  const token = await obterToken();
  const url =
    'https://api.mercadolibre.com/sites/' + SITE + '/search?q=' + encodeURIComponent(termo) +
    '&limit=' + LIMITE;

  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });

  if (r.status === 401 || r.status === 403) {
    cache = { token: '', expira: 0 };
    const detalhe = await r.text().catch(() => '');
    throw new Error('Mercado Livre recusou a consulta (' + r.status + '). ' + detalhe.slice(0, 200));
  }
  if (!r.ok) throw new Error('Mercado Livre respondeu HTTP ' + r.status + '.');

  const dados = await r.json().catch(() => ({}));
  const itens = Array.isArray(dados.results) ? dados.results : [];
  return itens.map(normalizar).filter((o) => o.preco > 0);
}

module.exports = { nome: NOME, chave: 'mercadolivre', configurado, buscar };
