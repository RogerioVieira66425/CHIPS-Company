'use strict';

const App = (function () {
  const $ = (s) => document.querySelector(s);

  const dinheiro = (v) =>
    (v < 0 ? '-' : '') + 'R$ ' + Math.abs(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctFmt = (v) => (Number(v) || 0).toFixed(1).replace('.', ',') + '%';
  const dataHora = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };

  const el = (tag, classe, texto) => {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto;
    return e;
  };
  const celula = (texto, classe) => el('td', classe, texto);
  const link = (texto, url, classe) => {
    const a = el('a', classe || 'link-externo', texto);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  };

  let produtos = [];
  let detalhe = null;
  let usuarioAtual = null;
  let ehAdmin = false;
  let vistaAtual = 'busca';
  let ofertasDaBusca = [];   // resultado completo da ultima busca
  let pagina = 1;
  const POR_PAGINA = 10;

  /* ---------- utilitarios ---------- */
  let temporizadorToast;
  function toast(msg, erro) {
    const e = $('#toast');
    e.textContent = msg;
    e.className = 'toast' + (erro ? ' erro' : '');
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => e.classList.add('oculto'), 4200);
  }

  async function pedir(rota, opcoes) {
    const conf = Object.assign({ headers: { 'Content-Type': 'application/json' } }, opcoes);
    if (conf.body && typeof conf.body !== 'string') conf.body = JSON.stringify(conf.body);
    const r = await fetch(rota, conf);
    const dados = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(dados.erro || 'Falha na requisição'), { status: r.status });
    return dados;
  }

  function dadosForm(form) {
    const o = {};
    new FormData(form).forEach((v, k) => { o[k] = v; });
    return o;
  }

  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ================= NAVEGACAO ================= */
  function mostrar(vista) {
    vistaAtual = vista;
    $('#vista-busca').classList.toggle('oculto', vista !== 'busca');
    $('#vista-detalhe').classList.toggle('oculto', vista !== 'detalhe');
    $('#vista-metricas').classList.toggle('oculto', vista !== 'metricas');
    $('#vista-admin').classList.toggle('oculto', vista !== 'admin');
    if (vista === 'admin') carregarAdmin().catch((e) => toast(e.message, true));
    if (vista === 'metricas') carregarMetricas().catch((e) => toast(e.message, true));
    renderMenu();
    window.scrollTo({ top: 0 });
  }

  /* O visitante ve so a busca: o topo fica limpo.
     Quem administra ganha o menu para circular entre as telas.
     As metricas continuam acessiveis pelo endereco /metricas. */
  function renderMenu() {
    const menu = $('#menu');
    menu.innerHTML = '';
    if (!ehAdmin) return;

    const botao = (rotulo, vista) => {
      const b = el('button', 'item-menu' + (vistaAtual === vista ? ' ativo' : ''), rotulo);
      b.addEventListener('click', () => mostrar(vista));
      return b;
    };
    menu.appendChild(botao('Buscar', 'busca'));
    menu.appendChild(botao('Métricas', 'metricas'));
    menu.appendChild(botao('⚙️ Admin', 'admin'));
  }

  /* ---------- frase da capa: muda a cada visita ---------- */
  const FRASES = [
    'Farme desconto, não arrependimento.',
    'Preço cheio é dano no bolso. Compare antes do clique.',
    'Não pague preço de boss final em item de fase 1.',
    'Seu setup merece o melhor loot pelo menor preço.',
    'Antes de comprar, scaneie o mapa inteiro.',
    'Aqui o desconto não é drop raro: é garantido na comparação.',
    'Upgrade no setup, downgrade no preço.',
    'Missão: achar o menor preço. Recompensa: seu dinheiro de volta no bolso.',
  ];

  function escreverFrase() {
    const alvo = $('#frase');
    if (!alvo) return;
    const texto = FRASES[Math.floor(Math.random() * FRASES.length)];

    // efeito de digitação, como um terminal
    alvo.textContent = '';
    const cursor = el('span', 'cursor', '\u00a0');
    alvo.appendChild(cursor);

    let i = 0;
    const tique = setInterval(() => {
      if (i >= texto.length) { clearInterval(tique); setTimeout(() => cursor.remove(), 1800); return; }
      cursor.before(document.createTextNode(texto[i]));
      i += 1;
    }, 32);
  }

  /* ================= BUSCA PUBLICA ================= */
  function estado(texto, carregando) {
    const caixa = $('#estado-busca');
    caixa.classList.remove('oculto');
    caixa.innerHTML = '';
    if (carregando) caixa.appendChild(el('span', 'girando', '◐'));
    caixa.appendChild(el('span', '', texto));
  }

  function limparEstado() {
    $('#estado-busca').classList.add('oculto');
  }

  $('#form-busca').addEventListener('submit', (e) => {
    e.preventDefault();
    const termo = $('#campo-busca').value.trim();
    if (termo.length >= 2) buscar(termo);
  });

  async function buscar(termo) {
    $('#campo-busca').value = termo;
    $('#resultado').classList.add('oculto');
    // a capa centralizada da lugar ao layout com rolagem
    $('#vista-busca').classList.remove('centralizada');
    document.body.classList.remove('capa');
    pagina = 1;
    estado('Procurando "' + termo + '" nas lojas...', true);

    let busca;
    try {
      busca = await pedir('/api/buscas', { method: 'POST', body: { termo } });
    } catch (err) {
      estado(err.message, false);
      return;
    }

    // o resultado pode vir do proprio servidor ou do agente coletor
    const limite = Date.now() + 90000;
    while (busca.status !== 'pronta' && busca.status !== 'falhou' && Date.now() < limite) {
      estado('Consultando as lojas... (' + (busca.status === 'executando' ? 'em andamento' : 'na fila') + ')', true);
      await espera(2000);
      try {
        busca = await pedir('/api/buscas/' + busca.id);
      } catch (err) { break; }
    }

    if (busca.status !== 'pronta') {
      estado(
        busca.erro ||
        'Nenhuma loja respondeu a tempo. O coletor precisa estar rodando para atender buscas neste site.',
        false
      );
      return;
    }

    limparEstado();
    renderResultado(busca);
    carregarSugestoes();
  }

  function renderResultado(busca) {
    const r = busca.resultado || {};
    const comparacao = r.comparacao || { ranking: [], melhor: null, economia: 0, economia_pct: 0 };
    // mostra apenas as ofertas que combinam com o que foi pesquisado
    const termos = String(busca.termo || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '').split(' ').filter((t) => t.length >= 3 && t !== 'gamer');
    const combina = (titulo) => {
      if (!termos.length) return true;
      const alvo = String(titulo || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '');
      return termos.filter((t) => alvo.indexOf(t) !== -1).length / termos.length >= 0.7;
    };
    let ofertas = (r.fontes || []).reduce((acc, f) => acc.concat(f.ofertas || []), []).filter((o) => combina(o.titulo));
    ofertas.sort((a, b) => a.preco_total - b.preco_total);

    $('#resultado').classList.remove('oculto');

    const destino = $('#res-veredito');
    destino.innerHTML = '';

    if (!comparacao.melhor) {
      destino.appendChild(el('p', 'painel vazio', 'Nenhuma oferta encontrada para "' + busca.termo + '".'));
    } else {
      destino.appendChild(cartaoMelhor(comparacao, busca));
    }

    // detalhes tecnicos de cada fonte so interessam a quem administra
    if (ehAdmin) {
      (r.fontes || []).filter((f) => f.erro).forEach((f) => {
        destino.appendChild(el('p', 'aviso', f.fonte + ': ' + f.erro));
      });
    }

    ofertasDaBusca = ofertas;
    pagina = 1;
    renderPagina();
  }

  /* Mostra uma pagina da lista de ofertas e os controles de navegacao. */
  function renderPagina() {
    const total = ofertasDaBusca.length;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    if (pagina > paginas) pagina = paginas;

    const inicio = (pagina - 1) * POR_PAGINA;
    renderOfertas($('#tbody-ofertas'), ofertasDaBusca.slice(inicio, inicio + POR_PAGINA), $('#vazio-ofertas'), inicio);

    const caixa = $('#paginacao');
    caixa.innerHTML = '';
    caixa.classList.toggle('oculto', total <= POR_PAGINA);
    if (total <= POR_PAGINA) return;

    const irPara = (n) => {
      pagina = Math.min(paginas, Math.max(1, n));
      renderPagina();
      $('#resultado').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const anterior = el('button', 'botao', '← Anterior');
    anterior.disabled = pagina === 1;
    anterior.addEventListener('click', () => irPara(pagina - 1));
    caixa.appendChild(anterior);

    const numeros = el('div', 'numeros');
    for (let n = 1; n <= paginas; n += 1) {
      const b = el('button', 'num' + (n === pagina ? ' ativa' : ''), String(n));
      b.addEventListener('click', () => irPara(n));
      numeros.appendChild(b);
    }
    caixa.appendChild(numeros);

    const proxima = el('button', 'botao', 'Próxima →');
    proxima.disabled = pagina === paginas;
    proxima.addEventListener('click', () => irPara(pagina + 1));
    caixa.appendChild(proxima);

    caixa.appendChild(el('span', 'pagina-info',
      'mostrando ' + (inicio + 1) + '–' + Math.min(inicio + POR_PAGINA, total) + ' de ' + total + ' ofertas'));
  }

  function cartaoMelhor(comparacao, busca) {
    const melhor = comparacao.melhor;
    const cartao = el('section', 'painel veredito bom');

    const topo = el('div', 'veredito-topo');
    const esq = el('div');
    esq.appendChild(el('h2', '', 'Mais vantajoso: ' + melhor.loja));
    esq.appendChild(el('p', 'veredito-preco', dinheiro(melhor.preco_total)));

    const detalhes = [];
    if (melhor.frete > 0) detalhes.push('inclui frete de ' + dinheiro(melhor.frete));
    else detalhes.push('frete grátis ou não informado');
    if (melhor.condicao !== 'novo') detalhes.push('produto ' + melhor.condicao);
    if (melhor.parcelas > 0) detalhes.push('até ' + melhor.parcelas + 'x');
    esq.appendChild(el('small', 'neutro', detalhes.join(' · ')));

    if (melhor.titulo) esq.appendChild(el('p', 'anuncio-titulo', melhor.titulo));
    if (melhor.url) esq.appendChild(link('Ir à loja e comprar ↗', melhor.url, 'botao primario comprar'));
    topo.appendChild(esq);

    const dir = el('div', 'ranking-lado');
    if (comparacao.ranking.length > 1) {
      dir.appendChild(el('h3', '', 'Comparação entre lojas'));
      dir.appendChild(barrasDeLojas(comparacao.ranking));
    }
    topo.appendChild(dir);
    cartao.appendChild(topo);

    if (comparacao.economia > 0) {
      cartao.appendChild(el('p', 'economia',
        'Comprando aqui em vez da loja mais cara você economiza ' + dinheiro(comparacao.economia) +
        ' (' + pctFmt(comparacao.economia_pct) + ').'));
    } else if (comparacao.mesmo_produto === false) {
      cartao.appendChild(el('p', 'dica',
        'As lojas trouxeram modelos diferentes para esta busca, então não dá para falar em economia: ' +
        'a lista abaixo mostra a opção mais barata de cada loja. Para comparar o mesmo produto, ' +
        'busque pelo modelo exato (ex.: "redragon kumara k552").'));
    }

    const maisBarato = comparacao.mais_barato;
    if (maisBarato && maisBarato.preco_total < melhor.preco_total) {
      cartao.appendChild(el('p', 'dica',
        'Existe oferta mais barata (' + dinheiro(maisBarato.preco_total) + ' na ' + maisBarato.loja +
        '), mas o sistema não a recomenda por causa da condição do produto ou da reputação do vendedor.'));
    }

    if (busca && busca.atualizado_em) {
      cartao.appendChild(el('small', 'neutro rodape-busca',
        'Consulta feita em ' + dataHora(busca.atualizado_em) + (busca.origem ? ' · coleta pelo ' + busca.origem : '')));
    }

    return cartao;
  }

  function barrasDeLojas(ranking) {
    const maximo = Math.max(...ranking.map((o) => o.preco_total));
    const ul = el('ul', 'barras');
    ranking.forEach((o, i) => {
      const li = el('li');
      li.appendChild(el('span', 'barra-rotulo', o.loja));
      const trilho = el('div', 'barra-trilho');
      const barra = el('div', 'barra ' + (i === 0 ? 'positivo' : ''));
      barra.style.width = (o.preco_total / maximo) * 100 + '%';
      trilho.appendChild(barra);
      li.appendChild(trilho);
      const valor = el('span', 'barra-valor');
      if (o.url) valor.appendChild(link(dinheiro(o.preco_total) + ' ↗', o.url));
      else valor.textContent = dinheiro(o.preco_total);
      li.appendChild(valor);
      ul.appendChild(li);
    });
    return ul;
  }

  function renderOfertas(tbody, ofertas, avisoVazio, deslocamento) {
    const base = deslocamento || 0;
    tbody.innerHTML = '';
    if (avisoVazio) avisoVazio.classList.toggle('oculto', ofertas.length > 0);

    ofertas.forEach((o, indice) => {
      const i = base + indice; // posicao na lista inteira, nao so na pagina
      const tr = el('tr', i === 0 ? 'melhor-linha' : '');
      tr.appendChild(celula(o.loja, 'ticker'));

      const tdTitulo = el('td', 'titulo-oferta');
      const curto = (o.titulo || '').length > 62 ? o.titulo.slice(0, 62).trim() + '…' : (o.titulo || 'ver anúncio');
      if (o.url) {
        const a = link(curto, o.url);
        a.title = o.titulo || '';
        tdTitulo.appendChild(a);
      } else {
        tdTitulo.textContent = curto;
      }
      tr.appendChild(tdTitulo);

      tr.appendChild(celula(o.condicao, o.condicao === 'usado' ? 'negativo' : ''));
      tr.appendChild(celula((o.vendedor || '—') + (o.vendidos ? ' · ' + o.vendidos + ' vendas' : '')));
      tr.appendChild(celula(dinheiro(o.preco), 'dir'));
      tr.appendChild(celula(o.frete > 0 ? dinheiro(o.frete) : 'grátis', 'dir'));
      tr.appendChild(celula(dinheiro(o.preco_total), 'dir ' + (i === 0 ? 'positivo' : '')));

      const tdAcao = el('td', 'dir');
      if (o.url) tdAcao.appendChild(link('comprar ↗', o.url, 'mini-botao'));
      tr.appendChild(tdAcao);

      tbody.appendChild(tr);
    });
  }

  async function carregarSugestoes() {
    try {
      const populares = await pedir('/api/buscas/populares');
      const caixa = $('#sugestoes');
      caixa.innerHTML = '';
      if (!populares.length) return;
      caixa.appendChild(el('span', 'sugestoes-titulo', 'Buscas recentes:'));
      populares.forEach((p) => {
        const b = el('button', 'chip', p.termo);
        b.addEventListener('click', () => buscar(p.termo));
        caixa.appendChild(b);
      });
    } catch (e) { /* sugestoes sao opcionais */ }
  }

  /* ================= PRODUTOS ACOMPANHADOS ================= */
  async function carregarProdutos() {
    try {
      produtos = await pedir('/api/produtos');
    } catch (e) {
      produtos = [];
    }
    $('#monitorados').classList.toggle('oculto', produtos.length === 0);

    const tb = $('#tbody-produtos');
    tb.innerHTML = '';

    produtos.forEach((p) => {
      const tr = el('tr');

      const tdNome = el('td');
      const botao = el('button', 'link-produto', p.nome);
      botao.addEventListener('click', () => abrirDetalhe(p.id));
      tdNome.appendChild(botao);
      tdNome.appendChild(el('small', 'termo', 'busca: ' + p.termo));
      tr.appendChild(tdNome);

      const tdCat = el('td');
      tdCat.appendChild(el('span', 'etiqueta', p.categoria));
      tr.appendChild(tdCat);

      const tdLoja = el('td');
      if (p.melhor_url) tdLoja.appendChild(link(p.melhor_loja + ' ↗', p.melhor_url));
      else tdLoja.textContent = p.melhor_loja || '—';
      tr.appendChild(tdLoja);

      const abaixoAlvo = p.preco_alvo > 0 && p.menor_preco > 0 && p.menor_preco <= p.preco_alvo;
      tr.appendChild(celula(p.menor_preco ? dinheiro(p.menor_preco) : '—', 'dir ' + (abaixoAlvo ? 'positivo' : '')));
      tr.appendChild(celula(String(p.ofertas), 'dir'));
      tr.appendChild(celula(dataHora(p.ultima_coleta)));

      const tdAcoes = el('td', 'dir');
      if (ehAdmin) {
        const btnColeta = el('button', 'mini', '🔄');
        btnColeta.title = 'Atualizar preços deste produto';
        btnColeta.addEventListener('click', () => coletar(p.id, btnColeta));
        const btnExcluir = el('button', 'mini', '🗑');
        btnExcluir.title = 'Parar de acompanhar';
        btnExcluir.addEventListener('click', async () => {
          if (!confirm('Remover "' + p.nome + '" e todo o histórico dele?')) return;
          try {
            await pedir('/api/produtos/' + p.id, { method: 'DELETE' });
            toast('Produto removido.');
            carregarProdutos();
          } catch (err) { toast(err.message, true); }
        });
        tdAcoes.append(btnColeta, btnExcluir);
      }
      tr.appendChild(tdAcoes);

      tb.appendChild(tr);
    });
  }

  async function abrirDetalhe(id) {
    try {
      detalhe = await pedir('/api/produtos/' + id);
    } catch (e) {
      toast(e.message, true);
      return;
    }
    renderDetalhe();
    mostrar('detalhe');
  }

  $('#det-voltar').addEventListener('click', () => mostrar('busca'));
  $('#det-coletar').addEventListener('click', () => { if (detalhe) coletar(detalhe.produto.id); });

  function renderDetalhe() {
    const d = detalhe;
    $('#det-nome').textContent = d.produto.nome;
    $('#det-sub').textContent =
      d.produto.categoria + ' · busca: "' + d.produto.termo + '"' +
      (d.produto.preco_alvo > 0 ? ' · alvo ' + dinheiro(d.produto.preco_alvo) : '') +
      ' · última coleta ' + dataHora(d.ultima_coleta ? d.ultima_coleta.executado_em : '');

    const destino = $('#det-veredito');
    destino.innerHTML = '';

    if (!d.comparacao.melhor) {
      destino.appendChild(el('p', 'painel vazio', 'Ainda não há ofertas para este produto.'));
    } else {
      const cartao = cartaoMelhor(d.comparacao, null);
      cartao.classList.remove('bom');
      cartao.classList.add(d.momento.status);

      const momento = el('div', 'veredito-momento');
      momento.appendChild(el('span', 'selo ' + d.momento.status, d.momento.titulo));
      momento.appendChild(el('p', '', d.momento.texto));
      if (d.momento.dias > 1) {
        momento.appendChild(el('small', 'neutro',
          'mínimo ' + dinheiro(d.momento.minimo) + ' · mediana ' + dinheiro(d.momento.mediana) +
          ' · máximo ' + dinheiro(d.momento.maximo) + ' em ' + d.momento.dias + ' dia(s)'));
      }
      cartao.querySelector('.veredito-topo').appendChild(momento);
      destino.appendChild(cartao);
    }

    const ranking = $('#det-ranking');
    ranking.innerHTML = '';
    if (d.comparacao.ranking.length) {
      ranking.appendChild(barrasDeLojas(d.comparacao.ranking));
      ranking.appendChild(el('p', 'dica',
        'A ordem considera o preço final mais uma penalidade de risco para produto usado ou vendedor com reputação baixa.'));
    } else {
      ranking.appendChild(el('p', 'vazio', 'Sem lojas para comparar ainda.'));
    }

    renderGrafico(d.historico);
    renderOfertas($('#tbody-det-ofertas'), d.ofertas, $('#vazio-det-ofertas'));
  }

  function renderGrafico(historico) {
    const destino = $('#det-grafico');
    destino.innerHTML = '';
    if (!historico || historico.length < 2) {
      destino.appendChild(el('p', 'vazio', 'O gráfico aparece quando houver coletas em pelo menos dois dias diferentes.'));
      return;
    }

    const largura = 560, altura = 220, margem = { topo: 16, dir: 12, baixo: 28, esq: 62 };
    const valores = historico.map((h) => h.minimo);
    const min = Math.min(...valores), max = Math.max(...valores);
    const faixa = max - min || max * 0.1 || 1;
    const x = (i) => margem.esq + (i / (historico.length - 1)) * (largura - margem.esq - margem.dir);
    const y = (v) => margem.topo + (1 - (v - min + faixa * 0.1) / (faixa * 1.2)) * (altura - margem.topo - margem.baixo);

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + largura + ' ' + altura);
    svg.setAttribute('class', 'grafico');

    [0, 0.5, 1].forEach((f) => {
      const valor = min + faixa * f;
      const linha = document.createElementNS(ns, 'line');
      linha.setAttribute('x1', margem.esq); linha.setAttribute('x2', largura - margem.dir);
      linha.setAttribute('y1', y(valor)); linha.setAttribute('y2', y(valor));
      linha.setAttribute('stroke', '#232a36');
      svg.appendChild(linha);
      const rotulo = document.createElementNS(ns, 'text');
      rotulo.setAttribute('x', 6); rotulo.setAttribute('y', y(valor) + 4);
      rotulo.setAttribute('fill', '#97a1b2'); rotulo.setAttribute('font-size', '11');
      rotulo.textContent = dinheiro(valor);
      svg.appendChild(rotulo);
    });

    const linha = document.createElementNS(ns, 'polyline');
    linha.setAttribute('points', historico.map((h, i) => x(i) + ',' + y(h.minimo)).join(' '));
    linha.setAttribute('fill', 'none');
    linha.setAttribute('stroke', '#4c8dff');
    linha.setAttribute('stroke-width', '2');
    svg.appendChild(linha);

    historico.forEach((h, i) => {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', x(i)); c.setAttribute('cy', y(h.minimo)); c.setAttribute('r', '3');
      c.setAttribute('fill', h.minimo === min ? '#22c55e' : '#4c8dff');
      const t = document.createElementNS(ns, 'title');
      t.textContent = h.dia.split('-').reverse().join('/') + ': ' + dinheiro(h.minimo);
      c.appendChild(t);
      svg.appendChild(c);
    });

    [0, historico.length - 1].forEach((i) => {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', x(i)); t.setAttribute('y', altura - 8);
      t.setAttribute('fill', '#97a1b2'); t.setAttribute('font-size', '11');
      t.setAttribute('text-anchor', i === 0 ? 'start' : 'end');
      t.textContent = historico[i].dia.slice(5).split('-').reverse().join('/');
      svg.appendChild(t);
    });

    destino.appendChild(svg);
    destino.appendChild(el('p', 'dica', 'Cada ponto é o menor preço observado naquele dia, somando todas as lojas.'));
  }

  /* ================= METRICAS ================= */
  const segundos = (v) => (Number(v) || 0).toFixed(1).replace('.', ',') + 's';

  async function carregarMetricas() {
    const m = await pedir('/api/metricas');

    $('#met-buscas').textContent = m.buscas_total;
    $('#met-buscas-sub').textContent = m.buscas_prontas + ' concluídas nas últimas ' + m.buscas_analisadas;

    $('#met-tempo').textContent = segundos(m.tempo_medio_s);
    $('#met-tempo-sub').textContent = 'mediana ' + segundos(m.tempo_mediano_s);

    $('#met-ofertas').textContent = m.ofertas_brutas;
    $('#met-ofertas-sub').textContent = m.ofertas_relevantes + ' relevantes · ' +
      (Number(m.descartadas_pct) || 0).toFixed(0) + '% descartadas por relevância';

    $('#met-historico').textContent = m.ofertas_historico;
    $('#met-historico-sub').textContent = m.produtos_monitorados + ' produto(s) acompanhado(s)';

    const tb = $('#tbody-metricas');
    tb.innerHTML = '';
    m.lojas.forEach((l) => {
      const tr = el('tr');
      tr.appendChild(celula(l.loja, 'ticker'));
      tr.appendChild(celula(String(l.consultas), 'dir'));
      const taxa = (Number(l.taxa_sucesso) || 0).toFixed(0) + '%';
      tr.appendChild(celula(taxa, 'dir ' + (l.taxa_sucesso >= 80 ? 'positivo' : l.taxa_sucesso >= 50 ? '' : 'negativo')));
      tr.appendChild(celula(String(l.ofertas), 'dir'));
      tr.appendChild(celula((Number(l.media_ofertas) || 0).toFixed(1).replace('.', ','), 'dir'));
      tr.appendChild(celula(segundos(l.tempo_medio_s), 'dir'));
      const tdErro = el('td', 'neutro', l.ultimo_erro ? l.ultimo_erro.slice(0, 48) + '…' : '—');
      tdErro.title = l.ultimo_erro || '';
      tr.appendChild(tdErro);
      tb.appendChild(tr);
    });

    const tt = $('#tbody-termos');
    tt.innerHTML = '';
    m.termos.forEach((t) => {
      const tr = el('tr');
      const td = el('td');
      const b = el('button', 'link-produto', t.termo);
      b.addEventListener('click', () => { mostrar('busca'); buscar(t.termo); });
      td.appendChild(b);
      tr.appendChild(td);
      tr.appendChild(celula(String(t.vezes), 'dir'));
      tt.appendChild(tr);
    });

    desenharBarrasDia(m.por_dia);
  }

  function desenharBarrasDia(dias) {
    const destino = $('#met-grafico');
    destino.innerHTML = '';
    if (!dias || !dias.length) {
      destino.appendChild(el('p', 'vazio', 'Ainda não há buscas registradas.'));
      return;
    }
    const maximo = Math.max(...dias.map((d) => d.buscas));
    const ul = el('ul', 'barras');
    dias.forEach((d) => {
      const li = el('li');
      li.appendChild(el('span', 'barra-rotulo', d.dia.slice(5).split('-').reverse().join('/')));
      const trilho = el('div', 'barra-trilho');
      const barra = el('div', 'barra');
      barra.style.width = (d.buscas / maximo) * 100 + '%';
      trilho.appendChild(barra);
      li.appendChild(trilho);
      li.appendChild(el('span', 'barra-valor', String(d.buscas)));
      ul.appendChild(li);
    });
    destino.appendChild(ul);
  }

  const btnMetricas = $('#met-atualizar');
  if (btnMetricas) btnMetricas.addEventListener('click', () => carregarMetricas().catch((e) => toast(e.message, true)));

  /* ================= ADMINISTRACAO ================= */
  async function coletar(id, botao) {
    if (botao) { botao.disabled = true; botao.textContent = '⏳'; }
    try {
      const r = await pedir('/api/produtos/' + id + '/coletar', { method: 'POST' });
      const falhas = r.relatorio.filter((f) => f.erro);
      if (falhas.length) toast(falhas.map((f) => f.fonte + ': ' + f.erro).join(' | '), true);
      else toast(r.relatorio.reduce((t, f) => t + f.encontrados, 0) + ' oferta(s) coletada(s).');
      await carregarProdutos();
      if (detalhe && detalhe.produto.id === id) { detalhe = r.detalhe; renderDetalhe(); }
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (botao) { botao.disabled = false; botao.textContent = '🔄'; }
    }
  }

  const formProduto = $('#form-produto');
  if (formProduto) {
    formProduto.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const p = await pedir('/api/produtos', { method: 'POST', body: dadosForm(e.target) });
        e.target.reset();
        await carregarProdutos();
        toast('Produto adicionado ao acompanhamento.');
        coletar(p.id);
      } catch (err) { toast(err.message, true); }
    });
  }

  const btnColetarTodos = $('#btn-coletar-todos');
  if (btnColetarTodos) {
    btnColetarTodos.addEventListener('click', async (e) => {
      if (!produtos.length) { toast('Nenhum produto acompanhado.', true); return; }
      e.target.disabled = true;
      for (const p of produtos) await coletar(p.id);
      e.target.disabled = false;
      toast('Coleta concluída.');
    });
  }

  async function carregarAdmin() {
    const usuarios = await pedir('/api/admin/usuarios');
    const soma = (campo) => usuarios.reduce((t, u) => t + u[campo], 0);
    $('#admin-total-usuarios').textContent = usuarios.length;
    $('#admin-total-produtos').textContent = soma('produtos');
    $('#admin-total-coletas').textContent = soma('coletas');
    $('#admin-total-ofertas').textContent = soma('ofertas');

    const tb = $('#tbody-admin');
    tb.innerHTML = '';
    usuarios.forEach((u) => {
      const tr = el('tr');
      tr.appendChild(celula('#' + u.id));

      const tdNome = el('td', '', u.nome);
      if (u.admin) {
        const et = el('span', 'etiqueta oficial', 'admin');
        et.style.marginLeft = '6px';
        tdNome.appendChild(et);
      }
      tr.appendChild(tdNome);

      tr.appendChild(celula(u.email));
      tr.appendChild(celula(u.criado_em.slice(0, 10).split('-').reverse().join('/')));
      tr.appendChild(celula(String(u.produtos), 'dir'));
      tr.appendChild(celula(String(u.coletas), 'dir'));
      tr.appendChild(celula(String(u.ofertas), 'dir'));
      tr.appendChild(celula(u.sessoes > 0 ? 'ativa' : '—', 'dir ' + (u.sessoes > 0 ? 'positivo' : 'neutro')));

      const tdAcoes = el('td', 'dir');
      const btnSenha = el('button', 'mini', '🔑');
      btnSenha.title = 'Definir nova senha';
      btnSenha.addEventListener('click', async () => {
        const senha = prompt('Nova senha para ' + u.nome + ' (mínimo 8 caracteres):');
        if (!senha) return;
        try {
          await pedir('/api/admin/usuarios/' + u.id + '/senha', { method: 'POST', body: { senha } });
          toast('Senha redefinida.');
          if (usuarioAtual && u.id === usuarioAtual.id) location.reload();
          else carregarAdmin();
        } catch (err) { toast(err.message, true); }
      });
      tdAcoes.appendChild(btnSenha);
      tr.appendChild(tdAcoes);

      tb.appendChild(tr);
    });
  }

  const btnAdminAtualizar = $('#admin-atualizar');
  if (btnAdminAtualizar) btnAdminAtualizar.addEventListener('click', () => carregarAdmin().catch((e) => toast(e.message, true)));

  /* ---------- login (so em /admin) ---------- */
  $('#form-entrar').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await pedir('/api/login', { method: 'POST', body: dadosForm(e.target) });
      location.href = '/';
    } catch (err) {
      const aviso = $('#aviso-login');
      aviso.textContent = err.message;
      aviso.classList.remove('oculto');
    }
  });

  $('#btn-voltar-site').addEventListener('click', () => { location.href = '/'; });

  $('#btn-sair').addEventListener('click', async () => {
    await pedir('/api/logout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  });

  /* ================= INICIO ================= */
  (async function iniciar() {
    try {
      usuarioAtual = await pedir('/api/eu');
      ehAdmin = Boolean(usuarioAtual && usuarioAtual.admin);
    } catch {
      usuarioAtual = null;
      ehAdmin = false;
    }

    const caminho = location.pathname.replace(/\/+$/, '');
    const querAdmin = caminho === '/admin';
    const querMetricas = caminho === '/metricas';

    if (querAdmin && !usuarioAtual) {
      $('#tela-login').classList.remove('oculto');
      document.querySelector('header').classList.add('oculto');
      return;
    }

    document.querySelectorAll('.so-admin').forEach((e) => e.classList.toggle('oculto', !ehAdmin));
    $('#btn-sair').classList.toggle('oculto', !usuarioAtual);
    $('#ola').textContent = usuarioAtual ? usuarioAtual.nome : '';

    if ($('#vista-busca').classList.contains('centralizada')) document.body.classList.add('capa');

    await carregarProdutos();
    carregarSugestoes();
    escreverFrase();
    mostrar(querAdmin && ehAdmin ? 'admin' : querMetricas ? 'metricas' : 'busca');
    $('#campo-busca').focus();
  })();

  return { pedir, toast, buscar };
})();
