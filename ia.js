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
    produto: r.nome_produto_padronizado,
    referencia: referencia || 0,
    variacao: Number(r.variacao_vs_base) || 0,
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
    '  variacao_vs_base, situacao_compra, url_oferta FROM ofertas_ia WHERE ' + condicoes + ' ORDER BY preco ASC LIMIT 400',
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

/* Analise de um produto: tudo o que a base sabe sobre ele, a partir das ofertas
   do mesmo produto padronizado. "titulo" escolhe a oferta que a pessoa abriu. */
const mediana = (v) => {
  if (!v.length) return 0;
  const o = v.slice().sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
};
const arredonda = (v) => Math.round(v * 100) / 100;

/* Mesmo modelo, para a analise: quase todas as palavras do titulo escolhido
   aparecem no outro titulo, e vice-versa. Mais rigido que o parecidos() da
   comparacao: codigos de chipset (A520, B450) nao bastam para juntar modelos. */
const PALAVRAS_FRACAS = ['com', 'para', 'sem', 'the', 'kit', 'preto', 'branco', 'branca', 'cor', 'gamer', 'usb', 'rgb', 'led'];
function palavrasDoTitulo(texto) {
  return new Set(textoDeBusca(texto).split(' ').filter((p) => p.length >= 3 && PALAVRAS_FRACAS.indexOf(p) === -1));
}
function mesmoModelo(a, b) {
  const pa = palavrasDoTitulo(a);
  const pb = palavrasDoTitulo(b);
  if (!pa.size || !pb.size) return false;
  let emB = 0;
  pa.forEach((p) => { if (pb.has(p)) emB += 1; });
  let emA = 0;
  pb.forEach((p) => { if (pa.has(p)) emA += 1; });
  return emB / pa.size >= 0.8 && emA / pb.size >= 0.6;
}

async function analiseDoProduto(produto, titulo) {
  const porProduto = (nome) => db.all(
    'SELECT nome_produto_padronizado, nome_oferta_original, nome_loja, preco, preco_referencia_base, ' +
    '  variacao_vs_base, situacao_compra, url_oferta FROM ofertas_ia WHERE nome_produto_padronizado = ? ' +
    '  ORDER BY preco ASC LIMIT 400',
    nome
  );

  let linhas = produto ? await porProduto(produto) : [];
  // o nome do produto pode nao ser o da base (resultado guardado antes, por exemplo):
  // entao procura o produto pelo titulo da oferta que a pessoa abriu
  if (!linhas.length && titulo) {
    const achado = await db.get('SELECT nome_produto_padronizado AS produto FROM ofertas_ia WHERE nome_oferta_original = ? LIMIT 1', titulo);
    if (achado) linhas = await porProduto(achado.produto);
  }
  if (!linhas.length) return null;

  // o agrupamento da IA junta produtos diferentes (ex.: placa-mae e placa decorativa).
  // So fica o que e o mesmo modelo da oferta escolhida: mesmo codigo ou mesmas palavras.
  const todas = linhas.map(paraOferta);
  const base = todas.find((o) => o.titulo === titulo) || todas[0];
  const ofertas = todas.filter((o) => o === base || mesmoModelo(base.titulo, o.titulo));
  const precos = ofertas.map((o) => o.preco);
  const referencias = ofertas.map((o) => o.referencia).filter((v) => v > 0);

  // a oferta que a pessoa abriu; sem titulo, a mais barata
  const escolhida = ofertas.find((o) => o.titulo === titulo) || ofertas[0];
  const menorPreco = Math.min(...precos);
  const maiorPreco = Math.max(...precos);
  const abaixoDela = ofertas.filter((o) => o.preco < escolhida.preco).length;

  const porLoja = new Map();
  ofertas.forEach((o) => {
    if (!porLoja.has(o.loja)) porLoja.set(o.loja, []);
    porLoja.get(o.loja).push(o.preco);
  });
  const lojas = [...porLoja.entries()]
    .map(([loja, v]) => ({ loja, ofertas: v.length, menor: arredonda(Math.min(...v)), mediana: arredonda(mediana(v)), maior: arredonda(Math.max(...v)) }))
    .sort((a, b) => a.menor - b.menor);

  return {
    produto,
    oferta: escolhida,
    situacao: escolhida.situacao,
    referencia: arredonda(mediana(referencias)),
    variacao_pct: arredonda(escolhida.variacao),
    estatisticas: {
      ofertas: ofertas.length,
      menor: arredonda(menorPreco),
      mediana: arredonda(mediana(precos)),
      media: arredonda(precos.reduce((a, b) => a + b, 0) / precos.length),
      maior: arredonda(maiorPreco),
      posicao_pct: arredonda((abaixoDela / ofertas.length) * 100),
    },
    lojas,
    ofertas,
    // a base guarda um preco por oferta, sem serie no tempo: o historico vem do acompanhamento
    tem_serie_historica: false,
  };
}

module.exports = { resumo, ofertas, pesquisar, analiseDoProduto, textoDeBusca, SITUACOES };
