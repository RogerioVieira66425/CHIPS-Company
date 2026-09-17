'use strict';
/* Motor de blocos: transforma a configuracao de uma tela em elementos na pagina.
   Usado tanto na pre-visualizacao do Laboratorio quanto nas telas oficiais. */

const Blocos = (function () {
  const CORES = ['#4c8dff', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#94a3b8'];

  const CATALOGO = {
    kpi: { nome: 'Indicador (KPI)', dica: 'Um número grande: patrimônio, lucro, rentabilidade...' },
    rosca: { nome: 'Gráfico de rosca', dica: 'Participação de cada classe ou ativo na carteira.' },
    barras: { nome: 'Gráfico de barras', dica: 'Compara ativos ou classes por valor, custo ou lucro.' },
    tabela: { nome: 'Tabela da carteira', dica: 'Suas posições, com as colunas que você escolher.' },
    lancamentos: { nome: 'Lista de lançamentos', dica: 'Histórico de compras, vendas e proventos.' },
    metas: { nome: 'Metas de alocação', dica: 'Compara a alocação desejada com a real.' },
    texto: { nome: 'Texto / anotação', dica: 'Um bilhete, uma regra sua, um lembrete.' },
    livre: { nome: 'Código livre (HTML/CSS/JS)', dica: 'Monte o que quiser: os dados chegam na variável dados.' },
  };

  const METRICAS = {
    patrimonio: 'Patrimônio atual',
    investido: 'Total investido',
    lucro: 'Lucro / prejuízo',
    rentabilidade: 'Rentabilidade %',
    realizado: 'Resultado realizado',
    proventos: 'Proventos recebidos',
    n_ativos: 'Quantidade de ativos',
    n_classes: 'Quantidade de classes',
  };

  const COLUNAS = {
    ticker: 'Ativo',
    classe: 'Classe',
    quantidade: 'Quantidade',
    preco_medio: 'Preço médio',
    preco_atual: 'Preço atual',
    custo: 'Investido',
    valor_atual: 'Valor atual',
    lucro: 'Lucro/prej.',
    rentabilidade: 'Rentabilidade',
    participacao: 'Participação %',
    proventos: 'Proventos',
    realizado: 'Realizado',
  };

  /* ---------- formatadores ---------- */
  const dinheiro = (v) =>
    (v < 0 ? '-' : '') + 'R$ ' + Math.abs(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (v) => ((Number(v) || 0) >= 0 ? '+' : '') + (Number(v) || 0).toFixed(2).replace('.', ',') + '%';
  const pctSimples = (v) => (Number(v) || 0).toFixed(1).replace('.', ',') + '%';
  const qtdFmt = (v) => (Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 8 });
  const sinal = (v) => (v > 0 ? 'positivo' : v < 0 ? 'negativo' : 'neutro');

  function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto;
    return e;
  }

  /* ---------- dados ---------- */
  function posicoesFiltradas(dados, opcoes) {
    const classe = opcoes.classe || 'todas';
    let lista = dados.carteira.posicoes.slice();
    if (classe !== 'todas') lista = lista.filter((p) => p.classe === classe);
    if (opcoes.somente_com_posicao !== false) lista = lista.filter((p) => p.quantidade > 0 || p.custo > 0);
    return lista;
  }

  function totaisDe(lista) {
    const t = lista.reduce(
      (acc, p) => ({
        investido: acc.investido + p.custo,
        patrimonio: acc.patrimonio + p.valor_atual,
        lucro: acc.lucro + p.lucro,
        realizado: acc.realizado + p.realizado,
        proventos: acc.proventos + p.proventos,
      }),
      { investido: 0, patrimonio: 0, lucro: 0, realizado: 0, proventos: 0 }
    );
    t.rentabilidade = t.investido > 0 ? (t.lucro / t.investido) * 100 : 0;
    t.n_ativos = lista.length;
    t.n_classes = new Set(lista.map((p) => p.classe)).size;
    return t;
  }

  function agrupar(lista, por, campo) {
    const mapa = new Map();
    lista.forEach((p) => {
      const chave = por === 'classe' ? p.classe : p.ticker;
      mapa.set(chave, (mapa.get(chave) || 0) + (Number(p[campo]) || 0));
    });
    return [...mapa.entries()]
      .map(([rotulo, valor]) => ({ rotulo, valor }))
      .sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor));
  }

  /* ---------- blocos ---------- */
  function blocoKpi(corpo, dados, o) {
    const t = totaisDe(posicoesFiltradas(dados, o));
    const metrica = o.metrica || 'patrimonio';
    const valor = t[metrica] || 0;
    const ehPercentual = metrica === 'rentabilidade';
    const ehContagem = metrica === 'n_ativos' || metrica === 'n_classes';

    const forte = el('strong', 'kpi-valor');
    forte.textContent = ehPercentual ? pct(valor) : ehContagem ? String(valor) : dinheiro(valor);
    if (['lucro', 'rentabilidade', 'realizado'].indexOf(metrica) !== -1) forte.classList.add(sinal(valor));
    corpo.appendChild(forte);

    const legenda = o.legenda || (o.classe && o.classe !== 'todas' ? 'Somente ' + o.classe : '');
    if (legenda) corpo.appendChild(el('span', 'variacao neutro', legenda));
  }

  function desenharRosca(svg, fatias, total) {
    svg.innerHTML = '';
    svg.setAttribute('viewBox', '0 0 42 42');
    if (!total) {
      svg.innerHTML = '<circle cx="21" cy="21" r="15.9155" fill="none" stroke="#232a36" stroke-width="6"></circle>';
      return;
    }
    let offset = 25;
    fatias.forEach((f, i) => {
      const p = (f.valor / total) * 100;
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', '21');
      c.setAttribute('cy', '21');
      c.setAttribute('r', '15.9155');
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', CORES[i % CORES.length]);
      c.setAttribute('stroke-width', '6');
      c.setAttribute('stroke-dasharray', p.toFixed(2) + ' ' + (100 - p).toFixed(2));
      c.setAttribute('stroke-dashoffset', String(offset));
      svg.appendChild(c);
      offset = (offset - p + 100) % 100;
    });
  }

  function blocoRosca(corpo, dados, o) {
    const lista = posicoesFiltradas(dados, o);
    const campo = o.campo || 'valor_atual';
    const fatias = agrupar(lista, o.agrupar || 'classe', campo).filter((f) => f.valor > 0);
    const total = fatias.reduce((s, f) => s + f.valor, 0);

    const caixa = el('div', 'alocacao');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'rosca');
    desenharRosca(svg, fatias, total);
    caixa.appendChild(svg);

    const ul = el('ul', 'legenda');
    if (!fatias.length) {
      ul.appendChild(el('li', 'neutro', 'Sem valores para exibir ainda.'));
    } else {
      fatias.forEach((f, i) => {
        const li = el('li');
        const ponto = el('i', 'ponto');
        ponto.style.background = CORES[i % CORES.length];
        li.appendChild(ponto);
        li.appendChild(el('b', '', f.rotulo));
        li.appendChild(el('span', 'valor', pctSimples((f.valor / total) * 100) + ' · ' + dinheiro(f.valor)));
        ul.appendChild(li);
      });
    }
    caixa.appendChild(ul);
    corpo.appendChild(caixa);
  }

  function blocoBarras(corpo, dados, o) {
    const lista = posicoesFiltradas(dados, o);
    const campo = o.campo || 'valor_atual';
    let itens = agrupar(lista, o.agrupar || 'ativo', campo);
    const limite = Number(o.limite) || 10;
    itens = itens.slice(0, limite);
    const maximo = Math.max(...itens.map((i) => Math.abs(i.valor)), 1);

    if (!itens.length) { corpo.appendChild(el('p', 'vazio', 'Sem dados para o gráfico.')); return; }

    const lista_el = el('ul', 'barras');
    itens.forEach((i) => {
      const li = el('li');
      li.appendChild(el('span', 'barra-rotulo', i.rotulo));
      const trilho = el('div', 'barra-trilho');
      const barra = el('div', 'barra ' + sinal(i.valor));
      barra.style.width = (Math.abs(i.valor) / maximo) * 100 + '%';
      trilho.appendChild(barra);
      li.appendChild(trilho);
      li.appendChild(el('span', 'barra-valor ' + (campo === 'lucro' ? sinal(i.valor) : ''), campo === 'rentabilidade' ? pct(i.valor) : dinheiro(i.valor)));
      lista_el.appendChild(li);
    });
    corpo.appendChild(lista_el);
  }

  function valorColuna(p, coluna, patrimonio) {
    switch (coluna) {
      case 'ticker': return { texto: p.ticker, classe: 'ticker' };
      case 'classe': return { texto: p.classe };
      case 'quantidade': return { texto: qtdFmt(p.quantidade), classe: 'dir' };
      case 'preco_medio': return { texto: dinheiro(p.preco_medio), classe: 'dir' };
      case 'preco_atual': return { texto: dinheiro(p.preco_atual), classe: 'dir' };
      case 'custo': return { texto: dinheiro(p.custo), classe: 'dir' };
      case 'valor_atual': return { texto: dinheiro(p.valor_atual), classe: 'dir' };
      case 'lucro': return { texto: dinheiro(p.lucro), classe: 'dir ' + sinal(p.lucro) };
      case 'rentabilidade': return { texto: p.custo > 0 ? pct(p.rentabilidade) : '—', classe: 'dir ' + sinal(p.lucro) };
      case 'participacao': return { texto: patrimonio > 0 ? pctSimples((p.valor_atual / patrimonio) * 100) : '—', classe: 'dir' };
      case 'proventos': return { texto: dinheiro(p.proventos), classe: 'dir' };
      case 'realizado': return { texto: dinheiro(p.realizado), classe: 'dir ' + sinal(p.realizado) };
      default: return { texto: '' };
    }
  }

  function blocoTabela(corpo, dados, o) {
    const colunas = (Array.isArray(o.colunas) && o.colunas.length ? o.colunas : ['ticker', 'classe', 'quantidade', 'preco_medio', 'valor_atual', 'lucro', 'rentabilidade'])
      .filter((c) => COLUNAS[c]);
    let lista = posicoesFiltradas(dados, o);
    const ordenar = o.ordenar || 'valor_atual';
    lista.sort((a, b) => (Number(b[ordenar]) || 0) - (Number(a[ordenar]) || 0));
    if (o.limite) lista = lista.slice(0, Number(o.limite));
    const patrimonio = dados.carteira.totais.patrimonio;

    if (!lista.length) { corpo.appendChild(el('p', 'vazio', 'Nenhuma posição para mostrar.')); return; }

    const rolagem = el('div', 'rolagem');
    const tabela = el('table', 'tabela');
    const thead = el('thead');
    const trh = el('tr');
    colunas.forEach((c) => {
      const th = el('th', c === 'ticker' || c === 'classe' ? '' : 'dir', COLUNAS[c]);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    tabela.appendChild(thead);

    const tbody = el('tbody');
    lista.forEach((p) => {
      const tr = el('tr');
      colunas.forEach((c) => {
        const v = valorColuna(p, c, patrimonio);
        tr.appendChild(el('td', v.classe || '', v.texto));
      });
      tbody.appendChild(tr);
    });
    tabela.appendChild(tbody);
    rolagem.appendChild(tabela);
    corpo.appendChild(rolagem);

    if (o.totalizar !== false) {
      const t = totaisDe(lista);
      corpo.appendChild(el('p', 'resumo-linha', 'Investido ' + dinheiro(t.investido) + ' · Atual ' + dinheiro(t.patrimonio) + ' · Resultado ' + dinheiro(t.lucro) + ' (' + pct(t.rentabilidade) + ')'));
    }
  }

  const NOME_TIPO = { compra: 'Compra', venda: 'Venda', provento: 'Provento' };

  function blocoLancamentos(corpo, dados, o) {
    let txs = dados.transacoes.slice();
    if (o.tipo && o.tipo !== 'todos') txs = txs.filter((t) => t.tipo === o.tipo);
    if (o.classe && o.classe !== 'todas') {
      const tickers = new Set(dados.carteira.posicoes.filter((p) => p.classe === o.classe).map((p) => p.ticker));
      txs = txs.filter((t) => tickers.has(t.ticker));
    }
    txs = txs.slice(0, Number(o.limite) || 10);

    if (!txs.length) { corpo.appendChild(el('p', 'vazio', 'Nenhum lançamento encontrado.')); return; }

    const rolagem = el('div', 'rolagem');
    const tabela = el('table', 'tabela');
    tabela.innerHTML = '<thead><tr><th>Data</th><th>Ativo</th><th>Tipo</th><th class="dir">Qtd.</th><th class="dir">Valor</th></tr></thead>';
    const tbody = el('tbody');
    txs.forEach((t) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', t.data.split('-').reverse().join('/')));
      tr.appendChild(el('td', 'ticker', t.ticker));
      tr.appendChild(el('td', t.tipo === 'compra' ? 'positivo' : t.tipo === 'venda' ? 'negativo' : 'neutro', NOME_TIPO[t.tipo]));
      tr.appendChild(el('td', 'dir', t.tipo === 'provento' ? '—' : qtdFmt(t.quantidade)));
      tr.appendChild(el('td', 'dir', dinheiro(t.tipo === 'provento' ? t.preco : t.quantidade * t.preco + t.taxas)));
      tbody.appendChild(tr);
    });
    tabela.appendChild(tbody);
    rolagem.appendChild(tabela);
    corpo.appendChild(rolagem);
  }

  function lerMetas(texto) {
    return String(texto || '')
      .split(/[\n,;]+/)
      .map((linha) => {
        const m = linha.split(/[:=]/);
        if (m.length < 2) return null;
        const alvo = Number(String(m[1]).replace(',', '.').replace('%', '').trim());
        const classe = m[0].trim();
        if (!classe || !Number.isFinite(alvo)) return null;
        return { classe, alvo };
      })
      .filter(Boolean);
  }

  function blocoMetas(corpo, dados, o) {
    const metas = lerMetas(o.metas);
    const patrimonio = dados.carteira.totais.patrimonio;
    if (!metas.length) {
      corpo.appendChild(el('p', 'vazio', 'Defina as metas assim: Ações: 50, FIIs: 30, Renda Fixa: 20'));
      return;
    }
    const real = {};
    dados.carteira.posicoes.forEach((p) => { real[p.classe] = (real[p.classe] || 0) + p.valor_atual; });

    const ul = el('ul', 'metas');
    metas.forEach((meta, i) => {
      const valorReal = real[meta.classe] || 0;
      const pctReal = patrimonio > 0 ? (valorReal / patrimonio) * 100 : 0;
      const diferenca = pctReal - meta.alvo;
      const ajuste = (meta.alvo / 100) * patrimonio - valorReal;

      const li = el('li');
      const topo = el('div', 'meta-topo');
      topo.appendChild(el('b', '', meta.classe));
      topo.appendChild(el('span', 'neutro', pctSimples(pctReal) + ' de ' + pctSimples(meta.alvo)));
      li.appendChild(topo);

      const trilho = el('div', 'barra-trilho');
      const barra = el('div', 'barra');
      barra.style.width = Math.min(100, pctReal) + '%';
      barra.style.background = CORES[i % CORES.length];
      const alvoMarca = el('span', 'marca-alvo');
      alvoMarca.style.left = Math.min(100, meta.alvo) + '%';
      trilho.appendChild(barra);
      trilho.appendChild(alvoMarca);
      li.appendChild(trilho);

      li.appendChild(
        el('small', Math.abs(diferenca) < 0.5 ? 'neutro' : ajuste > 0 ? 'positivo' : 'negativo',
          Math.abs(diferenca) < 0.5 ? 'No alvo' : ajuste > 0 ? 'Faltam ' + dinheiro(ajuste) : 'Excesso de ' + dinheiro(-ajuste))
      );
      ul.appendChild(li);
    });
    corpo.appendChild(ul);
  }

  function blocoTexto(corpo, dados, o) {
    const p = el('div', 'texto-livre');
    String(o.corpo || '').split('\n').forEach((linha) => {
      p.appendChild(el('p', '', linha));
    });
    corpo.appendChild(p);
  }

  function blocoLivre(corpo, dados, o) {
    const frame = document.createElement('iframe');
    frame.className = 'quadro-livre';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.height = (Number(o.altura) || 320) + 'px';
    frame.srcdoc =
      '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">' +
      '<style>' +
      ':root{color-scheme:dark}' +
      'body{margin:0;padding:12px;font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:#e6e9ef;background:transparent}' +
      'a{color:#4c8dff}table{border-collapse:collapse;width:100%}th,td{padding:6px;border-bottom:1px solid #232a36;text-align:left}' +
      (o.css || '') +
      '</style></head><body>' +
      (o.html || '') +
      '<script>window.dados=' + JSON.stringify(JSON.stringify(dados)) + ';window.dados=JSON.parse(window.dados);' +
      'window.dinheiro=function(v){return (v<0?"-":"")+"R$ "+Math.abs(Number(v)||0).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})};' +
      'try{' + (o.js || '') + '}catch(e){document.body.insertAdjacentHTML("beforeend","<pre style=\\"color:#f05252\\">"+e.message+"</pre>")}' +
      '<\/script></body></html>';
    corpo.appendChild(frame);
  }

  const RENDERIZADORES = {
    kpi: blocoKpi,
    rosca: blocoRosca,
    barras: blocoBarras,
    tabela: blocoTabela,
    lancamentos: blocoLancamentos,
    metas: blocoMetas,
    texto: blocoTexto,
    livre: blocoLivre,
  };

  /* ---------- API publica ---------- */
  function renderizarBloco(bloco, dados) {
    const artigo = el('article', 'painel bloco tam-' + (bloco.tamanho || 'm'));
    if (bloco.titulo) artigo.appendChild(el('h2', '', bloco.titulo));
    const corpo = el('div', 'bloco-corpo');
    try {
      (RENDERIZADORES[bloco.tipo] || (() => {}))(corpo, dados, bloco.opcoes || {});
    } catch (e) {
      corpo.appendChild(el('p', 'vazio negativo', 'Erro ao montar este bloco: ' + e.message));
    }
    artigo.appendChild(corpo);
    return artigo;
  }

  function renderizarTela(tela, dados, destino) {
    destino.innerHTML = '';
    const blocos = (tela.config && tela.config.blocos) || [];
    if (!blocos.length) {
      destino.appendChild(el('p', 'vazio', 'Esta tela ainda não tem blocos. Adicione o primeiro no Laboratório.'));
      return;
    }
    blocos.forEach((b) => destino.appendChild(renderizarBloco(b, dados)));
  }

  return {
    CATALOGO, METRICAS, COLUNAS, CORES,
    renderizarTela, renderizarBloco, desenharRosca,
    dinheiro, pct, pctSimples, qtdFmt, sinal,
  };
})();
