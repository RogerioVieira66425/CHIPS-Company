'use strict';
/* Base de ofertas por dia (tabela ofertas_dia).
   -------------------------------------------------------------------------
   Cada importacao traz uma foto de um dia (um CSV por dia). A busca e a
   tela de produto mostram o dia mais recente; a analise tambem usa os dias
   anteriores para montar a evolucao do preco. As lojas nao sao consultadas:
   tudo sai do banco, no Supabase (DATABASE_URL) ou no SQLite local. */

const db = require('./db.js');
const analise = require('./analise.js');

// troque ao mudar as regras de busca: invalida os resultados guardados
const VERSAO_BUSCA = 11;

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

/* Acessorios: titulos que comecam com estas palavras, ou em que o termo so
   aparece depois de uma expressao de compatibilidade ("para PS5", "compativel
   com PS5"), sao acessorios do produto procurado, nao o produto. */
const PALAVRAS_ACESSORIO = ['suporte', 'cabo', 'adaptador', 'dissipador', 'capa', 'protetor', 'case', 'bolsa', 'mousepad', 'pelicula', 'alca', 'skin', 'adesivo', 'fonte'];
const PALAVRAS_TIPO_DIFERENTE = ['captura', 'streaming'];
const MARCADORES_COMPATIVEL = ['para', 'compativel', 'compativeis', 'compativeis', 'p'];

