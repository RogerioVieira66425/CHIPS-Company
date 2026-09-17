'use strict';
/* Laboratorio: onde voce monta suas telas e, quando estiver pronta, publica como tela oficial. */

const Lab = (function () {
  let telas = [];
  let editando = null;      // copia local da tela em edicao
  let salvoEm = null;       // JSON da ultima versao salva
  let aoMudar = () => {};   // avisa o app para atualizar o menu

  const $ = (s) => document.querySelector(s);
  const el = (tag, classe, texto) => {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto;
    return e;
  };

  const CLASSES = ['Ações', 'FIIs', 'Renda Fixa', 'ETF', 'BDR', 'Cripto', 'Exterior', 'Outros'];

  const MODELOS = {
    kpi: { titulo: 'Patrimônio', tamanho: 'p', opcoes: { metrica: 'patrimonio', classe: 'todas' } },
    rosca: { titulo: 'Alocação', tamanho: 'm', opcoes: { agrupar: 'classe', campo: 'valor_atual' } },
    barras: { titulo: 'Maiores posições', tamanho: 'm', opcoes: { agrupar: 'ativo', campo: 'valor_atual', limite: 10 } },
    tabela: { titulo: 'Carteira', tamanho: 'g', opcoes: { colunas: ['ticker', 'classe', 'quantidade', 'preco_medio', 'valor_atual', 'lucro', 'rentabilidade'], ordenar: 'valor_atual', classe: 'todas' } },
    lancamentos: { titulo: 'Últimos lançamentos', tamanho: 'm', opcoes: { limite: 10, tipo: 'todos' } },
    metas: { titulo: 'Metas de alocação', tamanho: 'm', opcoes: { metas: 'Ações: 50\nFIIs: 30\nRenda Fixa: 20' } },
    texto: { titulo: 'Anotação', tamanho: 'm', opcoes: { corpo: 'Escreva aqui suas regras, lembretes ou a tese da carteira.' } },
    livre: {
      titulo: 'Meu bloco',
      tamanho: 'g',
      opcoes: {
        altura: 320,
        html: '<h3>Olá!</h3>\n<div id="saida"></div>',
        css: 'h3 { color: #4c8dff; }',
        js: 'const t = dados.carteira.totais;\ndocument.getElementById("saida").innerHTML =\n  "Você tem " + dados.carteira.posicoes.length + " ativos, somando " + dinheiro(t.patrimonio) + ".";',
      },
    },
  };

  /* ---------- estado ---------- */
  function sujo() {
    return editando && JSON.stringify(editando) !== salvoEm;
  }

  function marcarSalvo() {
    salvoEm = JSON.stringify(editando);
    atualizarBotoes();
  }

  async function carregar() {
    telas = await App.pedir('/api/telas');
    return telas;
  }

  const lista = () => telas;
  const oficiais = () => telas.filter((t) => t.status === 'oficial');
  const telaInicial = () => oficiais().find((t) => t.inicial) || null;

  /* ---------- tela do laboratorio ---------- */
  function render() {
    renderListaTelas();
    renderEditor();
  }

  function renderListaTelas() {
    const ul = $('#lab-telas');
    ul.innerHTML = '';
    if (!telas.length) {
      ul.appendChild(el('li', 'vazio', 'Nenhuma tela ainda. Crie a primeira!'));
      return;
    }
    telas.forEach((t) => {
      const li = el('li', 'item-tela' + (editando && editando.id === t.id ? ' ativa' : ''));
      const botao = el('button', 'item-tela-nome');
      botao.appendChild(el('b', '', t.nome));
      const etiqueta = el('span', 'etiqueta ' + (t.status === 'oficial' ? 'oficial' : ''), t.status === 'oficial' ? (t.inicial ? 'oficial · inicial' : 'oficial') : 'rascunho');
      botao.appendChild(etiqueta);
      botao.appendChild(el('small', '', (t.config.blocos || []).length + ' bloco(s)'));
      botao.addEventListener('click', () => abrir(t.id));
      li.appendChild(botao);
      ul.appendChild(li);
    });
  }

  function abrir(id) {
    if (sujo() && !confirm('Você tem alterações não salvas. Descartar?')) return;
    const t = telas.find((x) => x.id === id);
    if (!t) return;
    editando = JSON.parse(JSON.stringify(t));
    salvoEm = JSON.stringify(editando);
    render();
  }

  async function nova() {
    const nome = prompt('Nome da nova tela:', 'Minha tela');
    if (!nome) return;
    const t = await App.pedir('/api/telas', { method: 'POST', body: { nome } });
    telas.push(t);
    editando = JSON.parse(JSON.stringify(t));
    salvoEm = JSON.stringify(editando);
    App.toast('Tela criada. Agora é só adicionar blocos.');
    aoMudar();
    render();
  }

  function renderEditor() {
    const area = $('#lab-editor');
    const vazio = $('#lab-sem-tela');
    if (!editando) {
      area.classList.add('oculto');
      vazio.classList.remove('oculto');
      return;
    }
    area.classList.remove('oculto');
    vazio.classList.add('oculto');

    $('#lab-nome').value = editando.nome;
    $('#lab-descricao').value = editando.descricao || '';
    atualizarBotoes();
    renderBlocos();
    previa();
  }

  function atualizarBotoes() {
    if (!editando) return;
    $('#lab-salvar').textContent = sujo() ? 'Salvar alterações •' : 'Salvar alterações';
    const oficial = editando.status === 'oficial';
    $('#lab-publicar').textContent = oficial ? 'Voltar para rascunho' : 'Publicar como tela oficial';
    $('#lab-publicar').classList.toggle('primario', !oficial);
    $('#lab-inicial').classList.toggle('oculto', !oficial);
    $('#lab-inicial').textContent = editando.inicial ? '★ É a tela inicial' : '☆ Definir como tela inicial';
    $('#lab-status').textContent = oficial ? (editando.inicial ? 'Oficial · abre ao entrar' : 'Oficial · aparece no menu') : 'Rascunho · só você vê aqui';
    $('#lab-status').className = 'etiqueta ' + (oficial ? 'oficial' : '');
  }

  /* ---------- blocos ---------- */
  function renderBlocos() {
    const ul = $('#lab-blocos');
    ul.innerHTML = '';
    const blocos = editando.config.blocos || [];
    if (!blocos.length) {
      ul.appendChild(el('li', 'vazio', 'Sem blocos. Use "Adicionar bloco" para começar.'));
      return;
    }
    blocos.forEach((bloco, i) => ul.appendChild(cartaoBloco(bloco, i, blocos.length)));
  }

  function cartaoBloco(bloco, indice, total) {
    const li = el('li', 'cartao-bloco');

    const cabecalho = el('div', 'cartao-topo');
    const info = el('div', 'cartao-info');
    info.appendChild(el('b', '', bloco.titulo || Blocos.CATALOGO[bloco.tipo].nome));
    info.appendChild(el('small', '', Blocos.CATALOGO[bloco.tipo].nome));
    cabecalho.appendChild(info);

    const acoes = el('div', 'cartao-acoes');
    const btnCima = el('button', 'mini', '▲');
    btnCima.title = 'Mover para cima';
    btnCima.disabled = indice === 0;
    btnCima.addEventListener('click', () => mover(indice, -1));
    const btnBaixo = el('button', 'mini', '▼');
    btnBaixo.title = 'Mover para baixo';
    btnBaixo.disabled = indice === total - 1;
    btnBaixo.addEventListener('click', () => mover(indice, 1));
    const btnCopiar = el('button', 'mini', '⧉');
    btnCopiar.title = 'Duplicar bloco';
    btnCopiar.addEventListener('click', () => {
      const copia = JSON.parse(JSON.stringify(bloco));
      copia.id = 'b' + Date.now();
      editando.config.blocos.splice(indice + 1, 0, copia);
      mudou();
    });
    const btnRemover = el('button', 'mini', '🗑');
    btnRemover.title = 'Remover bloco';
    btnRemover.addEventListener('click', () => {
      if (!confirm('Remover este bloco?')) return;
      editando.config.blocos.splice(indice, 1);
      mudou();
    });
    [btnCima, btnBaixo, btnCopiar, btnRemover].forEach((b) => acoes.appendChild(b));
    cabecalho.appendChild(acoes);
    li.appendChild(cabecalho);

    li.appendChild(camposDoBloco(bloco));
    return li;
  }

  function mover(indice, passo) {
    const blocos = editando.config.blocos;
    const destino = indice + passo;
    if (destino < 0 || destino >= blocos.length) return;
    const [b] = blocos.splice(indice, 1);
    blocos.splice(destino, 0, b);
    mudou();
  }

  function mudou() {
    renderBlocos();
    previa();
    atualizarBotoes();
  }

  /* --- construtores de campos --- */
  function campo(rotulo, controle) {
    const label = el('label', '', rotulo);
    label.appendChild(controle);
    return label;
  }

  function entrada(valor, aoEditar, tipo) {
    const i = document.createElement('input');
    i.type = tipo || 'text';
    i.value = valor === undefined || valor === null ? '' : valor;
    i.addEventListener('input', () => aoEditar(i.value));
    return i;
  }

  function areaTexto(valor, aoEditar, linhas) {
    const t = document.createElement('textarea');
    t.rows = linhas || 4;
    t.value = valor || '';
    t.addEventListener('input', () => aoEditar(t.value));
    return t;
  }

  function selecao(opcoes, valor, aoEditar) {
    const s = document.createElement('select');
    opcoes.forEach(([v, texto]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = texto;
      s.appendChild(o);
    });
    s.value = valor;
    s.addEventListener('change', () => aoEditar(s.value));
    return s;
  }

  const listaClasses = () => [['todas', 'Todas as classes']].concat(CLASSES.map((c) => [c, c]));

  function camposDoBloco(bloco) {
    const caixa = el('div', 'cartao-campos');
    const o = bloco.opcoes;
    const set = (chave, valor) => { o[chave] = valor; previa(); atualizarBotoes(); };

    const linha1 = el('div', 'linha');
    linha1.appendChild(campo('Título', entrada(bloco.titulo, (v) => { bloco.titulo = v; previa(); atualizarBotoes(); })));
    linha1.appendChild(campo('Largura', selecao([['p', 'Pequeno (1/3)'], ['m', 'Médio (1/2)'], ['g', 'Grande (tela toda)']], bloco.tamanho, (v) => { bloco.tamanho = v; previa(); atualizarBotoes(); })));
    caixa.appendChild(linha1);

    if (bloco.tipo === 'kpi') {
      const linha = el('div', 'linha');
      linha.appendChild(campo('Indicador', selecao(Object.entries(Blocos.METRICAS), o.metrica || 'patrimonio', (v) => set('metrica', v))));
      linha.appendChild(campo('Filtrar classe', selecao(listaClasses(), o.classe || 'todas', (v) => set('classe', v))));
      caixa.appendChild(linha);
      caixa.appendChild(campo('Legenda (opcional)', entrada(o.legenda, (v) => set('legenda', v))));
    }

    if (bloco.tipo === 'rosca' || bloco.tipo === 'barras') {
      const linha = el('div', 'linha');
      linha.appendChild(campo('Agrupar por', selecao([['classe', 'Classe'], ['ativo', 'Ativo']], o.agrupar || 'classe', (v) => set('agrupar', v))));
      linha.appendChild(campo('Medida', selecao([
        ['valor_atual', 'Valor atual'],
        ['custo', 'Total investido'],
        ['lucro', 'Lucro / prejuízo'],
        ['proventos', 'Proventos'],
      ].concat(bloco.tipo === 'barras' ? [['rentabilidade', 'Rentabilidade %']] : []), o.campo || 'valor_atual', (v) => set('campo', v))));
      caixa.appendChild(linha);
      const linha2 = el('div', 'linha');
      linha2.appendChild(campo('Filtrar classe', selecao(listaClasses(), o.classe || 'todas', (v) => set('classe', v))));
      if (bloco.tipo === 'barras') linha2.appendChild(campo('Quantas barras', entrada(o.limite || 10, (v) => set('limite', v), 'number')));
      caixa.appendChild(linha2);
    }

    if (bloco.tipo === 'tabela') {
      caixa.appendChild(el('span', 'rotulo-campo', 'Colunas'));
      const grade = el('div', 'caixa-colunas');
      Object.entries(Blocos.COLUNAS).forEach(([chave, nome]) => {
        const l = el('label', 'check');
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = (o.colunas || []).indexOf(chave) !== -1;
        c.addEventListener('change', () => {
          const atuais = new Set(o.colunas || []);
          if (c.checked) atuais.add(chave); else atuais.delete(chave);
          set('colunas', Object.keys(Blocos.COLUNAS).filter((k) => atuais.has(k)));
        });
        l.appendChild(c);
        l.appendChild(el('span', '', nome));
        grade.appendChild(l);
      });
      caixa.appendChild(grade);
      const linha = el('div', 'linha');
      linha.appendChild(campo('Ordenar por', selecao([
        ['valor_atual', 'Valor atual'], ['custo', 'Investido'], ['lucro', 'Lucro'], ['rentabilidade', 'Rentabilidade'], ['quantidade', 'Quantidade'],
      ], o.ordenar || 'valor_atual', (v) => set('ordenar', v))));
      linha.appendChild(campo('Filtrar classe', selecao(listaClasses(), o.classe || 'todas', (v) => set('classe', v))));
      caixa.appendChild(linha);
    }

    if (bloco.tipo === 'lancamentos') {
      const linha = el('div', 'linha');
      linha.appendChild(campo('Tipo', selecao([['todos', 'Todos'], ['compra', 'Compras'], ['venda', 'Vendas'], ['provento', 'Proventos']], o.tipo || 'todos', (v) => set('tipo', v))));
      linha.appendChild(campo('Quantos', entrada(o.limite || 10, (v) => set('limite', v), 'number')));
      caixa.appendChild(linha);
      caixa.appendChild(campo('Filtrar classe', selecao(listaClasses(), o.classe || 'todas', (v) => set('classe', v))));
    }

    if (bloco.tipo === 'metas') {
      caixa.appendChild(campo('Metas (uma por linha: Classe: %)', areaTexto(o.metas, (v) => set('metas', v), 4)));
    }

    if (bloco.tipo === 'texto') {
      caixa.appendChild(campo('Texto', areaTexto(o.corpo, (v) => set('corpo', v), 4)));
    }

    if (bloco.tipo === 'livre') {
      const aviso = el('p', 'dica', 'Você recebe a variável dados (dados.carteira.posicoes, dados.carteira.totais, dados.transacoes) e a função dinheiro(valor). O código roda isolado, só dentro deste bloco.');
      caixa.appendChild(aviso);
      caixa.appendChild(campo('HTML', areaTexto(o.html, (v) => set('html', v), 5)));
      caixa.appendChild(campo('CSS', areaTexto(o.css, (v) => set('css', v), 3)));
      caixa.appendChild(campo('JavaScript', areaTexto(o.js, (v) => set('js', v), 6)));
      caixa.appendChild(campo('Altura (px)', entrada(o.altura || 320, (v) => set('altura', v), 'number')));
    }

    return caixa;
  }

  /* ---------- previa ---------- */
  function previa() {
    if (!editando) return;
    Blocos.renderizarTela(editando, App.dados(), $('#lab-previa'));
  }

  /* ---------- acoes ---------- */
  async function salvar(silencioso) {
    if (!editando) return;
    editando.nome = $('#lab-nome').value.trim() || editando.nome;
    editando.descricao = $('#lab-descricao').value;
    const salva = await App.pedir('/api/telas/' + editando.id, {
      method: 'PATCH',
      body: { nome: editando.nome, descricao: editando.descricao, config: editando.config },
    });
    const i = telas.findIndex((t) => t.id === salva.id);
    if (i !== -1) telas[i] = salva;
    editando = JSON.parse(JSON.stringify(salva));
    marcarSalvo();
    renderListaTelas();
    aoMudar();
    if (!silencioso) App.toast('Tela salva.');
  }

  async function publicar() {
    if (!editando) return;
    await salvar(true);
    const novoStatus = editando.status === 'oficial' ? 'rascunho' : 'oficial';
    const salva = await App.pedir('/api/telas/' + editando.id, { method: 'PATCH', body: { status: novoStatus } });
    const i = telas.findIndex((t) => t.id === salva.id);
    if (i !== -1) telas[i] = salva;
    editando = JSON.parse(JSON.stringify(salva));
    marcarSalvo();
    render();
    aoMudar();
    App.toast(novoStatus === 'oficial' ? '“' + salva.nome + '” agora é uma tela oficial, veja no menu.' : 'Tela voltou para rascunho.');
  }

  async function definirInicial() {
    if (!editando || editando.status !== 'oficial') return;
    const salva = await App.pedir('/api/telas/' + editando.id, { method: 'PATCH', body: { inicial: !editando.inicial } });
    telas = await App.pedir('/api/telas');
    editando = JSON.parse(JSON.stringify(salva));
    marcarSalvo();
    render();
    aoMudar();
    App.toast(salva.inicial ? 'Esta tela abre ao entrar no sistema.' : 'Tela inicial voltou a ser o Painel.');
  }

  async function duplicar() {
    if (!editando) return;
    const nova_ = await App.pedir('/api/telas/' + editando.id + '/duplicar', { method: 'POST' });
    telas.push(nova_);
    editando = JSON.parse(JSON.stringify(nova_));
    marcarSalvo();
    render();
    aoMudar();
    App.toast('Cópia criada como rascunho.');
  }

  async function excluir() {
    if (!editando) return;
    if (!confirm('Excluir a tela “' + editando.nome + '”? Isso não pode ser desfeito.')) return;
    await App.pedir('/api/telas/' + editando.id, { method: 'DELETE' });
    telas = telas.filter((t) => t.id !== editando.id);
    editando = null;
    salvoEm = null;
    render();
    aoMudar();
    App.toast('Tela excluída.');
  }

  function adicionarBloco(tipo) {
    if (!editando) { App.toast('Crie ou escolha uma tela primeiro.', true); return; }
    const modelo = MODELOS[tipo];
    editando.config.blocos.push({
      id: 'b' + Date.now(),
      tipo,
      titulo: modelo.titulo,
      tamanho: modelo.tamanho,
      opcoes: JSON.parse(JSON.stringify(modelo.opcoes)),
    });
    mudou();
    $('#lab-blocos').lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------- ligacao com a pagina ---------- */
  function iniciar(callbackMudanca) {
    aoMudar = callbackMudanca || (() => {});

    const paleta = $('#lab-paleta');
    Object.entries(Blocos.CATALOGO).forEach(([tipo, info]) => {
      const b = el('button', 'item-paleta');
      b.appendChild(el('b', '', info.nome));
      b.appendChild(el('small', '', info.dica));
      b.addEventListener('click', () => adicionarBloco(tipo));
      paleta.appendChild(b);
    });

    $('#lab-nova').addEventListener('click', () => nova().catch((e) => App.toast(e.message, true)));
    $('#lab-salvar').addEventListener('click', () => salvar().catch((e) => App.toast(e.message, true)));
    $('#lab-publicar').addEventListener('click', () => publicar().catch((e) => App.toast(e.message, true)));
    $('#lab-inicial').addEventListener('click', () => definirInicial().catch((e) => App.toast(e.message, true)));
    $('#lab-duplicar').addEventListener('click', () => duplicar().catch((e) => App.toast(e.message, true)));
    $('#lab-excluir').addEventListener('click', () => excluir().catch((e) => App.toast(e.message, true)));
    $('#lab-nome').addEventListener('input', () => { editando.nome = $('#lab-nome').value; atualizarBotoes(); });
    $('#lab-descricao').addEventListener('input', () => { editando.descricao = $('#lab-descricao').value; atualizarBotoes(); });

    window.addEventListener('beforeunload', (e) => {
      if (sujo()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  return { iniciar, carregar, render, previa, lista, oficiais, telaInicial, abrir };
})();
