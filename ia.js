'use strict';
/* Base de ofertas por dia (tabela ofertas_dia).
   -------------------------------------------------------------------------
   Cada importacao traz uma foto de um dia (um CSV por dia). A busca e a
   tela de produto mostram o dia mais recente; a analise tambem usa os dias
   anteriores para montar a evolucao do preco. As lojas nao sao consultadas:
   tudo sai do banco, no Supabase (DATABASE_URL) ou no SQLite local. */

const db = require('./db.js');
const analise = require('./analise.js');

const SITUACOES = ['Boa Compra', 'Preço Médio', 'Sem Histórico (Novo)', 'Evitar', 'Anomalia (Isolada por IA)', 'Bom Momento'];

/* Texto de busca sem acento e em minusculas: "mecânico" e "mecanico" casam. */
function textoDeBusca(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* Dia mais recente da base: a foto que a busca e a tela mostram. */
async function diaAtual() {
  const r = await db.get('SELECT MAX(dia) AS dia FROM ofertas_dia');
  return r && r.dia ? r.dia : null;
}

const arredonda = (v) => Math.round(v * 100) / 100;
const mediana = (v) => {
  if (!v.length) return 0;
  const o = v.slice().sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
};

/* Converte uma linha do banco no formato de oferta que a comparacao usa. */
function paraOferta(r) {
  const preco = Number(r.preco) || 0;
  const medio = Number(r.preco_medio_historico) || 0;
  // o preco medio historico e o "preco de" riscado: so vale quando e plausivel (ate 3x o preco)
  const precoDe = medio > preco && medio <= preco * 3 ? medio : 0;
  return {
    loja: r.loja,
    titulo: r.nome_produto,
    produto: r.nome_produto,
    id_produto: r.id_produto,
    preco,
    preco_de: precoDe,
    frete: 0,
    preco_total: preco,
    frete_gratis: false,
    condicao: 'novo',
    vendedor: r.loja,
    reputacao: r.loja === 'Amazon' ? '4_light_green' : '5_green',
    vendidos: 0,
    parcelas: 0,
    url: String(r.url || ''),
    id_externo: String(r.id_produto || ''),
    situacao: r.situacao || '',
    referencia: medio,
    variacao: Number(r.variacao_pct) || 0,
    dia: r.dia,
  };
}

/* Quantidade por situacao e por loja, no dia mais recente. */
async function resumo() {
  const dia = await diaAtual();
  if (!dia) return { totais: { ofertas: 0, produtos: 0, dias: 0 }, por_situacao: [], por_loja: [] };
  const porSituacao = await db.all(
    "SELECT COALESCE(situacao, 'Sem classificação') AS situacao, COUNT(*) AS ofertas FROM ofertas_dia WHERE dia = ? GROUP BY 1 ORDER BY ofertas DESC", dia);
  const porLoja = await db.all('SELECT loja, COUNT(*) AS ofertas FROM ofertas_dia WHERE dia = ? GROUP BY loja ORDER BY ofertas DESC', dia);
  const totais = await db.get('SELECT COUNT(*) AS ofertas, COUNT(DISTINCT id_produto) AS produtos FROM ofertas_dia WHERE dia = ?', dia);
  const dias = await db.get('SELECT COUNT(DISTINCT dia) AS dias FROM ofertas_dia');
  return { dia, totais: { ...totais, dias: dias.dias }, por_situacao: porSituacao, por_loja: porLoja };
}

/* Ofertas filtradas no dia mais recente (rota /api/ia/ofertas). */
async function ofertas(filtro) {
  const dia = await diaAtual();
  const f = filtro || {};
  const condicoes = ['dia = ?'];
  const valores = [dia];
  if (SITUACOES.indexOf(f.situacao) !== -1) { condicoes.push('situacao = ?'); valores.push(f.situacao); }
  if (f.loja) { condicoes.push('loja = ?'); valores.push(String(f.loja).slice(0, 60)); }
  if (f.q) { condicoes.push('texto_busca LIKE ?'); valores.push('%' + textoDeBusca(String(f.q).slice(0, 80)) + '%'); }

  const limite = Math.min(Math.max(Number(f.limite) || 50, 1), 200);
  const pagina = Math.max(Number(f.pagina) || 1, 1);
  const linhas = await db.all(
    'SELECT id_produto, nome_produto AS produto, nome_produto AS titulo, loja, preco, preco_medio_historico, ' +
    '  variacao_pct AS variacao_vs_base, situacao, url FROM ofertas_dia WHERE ' + condicoes.join(' AND ') +
    ' ORDER BY preco ASC LIMIT ? OFFSET ?',
    ...valores, limite, (pagina - 1) * limite
  );
  return { dia, pagina, limite, ofertas: linhas };
}

/* Pesquisa o termo no dia mais recente e devolve fontes agrupadas por loja, comparacao e relevancia. */
async function pesquisar(termo) {
  const inicio = Date.now();
  const t = textoDeBusca(termo);
  const palavras = t.split(' ').filter((p) => p.length >= 2);
  const dia = await diaAtual();
  if (!palavras.length || !dia) {
    return { fontes: [], comparacao: analise.compararLojas([]), relevantes: 0, total_bruto: 0, duracao_ms: 0 };
  }

  // cada palavra precisa aparecer no texto da oferta; a relevancia fina vem depois
  const condicoes = palavras.map(() => 'texto_busca LIKE ?').join(' AND ');
  const linhas = await db.all(
    'SELECT id_produto, nome_produto, categoria, preco, loja, url, dia, preco_medio_historico, variacao_pct, situacao ' +
    'FROM ofertas_dia WHERE dia = ? AND ' + condicoes + ' ORDER BY preco ASC LIMIT 400',
    dia, ...palavras.map((p) => '%' + p + '%')
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
    dia,
  };
}

/* Analise de um produto: ofertas do dia mais recente e evolucao nos dias anteriores.
   "titulo" escolhe a oferta que a pessoa abriu; o produto e achado pelo nome. */
async function analiseDoProduto(produto, titulo) {
  const nomeBase = produto || titulo;
  if (!nomeBase) return null;
  const dia = await diaAtual();
  if (!dia) return null;

  let nome = nomeBase;
  let atuais = await db.all(
    'SELECT id_produto, nome_produto, categoria, preco, loja, url, dia, preco_medio_historico, variacao_pct, situacao ' +
    'FROM ofertas_dia WHERE dia = ? AND nome_produto = ? ORDER BY preco ASC LIMIT 400', dia, nome);
  // o nome pode nao bater (resultado guardado antes): procura pelo titulo da oferta aberta
  if (!atuais.length && titulo && titulo !== nome) {
    const achado = await db.get('SELECT nome_produto FROM ofertas_dia WHERE nome_produto = ? LIMIT 1', titulo);
    if (achado) {
      nome = achado.nome_produto;
      atuais = await db.all(
        'SELECT id_produto, nome_produto, categoria, preco, loja, url, dia, preco_medio_historico, variacao_pct, situacao ' +
        'FROM ofertas_dia WHERE dia = ? AND nome_produto = ? ORDER BY preco ASC LIMIT 400', dia, nome);
    }
  }
  if (!atuais.length) return null;

  const ofertas = atuais.map(paraOferta);
  const escolhida = ofertas.find((o) => o.titulo === titulo) || ofertas[0];
  const precos = ofertas.map((o) => o.preco);
  const abaixoDela = ofertas.filter((o) => o.preco < escolhida.preco).length;

  const porLoja = new Map();
  ofertas.forEach((o) => {
    if (!porLoja.has(o.loja)) porLoja.set(o.loja, []);
    porLoja.get(o.loja).push(o.preco);
  });
  const lojas = [...porLoja.entries()]
    .map(([loja, v]) => ({ loja, ofertas: v.length, menor: arredonda(Math.min(...v)), mediana: arredonda(mediana(v)), maior: arredonda(Math.max(...v)) }))
    .sort((a, b) => a.menor - b.menor);

  // evolucao: menor preco de cada dia em que o produto foi coletado
  const todosOsDias = await db.all(
    'SELECT dia, preco FROM ofertas_dia WHERE nome_produto = ? ORDER BY dia', nome);
  const pordia = new Map();
  todosOsDias.forEach((r) => {
    if (!pordia.has(r.dia)) pordia.set(r.dia, []);
    pordia.get(r.dia).push(Number(r.preco));
  });
  const historico = [...pordia.entries()].map(([d, v]) => ({
    dia: d,
    minimo: arredonda(Math.min(...v)),
    media: arredonda(v.reduce((a, b) => a + b, 0) / v.length),
    amostras: v.length,
  }));

  const referencias = ofertas.map((o) => o.referencia).filter((v) => v > 0);
  return {
    produto: nome,
    dia,
    oferta: escolhida,
    situacao: escolhida.situacao,
    referencia: arredonda(mediana(referencias)),
    variacao_pct: arredonda(escolhida.variacao),
    estatisticas: {
      ofertas: ofertas.length,
      menor: arredonda(Math.min(...precos)),
      mediana: arredonda(mediana(precos)),
      media: arredonda(precos.reduce((a, b) => a + b, 0) / precos.length),
      maior: arredonda(Math.max(...precos)),
      posicao_pct: arredonda((abaixoDela / ofertas.length) * 100),
    },
    lojas,
    ofertas,
    historico,
    tem_serie_historica: historico.length >= 2,
  };
}

module.exports = { resumo, ofertas, pesquisar, analiseDoProduto, textoDeBusca, SITUACOES };
