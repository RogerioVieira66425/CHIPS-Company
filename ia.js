'use strict';
/* Leitura do banco Supabase (Postgres) para os dados enriquecidos pela IA.
   -------------------------------------------------------------------------
   Ativado pela variavel DATABASE_URL (a string de conexao do Supabase, no
   Render em Environment). Sem ela, as rotas respondem 503 e o resto do site
   segue igual, com o SQLite local. O driver `pg` so e carregado quando ha
   DATABASE_URL, entao o servidor sobe mesmo sem a dependencia instalada. */

let pool = null;

function conectar() {
  if (pool) return pool;
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) return null;
  const { Pool } = require('pg');
  // Supabase exige SSL; o pooler usa certificado que o Node nao reconhece sozinho
  pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4 });
  return pool;
}

const disponivel = () => Boolean(String(process.env.DATABASE_URL || '').trim());

const SITUACOES = ['Boa Compra', 'Preço Médio', 'Sem Histórico (Novo)', 'Evitar', 'Anomalia (Isolada por IA)'];

/* Quantidade por situacao e por loja, para o painel de resumo. */
async function resumo() {
  const p = conectar();
  const [porSituacao, porLoja, totais] = await Promise.all([
    p.query('SELECT situacao_compra AS situacao, COUNT(*)::int AS ofertas FROM ofertas_ia GROUP BY 1 ORDER BY 2 DESC'),
    p.query('SELECT nome_loja AS loja, COUNT(*)::int AS ofertas FROM ofertas_ia GROUP BY 1 ORDER BY 2 DESC'),
    p.query('SELECT COUNT(*)::int AS ofertas, COUNT(DISTINCT nome_produto_padronizado)::int AS produtos FROM ofertas_ia'),
  ]);
  return { totais: totais.rows[0], por_situacao: porSituacao.rows, por_loja: porLoja.rows };
}

/* Ofertas filtradas. Tudo que chega do pedido vira parametro, nunca texto SQL. */
async function ofertas(filtro) {
  const f = filtro || {};
  const condicoes = [];
  const valores = [];
  const adicionar = (sql, valor) => { valores.push(valor); condicoes.push(sql.replace('?', '$' + valores.length)); };

  if (SITUACOES.indexOf(f.situacao) !== -1) adicionar('situacao_compra = ?', f.situacao);
  if (f.loja) adicionar('nome_loja = ?', String(f.loja).slice(0, 60));
  if (f.q) adicionar('nome_produto_padronizado ILIKE ?', '%' + String(f.q).slice(0, 80) + '%');

  const limite = Math.min(Math.max(Number(f.limite) || 50, 1), 200);
  const pagina = Math.max(Number(f.pagina) || 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const where = condicoes.length ? 'WHERE ' + condicoes.join(' AND ') : '';
  const linhas = await conectar().query(
    'SELECT nome_produto_padronizado AS produto, nome_oferta_original AS titulo, nome_loja AS loja, ' +
    '  preco, preco_referencia_base, variacao_vs_base, situacao_compra AS situacao, url_oferta AS url ' +
    'FROM ofertas_ia ' + where + ' ORDER BY preco ASC LIMIT $' + (valores.length - 1) + ' OFFSET $' + valores.length,
    valores
  );
  return { pagina, limite, ofertas: linhas.rows };
}

module.exports = { disponivel, resumo, ofertas, SITUACOES };