function ehAcessorio(titulo, palavrasBusca) {
  const tokens = textoDeBusca(titulo).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  // "captura" e outro tipo de produto (placa de captura, nao placa de video)
  const tipoDiferente = tokens.some((t) => PALAVRAS_TIPO_DIFERENTE.indexOf(t) !== -1) &&
    !palavrasBusca.some((p) => PALAVRAS_TIPO_DIFERENTE.indexOf(p) !== -1);
  if (tipoDiferente) return true;
  const buscaTemAcessorio = palavrasBusca.some((p) => PALAVRAS_ACESSORIO.indexOf(p) !== -1);
  if (!buscaTemAcessorio && PALAVRAS_ACESSORIO.indexOf(tokens[0]) !== -1) return true;

  const marcador = tokens.findIndex((t) => MARCADORES_COMPATIVEL.indexOf(t) !== -1);
  if (marcador === -1) return false;
  const posicaoDoTermo = tokens.findIndex((t) => palavrasBusca.indexOf(t) !== -1);
  return posicaoDoTermo > marcador;
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
  // situacao desconhecida nao e ignorada: filtro que nao existe nao traz nada
  if (f.situacao && SITUACOES.indexOf(f.situacao) === -1) return { dia, pagina: 1, limite: 0, ofertas: [] };
  if (f.situacao) { condicoes.push('situacao = ?'); valores.push(f.situacao); }
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

/* Mediana das coletas de cada produto (todos os dias), para o preco riscado e o desconto. */
async function medianasDoHistorico(nomes) {
  const mapa = new Map();
  for (let i = 0; i < nomes.length; i += 500) {
    const lote = nomes.slice(i, i + 500);
    const linhas = await db.all(
      'SELECT nome_produto, preco FROM ofertas_dia WHERE nome_produto IN (' + lote.map(() => '?').join(',') + ')', ...lote);
    const grupos = new Map();
    linhas.forEach((r) => {
      if (!grupos.has(r.nome_produto)) grupos.set(r.nome_produto, []);
      grupos.get(r.nome_produto).push(Number(r.preco));
    });
    grupos.forEach((v, k) => mapa.set(k, mediana(v)));
  }
  return mapa;
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
    'FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY loja ORDER BY preco ASC) AS rn FROM ofertas_dia WHERE dia = ? AND ' + condicoes + ') t ' +
    'WHERE rn <= 3000 ORDER BY preco ASC',
    dia, ...palavras.map((p) => '%' + p + '%')
  );

  // preco 9999,99 e valor de preenchimento da base, nao preco real; anuncio repetido aparece uma vez
  const vistos = new Set();
  const encontradas = linhas.map(paraOferta).filter((o) => {
    if (o.preco === 9999.99) return false;
    const chave = o.id_produto + '|' + o.loja + '|' + o.titulo;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
  // acessorios continuam na lista, mas marcados: a tela os coloca no fim
  const marcadas = encontradas.map((o) => Object.assign(o, { acessorio: ehAcessorio(o.titulo, palavras) }));
  const medianas = await medianasDoHistorico([...new Set(marcadas.map((o) => o.produto).filter(Boolean))]);
  marcadas.forEach((o) => {
    const m = medianas.get(o.produto);
    if (m) o.preco_de = m > o.preco && m <= o.preco * 3 ? arredonda(m) : 0;
  });
  const principais = marcadas.filter((o) => !o.acessorio);
  const acessorios = marcadas.filter((o) => o.acessorio);

  // a expressao digitada inteira (ex.: "placa de video") tem prioridade entre os principais
  let base = principais;
  if (palavras.length >= 2) {
    const inteira = principais.filter((o) => textoDeBusca(o.titulo).indexOf(t) !== -1);
    if (inteira.length >= 5) base = inteira;
  }
  // todas as palavras digitadas precisam estar no nome do produto
  const filtradoPrincipais = analise.filtrarRelevantes(base, termo, 1);
  const filtradoAcessorios = analise.filtrarRelevantes(acessorios, termo, 1);
  const todas = filtradoPrincipais.ofertas.concat(filtradoAcessorios.ofertas);
  const filtrado = { ofertas: filtradoPrincipais.ofertas, poucasCorrespondencias: filtradoPrincipais.poucasCorrespondencias };

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
    sugestao: filtrado.ofertas.length < 3 ? await corrigir(termo) : null,
    acessorios_ocultos: encontradas.length - principais.length,
    so_acessorios: principais.length === 0 && encontradas.length > 0,
    // versao das regras de busca: resultados guardados de outra versao nao sao reaproveitados
    versao: VERSAO_BUSCA,
    duracao_ms: Date.now() - inicio,
    dia,
  };
}

/* Analise de um produto: ofertas do dia mais recente e evolucao nos dias anteriores.
   "titulo" escolhe a oferta que a pessoa abriu; o produto e achado pelo nome. */
/* Avaliacao da oferta pelo historico do produto: compara o preco de hoje com o menor e a
   mediana ja vistos. So a anomalia marcada pela IA no CSV prevalece sobre a regra. */
function avaliarPeloHistorico(preco, precos, dias, situacaoAtual) {
  if (situacaoAtual === 'Anomalia (Isolada por IA)') return situacaoAtual;
  if (dias < 2) return 'Sem Histórico (Novo)';
  const menor = Math.min(...precos);
  const med = mediana(precos);
  // preco que nunca mudou: nao ha o que comparar, e fica como preco medio
  if (Math.max(...precos) === menor) return 'Preço Médio';
  if (preco <= menor * 1.02 || preco < med * 0.95) return 'Boa Compra';
  if (preco > med * 1.05) return 'Evitar';
  return 'Preço Médio';
}

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

  // o produto inteiro: estatisticas, lojas, faixa e posicao saem de todas as coletas do historico
  const coletas = await db.all(
    'SELECT dia, loja, preco, preco_medio_historico FROM ofertas_dia WHERE nome_produto = ? ORDER BY dia', nome);
  const precos = coletas.map((r) => Number(r.preco));
  const acimaDela = precos.filter((p) => p > escolhida.preco).length;

  const porLoja = new Map();
  coletas.forEach((r) => {
    if (!porLoja.has(r.loja)) porLoja.set(r.loja, []);
    porLoja.get(r.loja).push(Number(r.preco));
  });
  const lojas = [...porLoja.entries()]
    .map(([loja, v]) => ({ loja, ofertas: v.length, menor: arredonda(Math.min(...v)), mediana: arredonda(mediana(v)), maior: arredonda(Math.max(...v)) }))
    .sort((a, b) => a.menor - b.menor);

  // evolucao: menor preco de cada dia em que o produto foi coletado, somando as lojas
  const pordia = new Map();
  coletas.forEach((r) => {
    if (!pordia.has(r.dia)) pordia.set(r.dia, []);
    pordia.get(r.dia).push(Number(r.preco));
  });
  const historico = [...pordia.entries()].map(([d, v]) => ({
    dia: d,
    minimo: arredonda(Math.min(...v)),
    media: arredonda(v.reduce((a, b) => a + b, 0) / v.length),
    amostras: v.length,
  }));

  // a avaliacao vale para a oferta escolhida e para cada oferta da lista, com o mesmo criterio
  const CLASSIFICACOES_DO_MODELO = ['Boa Compra', 'Preço Médio', 'Sem Histórico (Novo)', 'Evitar', 'Anomalia (Isolada por IA)'];
  const refHist = mediana(precos);
  ofertas.forEach((o) => {
    // a classificacao do modelo (gravada pelo pipeline) vale; sem ela, usa a regra da mediana
    o.situacao = CLASSIFICACOES_DO_MODELO.indexOf(o.situacao) !== -1
      ? o.situacao
      : avaliarPeloHistorico(o.preco, precos, historico.length, o.situacao);
    o.referencia = arredonda(refHist);
    o.variacao = arredonda(((o.preco - refHist) / refHist) * 100);
  });
  return {
    produto: nome,
    dia,
    oferta: escolhida,
    situacao: escolhida.situacao,
    referencia: arredonda(mediana(precos)),
    variacao_pct: arredonda(((escolhida.preco - mediana(precos)) / mediana(precos)) * 100),
    estatisticas: {
      ofertas: precos.length,
      menor: arredonda(Math.min(...precos)),
      mediana: arredonda(mediana(precos)),
      media: arredonda(precos.reduce((a, b) => a + b, 0) / precos.length),
      maior: arredonda(Math.max(...precos)),
      posicao_pct: arredonda((acimaDela / precos.length) * 100),
    },
    lojas,
    ofertas,
    historico,
    tem_serie_historica: historico.length >= 2,
  };
}

