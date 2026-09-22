# Comparador de Preços de Equipamentos Gamer

Sistema web que monitora o preço de equipamentos gamer em várias lojas, guarda o histórico
e responde a duas perguntas: **em qual loja compensa comprar** e **se este é um bom momento**.

Projeto de TCC. Sem bibliotecas externas: só Node.js (o SQLite já vem embutido no Node 22.5+).

## Rodar no seu computador

1. Dê dois cliques em **INICIAR.bat** (ou rode `node server.js`).
2. Abra http://localhost:3000 — **o site é público**: qualquer visitante vê os produtos,
   a comparação entre lojas e o link de compra, sem precisar de conta.
3. Para administrar (cadastrar produtos, coletar, excluir), clique em **Entrar** e use
   `admin` com a senha definida em `ADMIN_SENHA` (padrão `admin` no ambiente local).

## Como funciona

```
 [ Coletores ]          [ Banco ]                  [ Análise ]              [ Interface ]
 Mercado Livre  --+                             compararLojas()  --+
 (API oficial)     +--> coletas --> ofertas -->                     +--> "Compre na X por R$ Y"
 Oferta manual   --+               (histórico)  avaliarMomento() --+      + gráfico + ranking
```

1. **Coleta** — cada fonte de preço é um módulo em `coletores/` com a mesma interface
   (`configurado()` e `buscar(termo)`). Hoje há o Mercado Livre pela API oficial;
   novas lojas entram sem mexer no resto do sistema.
2. **Armazenamento** — cada execução vira uma linha em `coletas` e cada anúncio encontrado
   vira uma linha em `ofertas`. Nada é sobrescrito: é isso que forma o histórico de preços.
3. **Análise** (`analise.js`, isolada e testável — é o núcleo acadêmico do trabalho):
   - `compararLojas()` pega a melhor oferta de cada loja, soma o frete e ordena por **custo ajustado**:
     o preço final mais uma penalidade de risco (15% para produto usado, até 12% conforme a
     reputação do vendedor). Assim o sistema não recomenda uma loja 2% mais barata com vendedor ruim
     — e avisa na tela quando o mais barato não é o recomendado.
   - `avaliarMomento()` compara o preço de hoje com a **mediana** do histórico do próprio produto
     e classifica em: melhor preço já registrado / bom momento / na média / vale esperar.
4. **Interface** — lista de produtos monitorados, tela de comparação com veredito, ranking
   por loja e gráfico do menor preço por dia.

## Fontes de preço

| Loja | Como é consultada | Situação |
|---|---|---|
| **KaBuM!** | API pública do catálogo | Funcionando |
| **Pichau** | Navegador local (CDP) | Funcionando |
| **Terabyte** | Navegador local (CDP) | Funcionando |
| Magazine Luiza | Navegador local (CDP) | Bloqueia acesso automatizado; desligada (`MAGALU_ATIVO=1` para testar) |
| Mercado Livre | API oficial | Bloqueada: apps não liberados recebem 403 |
| Qualquer loja | Lançamento manual na interface | Sempre disponível |

### Navegador local, sem dependências

Pichau e Terabyte recusam requisições HTTP simples (403), mesmo com cabeçalhos de navegador.
A solução em `coletores/navegador.js` usa o **Chrome que já existe na máquina**, controlado pelo
**Chrome DevTools Protocol** através do WebSocket nativo do Node — nenhuma biblioteca instalada.

Dois detalhes descobertos nos testes:

- **Modo headless é detectado**: a Pichau devolve "Site em Manutenção" para `--headless`. A janela
  é aberta normalmente, mas posicionada fora da tela (`--window-position=-32000,-32000`).
- Cada consulta abre uma aba nova e a fecha ao terminar; o navegador fica aberto entre as buscas.

### Relevância: não comparar produtos diferentes

As lojas completam a busca com produtos parecidos. Procurando "teclado redragon kumara", a
Terabyte devolveu um "Rise Mode G1" de R$ 39,99 — e, sem tratamento, o sistema recomendaria
esse teclado, que não é o que a pessoa quer.

`analise.filtrarRelevantes()` resolve isso: normaliza o texto (minúsculas, sem acento), separa os
termos da busca com 3+ letras e exige que **70% deles apareçam no título do anúncio**. Se nenhum
anúncio passar, devolve os cinco mais parecidos em vez de uma lista vazia. No teste real: 36
ofertas coletadas, 24 relevantes, e o falso positivo de R$ 39,99 eliminado.

### Credenciais do Mercado Livre
1. Acesse https://developers.mercadolivre.com.br → *Suas aplicações* → **Criar aplicação**.
2. Anote o **Client ID** e o **Client Secret**.
3. Local: `ML_CLIENT_ID=... ML_CLIENT_SECRET=... node server.js`
4. Render: *Environment → Add Environment Variable* → `ML_CLIENT_ID` e `ML_CLIENT_SECRET`.

Sem as credenciais o sistema continua funcionando: a coleta avisa "fonte não configurada"
e você registra as ofertas manualmente — útil como plano B na apresentação.

## Agente coletor local (contorna o bloqueio geografico)

As lojas respondem normalmente a partir de uma rede brasileira, mas bloqueiam servidores de
nuvem no exterior (o Render fica em Oregon, EUA): a KaBuM! devolve 403 quando a consulta parte
de la. A solucao e separar quem coleta de quem analisa:

```
 Seu computador (IP brasileiro)            Render (servidor publico)
 ----------------------------              -------------------------
 node agente.js  --consulta as lojas-->    /api/ingestao  --> banco --> analise --> site
```

