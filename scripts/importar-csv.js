'use strict';
/* Importa o CSV de dados enriquecidos para a tabela ofertas_ia.

   Uso (no seu computador):
     npm run importar-ia -- "C:\Users\roger\Downloads\dados_enriquecidos_ia.csv"

   Com DATABASE_URL definida, grava no Supabase; sem ela, no SQLite local.
   Recria a tabela inteira a cada execucao, para nao duplicar linhas. Se a
   gravacao falhar no meio, rode de novo: a tabela e recriada do zero. */

const fs = require('node:fs');
const db = require('../db.js');
const { textoDeBusca } = require('../ia.js');

const arquivo = process.argv[2];
if (!arquivo) {
  console.error('\n  Informe o CSV: npm run importar-ia -- "caminho\\do\\arquivo.csv"\n');
  process.exit(1);
}

// Separador ';' com campos entre aspas: um titulo pode ter ';' dentro.
function linhaCsv(linha) {
  const campos = [];
  let atual = '';
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      if (aspas && linha[i + 1] === '"') { atual += '"'; i++; } else { aspas = !aspas; }
    } else if (c === ';' && !aspas) {
      campos.push(atual); atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos;
}

const numero = (v) => {
  const n = Number(String(v || '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

(async () => {
  const texto = fs.readFileSync(arquivo, 'utf8').replace(/^\uFEFF/, '');
  const linhas = texto.split(/\r?\n/).filter(Boolean);
  const cab = linhaCsv(linhas[0]);
  const idx = (nome) => cab.indexOf(nome);

  const validas = [];
  const descartadas = [];
  linhas.slice(1).forEach((l, i) => {
    const c = linhaCsv(l);
    const reg = {
      produto: c[idx('nome_produto_padronizado')] || '',
      titulo: c[idx('nome_oferta_original')] || '',
      loja: c[idx('nome_loja')] || '',
      preco: numero(c[idx('preco')]),
      referencia: numero(c[idx('preco_referencia_base')]),
      variacao: numero(c[idx('variacao_vs_base')]),
      situacao: c[idx('situacao_compra')] || '',
      url: c[idx('url_oferta')] || '',
    };
    // linha quebrada no arquivo original: colunas a mais ou a menos, ou sem preco
    if (c.length !== cab.length || reg.preco === null || !reg.produto || !reg.loja) {
      descartadas.push(i + 2);
    } else {
      reg.texto = textoDeBusca(reg.produto + ' ' + reg.titulo + ' ' + reg.loja);
      validas.push(reg);
    }
  });

  console.log('  ' + (db.usaPostgres() ? 'Destino: Supabase' : 'Destino: SQLite local'));
  await db.iniciar();
  await db.run('DELETE FROM ofertas_ia');

  const LOTE = 400;
  for (let inicio = 0; inicio < validas.length; inicio += LOTE) {
    const lote = validas.slice(inicio, inicio + LOTE);
    const valores = [];
    const grupos = lote.map((r) => {
      valores.push(r.produto, r.titulo, r.loja, r.preco, r.referencia, r.variacao, r.situacao, r.url, r.texto);
      return '(?,?,?,?,?,?,?,?,?)';
    });
    await db.run(
      'INSERT INTO ofertas_ia (nome_produto_padronizado, nome_oferta_original, nome_loja, preco, preco_referencia_base, ' +
      'variacao_vs_base, situacao_compra, url_oferta, texto_busca) VALUES ' + grupos.join(','),
      ...valores
    );
    process.stdout.write('\r  gravadas ' + Math.min(inicio + LOTE, validas.length) + ' de ' + validas.length);
  }

  console.log('\n\n  Importacao concluida.');
  console.log('  gravadas:   ' + validas.length);
  console.log('  descartadas (linhas quebradas no arquivo): ' + descartadas.length +
    (descartadas.length ? ' -> ' + descartadas.slice(0, 10).join(', ') : ''));
  await db.fechar();
})().catch((e) => {
  console.error('\n  Erro na importacao: ' + e.message + '\n  Rode de novo para refazer a tabela do zero.\n');
  process.exit(1);
});