/* ---------- sugestoes enquanto digita e correcao de termo errado ----------
   O vocabulario sai dos nomes do dia mais recente e fica em memoria: e pequeno
   e so muda quando entra uma nova foto. */
let vocabCache = { dia: null, palavras: null, nomes: null };

async function vocabulario() {
  const dia = await diaAtual();
  if (vocabCache.dia === dia && vocabCache.palavras) return vocabCache;
  const linhas = await db.all('SELECT DISTINCT nome_produto AS nome FROM ofertas_dia WHERE dia = ?', dia);
  const palavras = new Map();
  const nomes = [];
  linhas.forEach((r) => {
    const texto = textoDeBusca(r.nome);
    nomes.push({ nome: r.nome, texto });
    texto.split(' ').forEach((p) => {
      if (p.length >= 3) palavras.set(p, (palavras.get(p) || 0) + 1);
    });
  });
  vocabCache = { dia, palavras, nomes };
  return vocabCache;
}

function distancia(a, b) {
  const m = a.length, n = b.length;
  let anterior = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const atual = [i];
    for (let j = 1; j <= n; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      atual[j] = Math.min(atual[j - 1] + 1, anterior[j] + 1, anterior[j - 1] + custo);
    }
    anterior = atual;
  }
  return anterior[n];
}

/* Produtos que contem o que foi digitado: a lista que aparece enquanto a pessoa digita. */
async function sugerir(termo) {
  const t = textoDeBusca(termo);
  const palavras = t.split(' ').filter((p) => p.length >= 2);
  if (!palavras.length) return [];
  const dia = await diaAtual();
  if (!dia) return [];
  const condicoes = palavras.map(() => 'texto_busca LIKE ?').join(' AND ');
  const linhas = await db.all(
    'SELECT nome_produto AS nome, MIN(preco) AS menor FROM ofertas_dia WHERE dia = ? AND ' + condicoes +
    ' GROUP BY nome_produto ORDER BY menor ASC LIMIT 8',
    dia, ...palavras.map((p) => '%' + p + '%')
  );
  return linhas.map((r) => ({ nome: r.nome, menor: arredonda(Number(r.menor)) }));
}

/* Corrige cada palavra que nao existe na base pela mais parecida (distancia de
   edicao pequena), preferindo a que mais aparece nos produtos. */
async function corrigir(termo) {
  const palavras = textoDeBusca(termo).split(' ').filter(Boolean);
  if (!palavras.length) return null;
  const v = await vocabulario();
  let mudou = false;
  const novas = palavras.map((p) => {
    if (p.length < 3 || v.palavras.has(p)) return p;
    const limite = p.length <= 4 ? 1 : 2;
    let melhor = null;
    v.palavras.forEach((freq, cand) => {
      if (Math.abs(cand.length - p.length) > limite) return;
      const d = distancia(p, cand);
      if (d > limite) return;
      if (!melhor || d < melhor.d || (d === melhor.d && freq > melhor.freq)) melhor = { c: cand, d, freq };
    });
    if (!melhor) return p;
    mudou = true;
    return melhor.c;
  });
  return mudou ? novas.join(' ') : null;
}

module.exports = { resumo, ofertas, pesquisar, analiseDoProduto, sugerir, corrigir, textoDeBusca, SITUACOES, VERSAO_BUSCA };
