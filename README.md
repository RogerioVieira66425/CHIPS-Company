# Comparador de Preços de Equipamentos Gamer

Sistema web que monitora o preço de equipamentos gamer em várias lojas, guarda o histórico
e responde a duas perguntas: **em qual loja compensa comprar** e **se este é um bom momento**.

Projeto de TCC. Sem bibliotecas externas: só Node.js (o SQLite já vem embutido no Node 22.5+).

## Rodar no seu computador

1. Dê dois cliques em **INICIAR.bat** (ou rode `node server.js`).
2. Abra http://localhost:3000 e entre com **admin / admin**, ou crie sua conta.

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

| Fonte | Como entra | Situação (testado em 17/09/2026) |
|---|---|---|
| **KaBuM!** | API pública do catálogo | **Funcionando**, sem credenciais |
| Mercado Livre | API oficial (`/sites/MLB/search`) | **Bloqueada**: aplicações comuns recebem 403 |
| Pichau, Terabyte, Magalu | HTML público | Respondem 403 a requisições fora do navegador |
| Amazon BR | HTML público | Responde 503 (proteção anti-robô) |
| Qualquer loja | Lançamento manual na interface | Sempre disponível |

### A restrição do Mercado Livre (limitação documentada do projeto)

A integração com o Mercado Livre está implementada e a autenticação funciona: o app emite o
token normalmente pelo fluxo *client credentials*. O que o Mercado Livre bloqueia é a consulta:
o endpoint `/sites/MLB/search` passou a responder **403 forbidden** para aplicações que não foram
liberadas, mesmo com token válido e permissão de leitura. Vários desenvolvedores relataram a
mesma mudança em 2025, e a liberação exige pedido ao suporte / Developer Partner Program.

A busca em HTML público (`lista.mercadolivre.com.br`) também não serve de alternativa: o site
devolve uma página de verificação de "tráfego suspeito" para requisições que não vêm de um navegador.

O coletor continua no projeto e volta a funcionar sozinho no dia em que o acesso for liberado —
basta as credenciais estarem configuradas. É bom material para a seção de limitações e decisões
de projeto do TCC: mostra dependência de terceiros e o valor de uma arquitetura de coletores
intercambiáveis.

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
| `coletores/kabum.js` | Coletor da API pública do catálogo da KaBuM! |
| `coletores/mercadolivre.js` | Coletor da API oficial do Mercado Livre (aguardando liberação) |
| `public/index.html` | Telas de login, produtos, comparação e administração |
| `public/app.js` | Lógica da interface, gráfico de histórico e chamadas à API |
| `public/estilo.css` | Visual |
| `render.yaml` | Configuração de deploy |

Os preços são coletados das lojas e mudam a qualquer momento: confirme no site da loja antes de comprar.
