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

  let produtos = [];
  let fontes = [];
  let detalhe = null;
  let usuarioAtual = null;
  let vistaAtual = { tipo: 'produtos', id: null };

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

  const el = (tag, classe, texto) => {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto;
    return e;
  };
  const celula = (texto, classe) => el('td', classe, texto);

  /* ---------- login ---------- */
  document.querySelectorAll('.aba').forEach((aba) => {
    aba.addEventListener('click', () => {
      document.querySelectorAll('.aba').forEach((a) => a.classList.toggle('ativa', a === aba));
      $('#form-entrar').classList.toggle('oculto', aba.dataset.aba !== 'entrar');
      $('#form-criar').classList.toggle('oculto', aba.dataset.aba !== 'criar');
      $('#aviso-login').classList.add('oculto');
    });
  });

  function erroLogin(msg) {
    const e = $('#aviso-login');
    e.textContent = msg;
    e.classList.remove('oculto');
  }

  $('#form-entrar').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const u = await pedir('/api/login', { method: 'POST', body: dadosForm(e.target) });
      e.target.reset();
      abrirApp(u);
    } catch (err) { erroLogin(err.message); }
  });

  $('#form-criar').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const u = await pedir('/api/registrar', { method: 'POST', body: dadosForm(e.target) });
      e.target.reset();
      abrirApp(u);
    } catch (err) { erroLogin(err.message); }
  });

  $('#btn-sair').addEventListener('click', async () => {
    await pedir('/api/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  async function abrirApp(usuario) {
    usuarioAtual = usuario;
    $('#tela-login').classList.add('oculto');
    $('#app').classList.remove('oculto');
    $('#ola').textContent = usuario.nome + (usuario.admin ? ' (admin)' : '');
    $('#ola').title = usuario.email;
    fontes = await pedir('/api/fontes').catch(() => []);
    await carregarProdutos();
    mostrar({ tipo: 'produtos' });
    verificarFontes();
  }

  /* ---------- navegacao ---------- */
  function renderMenu() {
    const menu = $('#menu');
    menu.innerHTML = '';
    const botao = (rotulo, vista) => {
      const b = el('button', 'item-menu' + (vistaAtual.tipo === vista.tipo ? ' ativo' : ''), rotulo);
      b.addEventListener('click', () => mostrar(vista));
      return b;
    };
    menu.appendChild(botao('Produtos', { tipo: 'produtos' }));
    if (usuarioAtual && usuarioAtual.admin) menu.appendChild(botao('⚙️ Admin', { tipo: 'admin' }));
  }

  function mostrar(vista) {
    vistaAtual = { tipo: vista.tipo, id: vista.id || null };
    $('#vista-produtos').classList.toggle('oculto', vista.tipo !== 'produtos');
    $('#vista-detalhe').classList.toggle('oculto', vista.tipo !== 'detalhe');
    $('#vista-admin').classList.toggle('oculto', vista.tipo !== 'admin');
    if (vista.tipo === 'admin') carregarAdmin().catch((e) => toast(e.message, true));
    renderMenu();
    window.scrollTo({ top: 0 });
  }

  /* Se o servidor nao alcanca nenhuma loja (bloqueio de IP), avisa e explica o agente local. */
  async function verificarFontes() {
    try {
      const d = await pedir('/api/diagnostico');
      const alcancaveis = d.fontes.filter((f) => f.ok);
      const aviso = $('#aviso-coleta');
      if (alcancaveis.length) { aviso.classList.add('oculto'); return; }
      aviso.classList.remove('oculto');
      aviso.innerHTML = '';
      aviso.appendChild(el('b', '', 'As lojas bloqueiam consultas vindas deste servidor.'));
      aviso.appendChild(el('p', '', 'O botao “Atualizar precos” vai falhar: KaBuM! e Mercado Livre recusam requisicoes de servidores de nuvem no exterior. Rode o agente coletor no seu computador (rede brasileira) para alimentar o historico:'));
      const cmd = el('code', 'comando', 'npm run coletar');
      aviso.appendChild(cmd);
      aviso.appendChild(el('small', '', 'Detalhes em /api/diagnostico e no README do projeto.'));
    } catch (e) { /* diagnostico e opcional */ }
  }

  /* ---------- lista de produtos ---------- */
  async function carregarProdutos() {
    produtos = await pedir('/api/produtos');
    renderKpis();
    renderProdutos();
  }

  function renderKpis() {
    $('#kpi-produtos').textContent = produtos.length;
    $('#kpi-ofertas').textContent = produtos.reduce((t, p) => t + p.ofertas, 0);

    const configuradas = fontes.filter((f) => f.configurado);
    $('#kpi-fontes').textContent = configuradas.length + ' de ' + fontes.length;
    $('#kpi-fontes-sub').textContent = fontes.length
      ? fontes.map((f) => f.nome + (f.configurado ? ' ✓' : ' (sem credenciais)')).join(' · ')
      : 'nenhuma fonte registrada';

    // economia potencial = soma das diferenças entre a melhor e a pior loja de cada produto
    const economia = produtos.reduce((t, p) => t + (p.economia || 0), 0);
    $('#kpi-economia').textContent = dinheiro(economia);
  }

  function renderProdutos() {
    const tb = $('#tbody-produtos');
    tb.innerHTML = '';
    $('#vazio-produtos').classList.toggle('oculto', produtos.length > 0);

    produtos.forEach((p) => {
      const tr = el('tr');

      const tdNome = el('td');
      const link = el('button', 'link-produto', p.nome);
      link.addEventListener('click', () => abrirDetalhe(p.id));
      tdNome.appendChild(link);
      tdNome.appendChild(el('small', 'termo', 'busca: ' + p.termo));
      tr.appendChild(tdNome);

      const tdCat = el('td');
      tdCat.appendChild(el('span', 'etiqueta', p.categoria));
      tr.appendChild(tdCat);

      tr.appendChild(celula(p.melhor_loja || '—'));

      const abaixoAlvo = p.preco_alvo > 0 && p.menor_preco > 0 && p.menor_preco <= p.preco_alvo;
      tr.appendChild(celula(p.menor_preco ? dinheiro(p.menor_preco) : '—', 'dir ' + (abaixoAlvo ? 'positivo' : '')));
      tr.appendChild(celula(p.preco_alvo ? dinheiro(p.preco_alvo) : '—', 'dir neutro'));
      tr.appendChild(celula(String(p.ofertas), 'dir'));
      tr.appendChild(celula(dataHora(p.ultima_coleta)));

      const tdAcoes = el('td', 'dir');
      const btnColeta = el('button', 'mini', '🔄');
      btnColeta.title = 'Atualizar preços deste produto';
      btnColeta.addEventListener('click', () => coletar(p.id, btnColeta));
      const btnExcluir = el('button', 'mini', '🗑');
      btnExcluir.title = 'Parar de monitorar';
      btnExcluir.addEventListener('click', async () => {
        if (!confirm('Remover "' + p.nome + '" e todo o histórico de preços dele?')) return;
        try {
          await pedir('/api/produtos/' + p.id, { method: 'DELETE' });
          toast('Produto removido.');
          carregarProdutos();
        } catch (err) { toast(err.message, true); }
      });
      tdAcoes.append(btnColeta, btnExcluir);
      tr.appendChild(tdAcoes);

      tb.appendChild(tr);
    });
  }

  /* ---------- coleta ---------- */
  async function coletar(id, botao) {
    if (botao) { botao.disabled = true; botao.textContent = '⏳'; }
    try {
      const r = await pedir('/api/produtos/' + id + '/coletar', { method: 'POST' });
      const ok = r.relatorio.filter((f) => !f.erro);
      const falhas = r.relatorio.filter((f) => f.erro);
      const total = ok.reduce((t, f) => t + f.encontrados, 0);

      if (falhas.length) toast(falhas.map((f) => f.fonte + ': ' + f.erro).join(' | '), true);
      else toast(total + ' oferta(s) coletada(s).');

      await carregarProdutos();
      if (detalhe && detalhe.produto.id === id) {
        detalhe = r.detalhe;
        renderDetalhe();
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (botao) { botao.disabled = false; botao.textContent = '🔄'; }
    }
  }

  $('#btn-coletar-todos').addEventListener('click', async (e) => {
    if (!produtos.length) { toast('Cadastre um produto primeiro.', true); return; }
    e.target.disabled = true;
    const rotulo = e.target.textContent;
    let i = 0;
    for (const p of produtos) {
      i += 1;
      e.target.textContent = 'Coletando ' + i + '/' + produtos.length + '...';
      await coletar(p.id);
    }
    e.target.disabled = false;
    e.target.textContent = rotulo;
    toast('Coleta concluída em ' + produtos.length + ' produto(s).');
  });

  /* ---------- formularios ---------- */
  $('#form-produto').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const p = await pedir('/api/produtos', { method: 'POST', body: dadosForm(e.target) });
      e.target.reset();
      await carregarProdutos();
      toast('Produto adicionado. Coletando preços...');
      coletar(p.id);
    } catch (err) { toast(err.message, true); }
  });

  $('#form-busca').addEventListener('submit', async (e) => {
    e.preventDefault();
    const destino = $('#resultado-busca');
    destino.innerHTML = '';
    destino.appendChild(el('p', 'vazio', 'Consultando as lojas...'));
    try {
      const r = await pedir('/api/buscar', { method: 'POST', body: dadosForm(e.target) });
      destino.innerHTML = '';

      r.fontes.forEach((f) => {
        if (f.erro) destino.appendChild(el('p', 'aviso', f.fonte + ': ' + f.erro));
      });

      const ranking = r.comparacao.ranking;
      if (!ranking.length) {
        destino.appendChild(el('p', 'vazio', 'Nenhuma oferta encontrada para "' + r.termo + '".'));
        return;
      }
      const ul = el('ul', 'lista-ofertas');
      ranking.slice(0, 5).forEach((o, i) => {
        const li = el('li', i === 0 ? 'destaque' : '');
        const topo = el('div', 'oferta-topo');
        topo.appendChild(el('b', '', o.loja));
        topo.appendChild(el('span', 'preco', dinheiro(o.preco_total)));
        li.appendChild(topo);
        li.appendChild(el('small', '', o.titulo));
        if (o.url) {
          const a = el('a', 'link-externo', 'abrir anúncio ↗');
          a.href = o.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
          li.appendChild(a);
        }
        ul.appendChild(li);
      });
      destino.appendChild(ul);
    } catch (err) {
      destino.innerHTML = '';
      destino.appendChild(el('p', 'aviso', err.message));
    }
  });

  $('#form-oferta').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!detalhe) return;
    try {
      detalhe = await pedir('/api/produtos/' + detalhe.produto.id + '/ofertas', { method: 'POST', body: dadosForm(e.target) });
      e.target.reset();
      renderDetalhe();
      carregarProdutos();
      toast('Oferta registrada.');
    } catch (err) { toast(err.message, true); }
  });

  /* ---------- detalhe do produto ---------- */
  async function abrirDetalhe(id) {
    detalhe = await pedir('/api/produtos/' + id);
    renderDetalhe();
    mostrar({ tipo: 'detalhe', id });
  }

  $('#det-voltar').addEventListener('click', () => mostrar({ tipo: 'produtos' }));
  $('#det-coletar').addEventListener('click', () => { if (detalhe) coletar(detalhe.produto.id); });

  function renderDetalhe() {
    const d = detalhe;
    $('#det-nome').textContent = d.produto.nome;
    $('#det-sub').textContent =
      d.produto.categoria + ' · busca: "' + d.produto.termo + '"' +
      (d.produto.preco_alvo > 0 ? ' · alvo ' + dinheiro(d.produto.preco_alvo) : '') +
      ' · última coleta ' + dataHora(d.ultima_coleta ? d.ultima_coleta.executado_em : '');

    renderVeredito(d);
    renderRanking(d);
    renderGrafico(d.historico);
    renderOfertas(d.ofertas);
  }

  function renderVeredito(d) {
    const destino = $('#det-veredito');
    destino.innerHTML = '';
    const melhor = d.comparacao.melhor;

    if (!melhor) {
      destino.appendChild(el('p', 'painel vazio', 'Ainda não há ofertas. Clique em "Atualizar preços agora" ou lance uma oferta manualmente.'));
      return;
    }

    const cartao = el('section', 'painel veredito ' + d.momento.status);
    const topo = el('div', 'veredito-topo');

    const esquerda = el('div');
    esquerda.appendChild(el('h2', '', 'Compre na ' + melhor.loja));
    esquerda.appendChild(el('p', 'veredito-preco', dinheiro(melhor.preco_total)));
    const detalhes = [];
    if (melhor.frete > 0) detalhes.push('inclui frete de ' + dinheiro(melhor.frete));
    else detalhes.push('frete grátis ou não informado');
    if (melhor.condicao !== 'novo') detalhes.push('produto ' + melhor.condicao);
    if (melhor.parcelas > 0) detalhes.push('até ' + melhor.parcelas + 'x');
    esquerda.appendChild(el('small', 'neutro', detalhes.join(' · ')));
    topo.appendChild(esquerda);

    const direita = el('div', 'veredito-momento');
    direita.appendChild(el('span', 'selo ' + d.momento.status, d.momento.titulo));
    direita.appendChild(el('p', '', d.momento.texto));
    if (d.momento.dias > 1) {
      direita.appendChild(el('small', 'neutro',
        'mínimo ' + dinheiro(d.momento.minimo) + ' · mediana ' + dinheiro(d.momento.mediana) +
        ' · máximo ' + dinheiro(d.momento.maximo) + ' em ' + d.momento.dias + ' dia(s)'));
    }
    topo.appendChild(direita);
    cartao.appendChild(topo);

    if (d.comparacao.economia > 0) {
      cartao.appendChild(el('p', 'economia',
        'Economia de ' + dinheiro(d.comparacao.economia) + ' (' + pctFmt(d.comparacao.economia_pct) +
        ') em relação à loja mais cara entre as comparadas.'));
    }

    const maisBarato = d.comparacao.mais_barato;
    if (maisBarato && maisBarato.id !== melhor.id) {
      cartao.appendChild(el('p', 'dica',
        'A oferta mais barata é da ' + maisBarato.loja + ' por ' + dinheiro(maisBarato.preco_total) +
        ', mas o sistema não a recomenda por causa da condição do produto ou da reputação do vendedor.'));
    }

    if (d.produto.preco_alvo > 0) {
      cartao.appendChild(el('p', d.alvo_atingido ? 'positivo' : 'neutro',
        d.alvo_atingido
          ? '🎯 Preço-alvo de ' + dinheiro(d.produto.preco_alvo) + ' atingido.'
          : 'Faltam ' + dinheiro(melhor.preco_total - d.produto.preco_alvo) + ' para chegar ao seu preço-alvo.'));
    }

    destino.appendChild(cartao);
  }

  function renderRanking(d) {
    const destino = $('#det-ranking');
    destino.innerHTML = '';
    const ranking = d.comparacao.ranking;
    if (!ranking.length) {
      destino.appendChild(el('p', 'vazio', 'Sem lojas para comparar ainda.'));
      return;
    }
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
      li.appendChild(el('span', 'barra-valor', dinheiro(o.preco_total)));
      ul.appendChild(li);
    });
    destino.appendChild(ul);
    destino.appendChild(el('p', 'dica',
      'A ordem considera o preço final mais uma penalidade de risco para produto usado ou vendedor com reputação baixa.'));
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

    // linhas de referência
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

    const pontos = historico.map((h, i) => x(i) + ',' + y(h.minimo)).join(' ');
    const linha = document.createElementNS(ns, 'polyline');
    linha.setAttribute('points', pontos);
    linha.setAttribute('fill', 'none');
    linha.setAttribute('stroke', '#4c8dff');
    linha.setAttribute('stroke-width', '2');
    svg.appendChild(linha);

    historico.forEach((h, i) => {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', x(i)); c.setAttribute('cy', y(h.minimo)); c.setAttribute('r', '3');
      c.setAttribute('fill', h.minimo === min ? '#22c55e' : '#4c8dff');
      const titulo = document.createElementNS(ns, 'title');
      titulo.textContent = h.dia.split('-').reverse().join('/') + ': ' + dinheiro(h.minimo) + ' (' + h.amostras + ' ofertas)';
      c.appendChild(titulo);
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

  function renderOfertas(ofertas) {
    const tb = $('#tbody-ofertas');
    tb.innerHTML = '';
    $('#vazio-ofertas').classList.toggle('oculto', ofertas.length > 0);

    ofertas.forEach((o, i) => {
      const tr = el('tr', i === 0 ? 'melhor-linha' : '');
      tr.appendChild(celula(o.loja, 'ticker'));

      const tdTitulo = el('td', 'titulo-oferta');
      if (o.url) {
        const a = el('a', 'link-externo', o.titulo || 'ver anúncio');
        a.href = o.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        tdTitulo.appendChild(a);
      } else {
        tdTitulo.textContent = o.titulo || '—';
      }
      tr.appendChild(tdTitulo);

      tr.appendChild(celula(o.condicao, o.condicao === 'usado' ? 'negativo' : ''));
      tr.appendChild(celula((o.vendedor || '—') + (o.vendidos ? ' · ' + o.vendidos + ' vendas' : '')));
      tr.appendChild(celula(dinheiro(o.preco), 'dir'));
      tr.appendChild(celula(o.frete > 0 ? dinheiro(o.frete) : 'grátis', 'dir'));
      tr.appendChild(celula(dinheiro(o.preco_total), 'dir ' + (i === 0 ? 'positivo' : '')));

      const tdAcao = el('td', 'dir');
      if (o.manual) {
        const btn = el('button', 'mini', '🗑');
        btn.title = 'Excluir oferta manual';
        btn.addEventListener('click', async () => {
          try {
            await pedir('/api/ofertas/' + o.id, { method: 'DELETE' });
            detalhe = await pedir('/api/produtos/' + detalhe.produto.id);
            renderDetalhe();
            toast('Oferta excluída.');
          } catch (err) { toast(err.message, true); }
        });
        tdAcao.appendChild(btn);
      }
      tr.appendChild(tdAcao);
      tb.appendChild(tr);
    });
  }

  /* ---------- administracao ---------- */
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
          toast('Senha de ' + u.nome + ' redefinida. As sessões dele foram encerradas.');
          if (u.id === usuarioAtual.id) location.reload();
          else carregarAdmin();
        } catch (err) { toast(err.message, true); }
      });
      tdAcoes.appendChild(btnSenha);

      if (u.id !== usuarioAtual.id) {
        const btnExcluir = el('button', 'mini', '🗑');
        btnExcluir.title = 'Excluir conta e todos os dados dela';
        btnExcluir.addEventListener('click', async () => {
          if (!confirm('Excluir a conta de ' + u.nome + ' com os produtos e o histórico? Isso não pode ser desfeito.')) return;
          try {
            await pedir('/api/admin/usuarios/' + u.id, { method: 'DELETE' });
            toast('Conta excluída.');
            carregarAdmin();
          } catch (err) { toast(err.message, true); }
        });
        tdAcoes.appendChild(btnExcluir);
      }

      tr.appendChild(tdAcoes);
      tb.appendChild(tr);
    });
  }

  $('#admin-atualizar').addEventListener('click', () => carregarAdmin().catch((e) => toast(e.message, true)));

  /* ---------- inicio ---------- */
  (async function iniciar() {
    try {
      await abrirApp(await pedir('/api/eu'));
    } catch {
      $('#tela-login').classList.remove('oculto');
    }
  })();

  return { pedir, toast };
})();
