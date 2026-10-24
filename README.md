# Comparador de Preços de Equipamentos Gamer

Sistema web que monitora o preço de equipamentos gamer em várias lojas, guarda o histórico
e responde a duas perguntas: **em qual loja compensa comprar** e **se este é um bom momento**.

Projeto de TCC. Sem bibliotecas externas: só Node.js (o SQLite já vem embutido no Node 22.5+).

## Rodar no seu computador

1. Dê dois cliques em **INICIAR.bat** (ou rode `node server.js`).
2. Abra http://localhost:3000 — **o site é público**: qualquer visitante vê os produtos,
   a comparação entre lojas e o link de compra, sem precisar de conta.
3. O site **não tem login nem senha**. O catálogo de produtos acompanhados é cuidado
   pela linha de comando, com o token do coletor (veja *Produtos acompanhados*).

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

## Lojas consultadas

| Loja | Como é consultada | Situação |
|---|---|---|
| **KaBuM!** | API pública do catálogo | Funcionando |
| **Pichau** | Navegador local | Funcionando |
| **Terabyte** | Navegador local | Funcionando |
| **Patoloco** | Navegador local | Funcionando |
| **Setup Ninja** | Navegador local | Funcionando |
| **Amazon BR** | Navegador local | Funcionando |
| Magazine Luiza | Navegador local | Bloqueia acesso automatizado; desligada (`MAGALU_ATIVO=1` para testar) |
| Mercado Livre | API oficial | Bloqueada: apps não liberados recebem 403, e a busca no site exige login |
| Qualquer loja | Lançamento manual na interface | Sempre disponível |

Uma busca consulta as seis lojas ativas em cerca de 40 segundos. Exemplo real
("mouse logitech g502"): 51 ofertas coletadas, 23 relevantes, e o produto encontrado em três
lojas — KaBuM! R$ 257,39, Amazon R$ 267,34 e Pichau R$ 339,99.

### Sobre o Mercado Livre

Duas portas fechadas: a API oficial responde **403** para aplicações não liberadas (mesmo com
credenciais válidas e token emitido), e a busca pelo site redireciona para
`account-verification` — exige conta logada, inclusive num navegador real. Usar a sessão pessoal
de alguém para raspagem violaria os termos de uso, então a loja fica disponível apenas pelo
lançamento manual de ofertas.

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
- **Métricas** (`/metricas`) — desempenho de cada loja, tempo por busca e ofertas
  descartadas pelo filtro de relevância: os números do capítulo de resultados.

## Produtos acompanhados

O histórico de preço (e o veredito "é bom momento para comprar") existe para os produtos
acompanhados. Como o site é aberto, quem mexe nesse catálogo é quem tem o `COLETOR_TOKEN`,
pelo agente:

```
node agente.js --lista
node agente.js --acompanhar "Teclado Redragon Kumara K552" "redragon kumara k552"
node agente.js --esquecer "redragon kumara k552"
node agente.js --exportar     # salva as métricas em JSON, antes de um deploy apagar o banco
```

## Publicar na web (Render)

Já está publicado em **https://meus-investimentos-x7dn.onrender.com** (o nome do serviço vem do
projeto anterior; para trocar, crie um serviço novo com outro nome apontando para este repositório).

O `render.yaml` está no plano **free**, então:
- **os dados são apagados a cada deploy ou reinício** — inclusive o histórico de preços;
- o serviço **dorme após 15 minutos** sem acesso e demora ~50s para acordar.

Para o TCC o histórico é o coração do trabalho: antes de começar a coletar dados de verdade,
troque para `plan: starter` e descomente o bloco `disk` + `DB_PATH` no `render.yaml`.

## Rotinas automáticas

| Arquivo | O que faz |
|---|---|
| `INICIAR.bat` | Sobe o sistema local em http://localhost:3000 |
| `ATENDER-BUSCAS.bat` | Agente em modo serviço: responde as buscas dos visitantes do site público |
| `COLETA-DIARIA.bat` | Coleta os preços dos produtos acompanhados e grava no histórico |

A coleta diária está agendada no Windows para rodar todo dia às 09:00
(tarefa `ComparadorPrecos-ColetaDiaria`). É ela que constrói a série temporal de preços.

Para conferir, alterar o horário ou remover:

```
schtasks /Query /TN "ComparadorPrecos-ColetaDiaria"
schtasks /Change /TN "ComparadorPrecos-ColetaDiaria" /ST 20:00
schtasks /Delete /TN "ComparadorPrecos-ColetaDiaria" /F
```

## Desempenho e métricas

