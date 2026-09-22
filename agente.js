'use strict';
/* Agente coletor local.
   -------------------------------------------------------------------------
   Por que existe: as lojas respondem normalmente a partir de uma rede
   brasileira, mas bloqueiam servidores de nuvem no exterior (o Render fica
   nos EUA). Entao a coleta roda aqui, no seu computador, e so o resultado e
   enviado para o sistema publicado.

   Como usar (PowerShell):
     $env:SERVIDOR="http://localhost:3000,https://seu-site.onrender.com"
     $env:COLETOR_TOKEN="a-mesma-chave-configurada-no-servidor"
     node agente.js

   SERVIDOR aceita varios destinos separados por virgula: a coleta acontece
   uma unica vez e o resultado e enviado para todos. Assim o banco local
   guarda o historico completo e o site publico mostra os precos atuais.

   Para gerar um token novo:  node agente.js --token
   Para formar historico, agende este comando no Agendador de Tarefas do
   Windows (uma vez por dia ja e suficiente e evita incomodar as lojas).
   ------------------------------------------------------------------------- */

const crypto = require('node:crypto');

const SERVIDORES = String(process.env.SERVIDOR || 'http://localhost:3000')
  .split(',')
  .map((u) => u.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const TOKEN = String(process.env.COLETOR_TOKEN || '').trim();
const PAUSA_MS = Number(process.env.PAUSA_MS) || 1500; // respeita as lojas entre consultas

/* O agente roda na maquina do usuario: pode usar o navegador local para as lojas
   que recusam requisicoes simples. O servidor publico usa so as fontes por API. */
const coletores = [
  require('./coletores/kabum.js'),
  require('./coletores/pichau.js'),
  require('./coletores/terabyte.js'),
  require('./coletores/magalu.js'),
  require('./coletores/mercadolivre.js'),
];

if (process.argv.indexOf('--token') !== -1) {
  console.log('\nToken gerado (use o MESMO valor no servidor e no agente):\n');
  console.log('  ' + crypto.randomBytes(24).toString('hex') + '\n');
  process.exit(0);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const apelido = (url) => url.replace(/^https?:\/\//, '').split('/')[0];

async function pedir(servidor, caminho, opcoes) {
  const conf = Object.assign({ headers: {} }, opcoes);
  conf.headers['X-Coletor-Token'] = TOKEN;
  if (conf.body) {
    conf.headers['Content-Type'] = 'application/json';
    conf.body = JSON.stringify(conf.body);
  }
  const r = await fetch(servidor + caminho, conf);
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || ('HTTP ' + r.status));
  return dados;
}

async function principal() {
  if (!TOKEN) {
    console.error('\n' + 'Defina COLETOR_TOKEN antes de rodar. Gere um com:  node agente.js --token' + '\n');
    process.exit(1);
  }

  console.log('\n  Agente coletor');
  console.log('  destinos: ' + SERVIDORES.map(apelido).join(', '));
  console.log('  fontes:   ' + coletores.filter((c) => c.configurado()).map((c) => c.nome).join(', ') + '\n');

  // 1) cada destino tem os proprios produtos (e os proprios ids)
  const destinos = [];
  for (const servidor of SERVIDORES) {
    try {
      const produtos = await pedir(servidor, '/api/ingestao/pendentes');
      destinos.push({ servidor, produtos });
      console.log('  ' + apelido(servidor) + ': ' + produtos.length + ' produto(s) monitorado(s)');
    } catch (e) {
      console.log('  ' + apelido(servidor) + ': indisponivel (' + e.message + ')');
    }
  }
  if (!destinos.length) {
    console.log('\n  Nenhum destino respondeu. Verifique o COLETOR_TOKEN e os enderecos.\n');
    return;
  }

  // 2) o termo de busca e o que identifica o produto entre servidores diferentes
  const termos = [...new Set(destinos.flatMap((d) => d.produtos.map((p) => p.termo)))];

  // 2b) espelha: o que existe em um destino passa a existir nos outros
  const modelo = new Map();
  destinos.forEach((d) => d.produtos.forEach((p) => { if (!modelo.has(p.termo)) modelo.set(p.termo, p); }));

  for (const destino of destinos) {
    const faltando = termos.filter((t) => !destino.produtos.some((p) => p.termo === t));
    for (const termo of faltando) {
      const base = modelo.get(termo);
      try {
        const r = await pedir(destino.servidor, '/api/ingestao/produtos', {
          method: 'POST',
          body: { nome: base.nome, termo: base.termo },
        });
        destino.produtos.push({ id: r.produto.id, nome: r.produto.nome, termo: r.produto.termo });
        if (r.criado) console.log('  ' + apelido(destino.servidor) + ': produto "' + base.nome + '" criado');
      } catch (e) {
        console.log('  ' + apelido(destino.servidor) + ': nao consegui criar "' + base.nome + '" (' + e.message + ')');
      }
    }
  }
  if (!termos.length) {
    console.log('\n  Nenhum produto monitorado. Cadastre um produto no site e rode de novo.\n');
    return;
  }

  // 3) consulta cada termo uma unica vez, mesmo que va para varios destinos
  console.log('');
  const resultados = new Map();
  for (const termo of termos) {
    console.log('  "' + termo + '"');
    const porFonte = [];
    for (const coletor of coletores) {
      if (!coletor.configurado()) continue;
      let ofertas = [];
      let erro = '';
      try {
        ofertas = await coletor.buscar(termo);
        console.log('     - ' + coletor.nome + ': ' + ofertas.length + ' oferta(s)');
      } catch (e) {
        erro = e.message;
        console.log('     - ' + coletor.nome + ': ' + erro.slice(0, 100));
      }
      porFonte.push({ fonte: coletor.nome, ofertas, erro });
      await espera(PAUSA_MS);
    }
    resultados.set(termo, porFonte);
  }

  // 4) envia o mesmo resultado para cada destino, usando o id de produto de la
  console.log('');
  let gravadasTotal = 0;
  for (const destino of destinos) {
    let doDestino = 0;
    for (const produto of destino.produtos) {
      for (const r of resultados.get(produto.termo) || []) {
        try {
          const resp = await pedir(destino.servidor, '/api/ingestao', {
            method: 'POST',
            body: { produto_id: produto.id, fonte: r.fonte, ofertas: r.ofertas, erro: r.erro },
          });
          doDestino += resp.gravadas;
        } catch (e) {
          console.log('  ' + apelido(destino.servidor) + ' / ' + produto.nome + ': falhou (' + e.message + ')');
        }
      }
    }
    gravadasTotal += doDestino;
    console.log('  ' + apelido(destino.servidor) + ': ' + doDestino + ' oferta(s) gravada(s)');
  }

  console.log('\n  Concluido: ' + gravadasTotal + ' gravacao(oes) em ' + destinos.length + ' destino(s).\n');
}

/* ---------- modo servico: atende as buscas pedidas no site publico ---------- */
async function atenderBuscas() {
  for (const servidor of SERVIDORES) {
    let pendentes = [];
    try {
      pendentes = await pedir(servidor, '/api/ingestao/buscas');
    } catch (e) {
      continue; // servidor fora do ar ou sem token: tenta no proximo ciclo
    }

    for (const busca of pendentes) {
      console.log('  [' + new Date().toLocaleTimeString('pt-BR') + '] busca de visitante: "' + busca.termo + '"');
      const fontes = [];
      for (const coletor of coletores) {
        if (!coletor.configurado()) {
          fontes.push({ fonte: coletor.nome, erro: 'Fonte nao configurada.', ofertas: [] });
          continue;
        }
        try {
          const ofertas = await coletor.buscar(busca.termo);
          fontes.push({ fonte: coletor.nome, erro: '', ofertas });
          console.log('      ' + coletor.nome + ': ' + ofertas.length + ' oferta(s)');
        } catch (e) {
          fontes.push({ fonte: coletor.nome, erro: e.message, ofertas: [] });
          console.log('      ' + coletor.nome + ': ' + e.message.slice(0, 80));
        }
        await espera(PAUSA_MS);
      }
      try {
        await pedir(servidor, '/api/ingestao/buscas/' + busca.id, { method: 'POST', body: { fontes } });
      } catch (e) {
        console.log('      nao consegui devolver o resultado: ' + e.message);
      }
    }
  }
}

async function servico() {
  const intervalo = Number(process.env.INTERVALO_MS) || 4000;
  console.log('');
  console.log('  Agente em modo servico');
  console.log('  destinos: ' + SERVIDORES.map(apelido).join(', '));
  console.log('  atendendo buscas do site a cada ' + (intervalo / 1000) + 's. Ctrl+C para parar.');
  console.log('');
  for (;;) {
    try {
      await atenderBuscas();
    } catch (e) {
      console.log('  erro no ciclo: ' + e.message);
    }
    await espera(intervalo);
  }
}

if (process.argv.indexOf('--servico') !== -1) {
  if (!TOKEN) {
    console.error('Defina COLETOR_TOKEN antes de rodar.');
    process.exit(1);
  }
  servico();
} else {

principal().catch((e) => {
  console.error('\n  Erro: ' + e.message + '\n');
  process.exit(1);
});
}
