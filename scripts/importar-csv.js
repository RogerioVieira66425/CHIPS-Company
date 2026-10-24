'use strict';
/* Importa o CSV de dados enriquecidos para a tabela ofertas_ia do Supabase.

   Uso (no seu computador, com a string de conexao do Supabase):
     set DATABASE_URL=postgres://...   (Windows)
     node scripts/importar-csv.js "C:\Users\roger\Downloads\dados_enriquecidos_ia.csv"

   Recria a tabela inteira a cada execucao, para nao duplicar linhas. */

const fs = require('node:fs');
const { Pool } = require('pg');

const arquivo = process.argv[2];
const url = String(process.env.DATABASE_URL || '').trim();
if (!arquivo || !url) {
  console.error('\n  Informe o CSV e defina DATABASE_URL.\n  node scripts/importar-csv.js "caminho\\do\\arquivo.csv"\n');
  process.exit(1);
}

// Separador ';' com campos entre aspas: uma linha pode ter ';' dentro de um titulo.
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
      validas.push(reg);
    }
  });

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  let cliente;
  try {
    cliente = await pool.connect();
  } catch (e) {
    console.error('\n  Nao consegui conectar ao banco: ' + e.message + '\n  Confira a DATABASE_URL (Session pooler, com a senha).\n');
    await pool.end().catch(() => {});
    process.exit(1);
  }
  try {
    await cliente.query('BEGIN');
    await cliente.query('TRUNCATE public.ofertas_ia RESTART IDENTITY');

    const LOTE = 500;
    for (let inicio = 0; inicio < validas.length; inicio += LOTE) {
      const lote = validas.slice(inicio, inicio + LOTE);
      const valores = [];
      const linhasSql = lote.map((r, k) => {
        const b = k * 8;
        valores.push(r.produto, r.titulo, r.loja, r.preco, r.referencia, r.variacao, r.situacao, r.url);
        return '($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ',$' + (b + 5) + ',$' + (b + 6) + ',$' + (b + 7) + ',$' + (b + 8) + ')';
      });
      await cliente.query(
        'INSERT INTO public.ofertas_ia (nome_produto_padronizado, nome_oferta_original, nome_loja, preco, preco_referencia_base, variacao_vs_base, situacao_compra, url_oferta) VALUES ' +
        linhasSql.join(','),
        valores
      );
      process.stdout.write('\r  gravadas ' + Math.min(inicio + LOTE, validas.length) + ' de ' + validas.length);
    }
    await cliente.query('COMMIT');
    console.log('\n\n  Importacao concluida.');
    console.log('  gravadas:   ' + validas.length);
    console.log('  descartadas (linhas quebradas no arquivo): ' + descartadas.length +
      (descartadas.length ? ' -> ' + descartadas.slice(0, 10).join(', ') : ''));
  } catch (e) {
    await cliente.query('ROLLBACK');
    console.error('\n  Erro, nada foi gravado: ' + e.message + '\n');
    process.exitCode = 1;
  } finally {
    cliente.release();
    await pool.end();
  }
})();
