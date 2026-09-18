'use strict';
/* Agente coletor local.
   -------------------------------------------------------------------------
   Por que existe: lojas como a KaBuM! respondem normalmente a partir de uma
   rede brasileira, mas bloqueiam servidores de nuvem no exterior (o Render
   fica nos EUA). Entao a coleta roda aqui, no seu computador, e so o
   resultado e enviado para o sistema publicado.

   Como usar:
     set SERVIDOR=https://seu-endereco.onrender.com
     set COLETOR_TOKEN=a-mesma-chave-configurada-no-servidor
     node agente.js

   Para gerar um token novo:  node agente.js --token
   Para coletar sempre no mesmo horario, agende este comando no Agendador de
   Tarefas do Windows (uma vez por dia ja forma um bom historico de precos).
   ------------------------------------------------------------------------- */

const crypto = require('node:crypto');

const SERVIDOR = String(process.env.SERVIDOR || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = String(process.env.COLETOR_TOKEN || '').trim();
const PAUSA_MS = Number(process.env.PAUSA_MS) || 1500; // respeita as lojas entre consultas

const coletores = [
  require('./coletores/kabum.js'),
  require('./coletores/mercadolivre.js'),
];

if (process.argv.indexOf('--token') !== -1) {
  console.log('\nToken gerado (use o MESMO valor no servidor e no agente):\n');
  console.log('  ' + crypto.randomBytes(24).toString('hex') + '\n');
  process.exit(0);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function pedir(caminho, opcoes) {
  const conf = Object.assign({ headers: {} }, opcoes);
  conf.headers['X-Coletor-Token'] = TOKEN;
  if (conf.body) {
    conf.headers['Content-Type'] = 'application/json';
    conf.body = JSON.stringify(conf.body);
  }
  const r = await fetch(SERVIDOR + caminho, conf);
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || ('HTTP ' + r.status));
  return dados;
}

async function principal() {
  if (!TOKEN) {
    console.error('\nDefina COLETOR_TOKEN antes de rodar. Gere um com:  node agente.js --token\n');
    process.exit(1);
  }

  console.log('\n  Agente coletor');
  console.log('  servidor: ' + SERVIDOR);
  console.log('  fontes:   ' + coletores.filter((c) => c.configurado()).map((c) => c.nome).join(', ') + '\n');

  const produtos = await pedir('/api/ingestao/pendentes');
  if (!produtos.length) {
    console.log('  Nenhum produto monitorado no servidor. Cadastre um produto no site e rode de novo.\n');
    return;
  }

  let totalOfertas = 0;
  for (const produto of produtos) {
    console.log('  ' + produto.nome + '  (busca: "' + produto.termo + '")');

    for (const coletor of coletores) {
      if (!coletor.configurado()) {
        console.log('     - ' + coletor.nome + ': sem credenciais, pulando');
        continue;
      }
      let ofertas = [];
      let erro = '';
      try {
        ofertas = await coletor.buscar(produto.termo);
      } catch (e) {
        erro = e.message;
      }

      try {
        const r = await pedir('/api/ingestao', {
          method: 'POST',
          body: { produto_id: produto.id, fonte: coletor.nome, ofertas, erro },
        });
        totalOfertas += r.gravadas;
        console.log('     - ' + coletor.nome + ': ' + (erro ? 'erro -> ' + erro.slice(0, 90) : r.gravadas + ' oferta(s) enviada(s)'));
      } catch (e) {
        console.log('     - ' + coletor.nome + ': falha ao enviar -> ' + e.message);
      }

      await espera(PAUSA_MS);
    }
  }

  console.log('\n  Concluido: ' + totalOfertas + ' oferta(s) gravada(s) em ' + produtos.length + ' produto(s).\n');
}

principal().catch((e) => {
  console.error('\n  Erro: ' + e.message + '\n');
  process.exit(1);
});
