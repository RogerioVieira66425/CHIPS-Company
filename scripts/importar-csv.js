'use strict';
/* Importa as coletas diarias (um CSV por dia) para a tabela ofertas_dia.

   Uso (no seu computador), um ou mais arquivos:
     npm run importar-ia -- "C:\Users\roger\Downloads\Ofertas 20-10.csv" "...21-10.csv" "...22-10.csv"

   Os arquivos podem usar ';' ou ',' como separador: o script detecta sozinho.
   Com DATABASE_URL definida, grava no Supabase; sem ela, no SQLite local.
   Apaga o conteudo atual da tabela e grava tudo de novo: o que for passado
   vira o padrao. Se a gravacao falhar no meio, rode de novo. */

const fs = require('node:fs');
const db = require('../db.js');
const { textoDeBusca } = require('../ia.js');

const arquivos = process.argv.slice(2);
if (!arquivos.length) {
  console.error('\n  Informe os CSVs: npm run importar-ia -- "caminho\\um.csv" "caminho\\dois.csv"\n');
  process.exit(1);
}

// Campos entre aspas podem ter o separador dentro (titulos com ';' ou ',').
function linhaCsv(linha, sep) {
  const campos = [];
  let atual = '';
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      if (aspas && linha[i + 1] === '"') { atual += '"'; i++; } else { aspas = !aspas; }
    } else if (c === sep && !aspas) {
      campos.push(atual); atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos;
}

const numero = (v) => {
  const texto = String(v || '').trim();
  if (!texto) return null;
  const n = Number(texto.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/* Le um arquivo e devolve as linhas ja no formato da tabela. */
function lerArquivo(caminho) {
  const texto = fs.readFileSync(caminho, 'utf8').replace(/^\uFEFF/, '');
  const linhas = texto.split(/\r?\n/).filter(Boolean);
  const sep = linhas[0].indexOf(';') !== -1 ? ';' : ',';
  const cab = linhaCsv(linhas[0], sep);
  const idx = (nome) => cab.indexOf(nome);

  const validas = [];
  const vistos = new Set();
  let descartadas = 0;
  let repetidas = 0;
  linhas.slice(1).forEach((l) => {
    const c = linhaCsv(l, sep);
    const get = (nome) => (idx(nome) === -1 ? '' : (c[idx(nome)] || '').trim());
    const coletado = get('data_coleta');
    const reg = {
      id_produto: get('id_produto_externo'),
      nome: get('nome_produto'),
      categoria: get('categoria_produto'),
      preco: numero(get('preco')),
      loja: get('nome_loja'),
      url: get('url_oferta'),
      coletado_em: coletado,
      dia: coletado.slice(0, 10),
      medio: numero(get('preco_medio_historico')),
      variacao: numero(get('variacao_percentual')),
      situacao: get('situacao_compra') || null,
    };
    // linha quebrada no arquivo: colunas a mais ou a menos, ou sem preco / sem data
    // preco 9999,99 e valor de preenchimento da base, nao preco real
    if (c.length !== cab.length || reg.preco === null || reg.preco === 9999.99 || !reg.id_produto || !reg.nome || !reg.loja || !reg.dia) {
      descartadas += 1;
    } else {
      // mesmo produto, loja, dia, nome e preco no mesmo arquivo: entra uma vez so
      const chave = [reg.id_produto, reg.loja, reg.dia, reg.nome, reg.preco].join('|');
      if (vistos.has(chave)) { repetidas += 1; return; }
      vistos.add(chave);
      reg.texto = textoDeBusca(reg.nome + ' ' + reg.categoria + ' ' + reg.loja);
      validas.push(reg);
    }
  });
  return { sep, validas, descartadas, repetidas };
}

(async () => {
  const todas = [];
  for (const caminho of arquivos) {
    const r = lerArquivo(caminho);
    const nome = caminho.split(/[\\/]/).pop();
    console.log('  ' + nome + ': separador "' + r.sep + '", ' + r.validas.length + ' linhas validas, ' + r.descartadas + ' descartadas, ' + r.repetidas + ' repetidas');
    todas.push(...r.validas);
  }
  if (!todas.length) { console.error('\n  Nenhuma linha valida nos arquivos.\n'); process.exit(1); }

  console.log('  ' + (db.usaPostgres() ? 'Destino: Supabase' : 'Destino: SQLite local'));
  await db.iniciar();
  await db.run('DELETE FROM ofertas_dia');

  const LOTE = 400;
  for (let inicio = 0; inicio < todas.length; inicio += LOTE) {
    const lote = todas.slice(inicio, inicio + LOTE);
    const valores = [];
    const grupos = lote.map((r) => {
      valores.push(r.id_produto, r.nome, r.categoria, r.preco, r.loja, r.url, r.coletado_em, r.dia,
        r.medio, r.variacao, r.situacao, r.texto);
      return '(?,?,?,?,?,?,?,?,?,?,?,?)';
    });
    await db.run(
      'INSERT INTO ofertas_dia (id_produto, nome_produto, categoria, preco, loja, url, coletado_em, dia, ' +
      'preco_medio_historico, variacao_pct, situacao, texto_busca) VALUES ' + grupos.join(','),
      ...valores
    );
    process.stdout.write('\r  gravadas ' + Math.min(inicio + LOTE, todas.length) + ' de ' + todas.length);
  }

  const dias = new Set(todas.map((r) => r.dia));
  console.log('\n\n  Importacao concluida: ' + todas.length + ' linhas em ' + dias.size + ' dia(s): ' + [...dias].sort().join(', '));
  await db.fechar();
})().catch((e) => {
  console.error('\n  Erro na importacao: ' + e.message + '\n  Rode de novo para refazer a tabela do zero.\n');
  process.exit(1);
});