1. Gere um token:  `npm run token`
2. No Render: *Environment* -> `COLETOR_TOKEN` = o token gerado -> *Save changes*
3. No seu computador, rode a coleta:

```
set SERVIDOR=https://meus-investimentos-x7dn.onrender.com
set COLETOR_TOKEN=o-mesmo-token
npm run coletar
```

O agente busca os produtos cadastrados no servidor, consulta as lojas daqui e envia as ofertas.
Agende esse comando no **Agendador de Tarefas do Windows** (uma vez por dia) e o historico de
precos do TCC se forma sozinho.

Para conferir quais fontes o servidor alcanca sozinho, abra `/api/diagnostico` no navegador.

## Como consultar as lojas sem ser bloqueado

Testes feitos a partir de uma rede residencial brasileira (17/09/2026):

| Caminho | Resultado | Quando usar |
|---|---|---|
| **API pública** (KaBuM!) | 200, JSON limpo | Sempre que a loja tiver uma. É o caminho mais estável e leve |
| **API oficial com credencial** (Mercado Livre) | 403 para apps não liberados | Quando houver liberação do endpoint |
| **HTML via `fetch`** (Pichau, Terabyte, Amazon) | 403 / 503 mesmo com cabeçalhos de navegador | Não funciona: as proteções exigem um navegador real |
| **Navegador real** (Playwright/Puppeteer) | Carrega normalmente (verificado na Pichau) | Para as lojas acima, rodando no agente local |
| **Lançamento manual** | Sempre funciona | Plano B garantido para a apresentação |

Boas práticas já implementadas no agente e nos coletores, que evitam bloqueio e são o
comportamento correto com quem fornece os dados:

- **Cabeçalhos de navegador** (User-Agent, Accept-Language, Origin, Referer) em toda consulta.
- **Pausa entre requisições** (`PAUSA_MS`, padrão 1,5 s) — nada de rajada.
- **Uma consulta por termo**, mesmo quando o resultado vai para vários destinos.
- **Baixa frequência**: uma coleta por dia já forma o histórico e não incomoda a loja.
- **Sem paralelismo**: as consultas são sequenciais.
- **Erro tratado, não insistido**: 403/503 viram mensagem explicativa, sem tentar de novo em loop.

O que *não* fazer: girar proxies, falsificar IP ou contornar CAPTCHA. Além de violar os termos
de uso das lojas, tornaria o trabalho indefensável na banca. Quando uma loja bloqueia
deliberadamente, as saídas legítimas são a API oficial, o navegador real em volume baixo ou
o registro manual.

## Telas

- **Produtos** — lista do que você monitora, com melhor loja, menor preço, preço-alvo e última coleta.
  Tem também uma **busca rápida**, que consulta as lojas sem salvar nada (bom para testar o termo).
- **Detalhe do produto** — veredito (onde comprar + se o momento é bom), ranking por loja,
  gráfico do histórico, todas as ofertas da última coleta e o formulário de oferta manual.
- **⚙️ Admin** — só para o administrador: contas, quantos produtos/coletas/ofertas cada uma tem,
  redefinição de senha e exclusão de conta.

## Publicar na web (Render)

Já está publicado em **https://meus-investimentos-x7dn.onrender.com** (o nome do serviço vem do
projeto anterior; para trocar, crie um serviço novo com outro nome apontando para este repositório).

O `render.yaml` está no plano **free**, então:
- **os dados são apagados a cada deploy ou reinício** — inclusive o histórico de preços;
- o serviço **dorme após 15 minutos** sem acesso e demora ~50s para acordar.

Para o TCC o histórico é o coração do trabalho: antes de começar a coletar dados de verdade,
troque para `plan: starter` e descomente o bloco `disk` + `DB_PATH` no `render.yaml`.

## Segurança

- Senhas com `scrypt` + salt aleatório; nunca em texto puro.
- Cookie de sessão `HttpOnly`, `SameSite=Lax` e `Secure` em produção.
- Máximo de 8 tentativas de login erradas por usuário/IP a cada 15 minutos.
- Cada usuário só acessa os próprios produtos, coletas e ofertas.
- **Troque a senha do admin** definindo `ADMIN_SENHA` antes de divulgar o endereço.

## Estrutura

| Arquivo | Função |
|---|---|
| `server.js` | Servidor HTTP, autenticação, rotas da API e orquestração da coleta |
| `db.js` | Banco SQLite e tabelas (`usuarios`, `sessoes`, `produtos`, `coletas`, `ofertas`) |
| `analise.js` | Regra de decisão: comparação entre lojas e avaliação do momento de compra |
| `agente.js` | Agente coletor local: consulta as lojas e envia ao servidor |
| `coletores/navegador.js` | Controla o Chrome local via DevTools Protocol (sem dependências) |
| `coletores/kabum.js` | Coletor da API pública do catálogo da KaBuM! |
| `coletores/pichau.js` | Coletor da Pichau (navegador local) |
| `coletores/terabyte.js` | Coletor da Terabyte (navegador local) |
| `coletores/magalu.js` | Coletor do Magazine Luiza (desligado: a loja bloqueia) |
| `coletores/mercadolivre.js` | Coletor da API oficial do Mercado Livre (aguardando liberação) |
| `public/index.html` | Telas de login, produtos, comparação e administração |
| `public/app.js` | Lógica da interface, gráfico de histórico e chamadas à API |
| `public/estilo.css` | Visual |
| `render.yaml` | Configuração de deploy |

Os preços são coletados das lojas e mudam a qualquer momento: confirme no site da loja antes de comprar.
