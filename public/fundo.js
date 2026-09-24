'use strict';
/* Fundo da capa.
   -------------------------------------------------------------------------
   A capa usa o video fundo-gamer.mp4. Enquanto ele nao comeca - rede lenta,
   formato nao suportado ou autoplay bloqueado - fica o preto da marca com o
   brilho vermelho definido no CSS, e nada mais entra no lugar dele. */

(function () {
  const video = document.getElementById('fundo-video');
  const veu = document.getElementById('fundo-veu');
  if (!video) return;

  const mostrarVeu = () => veu && veu.classList.add('ativo');

  const assumirVideo = () => {
    video.classList.add('tocando');
    mostrarVeu();
  };

  video.addEventListener('playing', assumirVideo, { once: true });
  video.addEventListener('error', mostrarVeu, { once: true });

  // alguns navegadores so liberam o autoplay apos um gesto: tenta de novo no primeiro toque
  const tentar = () => video.play().catch(() => {});
  tentar();
  window.addEventListener('pointerdown', tentar, { once: true });

  // sem video em 4s, o veu entra assim mesmo e a capa segue no fundo da marca
  setTimeout(() => { if (!video.classList.contains('tocando')) mostrarVeu(); }, 4000);
})();