As lojas são consultadas **em paralelo**: uma busca completa leva cerca de 18 segundos
(eram 45 quando era uma loja por vez). A tela **Métricas** mostra, a partir das buscas reais:
número de buscas, tempo médio e mediano, taxa de sucesso e tempo de resposta de cada loja,
quantas ofertas foram descartadas pelo filtro de relevância e os termos mais procurados —
material direto para o capítulo de resultados.

### Frete por CEP (em aberto)

A infraestrutura existe (`coletores/frete.js`): o agente abre a página da oferta, digita o CEP
com eventos de teclado reais do Chrome e lê o bloco de entrega. Funciona quando a página é
operada manualmente, mas as lojas não disparam o cálculo de frete para o navegador automatizado —
testado na KaBuM!, Pichau e Terabyte, com digitação caractere a caractere, clique real de mouse e
janela visível. Por isso o frete continua entrando como zero (ou pelo lançamento manual), e o
sistema deixa claro na tela quando o valor é apenas o preço do produto.

## Banco de dados

O sistema grava em **Postgres no Supabase** quando a variável `DATABASE_URL` está definida
(string do botão *Connect* → *Session pooler*). Sem ela, usa um arquivo SQLite local
(`precos.db`), para testar na sua máquina.

- As tabelas são criadas sozinhas na primeira inicialização, nos dois casos.
- No Render, a variável fica em *Environment*. No plano gratuito o SQLite some a cada deploy;
  o Supabase não.
- Os dados enriquecidos pela IA (`ofertas_ia`) são carregados a partir do CSV:

```
npm run importar-ia -- "C:\Users\roger\Downloads\dados_enriquecidos_ia.csv"
```

(com `DATABASE_URL` definida na sessão do PowerShell: `$env:DATABASE_URL="..."`)

Leitura: `/api/ia/resumo` e `/api/ia/ofertas?situacao=Boa%20Compra&loja=KaBuM!&q=teclado`.

## Segurança

O site é público e não guarda conta nem senha de ninguém: não há login, sessão nem dado
pessoal no banco. O que protege o sistema é o escopo das rotas.

- **Leitura é aberta**: buscar, comparar e ver histórico não exige nada.
- **Escrita exige o token do coletor** (`COLETOR_TOKEN`, header `X-Coletor-Token`), comparado
  em tempo constante: cadastrar produto, coletar preços e ingerir resultados só acontecem
  a partir do agente.
- **Busca com limite por endereço**: 30 a cada 10 minutos (`MAX_BUSCAS`). Cada busca vira
  consulta às seis lojas a partir da rede do agente; sem limite, um robô usaria o site para
  martelar as lojas em nome de quem hospeda o agente. Resultado repetido sai do cache e não
  consome o limite.
- **Fila que se recupera**: busca entregue ao agente que não volta em 3 minutos retorna à
  fila; pedido parado há mais de 15 minutos é encerrado.
- **Endereço de anúncio só vale `http(s)`**, tanto ao gravar quanto ao exibir: um
  `javascript:` vindo de uma página de loja não vira link clicável.
- **Consultas às lojas têm prazo** (15s nas APIs, 45s no navegador), para uma conexão
  pendurada não travar a rodada inteira do agente.

## Estrutura

| Arquivo | Função |
|---|---|
| `server.js` | Servidor HTTP, rotas da API, fila de buscas e orquestração da coleta |
| `db.js` | Banco SQLite e tabelas (`produtos`, `coletas`, `ofertas`, `buscas`) |
| `analise.js` | Regra de decisão: comparação entre lojas e avaliação do momento de compra |
| `agente.js` | Agente coletor local: consulta as lojas e envia ao servidor |
| `coletores/navegador.js` | Controla o Chrome local via DevTools Protocol (sem dependências) |
| `coletores/kabum.js` | Coletor da API pública do catálogo da KaBuM! |
| `coletores/pichau.js` | Coletor da Pichau (navegador local) |
| `coletores/patoloco.js` | Coletor da Patoloco (navegador local) |
| `coletores/setupninja.js` | Coletor da Setup Ninja (navegador local) |
| `coletores/amazon.js` | Coletor da Amazon BR (navegador local) |
| `coletores/terabyte.js` | Coletor da Terabyte (navegador local) |
| `coletores/magalu.js` | Coletor do Magazine Luiza (desligado: a loja bloqueia) |
| `coletores/mercadolivre.js` | Coletor da API oficial do Mercado Livre (aguardando liberação) |
| `public/index.html` | Telas de busca, comparação, produto acompanhado e métricas |
| `public/app.js` | Lógica da interface, gráfico de histórico e chamadas à API |
| `public/estilo.css` | Visual |
| `render.yaml` | Configuração de deploy |

Os preços são coletados das lojas e mudam a qualquer momento: confirme no site da loja antes de comprar.
