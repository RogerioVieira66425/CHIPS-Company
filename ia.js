'use strict';
/* Busca no banco de ofertas (tabela ofertas_ia).
   -------------------------------------------------------------------------
   Esta e a unica fonte de precos do site. As lojas nao sao mais consultadas
   em tempo real: as ofertas entram pelo importador (scripts/importar-csv.js)
   e a busca so le o banco. Funciona com o Supabase (DATABASE_URL) e com o
   SQLite local, pelo mesmo db.js. */

const db = require('./db.js');
const analise = require('./analise.js');

const SITUACOES = ['Boa Compra', 'Preço Médio', 'Sem Histórico (Novo)', 'Evitar', 'Anomalia (Isolada por IA)'];

/* Texto de busca sem acento e em minusculas: "mecânico" e "mecanico" casam. */
function textoDeBusca(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* Quantidade por situacao e por loja, para o painel de resumo. */
async function resumo() {
  const porSituacao = await db.all('SELECT situacao_compra AS situacao, COUNT(*) AS ofertas FROM ofertas_ia GROUP BY situacao_compra ORDER BY ofertas DESC');
  const porLoja = await db.all('SELECT nome_loja AS loja, COUNT(*) AS ofertas FROM ofertas_ia GROUP BY nome_loja ORDER BY ofertas DESC');
  const totais = await db.get('SELECT COUNT(*) AS ofertas, COUNT(DISTINCT nome_produto_padronizado) AS produtos FROM ofertas_ia');
  return { totais, por_situacao: porSituacao, por_loja: porLoja };
}

/* Ofertas filtradas (rota /api/ia/ofertas). Parametros viram valores, nunca SQL. */
async function ofertas(filtro) {
  const f = filtro || {};
  const condicoes = [];
  const valores = [];
  if (SITUACOES.indexOf(f.situacao) !== -1) { condicoes.push('situacao_compra = ?'); valores.push(f.situacao); }
  if (f.loja) { condicoes.push('nome_loja = ?'); valores.push(String(f.loja).slice(0, 60)); }
  if (f.q) { condicoes.push('texto_busca LIKE ?'); valores.push('%' + textoDeBusca(String(f.q).slice(0, 80)) + '%'); }

  const limite = Math.min(Math.max(Number(f.limite) || 50, 1), 200);
  const pagina = Math.max(Number(f.pagina) || 1, 1);
  const where = condicoes.length ? 'WHERE ' + condicoes.join(' AND ') : '';
  const linhas = await db.all(
    'SELECT nome_produto_padronizado AS produto, nome_oferta_original AS titulo, nome_loja AS loja, ' +
    '  preco, preco_referencia_base, variacao_vs_base, situacao_compra AS situacao, url_oferta AS url ' +
    'FROM ofertas_ia ' + where + ' ORDER BY preco ASC LIMIT ? OFFSET ?',
    ...valores, limite, (pagina - 1) * limite
  );
  return { pagina, limite, ofertas: linhas };
}

/* Converte uma linha do banco no formato de oferta que a comparacao usa. */
function paraOferta(r) {
  const preco = Number(r.preco) || 0;
  const referencia = Number(r.preco_referencia_base) || 0;
  // a referencia e o "preco de" riscado: so vale quando e plausivel (ate 3x o preco).
  // Referencias muito maiores que isso sao erro da base, e mostrariam descontos absurdos.
  const precoDe = referencia > preco && referencia <= preco * 3 ? referencia : 0;
  const amazon = r.nome_loja === 'Amazon';
  return {
    loja: r.nome_loja,
    titulo: r.nome_oferta_original,
    preco,
    preco_de: precoDe,
    frete: 0,
    preco_total: preco,
    frete_gratis: false,
    condicao: 'novo',
    vendedor: r.nome_loja,
    reputacao: amazon ? '4_light_green' : '5_green',
    vendidos: 0,
    parcelas: 0,
    url: String(r.url_oferta || ''),
    id_externo: '',
    situacao: r.situacao_compra,
  };
}

/* Pesquisa o termo no banco e devolve o mesmo formato que a tela de resultados
   recebia das lojas: fontes agrupadas por loja, comparacao e relevancia. */
async function pesquisar(termo) {
  const inicio = Date.now();
  const t = textoDeBusca(termo);
  const palavras = t.split(' ').filter((p) => p.length >= 2);
  if (!palavras.length) {
    return { fontes: [], comparacao: analise.compararLojas([]), relevantes: 0, total_bruto: 0, duracao_ms: 0 };
  }

  // cada palavra precisa aparecer no texto da oferta; a relevancia fina vem depois
  const condicoes = palavras.map(() => 'texto_busca LIKE ?').join(' AND ');
  const linhas = await db.all(
    'SELECT nome_produto_padronizado, nome_oferta_original, nome_loja, preco, preco_referencia_base, ' +
    '  situacao_compra, url_oferta FROM ofertas_ia WHERE ' + condicoes + ' ORDER BY preco ASC LIMIT 400',
    ...palavras.map((p) => '%' + p + '%')
  );

  const todas = linhas.map(paraOferta);
  const filtrado = analise.filtrarRelevantes(todas, termo);

  // uma "fonte" por loja, como as consultas antigas devolviam
  const porLoja = new Map();
  todas.forEach((o) => {
    if (!porLoja.has(o.loja)) porLoja.set(o.loja, { fonte: o.loja, erro: '', ofertas: [] });
    porLoja.get(o.loja).ofertas.push(o);
  });

  return {
    fontes: [...porLoja.values()],
    comparacao: analise.compararLojas(filtrado.ofertas),
    relevantes: filtrado.ofertas.length,
    total_bruto: todas.length,
    poucas_correspondencias: Boolean(filtrado.poucasCorrespondencias),
    duracao_ms: Date.now() - inicio,
  };
}

module.exports = { resumo, ofertas, pesquisar, textoDeBusca, SITUACOES };
