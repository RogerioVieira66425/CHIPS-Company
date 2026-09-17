'use strict';

const App = (function () {
  const $ = (s) => document.querySelector(s);
  const CORES = Blocos.CORES;
  const dinheiro = Blocos.dinheiro;
  const pct = Blocos.pct;
  const qtdFmt = Blocos.qtdFmt;
  const classeSinal = Blocos.sinal;

  let carteira = { posicoes: [], totais: { patrimonio: 0, investido: 0, lucro: 0, realizado: 0, proventos: 0, rentabilidade: 0 }, alocacao: [] };
  let transacoes = [];
  let vistaAtual = { tipo: 'painel', id: null };

  /* ---------- utilitarios ---------- */
  let temporizadorToast;
  function toast(msg, erro) {
    const e = $('#toast');
    e.textContent = msg;
    e.className = 'toast' + (erro ? ' erro' : '');
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => e.classList.add('oculto'), 3600);
  }

  async function pedir(rota, opcoes) {
    const conf = Object.assign({ headers: { 'Content-Type': 'application/json' } }, opcoes);
    if (conf.body && typeof conf.body !== 'string') conf.body = JSON.stringify(conf.body);
    const r = await fetch(rota, conf);
    const dados = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(dados.erro || 'Falha na requisição'), { status: r.status });
    return dados;
  }

  const dados = () => ({ carteira, transacoes });

  function dadosForm(form) {
    const o = {};
    new FormData(form).forEach((v, k) => { o[k] = v; });
    return o;
  }

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
    $('#tela-login').classList.add('oculto');
    $('#app').classList.remove('oculto');
    $('#ola').textContent = usuario.nome;
    $('#ola').title = usuario.email;
    await carregar();
    Lab.iniciar(renderMenu);
    await Lab.carregar();
    renderMenu();
    const inicial = Lab.telaInicial();
    mostrar(inicial ? { tipo: 'tela', id: inicial.id } : { tipo: 'painel' });
  }

  /* ---------- navegacao ---------- */
  function renderMenu() {
    const menu = $('#menu');
    menu.innerHTML = '';

    const botao = (rotulo, vista) => {
      const b = document.createElement('button');
      b.className = 'item-menu' + (vistaAtual.tipo === vista.tipo && vistaAtual.id === (vista.id || null) ? ' ativo' : '');
      b.textContent = rotulo;
      b.addEventListener('click', () => mostrar(vista));
      return b;
    };

    menu.appendChild(botao('Painel', { tipo: 'painel' }));
    Lab.oficiais().forEach((t) => menu.appendChild(botao(t.nome, { tipo: 'tela', id: t.id })));
    menu.appendChild(botao('🧪 Laboratório', { tipo: 'lab' }));
  }

  function mostrar(vista) {
    vistaAtual = { tipo: vista.tipo, id: vista.id || null };
    $('#vista-painel').classList.toggle('oculto', vista.tipo !== 'painel');
    $('#vista-tela').classList.toggle('oculto', vista.tipo !== 'tela');
    $('#vista-lab').classList.toggle('oculto', vista.tipo !== 'lab');

    if (vista.tipo === 'tela') {
      const tela = Lab.lista().find((t) => t.id === vista.id);
      if (!tela) { mostrar({ tipo: 'painel' }); return; }
      $('#tela-nome').textContent = tela.nome;
      $('#tela-descricao').textContent = tela.descricao || '';
      $('#btn-editar-tela').onclick = () => { Lab.abrir(tela.id); mostrar({ tipo: 'lab' }); };
      Blocos.renderizarTela(tela, dados(), $('#tela-blocos'));
    }
    if (vista.tipo === 'lab') Lab.render();

    renderMenu();
    window.scrollTo({ top: 0 });
  }

  /* ---------- dados da carteira ---------- */
  async function carregar() {
    const [c, txs] = await Promise.all([pedir('/api/carteira'), pedir('/api/transacoes')]);
    carteira = c;
    transacoes = txs;
    renderKpis(c.totais);
    renderRosca(c.alocacao);
    renderCarteira(c.posicoes);
    renderSelectAtivos(c.posicoes);
    renderTransacoes(txs);

    if (vistaAtual.tipo === 'tela') {
      const tela = Lab.lista().find((t) => t.id === vistaAtual.id);
      if (tela) Blocos.renderizarTela(tela, dados(), $('#tela-blocos'));
    }
    if (vistaAtual.tipo === 'lab') Lab.previa();
  }

  function renderKpis(t) {
    $('#kpi-patrimonio').textContent = dinheiro(t.patrimonio);
    $('#kpi-investido').textContent = dinheiro(t.investido);

    const lucro = $('#kpi-lucro');
    lucro.textContent = dinheiro(t.lucro);
    lucro.className = classeSinal(t.lucro);

    const rent = $('#kpi-rent');
    rent.textContent = pct(t.rentabilidade) + ' sobre o investido';
    rent.className = 'variacao ' + classeSinal(t.lucro);

    const real = $('#kpi-realizado');
    real.textContent = dinheiro(t.realizado + t.proventos);
    real.className = classeSinal(t.realizado + t.proventos);
    $('#kpi-proventos').textContent = 'vendas ' + dinheiro(t.realizado) + ' · proventos ' + dinheiro(t.proventos);
  }

  function renderRosca(alocacao) {
    const svg = $('#rosca');
    const legenda = $('#legenda');
    legenda.innerHTML = '';
    const total = alocacao.reduce((s, f) => s + f.valor, 0);
    Blocos.desenharRosca(svg, alocacao.map((f) => ({ rotulo: f.classe, valor: f.valor })), total);

    if (!alocacao.length) {
      legenda.innerHTML = '<li class="neutro">Sem posições com valor de mercado ainda.</li>';
      return;
    }
    alocacao.forEach((fatia, i) => {
      const li = document.createElement('li');
      const ponto = document.createElement('i');
      ponto.className = 'ponto';
      ponto.style.background = CORES[i % CORES.length];
      const nome = document.createElement('b');
      nome.textContent = fatia.classe;
      const valor = document.createElement('span');
      valor.className = 'valor';
      valor.textContent = Blocos.pctSimples(fatia.pct) + ' · ' + dinheiro(fatia.valor);
      li.append(ponto, nome, valor);
      legenda.appendChild(li);
    });
  }

  function celula(texto, classe) {
    const td = document.createElement('td');
    td.textContent = texto;
    if (classe) td.className = classe;
    return td;
  }

  function renderCarteira(posicoes) {
    const tb = $('#tbody-carteira');
    tb.innerHTML = '';
    $('#vazio-carteira').classList.toggle('oculto', posicoes.length > 0);

    posicoes.forEach((p) => {
      const tr = document.createElement('tr');

      const tdAtivo = document.createElement('td');
      tdAtivo.className = 'ticker';
      tdAtivo.textContent = p.ticker;
      if (p.nome) {
        const s = document.createElement('small');
        s.textContent = p.nome;
        tdAtivo.appendChild(s);
      }
      tr.appendChild(tdAtivo);

      const tdClasse = document.createElement('td');
      const et = document.createElement('span');
      et.className = 'etiqueta';
      et.textContent = p.classe;
      tdClasse.appendChild(et);
      tr.appendChild(tdClasse);

      tr.appendChild(celula(qtdFmt(p.quantidade), 'dir'));
      tr.appendChild(celula(dinheiro(p.preco_medio), 'dir'));

      const tdPreco = document.createElement('td');
      tdPreco.className = 'dir';
      const input = document.createElement('input');
      input.className = 'editavel';
      input.value = p.preco_atual.toFixed(2).replace('.', ',');
      input.title = 'Atualize a cotação e pressione Enter';
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      input.addEventListener('blur', async () => {
        const novo = input.value.replace(',', '.');
        if (Number(novo) === p.preco_atual) return;
        try {
          await pedir('/api/ativos/' + p.id, { method: 'PATCH', body: { preco_atual: novo } });
          toast(p.ticker + ' atualizado.');
          carregar();
        } catch (err) { toast(err.message, true); carregar(); }
      });
      tdPreco.appendChild(input);
      tr.appendChild(tdPreco);

      tr.appendChild(celula(dinheiro(p.custo), 'dir'));
      tr.appendChild(celula(dinheiro(p.valor_atual), 'dir'));
      tr.appendChild(celula(dinheiro(p.lucro), 'dir ' + classeSinal(p.lucro)));
      tr.appendChild(celula(p.custo > 0 ? pct(p.rentabilidade) : '—', 'dir ' + classeSinal(p.lucro)));

      const tdAcao = document.createElement('td');
      tdAcao.className = 'dir';
      const btn = document.createElement('button');
      btn.className = 'mini';
      btn.textContent = '🗑';
      btn.title = 'Remover ativo e seus lançamentos';
      btn.addEventListener('click', async () => {
        if (!confirm('Remover ' + p.ticker + ' e todos os seus lançamentos?')) return;
        try {
          await pedir('/api/ativos/' + p.id, { method: 'DELETE' });
          toast(p.ticker + ' removido.');
          carregar();
        } catch (err) { toast(err.message, true); }
      });
      tdAcao.appendChild(btn);
      tr.appendChild(tdAcao);

      tb.appendChild(tr);
    });
  }

  function renderSelectAtivos(posicoes) {
    const sel = $('#select-ativo');
    const anterior = sel.value;
    sel.innerHTML = '';
    posicoes.forEach((p) => {
      const op = document.createElement('option');
      op.value = p.id;
      op.textContent = p.ticker;
      sel.appendChild(op);
    });
    if (anterior) sel.value = anterior;
  }

  const NOME_TIPO = { compra: 'Compra', venda: 'Venda', provento: 'Provento' };

  function renderTransacoes(txs) {
    const tb = $('#tbody-tx');
    tb.innerHTML = '';
    $('#vazio-tx').classList.toggle('oculto', txs.length > 0);

    txs.forEach((t) => {
      const tr = document.createElement('tr');
      tr.appendChild(celula(t.data.split('-').reverse().join('/')));
      tr.appendChild(celula(t.ticker, 'ticker'));
      tr.appendChild(celula(NOME_TIPO[t.tipo], t.tipo === 'compra' ? 'positivo' : t.tipo === 'venda' ? 'negativo' : 'neutro'));
      tr.appendChild(celula(t.tipo === 'provento' ? '—' : qtdFmt(t.quantidade), 'dir'));
      tr.appendChild(celula(dinheiro(t.tipo === 'provento' ? t.preco : t.quantidade * t.preco + t.taxas), 'dir'));

      const tdAcao = document.createElement('td');
      tdAcao.className = 'dir';
      const btn = document.createElement('button');
      btn.className = 'mini';
      btn.textContent = '🗑';
      btn.title = 'Excluir lançamento';
      btn.addEventListener('click', async () => {
        if (!confirm('Excluir este lançamento?')) return;
        try {
          await pedir('/api/transacoes/' + t.id, { method: 'DELETE' });
          toast('Lançamento excluído.');
          carregar();
        } catch (err) { toast(err.message, true); }
      });
      tdAcao.appendChild(btn);
      tr.appendChild(tdAcao);

      tb.appendChild(tr);
    });
  }

  /* ---------- formularios do painel ---------- */
  $('#form-ativo').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await pedir('/api/ativos', { method: 'POST', body: dadosForm(e.target) });
      e.target.reset();
      toast('Ativo adicionado.');
      carregar();
    } catch (err) { toast(err.message, true); }
  });

  $('#select-tipo').addEventListener('change', (e) => {
    const provento = e.target.value === 'provento';
    $('#campo-qtd').classList.toggle('oculto', provento);
    $('#campo-preco').firstChild.textContent = provento ? 'Valor recebido' : 'Preço unitário';
  });

  $('#form-tx').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await pedir('/api/transacoes', { method: 'POST', body: dadosForm(e.target) });
      const tipo = $('#select-tipo').value;
      const ativo = $('#select-ativo').value;
      e.target.reset();
      $('#select-tipo').value = tipo;
      $('#select-ativo').value = ativo;
      toast('Lançamento registrado.');
      carregar();
    } catch (err) { toast(err.message, true); }
  });

  /* ---------- inicio ---------- */
  (async function iniciar() {
    document.querySelector('input[name="data"]').value = new Date().toISOString().slice(0, 10);
    try {
      await abrirApp(await pedir('/api/eu'));
    } catch {
      $('#tela-login').classList.remove('oculto');
    }
  })();

  return { pedir, toast, dados, carregar, mostrar };
})();
