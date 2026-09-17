'use strict';
/* Regra de decisao do sistema: dadas as ofertas coletadas e o historico de precos,
   responde "em qual loja compensa comprar" e "este e um bom momento". */

const PESO_REPUTACAO = { '5_green': 0, '4_light_green': 0.01, '3_yellow': 0.03, '2_orange': 0.06, '1_red': 0.12 };
const PENALIDADE_USADO = 0.15;   // 15% de "custo de risco" para produto usado
const PENALIDADE_SEM_DADOS = 0.02;

/* Custo ajustado: preco final mais uma penalidade de risco.
   Serve para nao recomendar uma loja 2% mais barata com vendedor ruim. */
function custoAjustado(oferta) {
  let fator = 1;
  if (oferta.condicao === 'usado') fator += PENALIDADE_USADO;
  if (oferta.condicao === 'nao informado') fator += PENALIDADE_SEM_DADOS;
  const rep = oferta.reputacao ? PESO_REPUTACAO[oferta.reputacao] : PENALIDADE_SEM_DADOS;
  fator += rep === undefined ? PENALIDADE_SEM_DADOS : rep;
  return oferta.preco_total * fator;
}

function mediana(valores) {
  if (!valores.length) return 0;
  const v = valores.slice().sort((a, b) => a - b);
  const meio = Math.floor(v.length / 2);
  return v.length % 2 ? v[meio] : (v[meio - 1] + v[meio]) / 2;
}

/* Compara as ofertas da coleta mais recente e devolve o ranking por loja. */
function compararLojas(ofertas, opcoes) {
  const o = opcoes || {};
  let lista = ofertas.slice();
  if (o.somenteNovos !== false) {
    const novos = lista.filter((x) => x.condicao === 'novo');
    if (novos.length) lista = novos;
  }
  if (!lista.length) return { ranking: [], melhor: null, economia: 0, economia_pct: 0 };

  // melhor oferta de cada loja
  const porLoja = new Map();
  lista.forEach((oferta) => {
    const atual = porLoja.get(oferta.loja);
    if (!atual || oferta.preco_total < atual.preco_total) porLoja.set(oferta.loja, oferta);
  });

  const ranking = [...porLoja.values()]
    .map((oferta) => Object.assign({}, oferta, { custo_ajustado: custoAjustado(oferta) }))
    .sort((a, b) => a.custo_ajustado - b.custo_ajustado);

  const melhor = ranking[0];
  const pior = ranking[ranking.length - 1];
  const economia = pior.preco_total - melhor.preco_total;

  return {
    ranking,
    melhor,
    economia,
    economia_pct: pior.preco_total > 0 ? (economia / pior.preco_total) * 100 : 0,
    // o mais barato nem sempre e o recomendado: avisamos quando diferem
    mais_barato: ranking.slice().sort((a, b) => a.preco_total - b.preco_total)[0],
  };
}

/* Compara o preco de hoje com o historico do proprio produto. */
function avaliarMomento(precoAtual, historico) {
  const valores = historico.map((h) => h.minimo).filter((v) => v > 0);
  if (!precoAtual || valores.length < 2) {
    return {
      status: 'sem_historico',
      titulo: 'Ainda sem histórico',
      texto: 'Atualize os preços por alguns dias para o sistema avaliar se o momento é bom.',
      minimo: valores.length ? Math.min(...valores) : precoAtual,
      maximo: valores.length ? Math.max(...valores) : precoAtual,
      mediana: valores.length ? mediana(valores) : precoAtual,
      variacao_pct: 0,
      dias: valores.length,
    };
  }

  const minimo = Math.min(...valores);
  const maximo = Math.max(...valores);
  const med = mediana(valores);
  const variacao = med > 0 ? ((precoAtual - med) / med) * 100 : 0;

  let status, titulo, texto;
  if (precoAtual <= minimo) {
    status = 'otimo';
    titulo = 'Melhor preço já registrado';
    texto = 'É o menor valor desde que você começou a monitorar este produto.';
  } else if (variacao <= -5) {
    status = 'bom';
    titulo = 'Bom momento para comprar';
    texto = 'Está ' + Math.abs(variacao).toFixed(1).replace('.', ',') + '% abaixo da mediana do período.';
  } else if (variacao < 5) {
    status = 'neutro';
    titulo = 'Preço na média';
    texto = 'Está próximo da mediana histórica. Comprar agora não é vantagem nem prejuízo claro.';
  } else {
    status = 'ruim';
    titulo = 'Vale esperar';
    texto = 'Está ' + variacao.toFixed(1).replace('.', ',') + '% acima da mediana. Já esteve por ' +
      minimo.toFixed(2).replace('.', ',') + '.';
  }

  return { status, titulo, texto, minimo, maximo, mediana: med, variacao_pct: variacao, dias: valores.length };
}

module.exports = { compararLojas, avaliarMomento, custoAjustado, mediana };
