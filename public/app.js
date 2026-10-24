'use strict';

const App = (function () {
  const $ = (s) => document.querySelector(s);

  const dinheiro = (v) =>
    (v < 0 ? '-' : '') + 'R$ ' + Math.abs(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctFmt = (v) => (Number(v) || 0).toFixed(1).replace('.', ',') + '%';
  const dataHora = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const local = I18N.formatoData();
    return d.toLocaleDateString(local) + ' ' + d.toLocaleTimeString(local, { hour: '2-digit', minute: '2-digit' });
  };

  const t = (chave, valores) => I18N.t(chave, valores);

  const el = (tag, classe, texto) => {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto;
    return e;
  };
  const celula = (texto, classe) => el('td', classe, texto);
  /* O endereco vem da pagina da loja: so vale http(s). Um "javascript:" ali
     viraria execucao de script dentro do nosso site. */
  const enderecoSeguro = (url) => (/^https?:\/\//i.test(String(url || '')) ? String(url) : '');

  const link = (texto, url, classe) => {
    const a = el('a', classe || 'link-externo', texto);
    a.href = enderecoSeguro(url);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  };

  let produtos = [];
  let detalhe = null;
  let vistaAtual = 'busca';
  let ofertasDaBusca = [];   // resultado completo da ultima busca
  let buscaAtual = null;     // dados da busca (termo, origem, data)
  let filtros = { marca: '', categoria: '', loja: '', preco: '' };
  let pagina = 1;
  const POR_PAGINA = 12;   // divisivel por 4, 3, 2 e 1: a ultima linha nunca fica com buraco

  /* Marcas conhecidas do mercado gamer: usadas para classificar o anuncio pelo titulo. */
  const MARCAS = [
    'Logitech', 'Redragon', 'HyperX', 'Razer', 'Corsair', 'Kingston', 'Asus', 'Gigabyte',
    'MSI', 'Intel', 'AMD', 'NVIDIA', 'Sandisk', 'Seagate', 'Western Digital', 'XPG', 'Adata',
    'Fortrek', 'Havit', 'Motospeed', 'Multilaser', 'Dazz', 'Mancer', 'Pichau', 'Rise Mode',
    'Cooler Master', 'Thermaltake', 'DeepCool', 'Akko', 'Keychron', 'Steelseries', 'Sades',
    'JBL', 'Sony', 'Samsung', 'LG', 'AOC', 'Acer', 'Dell', 'Philips', 'TP-Link', 'Intelbras',
    'Galax', 'PowerColor', 'Sapphire', 'Zotac', 'PNY', 'Crucial', 'Husky', 'Vinik', 'C3Tech',
    'Clanm', 'Attack Shark', 'Epomaker', 'Gamdias', 'Marvo', 'Elgato', 'Trust', 'Aula',
  ];

  const CATEGORIAS = [
    ['Teclado', /teclado/i],
    ['Mouse', /\bmouse\b/i],
    ['Mousepad', /mousepad|mouse pad/i],
    ['Headset', /headset|fone de ouvido|fone gamer/i],
    ['Monitor', /monitor/i],
    ['Placa de vídeo', /placa de v[íi]deo|geforce|radeon|rtx|gtx/i],
    ['Processador', /processador|ryzen|core i[3579]/i],
    ['Memória', /mem[óo]ria|ddr[45]/i],
    ['Armazenamento', /ssd|hd |hd\b|nvme|disco/i],
    ['Cadeira', /cadeira/i],
    ['Gabinete', /gabinete/i],
    ['Fonte', /fonte/i],
    ['Cooler', /cooler|water ?cooler|ventoinha/i],
    ['Microfone', /microfone/i],
    ['Webcam', /webcam/i],
    ['Controle', /controle|gamepad|joystick/i],
    ['Cabo e adaptador', /cabo|adaptador|hub/i],
  ];

  /* Faixas de preco. O rotulo e montado na hora para acompanhar o idioma
     escolhido; os limites e que definem o filtro. */
  const FAIXAS = [
    ['ate100', 0, 100],
    ['100a300', 100, 300],
    ['300a600', 300, 600],
    ['600a1200', 600, 1200],
    ['acima1200', 1200, Infinity],
  ];

  const rotuloFaixa = ([, min, max]) => (
    min === 0 ? t('faixa.ate', { valor: dinheiroRedondo(max) })
      : max === Infinity ? t('faixa.acima', { valor: dinheiroRedondo(min) })
        : t('faixa.entre', { de: dinheiroRedondo(min), ate: dinheiroRedondo(max) })
  );

  const marcaDe = (titulo) => {
    const t = String(titulo || '').toLowerCase();
    return MARCAS.find((m) => t.indexOf(m.toLowerCase()) !== -1) || I18N.t('filtro.outras');
  };

  const categoriaDe = (titulo) => {
    const achou = CATEGORIAS.find(([, padrao]) => padrao.test(String(titulo || '')));
    return achou ? achou[0] : I18N.t('filtro.outros');
  };

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

  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ================= NAVEGACAO ================= */
  function mostrar(vista) {
    vistaAtual = vista;
    $('#vista-busca').classList.toggle('oculto', vista !== 'busca');
    $('#vista-detalhe').classList.toggle('oculto', vista !== 'detalhe');
    $('#vista-metricas').classList.toggle('oculto', vista !== 'metricas');
    $('#vista-analise').classList.toggle('oculto', vista !== 'analise');
    if (vista === 'metricas') carregarMetricas().catch((e) => toast(e.message, true));
    renderMenu();
    window.scrollTo({ top: 0 });
  }

  /* O site nao tem areas restritas: o topo fica limpo. */
  function renderMenu() {
    $('#menu').innerHTML = '';
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
  function estado(texto, carregando, detalhe) {
    const caixa = $('#estado-busca');
    caixa.classList.remove('oculto');
    caixa.innerHTML = '';

    if (!carregando) {
      caixa.appendChild(el('p', 'estado-aviso', texto));
      return;
    }

    const linha = el('div', 'estado-linha');
    linha.appendChild(el('span', 'anel'));
    const bloco = el('div', 'estado-texto');
    bloco.appendChild(el('b', '', texto));
    bloco.appendChild(el('small', '', detalhe || t('estado.lojas')));
    linha.appendChild(bloco);
    caixa.appendChild(linha);
  }

  function limparEstado() {
    $('#estado-busca').classList.add('oculto');
  }

  $('#form-busca').addEventListener('submit', (e) => {
    e.preventDefault();
    const termo = $('#campo-busca').value.trim();
    if (termo.length >= 2) buscar(termo);
  });

  $('#busca-topo').addEventListener('submit', (e) => {
    e.preventDefault();
    const termo = $('#campo-topo').value.trim();
    if (termo.length >= 2) { mostrar('busca'); buscar(termo); }
  });

  async function buscar(termo) {
    $('#campo-busca').value = termo;
    $('#resultado').classList.add('oculto');
    // a capa centralizada da lugar ao layout com rolagem
    $('#vista-busca').classList.remove('centralizada');
    document.body.classList.remove('capa');

    // o video de fundo para de tocar fora da capa: economiza processamento
    const video = $('#fundo-video');
    if (video) { try { video.pause(); } catch (e) { /* sem problema */ } }

    // a busca sobe para o topo e a capa sai de cena
    document.body.classList.add('com-resultado');
    $('#busca-topo').classList.remove('oculto');
    $('#campo-topo').value = termo;
    pagina = 1;
    estado(t('estado.procurando', { termo }), true);

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
      estado(
        t(busca.status === 'executando' ? 'estado.consultando' : 'estado.preparando'),
        true,
        t(busca.status === 'executando' ? 'estado.tempo' : 'estado.fila')
      );
      await espera(2000);
      try {
        busca = await pedir('/api/buscas/' + busca.id);
      } catch (err) { break; }
    }

    if (busca.status !== 'pronta') {
      estado(busca.erro || t('estado.semResposta'), false);
      return;
    }

    limparEstado();
    renderResultado(busca);
    carregarSugestoes();
  }

  /* ================= TELA DE RESULTADOS =================
     O resultado e montado em tres camadas: o resumo (melhor oferta e ranking
     das lojas), a barra de filtros e a lista de ofertas em grade ou lista. */

  let ordem = 'preco';     // criterio de ordenacao escolhido na barra
  let vista = 'lista';     // a busca abre em lista; a grade fica a um clique

  const ORDENS = [
    ['preco', 'ordem.menorPreco'],
    ['-preco', 'ordem.maiorPreco'],
    ['desconto', 'ordem.maiorDesconto'],
  ];

  /* Uma cor por loja apenas para o selo redondo do cartao. */
  const COR_LOJA = {
    'KaBuM!': '#1a4fd6',
    Pichau: '#c2410c',
    Terabyte: '#0e7490',
    Patoloco: '#5b3fd1',
    'Setup Ninja': '#0f766e',
    Amazon: '#0d0f12',
    'Mercado Livre': '#a68b00',
  };
  const corDaLoja = (loja) => COR_LOJA[loja] || '#0d0f12';

  /* Marca da loja: public/lojas/<nome-da-loja>.png (ou .svg). Sem arquivo,
     o cartao escreve o nome da loja no lugar da imagem. */
  const FORMATOS_MARCA = ['.png', '.svg'];

  /* lojas cuja marca e clara sobre fundo escuro: a placa acompanha */
  const MARCA_ESCURA = ['Setup Ninja'];

  const chaveDaLoja = (loja) => String(loja || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function marcaDaLoja(loja) {
    const caixa = el('div', 'hero-logo marca-' + chaveDaLoja(loja) +
      (MARCA_ESCURA.indexOf(loja) !== -1 ? ' escura' : ''));
    const img = document.createElement('img');
    img.alt = loja || '';

    let formato = 0;
    const carregar = () => { img.src = '/lojas/' + chaveDaLoja(loja) + FORMATOS_MARCA[formato]; };
    img.addEventListener('error', () => {
      formato += 1;
      if (formato < FORMATOS_MARCA.length) { carregar(); return; }
      caixa.classList.add('sem-marca');
      caixa.textContent = loja || '';
    });
    carregar();

    caixa.appendChild(img);
    return caixa;
  }

  const ICONE_CHECK = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="m2.5 6.2 2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICONE_LINK = '<svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M4 2h6v6M10 2 3 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const ICONE_ANALISE = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M2.5 13.5h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<rect x="3.5" y="8" width="2.4" height="3.6" rx="1" fill="currentColor"/>' +
    '<rect x="7" y="5" width="2.4" height="6.6" rx="1" fill="currentColor"/>' +
    '<rect x="10.5" y="2.5" width="2.4" height="9.1" rx="1" fill="currentColor"/></svg>';
  const ICONE_PONTO = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* o preco grande do cartao principal mostra o "R$" separado do numero */
  const valor = (v) => Math.abs(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const curto = (texto, limite) => {
    const s = String(texto || '');
    return s.length > limite ? s.slice(0, limite).trim() + '…' : s;
  };
  /* na faixa de precos os centavos so atrapalham: o cartao e um resumo */
  const dinheiroRedondo = (v) => 'R$ ' + Math.round(Number(v) || 0).toLocaleString('pt-BR');
  const descontoDe = (o) => {
    const de = Number(o.preco_de) || 0;
    return de > o.preco ? Math.round(((de - o.preco) / de) * 100) : 0;
  };

  function renderResultado(busca) {
    const r = busca.resultado || {};
    // mostra apenas as ofertas que combinam com o que foi pesquisado
    const termos = String(busca.termo || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '').split(' ').filter((t) => t.length >= 3 && t !== 'gamer');
    const combina = (titulo) => {
      if (!termos.length) return true;
      const alvo = String(titulo || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '');
      return termos.filter((t) => alvo.indexOf(t) !== -1).length / termos.length >= 0.7;
    };
    const ofertas = (r.fontes || []).reduce((acc, f) => acc.concat(f.ofertas || []), []).filter((o) => combina(o.titulo));
    ofertas.sort((a, b) => a.preco_total - b.preco_total);

    $('#resultado').classList.remove('oculto');

    ofertasDaBusca = ofertas.map((o) => Object.assign({}, o, {
      marca: marcaDe(o.titulo),
      categoria: categoriaDe(o.titulo),
    }));
    buscaAtual = busca;
    filtros = { marca: '', categoria: '', loja: '', preco: '' };
    ordem = 'preco';
    pagina = 1;

    $('#res-erros').innerHTML = '';

    montarIntro(busca);
    montarFiltros();
    aplicarFiltros();
  }

  /* ---------- titulo: quantas ofertas, para qual termo e de quando ---------- */
  function montarIntro(busca) {
    const titulo = $('#res-titulo');
    titulo.textContent = t('res.titulo', { n: ofertasDaBusca.length }) + ' ';
    titulo.appendChild(el('em', '', '“' + (busca.termo || '') + '”'));

    const lojas = new Set(ofertasDaBusca.map((o) => o.loja)).size;
    // "servidor" e "agente" tambem sao palavras da interface, nao dados
    const origem = busca.origem ? t('origem.' + busca.origem) : '';
    $('#res-meta').textContent = t('res.meta', { lojas, data: dataHora(busca.atualizado_em) }) +
      (busca.origem ? t('veredito.origem', { origem: origem || busca.origem }) : '');
  }

  /* ---------- barra de filtros: lojas, preco, ordem, marca e categoria ---------- */
  function encherSelect(select, opcoes, escolhido) {
    select.innerHTML = '';
    opcoes.forEach(([valorOpcao, texto]) => {
      const op = document.createElement('option');
      op.value = valorOpcao;
      op.textContent = texto;
      select.appendChild(op);
    });
    select.value = escolhido;
  }

  function montarFiltros() {
    const unicos = (campo) => [...new Set(ofertasDaBusca.map((o) => o[campo]))].sort();
    const faixasComOfertas = FAIXAS.filter(([, min, max]) =>
      ofertasDaBusca.some((o) => o.preco_total >= min && o.preco_total < max));

    encherSelect($('#filtro-preco'),
      [['', t('filtro.qualquer')]].concat(faixasComOfertas.map((f) => [f[0], rotuloFaixa(f)])), filtros.preco);
    encherSelect($('#filtro-ordem'),
      ORDENS.map(([chave, rotulo]) => [chave, t(rotulo)]), ordem);
    encherSelect($('#filtro-marca'),
      [['', t('filtro.todas')]].concat(unicos('marca').map((m) => [m, m])), filtros.marca);
    encherSelect($('#filtro-categoria'),
      [['', t('filtro.todas')]].concat(unicos('categoria').map((c) => [c, c])), filtros.categoria);

    renderPills();
  }

  /* As pastilhas de loja mostram quantas ofertas cada uma tem dentro dos
     outros filtros, para o visitante ver o que ganha ao trocar de loja. */
  function renderPills() {
    const caixa = $('#filtro-lojas');
    caixa.innerHTML = '';

    const semLoja = ofertasDaBusca.filter((o) => passaFiltros(o, { ignorarLoja: true }));
    const lojas = [''].concat([...new Set(ofertasDaBusca.map((o) => o.loja))].sort());

    lojas.forEach((loja) => {
      const b = el('button', 'pill');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(filtros.loja === loja));
      b.appendChild(document.createTextNode(loja || t('filtro.todas')));
      b.appendChild(el('span', 'count', String(semLoja.filter((o) => !loja || o.loja === loja).length)));
      b.addEventListener('click', () => {
        filtros.loja = loja;
        pagina = 1;
        aplicarFiltros();
      });
      caixa.appendChild(b);
    });
  }

  function passaFiltros(o, opcoes) {
    const como = opcoes || {};
    const faixa = FAIXAS.find(([chave]) => chave === filtros.preco);
    if (filtros.marca && o.marca !== filtros.marca) return false;
    if (filtros.categoria && o.categoria !== filtros.categoria) return false;
    if (!como.ignorarLoja && filtros.loja && o.loja !== filtros.loja) return false;
    if (faixa && !(o.preco_total >= faixa[1] && o.preco_total < faixa[2])) return false;
    return true;
  }

  function ofertasFiltradas() {
    return ofertasDaBusca.filter((o) => passaFiltros(o));
  }

  function ordenar(lista) {
    const copia = lista.slice();
    if (ordem === '-preco') copia.sort((a, b) => b.preco_total - a.preco_total);
    else if (ordem === 'desconto') copia.sort((a, b) => descontoDe(b) - descontoDe(a));
    else copia.sort((a, b) => a.preco_total - b.preco_total);
    return copia;
  }

  /* Mesma regra do servidor (analise.js): preco final mais penalidade de risco. */
  function custoAjustado(o) {
    const pesos = { '5_green': 0, '4_light_green': 0.01, '3_yellow': 0.03, '2_orange': 0.06, '1_red': 0.12 };
    let fator = 1;
    if (o.condicao === 'usado') fator += 0.15;
    const risco = o.reputacao ? pesos[o.reputacao] : 0.02;
    fator += risco === undefined ? 0.02 : risco;
    return o.preco_total * fator;
  }

  function compararLocal(lista) {
    let base = lista.filter((o) => o.condicao === 'novo');
    if (!base.length) base = lista;
    if (!base.length) return { ranking: [], melhor: null, economia: 0, economia_pct: 0 };

    const porLoja = new Map();
    base.forEach((o) => {
      const atual = porLoja.get(o.loja);
      if (!atual || o.preco_total < atual.preco_total) porLoja.set(o.loja, o);
    });
    const ranking = [...porLoja.values()].sort((a, b) => custoAjustado(a) - custoAjustado(b));
    const melhor = ranking[0];
    const pior = ranking[ranking.length - 1];
    const economia = pior.preco_total - melhor.preco_total;
    const mesmo = ranking.length < 2 || buscaAtual && buscaAtual.resultado &&
      buscaAtual.resultado.comparacao && buscaAtual.resultado.comparacao.mesmo_produto;

    return {
      ranking,
      melhor,
      economia: mesmo ? economia : 0,
      economia_pct: mesmo && pior.preco_total > 0 ? (economia / pior.preco_total) * 100 : 0,
      mesmo_produto: Boolean(mesmo),
      mais_barato: ranking.slice().sort((a, b) => a.preco_total - b.preco_total)[0],
    };
  }

  function aplicarFiltros() {
    const lista = ordenar(ofertasFiltradas());
    const comparacao = lista.length ? compararLocal(lista) : null;

    renderPills();
    renderHero(comparacao);
    renderRank(comparacao);
    renderInsights(comparacao, lista);
    renderStats(lista);
    $('#res-contagem').textContent = t('res.contagem', { n: lista.length });
    renderPagina(lista);
  }

  /* ---------- cartao escuro: a oferta que o sistema recomenda ---------- */
  function renderHero(comparacao) {
    const caixa = $('#res-hero');
    caixa.innerHTML = '';
    caixa.classList.toggle('vazia', !comparacao);

    if (!comparacao || !comparacao.melhor) {
      caixa.appendChild(el('p', '', ofertasDaBusca.length
        ? t('estado.semFiltro')
        : t('estado.semOfertas', { termo: (buscaAtual && buscaAtual.termo) || '' })));
      return;
    }

    const melhor = comparacao.melhor;
    caixa.appendChild(marcaDaLoja(melhor.loja));

    const chips = el('div', 'chips');
    const selo = el('span', 'tag tag-glow');
    selo.innerHTML = ICONE_CHECK;
    selo.appendChild(document.createTextNode(
      comparacao.mais_barato === melhor ? t('res.menorPreco') : t('res.maisVantajoso')));
    chips.appendChild(selo);
    // o nome da loja ja aparece na marca, no canto do cartao
    caixa.appendChild(chips);

    const preco = el('div', 'hero-price num');
    preco.appendChild(el('sup', '', 'R$'));
    preco.appendChild(document.createTextNode(valor(melhor.preco_total)));
    caixa.appendChild(preco);

    const detalhes = [];
    if (melhor.frete > 0) detalhes.push(t('veredito.freteIncluso', { valor: dinheiro(melhor.frete) }));
    else detalhes.push(t('veredito.freteGratis'));
    if (melhor.condicao !== 'novo') detalhes.push(t('veredito.condicao', { condicao: t('condicao.' + melhor.condicao) }));
    if (melhor.parcelas > 0) detalhes.push(t('veredito.parcelas', { n: melhor.parcelas }));
    caixa.appendChild(el('div', 'hero-ship', detalhes.join(' · ')));

    if (melhor.titulo) caixa.appendChild(el('p', 'hero-title', melhor.titulo));

    if (melhor.url) {
      const ir = link(t('res.irLoja', { loja: melhor.loja }), melhor.url, 'btn btn-primary');
      ir.insertAdjacentHTML('beforeend', ICONE_LINK);
      caixa.appendChild(ir);
    }
  }

  /* ---------- ranking: o menor preco de cada loja, em barras ---------- */
  function renderRank(comparacao) {
    const caixa = $('#res-rank');
    caixa.innerHTML = '';
    if (!comparacao || !comparacao.ranking.length) {
      caixa.appendChild(el('p', 'neutro', t('res.semLojas')));
      return;
    }

    const ranking = comparacao.ranking;
    const maximo = Math.max(...ranking.map((o) => o.preco_total));
    const menor = Math.min(...ranking.map((o) => o.preco_total));
    const barras = [];

    ranking.forEach((o, i) => {
      const linha = el('div', 'rank-row' + (i === 0 ? ' win' : ''));
      linha.appendChild(el('span', 'rank-pos', String(i + 1)));
      linha.appendChild(el('span', 'rank-store', o.loja));

      const trilho = el('span', 'track');
      const barra = el('span', 'fill');
      trilho.appendChild(barra);
      linha.appendChild(trilho);
      barras.push([barra, maximo > 0 ? (o.preco_total / maximo) * 100 : 0]);

      const preco = el('span', 'rank-price num');
      if (o.url) preco.appendChild(link(dinheiro(o.preco_total), o.url, 'link-externo'));
      else preco.textContent = dinheiro(o.preco_total);
      linha.appendChild(preco);

      linha.appendChild(el('span', 'rank-diff num',
        o.preco_total <= menor ? t('res.maisBarato') : '+ ' + dinheiro(o.preco_total - menor)));

      caixa.appendChild(linha);
    });

    // as barras crescem depois de entrarem na tela: a diferenca fica visivel
    setTimeout(() => barras.forEach(([barra, largura]) => { barra.style.width = largura + '%'; }), 80);
  }

  /* ---------- a leitura da comparacao, em uma frase ----------
     Uma linha so, escolhida pelo que aquela busca tem de mais util: a
     economia quando as lojas trouxeram o mesmo produto, o tamanho da
     diferenca entre elas quando os modelos divergem, ou a posicao do
     preco recomendado dentro das ofertas encontradas. */
  function mediana(valores) {
    const ordem = valores.slice().sort((a, b) => a - b);
    if (!ordem.length) return 0;
    const meio = Math.floor(ordem.length / 2);
    return ordem.length % 2 ? ordem[meio] : (ordem[meio - 1] + ordem[meio]) / 2;
  }

  function fraseDaComparacao(comparacao, lista) {
    const melhor = comparacao.melhor;
    const ranking = comparacao.ranking;

    if (ranking.length > 1) {
      const porPreco = ranking.slice().sort((a, b) => a.preco_total - b.preco_total);
      const barata = porPreco[0];
      const cara = porPreco[porPreco.length - 1];
      const diferenca = cara.preco_total - barata.preco_total;
      if (diferenca > 0) {
        return t(comparacao.mesmo_produto ? 'insight.economia' : 'insight.variacao', {
          lojaMin: barata.loja,
          lojaMax: cara.loja,
          min: dinheiro(barata.preco_total),
          max: dinheiro(cara.preco_total),
          dif: dinheiro(diferenca),
          pct: Math.round((diferenca / cara.preco_total) * 100) + '%',
        });
      }
    }

    const meio = mediana(lista.map((o) => o.preco_total));
    if (meio > 0 && lista.length > 2) {
      const abaixo = ((meio - melhor.preco_total) / meio) * 100;
      return abaixo >= 5
        ? t('insight.mediana', { pct: Math.round(abaixo) + '%', n: lista.length, mediana: dinheiro(meio) })
        : t('insight.medianaPerto', { valor: dinheiro(melhor.preco_total), n: lista.length, mediana: dinheiro(meio) });
    }

    const comDesconto = lista.filter((o) => descontoDe(o));
    if (comDesconto.length) {
      const maior = comDesconto.slice().sort((a, b) => descontoDe(b) - descontoDe(a))[0];
      return t('insight.descontos', {
        n: comDesconto.length,
        total: lista.length,
        pct: descontoDe(maior) + '%',
        loja: maior.loja,
      });
    }
    return t('insight.semDescontos');
  }

  function renderInsights(comparacao, lista) {
    const caixa = $('#res-nota');
    caixa.innerHTML = '';
    if (!comparacao || !comparacao.melhor || !lista.length) return;

    const bloco = el('section', 'insights');
    bloco.innerHTML = ICONE_PONTO;
    bloco.appendChild(el('span', '', fraseDaComparacao(comparacao, lista)));
    caixa.appendChild(bloco);
  }

  /* ---------- dois numeros que resumem a busca ---------- */
  function renderStats(lista) {
    const caixa = $('#res-stats');
    caixa.innerHTML = '';

    const cartao = (rotulo, texto, sub, positivo) => {
      const c = el('div', 'stat');
      c.appendChild(el('div', 'stat-l', rotulo));
      c.appendChild(el('div', 'stat-v num' + (positivo ? ' pos' : ''), texto));
      c.appendChild(el('div', 'stat-s', sub));
      return c;
    };

    const campeao = lista.filter((o) => descontoDe(o)).sort((a, b) => descontoDe(b) - descontoDe(a))[0];
    caixa.appendChild(campeao
      ? cartao(t('res.maiorDesconto'), '-' + descontoDe(campeao) + '%',
        campeao.loja + ' · ' + curto(campeao.titulo, 40), true)
      : cartao(t('res.maiorDesconto'), '—', t('res.semDesconto'), false));

    if (lista.length) {
      const precos = lista.map((o) => o.preco_total);
      caixa.appendChild(cartao(t('res.faixaPreco'),
        dinheiroRedondo(Math.min(...precos)) + ' – ' + dinheiroRedondo(Math.max(...precos)),
        t('res.faixaSub', { n: lista.length })));
    } else {
      caixa.appendChild(cartao(t('res.faixaPreco'), '—', t('res.semDesconto')));
    }
  }

  /* ---------- paginacao: 15 ofertas por pagina ---------- */
  let listaVisivel = [];
  function renderPagina(lista) {
    if (lista) listaVisivel = lista;
    const total = listaVisivel.length;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    if (pagina > paginas) pagina = paginas;

    const inicio = (pagina - 1) * POR_PAGINA;
    const campeao = listaVisivel.slice().sort((a, b) => a.preco_total - b.preco_total)[0];
    // lista vazia por causa dos filtros ou porque a busca nao achou nada: sao avisos diferentes
    renderCartoes($('#ofertas'), listaVisivel.slice(inicio, inicio + POR_PAGINA), campeao, false,
      ofertasDaBusca.length ? null : { titulo: t('res.vazioBuscaTitulo'), texto: t('res.vazioBuscaTexto') });
    renderPaginacao(total, paginas, inicio);
  }

  function renderPaginacao(total, paginas, inicio) {
    const caixa = $('#paginacao');
    caixa.innerHTML = '';
    caixa.classList.toggle('oculto', total <= POR_PAGINA);
    if (total <= POR_PAGINA) return;

    const irPara = (n) => {
      pagina = Math.min(paginas, Math.max(1, n));
      renderPagina();
      $('#resultado').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const botao = (rotulo, destino, atual) => {
      const b = el('button', 'pg', rotulo);
      b.type = 'button';
      if (atual) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', () => irPara(destino));
      return b;
    };

    const anterior = botao(t('pagina.anterior'), pagina - 1, false);
    anterior.disabled = pagina === 1;
    caixa.appendChild(anterior);

    // com muitas paginas, mostra so as vizinhas da atual, a primeira e a ultima
    const numeros = [];
    for (let n = 1; n <= paginas; n += 1) {
      if (paginas <= 7 || n === 1 || n === paginas || Math.abs(n - pagina) <= 1) numeros.push(n);
    }
    let anteriorNumero = 0;
    numeros.forEach((n) => {
      if (anteriorNumero && n - anteriorNumero > 1) caixa.appendChild(el('span', 'pager-info', '…'));
      caixa.appendChild(botao(String(n), n, n === pagina));
      anteriorNumero = n;
    });

    const proxima = botao(t('pagina.proxima'), pagina + 1, false);
    proxima.disabled = pagina === paginas;
    caixa.appendChild(proxima);

    caixa.appendChild(el('span', 'pager-info', t('pagina.info', {
      de: inicio + 1,
      ate: Math.min(inicio + POR_PAGINA, total),
      total,
    })));
  }

  /* ---------- ofertas em grade ou em lista ---------- */
  function renderCartoes(destino, lista, campeao, forcarLista, aviso) {
    destino.innerHTML = '';
    const emLista = forcarLista || vista === 'lista';

    if (!lista.length) {
      destino.className = '';
      const vazio = el('div', 'vazio-ofertas');
      vazio.appendChild(el('b', '', (aviso && aviso.titulo) || t('res.vazioTitulo')));
      vazio.appendChild(document.createTextNode((aviso && aviso.texto) || t('res.vazioTexto')));
      destino.appendChild(vazio);
      return;
    }

    destino.className = emLista ? 'list' : 'grid';
    lista.forEach((o, i) => {
      destino.appendChild(emLista ? linhaOferta(o, i, campeao) : cartaoOferta(o, i, campeao));
    });
  }

  function seloLoja(loja) {
    const selo = el('span', 'store');
    const ponto = el('span', 'dot', String(loja || '?').charAt(0));
    ponto.style.background = corDaLoja(loja);
    selo.appendChild(ponto);
    selo.appendChild(document.createTextNode(loja || ''));
    return selo;
  }

  function marcaDesconto(o, venceu, comBarra) {
    if (venceu) return el('span', 'win-tag', '★ ' + t('res.menorPreco'));
    const desconto = descontoDe(o);
    if (desconto) return el('span', 'disc num', '-' + desconto + '%');
    // na lista a coluna nunca fica vazia: sem desconto, entra uma barra
    return el('span', comBarra ? 'sem-desconto' : '', comBarra ? '—' : '');
  }

  function blocoPreco(o) {
    const caixa = el('div');
    caixa.appendChild(el('span', 'old num', descontoDe(o) ? dinheiro(Number(o.preco_de)) : ''));
    caixa.appendChild(el('span', 'price num', dinheiro(o.preco_total)));
    if (o.frete > 0) {
      caixa.appendChild(el('div', 'frete-linha',
        dinheiro(o.preco) + ' + ' + dinheiro(o.frete) + ' ' + t('tabela.frete').toLowerCase()));
    }
    return caixa;
  }

  function botaoLoja(o, classe) {
    if (!o.url) return el('span', '');
    const ir = link(t('res.irLoja', { loja: o.loja }), o.url, classe);
    ir.insertAdjacentHTML('beforeend', ICONE_LINK);
    return ir;
  }

  /* O historico de preco so existe para os produtos acompanhados, entao a
     analise procura qual deles corresponde ao anuncio: todos os termos da
     busca cadastrada precisam aparecer no titulo da oferta. */
  const semAcento = (texto) => String(texto || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '')      // tira o acento sem partir a palavra
    .replace(/[^a-z0-9]+/g, ' ').trim();

  function produtoDaOferta(oferta) {
    const alvo = semAcento(oferta.titulo);
    return produtos.find((p) => {
      const palavras = semAcento(p.termo || p.nome).split(' ').filter((x) => x.length >= 3);
      return palavras.length > 0 && palavras.every((x) => alvo.indexOf(x) !== -1);
    });
  }

  /* Abre a tela de analise do produto da oferta: todas as ofertas do mesmo
     produto na base, com a posicao da oferta escolhida. */
  async function abrirAnalise(oferta) {
    let dados;
    try {
      dados = await pedir('/api/ia/analise?produto=' + encodeURIComponent(oferta.produto || oferta.titulo) +
        '&titulo=' + encodeURIComponent(oferta.titulo || ''));
    } catch (e) {
      toast(e.message, true);
      return;
    }
    renderAnalise(dados);
    mostrar('analise');
  }

  /* Rotulos e explicacoes da classificacao feita pela IA na base. */
  const SITUACAO = {
    'Boa Compra': 'situacao.boa',
    'Preço Médio': 'situacao.media',
    'Sem Histórico (Novo)': 'situacao.novo',
    'Evitar': 'situacao.evitar',
    'Anomalia (Isolada por IA)': 'situacao.anomalia',
  };

  function renderAnalise(d) {
    const pct = (v) => (v > 0 ? '+' : '') + pctFmt(v);
    const titulo = (d.oferta && d.oferta.titulo) || d.produto;
    const est = d.estatisticas;

    $('#an-titulo').textContent = curto(titulo, 90);
    $('#an-sub').textContent = t('analise.resumoSub', { n: est.ofertas, lojas: d.lojas.length });

    $('#an-preco').textContent = dinheiro(d.oferta.preco);
    $('#an-preco-sub').textContent = d.oferta.loja;

    $('#an-referencia').textContent = d.referencia > 0 ? dinheiro(d.referencia) : '—';
    $('#an-referencia-sub').textContent = d.referencia > 0 ? t('analise.referenciaSub') : t('analise.semReferencia');

    const variacao = $('#an-variacao');
    variacao.textContent = d.referencia > 0 ? pct(d.variacao_pct) : '—';
    variacao.className = d.variacao_pct < 0 ? 'positivo' : (d.variacao_pct > 0 ? 'negativo' : '');
    $('#an-variacao-sub').textContent = t('analise.variacaoSub');

    $('#an-situacao').textContent = t(SITUACAO[d.situacao] || 'situacao.media');
    $('#an-situacao-sub').textContent = t((SITUACAO[d.situacao] || 'situacao.media') + '.dica');

    // faixa de precos: onde a oferta cai entre o menor e o maior preco do produto
    const amplitude = est.maior - est.menor;
    const pos = amplitude > 0 ? ((d.oferta.preco - est.menor) / amplitude) * 100 : 50;
    $('#an-marcador').style.left = pos.toFixed(1) + '%';
    $('#an-min').textContent = t('analise.menorDe') + ' ' + dinheiro(est.menor);
    $('#an-max').textContent = dinheiro(est.maior) + ' ' + t('analise.maiorDe');
    $('#an-pos').textContent = t('analise.maisBaratoQue', { pct: pctFmt(est.posicao_pct) });

    const stats = [
      [t('analise.mediana'), dinheiro(est.mediana)],
      [t('analise.media'), dinheiro(est.media)],
      [t('analise.ofertasTotal'), String(est.ofertas)],
      [t('analise.lojasTotal'), String(d.lojas.length)],
    ];
    $('#an-stats').innerHTML = '';
    stats.forEach(([rotulo, valor]) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', rotulo));
      tr.appendChild(el('td', 'dir num', valor));
      $('#an-stats').appendChild(tr);
    });

    const acompanhado = produtoDaOferta(d.oferta);
    $('#an-historico-texto').textContent = acompanhado
      ? t('analise.historicoAcompanhado')
      : t('analise.historicoVazio');
    const btnAcomp = $('#an-acompanhado');
    btnAcomp.classList.toggle('oculto', !acompanhado);
    btnAcomp.onclick = acompanhado ? () => abrirDetalhe(acompanhado.id) : null;

    const tbLojas = $('#an-lojas');
    tbLojas.innerHTML = '';
    d.lojas.forEach((l) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'ticker', l.loja));
      tr.appendChild(celula(String(l.ofertas), 'cen'));
      tr.appendChild(celula(dinheiro(l.menor), 'cen positivo'));
      tr.appendChild(celula(dinheiro(l.mediana), 'cen'));
      tr.appendChild(celula(dinheiro(l.maior), 'cen'));
      tbLojas.appendChild(tr);
    });

    const tbOfertas = $('#an-ofertas');
    tbOfertas.innerHTML = '';
    d.ofertas.forEach((o) => {
      const tr = el('tr', o.titulo === d.oferta.titulo && o.loja === d.oferta.loja ? 'melhor-linha' : '');
      tr.appendChild(celula(o.loja, 'ticker'));
      const td = el('td', 'titulo-oferta');
      const a = link(curto(o.titulo, 60), o.url);
      a.title = o.titulo;
      td.appendChild(a);
      tr.appendChild(td);
      tr.appendChild(celula(dinheiro(o.preco), 'cen'));
      const v = o.referencia > 0 ? o.variacao : null;
      tr.appendChild(celula(v === null ? '—' : pct(v), 'cen ' + (v < 0 ? 'positivo' : (v > 0 ? 'negativo' : ''))));
      tr.appendChild(celula(t(SITUACAO[o.situacao] || 'situacao.media'), 'cen'));
      const acao = el('td', 'dir');
      if (o.url) acao.appendChild(link(t('tabela.comprar'), o.url, 'mini-botao botao-acao'));
      tr.appendChild(acao);
      tbOfertas.appendChild(tr);
    });
  }

  $('#an-voltar').addEventListener('click', () => mostrar('busca'));

  function botaoAnalise(oferta, classe) {
    const b = el('button', 'btn analise' + (classe ? ' ' + classe : ''));
    b.type = 'button';
    b.innerHTML = ICONE_ANALISE;
    b.appendChild(document.createTextNode(t('res.analise')));
    b.title = t('res.analiseDica');
    b.addEventListener('click', () => abrirAnalise(oferta));
    return b;
  }

  function cartaoOferta(o, i, campeao) {
    const venceu = o === campeao;
    const cartao = el('article', 'card' + (venceu ? ' win' : ''));
    cartao.style.animationDelay = (i * 30) + 'ms';

    const topo = el('div', 'card-top');
    topo.appendChild(seloLoja(o.loja));
    topo.appendChild(marcaDesconto(o, venceu));
    cartao.appendChild(topo);

    const titulo = el('h3');
    if (o.url) {
      const a = link(o.titulo || t('tabela.verAnuncio'), o.url);
      a.title = o.titulo || '';
      titulo.appendChild(a);
    } else {
      titulo.textContent = o.titulo || '';
    }
    cartao.appendChild(titulo);

    const precos = el('div', 'price-box');
    precos.appendChild(blocoPreco(o));
    precos.appendChild(el('span', 'cond', t('condicao.' + o.condicao) || o.condicao));
    cartao.appendChild(precos);

    const acoes = el('div', 'card-acoes');
    acoes.appendChild(botaoAnalise(o));
    acoes.appendChild(botaoLoja(o, 'btn go'));
    cartao.appendChild(acoes);
    return cartao;
  }

  function linhaOferta(o, i, campeao) {
    const venceu = o === campeao;
    const linha = el('div', 'row' + (venceu ? ' win' : ''));
    linha.style.animationDelay = (i * 20) + 'ms';

    const loja = seloLoja(o.loja);
    loja.classList.add('s');
    linha.appendChild(loja);

    if (o.url) {
      const a = link(o.titulo || t('tabela.verAnuncio'), o.url, 't');
      a.title = o.titulo || '';
      linha.appendChild(a);
    } else {
      linha.appendChild(el('span', 't', o.titulo || ''));
    }

    const precos = blocoPreco(o);
    precos.className = 'p';
    linha.appendChild(precos);

    const marca = marcaDesconto(o, venceu, true);
    marca.classList.add('d');
    linha.appendChild(marca);

    const acao = el('span', 'a');
    acao.appendChild(botaoAnalise(o));
    acao.appendChild(botaoLoja(o, 'btn go'));
    linha.appendChild(acao);
    return linha;
  }

  /* ---------- controles fixos da barra de ferramentas ---------- */
  function montarControles() {
    $('#filtro-preco').addEventListener('change', (e) => {
      filtros.preco = e.target.value; pagina = 1; aplicarFiltros();
    });
    $('#filtro-ordem').addEventListener('change', (e) => {
      ordem = e.target.value; pagina = 1; aplicarFiltros();
    });
    $('#filtro-marca').addEventListener('change', (e) => {
      filtros.marca = e.target.value; pagina = 1; aplicarFiltros();
    });
    $('#filtro-categoria').addEventListener('change', (e) => {
      filtros.categoria = e.target.value; pagina = 1; aplicarFiltros();
    });

    const mais = $('#btn-mais-filtros');
    const caixaMais = $('#mais-filtros');
    mais.addEventListener('click', () => {
      const aberto = caixaMais.classList.toggle('aberto');
      mais.setAttribute('aria-expanded', String(aberto));
      mais.setAttribute('aria-pressed', String(aberto));
    });

    $('#btn-limpar').addEventListener('click', () => {
      filtros = { marca: '', categoria: '', loja: '', preco: '' };
      ordem = 'preco';
      pagina = 1;
      montarFiltros();
      aplicarFiltros();
    });

    const grade = $('#ver-grade');
    const emLista = $('#ver-lista');
    const trocarVista = (nova) => {
      vista = nova;
      grade.setAttribute('aria-pressed', String(nova === 'grade'));
      emLista.setAttribute('aria-pressed', String(nova === 'lista'));
      renderPagina();
    };
    grade.addEventListener('click', () => trocarVista('grade'));
    emLista.addEventListener('click', () => trocarVista('lista'));

    // o topo preto ganha sombra quando a pagina rola
    window.addEventListener('scroll', () => {
      $('#topo').classList.toggle('rolou', window.scrollY > 4);
    }, { passive: true });
  }
  montarControles();

  /* ---------- cartao de veredito (tela de produto acompanhado) ---------- */
  function cartaoMelhor(comparacao, busca) {
    const melhor = comparacao.melhor;
    const cartao = el('section', 'painel veredito bom');

    const topo = el('div', 'veredito-topo');
    const esq = el('div');
    esq.appendChild(el('h2', '', t('veredito.melhor', { loja: melhor.loja })));
    esq.appendChild(el('p', 'veredito-preco', dinheiro(melhor.preco_total)));

    const detalhes = [];
    if (melhor.frete > 0) detalhes.push(t('veredito.freteIncluso', { valor: dinheiro(melhor.frete) }));
    else detalhes.push(t('veredito.freteGratis'));
    if (melhor.condicao !== 'novo') detalhes.push(t('veredito.condicao', { condicao: t('condicao.' + melhor.condicao) }));
    if (melhor.parcelas > 0) detalhes.push(t('veredito.parcelas', { n: melhor.parcelas }));
    esq.appendChild(el('small', 'neutro', detalhes.join(' · ')));

    if (melhor.titulo) esq.appendChild(el('p', 'anuncio-titulo', melhor.titulo));
    if (melhor.url) esq.appendChild(link(t('veredito.comprar'), melhor.url, 'botao primario comprar'));
    topo.appendChild(esq);

    const dir = el('div', 'ranking-lado');
    if (comparacao.ranking.length > 1) {
      dir.appendChild(el('h3', '', t('veredito.comparacao')));
      dir.appendChild(barrasDeLojas(comparacao.ranking));
    }
    topo.appendChild(dir);
    cartao.appendChild(topo);

    if (comparacao.economia > 0) {
      cartao.appendChild(el('p', 'economia', t('veredito.economia', {
        valor: dinheiro(comparacao.economia),
        pct: pctFmt(comparacao.economia_pct),
      })));
    } else if (comparacao.mesmo_produto === false) {
      cartao.appendChild(el('p', 'dica', t('veredito.modelosDiferentes')));
    }

    const maisBarato = comparacao.mais_barato;
    if (maisBarato && maisBarato.preco_total < melhor.preco_total) {
      cartao.appendChild(el('p', 'dica', t('veredito.maisBarato', {
        valor: dinheiro(maisBarato.preco_total),
        loja: maisBarato.loja,
      })));
    }

    if (busca && busca.atualizado_em) {
      cartao.appendChild(el('small', 'neutro rodape-busca',
        t('veredito.consulta', { data: dataHora(busca.atualizado_em) }) +
        (busca.origem ? t('veredito.origem', { origem: busca.origem }) : '')));
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
      const valorLoja = el('span', 'barra-valor');
      if (o.url) valorLoja.appendChild(link(dinheiro(o.preco_total) + ' ↗', o.url));
      else valorLoja.textContent = dinheiro(o.preco_total);
      li.appendChild(valorLoja);
      ul.appendChild(li);
    });
    return ul;
  }

  async function carregarSugestoes() {
    try {
      const populares = await pedir('/api/buscas/populares');
      const caixa = $('#sugestoes');
      caixa.innerHTML = '';
      if (!populares.length) return;
      caixa.appendChild(el('span', 'sugestoes-titulo', t('busca.recentes')));
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

      tr.appendChild(el('td', 'dir'));

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
    const maisBarata = d.ofertas.slice().sort((a, b) => a.preco_total - b.preco_total)[0];
    renderCartoes($('#det-ofertas'), d.ofertas, maisBarata, true, {
      titulo: 'Nenhuma oferta coletada ainda',
      texto: 'Use "Atualizar preços agora" para consultar as lojas e começar o histórico.',
    });
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

  /* ================= IDIOMA ================= */
  function montarSeletorIdioma() {
    const botao = $('#idioma-botao');
    const lista = $('#idioma-lista');
    if (!botao || !lista) return;

    const nomeDe = (codigo) => (I18N.disponiveis.find(([c]) => c === codigo) || [, ''])[1];

    const desenharBotao = () => {
      const atual = I18N.idioma();
      botao.innerHTML = I18N.bandeiras[atual] + '<span>' + nomeDe(atual) + '</span><span class="seta">▾</span>';
    };

    const fechar = () => {
      lista.classList.add('oculto');
      botao.setAttribute('aria-expanded', 'false');
    };

    lista.innerHTML = '';
    I18N.disponiveis.forEach(([codigo, nome]) => {
      const item = document.createElement('li');
      const opcao = document.createElement('button');
      opcao.type = 'button';
      opcao.className = 'idioma-opcao' + (codigo === I18N.idioma() ? ' ativa' : '');
      opcao.setAttribute('role', 'option');
      opcao.innerHTML = I18N.bandeiras[codigo] + '<span>' + nome + '</span>';
      opcao.addEventListener('click', () => {
        I18N.definir(codigo);
        lista.querySelectorAll('.idioma-opcao').forEach((b, i) => {
          b.classList.toggle('ativa', I18N.disponiveis[i][0] === codigo);
        });
        desenharBotao();
        fechar();
      });
      item.appendChild(opcao);
      lista.appendChild(item);
    });

    desenharBotao();

    botao.addEventListener('click', (e) => {
      e.stopPropagation();
      const aberto = !lista.classList.contains('oculto');
      lista.classList.toggle('oculto', aberto);
      botao.setAttribute('aria-expanded', String(!aberto));
    });

    document.addEventListener('click', fechar);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fechar(); });
  }

  // ao trocar de idioma, redesenha o que foi montado por JavaScript
  document.addEventListener('idioma-mudou', () => {
    escreverFrase();
    carregarSugestoes();
    // o titulo e a linha de data tambem sao texto montado por aqui
    if (buscaAtual) montarIntro(buscaAtual);
    if (ofertasDaBusca.length) { montarFiltros(); aplicarFiltros(); }
    if (detalhe) renderDetalhe();
  });

  /* ================= INICIO ================= */
  (async function iniciar() {
    I18N.traduzirPagina();
    montarSeletorIdioma();

    await carregarProdutos();
    carregarSugestoes();
    escreverFrase();
    // /metricas abre direto o painel de operacao; o resto e a busca
    mostrar(location.pathname.replace(/\/+$/, '') === '/metricas' ? 'metricas' : 'busca');
    $('#campo-busca').focus();
  })();

  return { pedir, toast, buscar };
})();
