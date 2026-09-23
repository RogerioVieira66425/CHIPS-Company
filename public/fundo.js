'use strict';
/* Cena animada da capa: synthwave gamer.
   -------------------------------------------------------------------------
   Sol neon fatiado, grade em perspectiva correndo para o horizonte, campo de
   estrelas piscando e riscos de luz cruzando a tela. Tudo desenhado em canvas:
   nenhum GIF, video ou imagem externa — carrega instantaneo e nunca quebra.
   Quem tem "reduzir movimento" ligado ve a cena parada. */

(function () {
  const tela = document.getElementById('fundo-gamer');
  if (!tela) return;

  const ctx = tela.getContext('2d');
  const menosMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const AZUL = '76, 141, 255';
  const ROXO = '168, 85, 247';
  const ROSA = '236, 72, 153';

  let largura = 0;
  let altura = 0;
  let horizonte = 0;
  let estrelas = [];
  let riscos = [];
  let faiscas = [];

  function dimensionar() {
    const escala = Math.min(window.devicePixelRatio || 1, 2);
    largura = tela.clientWidth;
    altura = tela.clientHeight;
    horizonte = altura * 0.62;
    tela.width = Math.floor(largura * escala);
    tela.height = Math.floor(altura * escala);
    ctx.setTransform(escala, 0, 0, escala, 0, 0);

    const quantasEstrelas = Math.min(160, Math.round((largura * horizonte) / 5200));
    estrelas = new Array(quantasEstrelas).fill(0).map(() => ({
      x: Math.random() * largura,
      y: Math.random() * horizonte,
      raio: Math.random() * 1.4 + 0.3,
      fase: Math.random() * Math.PI * 2,
      ritmo: 0.6 + Math.random() * 1.6,
    }));

    faiscas = new Array(Math.min(40, Math.round(largura / 34))).fill(0).map(() => novaFaisca(true));
    riscos = [];
  }

  function novaFaisca(inicial) {
    return {
      x: Math.random() * largura,
      y: inicial ? horizonte + Math.random() * (altura - horizonte) : altura + 8,
      tamanho: 1 + Math.random() * 2.5,
      velocidade: 0.25 + Math.random() * 0.7,
      brilho: 0.25 + Math.random() * 0.5,
      cor: Math.random() > 0.7 ? ROSA : AZUL,
      balanco: Math.random() * Math.PI * 2,
    };
  }

  /* ---------- sol neon fatiado ---------- */
  function desenharSol(t) {
    const raio = Math.min(largura * 0.16, 190);
    const cx = largura / 2;
    const cy = horizonte - raio * 0.28;
    const pulso = 1 + Math.sin(t / 900) * 0.02;

    ctx.save();

    // halo
    const halo = ctx.createRadialGradient(cx, cy, raio * 0.2, cx, cy, raio * 2.5);
    halo.addColorStop(0, 'rgba(' + ROSA + ',0.16)');
    halo.addColorStop(0.45, 'rgba(' + ROXO + ',0.07)');
    halo.addColorStop(1, 'rgba(' + ROXO + ',0)');
    ctx.fillStyle = halo;
    ctx.fillRect(cx - raio * 2.6, cy - raio * 2.6, raio * 5.2, raio * 5.2);

    // disco
    ctx.beginPath();
    ctx.arc(cx, cy, raio * pulso, 0, Math.PI * 2);
    ctx.clip();

    const corpo = ctx.createLinearGradient(0, cy - raio, 0, cy + raio);
    corpo.addColorStop(0, 'rgba(255, 210, 120, 0.78)');
    corpo.addColorStop(0.42, 'rgba(' + ROSA + ',0.62)');
    corpo.addColorStop(1, 'rgba(' + ROXO + ',0.30)');
    ctx.fillStyle = corpo;
    ctx.fillRect(cx - raio, cy - raio, raio * 2, raio * 2);

    // fatias horizontais, mais grossas embaixo (marca do estilo synthwave)
    ctx.globalCompositeOperation = 'destination-out';
    let y = cy - raio * 0.05;
    let espessura = 2;
    while (y < cy + raio) {
      ctx.fillRect(cx - raio, y, raio * 2, espessura);
      y += espessura + Math.max(3, raio * 0.055);
      espessura += 0.9;
    }
    ctx.restore();
  }

  /* ---------- grade em perspectiva ---------- */
  function desenharGrade(t) {
    const avanco = (t / 16) % 70;

    // brilho do chao
    const chao = ctx.createLinearGradient(0, horizonte, 0, altura);
    chao.addColorStop(0, 'rgba(' + ROXO + ',0.10)');
    chao.addColorStop(1, 'rgba(' + AZUL + ',0.02)');
    ctx.fillStyle = chao;
    ctx.fillRect(0, horizonte, largura, altura - horizonte);

    ctx.lineWidth = 1.1;

    // horizontais
    for (let i = 0; i < 30; i += 1) {
      const passo = (i * 70 + avanco) / 70;
      const y = horizonte + Math.pow(passo, 2.15) * 13;
      if (y > altura + 30) continue;
      const forca = Math.max(0, 1 - (y - horizonte) / (altura - horizonte));
      ctx.strokeStyle = 'rgba(' + AZUL + ',' + (0.34 * forca + 0.05).toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(largura, y);
      ctx.stroke();
    }

    // verticais convergindo
    const centro = largura / 2;
    for (let i = -16; i <= 16; i += 1) {
      const xBase = centro + i * (largura / 11);
      const distancia = Math.abs(i) / 16;
      ctx.strokeStyle = 'rgba(' + AZUL + ',' + (0.22 - distancia * 0.12).toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(centro + (xBase - centro) * 0.02, horizonte);
      ctx.lineTo(xBase, altura + 40);
      ctx.stroke();
    }

    // linha do horizonte, acesa
    ctx.strokeStyle = 'rgba(' + ROSA + ',0.55)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, horizonte);
    ctx.lineTo(largura, horizonte);
    ctx.stroke();

    const brilhoHorizonte = ctx.createLinearGradient(0, horizonte - 26, 0, horizonte + 26);
    brilhoHorizonte.addColorStop(0, 'rgba(' + ROSA + ',0)');
    brilhoHorizonte.addColorStop(0.5, 'rgba(' + ROSA + ',0.14)');
    brilhoHorizonte.addColorStop(1, 'rgba(' + ROSA + ',0)');
    ctx.fillStyle = brilhoHorizonte;
    ctx.fillRect(0, horizonte - 26, largura, 52);
  }

  /* ---------- estrelas ---------- */
  function desenharEstrelas(t) {
    estrelas.forEach((e) => {
      const brilho = 0.25 + Math.abs(Math.sin(t / 1000 * e.ritmo + e.fase)) * 0.6;
      ctx.fillStyle = 'rgba(226, 232, 240,' + brilho.toFixed(2) + ')';
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.raio, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /* ---------- riscos de luz atravessando o ceu ---------- */
  function atualizarRiscos() {
    if (riscos.length < 2 && Math.random() < 0.012) {
      const daEsquerda = Math.random() > 0.5;
      riscos.push({
        x: daEsquerda ? -60 : largura + 60,
        y: Math.random() * horizonte * 0.7,
        direcao: daEsquerda ? 1 : -1,
        velocidade: 4 + Math.random() * 5,
        comprimento: 90 + Math.random() * 110,
        vida: 1,
      });
    }

    riscos = riscos.filter((r) => {
      r.x += r.velocidade * r.direcao;
      r.y += r.velocidade * 0.22;
      r.vida -= 0.004;
      return r.vida > 0 && r.x > -240 && r.x < largura + 240;
    });

    riscos.forEach((r) => {
      const risco = ctx.createLinearGradient(r.x, r.y, r.x - r.comprimento * r.direcao, r.y - r.comprimento * 0.22);
      risco.addColorStop(0, 'rgba(255,255,255,' + (0.5 * r.vida).toFixed(2) + ')');
      risco.addColorStop(0.4, 'rgba(' + AZUL + ',' + (0.3 * r.vida).toFixed(2) + ')');
      risco.addColorStop(1, 'rgba(' + AZUL + ',0)');
      ctx.strokeStyle = risco;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(r.x - r.comprimento * r.direcao, r.y - r.comprimento * 0.22);
      ctx.stroke();
    });
  }

  /* ---------- faiscas subindo do chao ---------- */
  function desenharFaiscas() {
    faiscas.forEach((f, i) => {
      f.y -= f.velocidade;
      f.balanco += 0.012;
      const x = f.x + Math.sin(f.balanco) * 10;
      if (f.y < horizonte - 40) faiscas[i] = novaFaisca(false);

      ctx.fillStyle = 'rgba(' + f.cor + ',' + f.brilho.toFixed(2) + ')';
      ctx.fillRect(x, f.y, f.tamanho, f.tamanho);
    });
  }

  /* ---------- escurece o centro para o texto ficar legivel ---------- */
  function desenharVinheta() {
    const v = ctx.createRadialGradient(largura / 2, altura * 0.42, 40, largura / 2, altura * 0.42, Math.max(largura, altura) * 0.62);
    v.addColorStop(0, 'rgba(10, 13, 20, 0.82)');
    v.addColorStop(0.55, 'rgba(10, 13, 20, 0.35)');
    v.addColorStop(1, 'rgba(10, 13, 20, 0)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, largura, altura);
  }

  function cena(t) {
    ctx.clearRect(0, 0, largura, altura);
    desenharEstrelas(t);
    desenharSol(t);
    desenharGrade(t);
    desenharFaiscas();
    atualizarRiscos();
    desenharVinheta();
  }

  function quadro(t) {
    cena(t);
    if (document.hidden) setTimeout(() => requestAnimationFrame(quadro), 500);
    else requestAnimationFrame(quadro);
  }

  dimensionar();
  window.addEventListener('resize', dimensionar);

  if (menosMovimento) cena(0);
  else requestAnimationFrame(quadro);
})();
