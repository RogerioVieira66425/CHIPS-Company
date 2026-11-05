<div align="center">

# CHIPS Company

### Pipeline analítico para comparação e avaliação de preços de hardware no e-commerce brasileiro

<p>
  <a href="https://meus-investimentos-x7dn.onrender.com"><img alt="Site" src="https://img.shields.io/badge/site-chips--company-E63946?style=for-the-badge&logo=render&logoColor=white"></a>
  <img alt="Status" src="https://img.shields.io/badge/status-em%20produção-2E7D32?style=for-the-badge">
  <img alt="Pipeline" src="https://img.shields.io/badge/pipeline-diário%2003%3A00%20UTC-1976D2?style=for-the-badge&logo=githubactions&logoColor=white">
</p>

<p>
  <img alt="Node" src="https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white">
  <img alt="Python" src="https://img.shields.io/badge/Python-3.10-3776AB?logo=python&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-Supabase-336791?logo=postgresql&logoColor=white">
  <img alt="scikit-learn" src="https://img.shields.io/badge/scikit--learn-1.5-F7931E?logo=scikit-learn&logoColor=white">
  <img alt="Render" src="https://img.shields.io/badge/deploy-Render-46E3B7?logo=render&logoColor=white">
</p>

<p><i>TCC em Engenharia de Computação — Faculdade de Tecnologia Pitágoras</i> · <i>Submetido à revista RECIMA21 (2026)</i></p>

<p>
  <a href="https://meus-investimentos-x7dn.onrender.com"><b>Acessar o site →</b></a> &nbsp;·&nbsp;
  <a href="#resultados"><b>Ver resultados ↓</b></a> &nbsp;·&nbsp;
  <a href="#como-rodar-localmente"><b>Como rodar ↓</b></a>
</p>

</div>

---

## Sumário

- [Contexto e motivação](#contexto-e-motivação)
- [Arquitetura em quatro camadas](#arquitetura-em-quatro-camadas)
- [Como funciona a avaliação](#como-funciona-a-avaliação)
- [Resultados](#resultados)
- [Stack técnica](#stack-técnica)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Como rodar localmente](#como-rodar-localmente)
- [Reprodutibilidade](#reprodutibilidade)
- [Conformidade com termos de uso](#conformidade-com-termos-de-uso)
- [Trabalhos futuros](#trabalhos-futuros)

---

## Contexto e motivação

O comércio eletrônico brasileiro movimentou **R$ 295,6 bilhões em 2025** (FecomercioSP), o que multiplicou o número de lojas virtuais ao alcance do consumidor. No mercado de hardware (placas de vídeo, processadores, memória, SSDs), os lançamentos são frequentes, os preços oscilam com rapidez e as mesmas ofertas aparecem em plataformas que não se comunicam. Decidir se o preço do dia é mesmo uma boa compra exige abrir cada site, consultar o histórico — ou ter um pipeline que faça isso de forma automatizada.

O **CHIPS Company** é esse pipeline. Ele coleta diariamente, armazena um histórico comparável, avalia cada oferta contra o próprio padrão do produto e apresenta a conclusão em uma aplicação web multilíngue, operando inteiramente em planos gratuitos de nuvem.

---

## Arquitetura em quatro camadas

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────┐   ┌──────────────────┐
│    COLETORES     │   │    IMPORTADOR    │   │       ANÁLISE        │   │   APLICAÇÃO WEB  │
├──────────────────┤   ├──────────────────┤   ├──────────────────────┤   ├──────────────────┤
│  KaBuM! API      │──▶│  Node.js         │──▶│  Regra de variação   │──▶│  Node + Express  │
│  Amazon Selenium │   │  deduplica       │   │  ±5% / ±10%          │   │  HTML · CSS · JS │
│                  │   │  descarta <R$ 1  │   │                      │   │  pt · en · es    │
│                  │   │                  │   │  Random Forest       │   │  Hospedado no    │
│                  │   │                  │   │  fora da amostra     │   │  Render          │
└──────────────────┘   └────────┬─────────┘   └──────────┬───────────┘   └────────┬─────────┘
                                │                        │                        ▲
                                ▼                        ▼                        │
                      ┌──────────────────────────────────────────────┐            │
                      │       Supabase · PostgreSQL · ofertas_dia    │────────────┘
                      │       (situacao, prob_ia_boa_compra)         │
                      └──────────────────────────────────────────────┘

                                       GitHub Actions · cron 03:00 UTC
```

A separação em camadas isoladas permite substituir cada parte sem afetar as outras: trocar o provedor de hospedagem, acrescentar uma loja, mudar o modelo de ML ou o front-end.

---

## Como funciona a avaliação

Cada oferta é comparada à **média dos preços dos sete dias anteriores do mesmo produto, na mesma loja**. A variação V = (P − M) / M × 100 define a faixa:

<div align="center">

<table width="100%">
<thead>
<tr>
  <th width="25%">Faixa</th>
  <th width="25%">Condição</th>
  <th width="25%">Cor no site</th>
  <th width="25%">Significado</th>
</tr>
</thead>
<tbody>
<tr><td align="center"><b>Boa compra</b></td><td align="center">V ≤ −10%</td><td align="center">🟢 Verde escuro</td><td align="center">queda relevante</td></tr>
<tr><td align="center">Queda moderada</td><td align="center">−10% &lt; V ≤ −5%</td><td align="center">🟩 Verde claro</td><td align="center">atenção ao preço</td></tr>
<tr><td align="center">Preço normal</td><td align="center">−5% &lt; V &lt; +5%</td><td align="center">🟡 Amarelo</td><td align="center">dentro do padrão</td></tr>
<tr><td align="center">Alta moderada</td><td align="center">+5% ≤ V &lt; +10%</td><td align="center">🟠 Laranja</td><td align="center">acima da média</td></tr>
<tr><td align="center"><b>Evitar</b></td><td align="center">V ≥ +10%</td><td align="center">🔴 Vermelho</td><td align="center">preço inflado</td></tr>
<tr><td align="center">Sem histórico</td><td align="center">produto novo na loja</td><td align="center">⚪ Cinza</td><td align="center">sem referência</td></tr>
</tbody>
</table>

</div>

Em paralelo, um **Random Forest** (treinado apenas com os dias anteriores ao avaliado) estima a probabilidade de uma oferta ser boa compra, usando atributos de contexto: preço, desconto absoluto em R$, volatilidade relativa, média de referência, log do preço e número de coletas anteriores. Quando a probabilidade é ≥ 0,5, o site exibe o selo **"Sugerida pela IA"** — sem alterar as cinco faixas da regra.

---

## Resultados

Base de validação: **16 dias** (20/10/2026 a 04/11/2026), **339.417 ofertas** gravadas, semente aleatória **42** em todos os experimentos.

### Regra de variação vs. métodos alternativos

AUC no teste de injeção (média de 5 dias, mesmo número de ofertas marcadas por dia):

<div align="center">

<table width="100%">
<thead>
<tr>
  <th width="55%">Método</th>
  <th width="22%">AUC</th>
  <th width="23%">Falsos alarmes</th>
</tr>
</thead>
<tbody>
<tr><td align="center"><b>Regra de variação (10%)</b></td><td align="center"><b>0,953</b></td><td align="center"><b>5,5%</b></td></tr>
<tr><td align="center">K-Means (5 grupos)</td><td align="center">0,884</td><td align="center">11,9%</td></tr>
<tr><td align="center">Isolation Forest ampliado</td><td align="center">0,850</td><td align="center">11,3%</td></tr>
<tr><td align="center">Escore z por produto e loja</td><td align="center">0,514</td><td align="center">16,6%</td></tr>
</tbody>
</table>

</div>

A regra é a mais simples e explicável e, ainda assim, supera todos os métodos alternativos avaliados.

### Random Forest fora da amostra (14 dias)

Treino apenas com dias anteriores ao avaliado, sem vazamento temporal:

<div align="center">

<table width="100%">
<thead>
<tr>
  <th width="40%">Métrica</th>
  <th width="20%">Média</th>
  <th width="20%">Mínimo</th>
  <th width="20%">Máximo</th>
</tr>
</thead>
<tbody>
<tr><td align="center">AUC vs. regra do site</td><td align="center"><b>0,999</b></td><td align="center">0,998</td><td align="center">1,000</td></tr>
<tr><td align="center">Recall vs. regra</td><td align="center">99,7%</td><td align="center">97,1%</td><td align="center">100,0%</td></tr>
<tr><td align="center"><b>Persistência no dia seguinte</b></td><td align="center"><b>72,3%</b></td><td align="center">49,2%</td><td align="center">88,0%</td></tr>
</tbody>
</table>

</div>

> **Persistência:** entre as ofertas marcadas como Boa Compra pela IA, três em cada quatro mantêm o preço abaixo de 95% da mediana histórica no dia seguinte. Esta é a validação externa, independente do rótulo usado no treino.

### Variação de preço dentro do mesmo dia

Duas extrações completas da KaBuM! em 04/11/2026 (12h20 e 18h03 UTC), 19.279 ofertas em comum:

<div align="center">

<table width="100%">
<thead>
<tr>
  <th width="40%">Observação</th>
  <th width="20%">Ofertas</th>
  <th width="40%">Detalhe</th>
</tr>
</thead>
<tbody>
<tr><td align="center">Preço inalterado</td><td align="center">17.830</td><td align="center">92,5% do total</td></tr>
<tr><td align="center"><b>Preço alterado</b></td><td align="center"><b>1.449</b></td><td align="center"><b>7,5% em ~6 horas</b></td></tr>
<tr><td align="center">Subida de 5% a 20%</td><td align="center">1.337</td><td align="center">maior categoria de mudança</td></tr>
<tr><td align="center">Queda de 5% a 20%</td><td align="center">51</td><td align="center">mediana +R$ 75,24</td></tr>
</tbody>
</table>

</div>

As categorias mais voláteis foram placas-mãe (29,8%), armazenamento (20,9%) e memórias RAM (17,1%). Teclados ficaram em 1,3%.

---

## Stack técnica

<div align="center">

<table width="100%">
<thead>
<tr>
  <th width="20%">Camada</th>
  <th width="30%">Tecnologia</th>
  <th width="50%">Finalidade</th>
</tr>
</thead>
<tbody>
<tr><td align="center"><b>Coleta</b></td><td align="center">Python · requests · Selenium · BeautifulSoup</td><td align="center">Extrai ofertas de KaBuM! e Amazon em treze termos de busca</td></tr>
<tr><td align="center"><b>Importação</b></td><td align="center">Node.js · node-postgres</td><td align="center">Deduplica, filtra preços inválidos, grava no Supabase</td></tr>
<tr><td align="center"><b>Banco</b></td><td align="center">PostgreSQL · Supabase</td><td align="center">Histórico de ofertas por dia, consulta pela aplicação</td></tr>
<tr><td align="center"><b>Análise</b></td><td align="center">scikit-learn · pandas · numpy · matplotlib</td><td align="center">Regra de variação + Random Forest + métricas</td></tr>
<tr><td align="center"><b>Aplicação web</b></td><td align="center">Node.js · Express · HTML/CSS/JS</td><td align="center">Busca, comparação, análise do produto em pt/en/es</td></tr>
<tr><td align="center"><b>Hospedagem</b></td><td align="center">Render · GitHub Actions</td><td align="center">Deploy contínuo e cron diário às 03:00 UTC</td></tr>
</tbody>
</table>

</div>

---

## Estrutura do repositório

```
📂 pipeline/
   ├── extracao_lojas.py           Coleta KaBuM! e Amazon
   ├── ml_model.py                 Regra de variação + Random Forest · grava no banco
   ├── revisao_orientador.py       Injeção, retroativo, TF-IDF, silhueta
   └── validar_ia_retroativo.py    Valida a IA fora da amostra em TODOS os dias

📂 scripts/
   └── importar-csv.js             Importa o CSV para o Supabase

📂 public/
   ├── app.js                      Interface
   ├── estilo.css                  Tema + selo "Sugerida pela IA"
   └── idiomas.js                  Português · English · Español

📂 artigo/
   └── ARTIGO_atualizado_04-11.docx  Submissão RECIMA21

📂 .github/workflows/
   └── pipeline.yml                Cron 03:00 UTC + modo somente análise

📄 server.js · ia.js · db.js       Servidor Express + consultas
📄 package.json · render.yaml      Configuração do deploy
```

---

## Como rodar localmente

**Pré-requisitos:** Node.js 22+, Python 3.10+, variável de ambiente `DATABASE_URL` apontando para um PostgreSQL (o projeto usa Supabase).

```bash
# 1. Dependências
npm install
pip install pandas numpy scikit-learn requests selenium beautifulsoup4 \
            matplotlib seaborn psycopg2-binary

# 2. Servidor local (porta 3000)
npm start

# 3. Pipeline manual (opcional)
python pipeline/extracao_lojas.py
node scripts/importar-csv.js --adicionar pipeline/saida/ofertas_consolidadas.csv
python pipeline/ml_model.py
```

Para disparar o workflow sem coleta nova (só a análise):

```bash
gh workflow run pipeline.yml -f somente_analise=true
```

---

## Reprodutibilidade

- **Semente aleatória 42** em todos os experimentos (Random Forest, K-Means, injeção).
- **Janela de referência:** somente os sete dias anteriores ao dia avaliado — evita vazamento temporal (look-ahead bias).
- **Artefatos de cada execução** salvos em `pipeline/saida/` e no artifact do workflow:

<div align="center">

<table width="100%">
<thead>
<tr>
  <th width="50%">Arquivo</th>
  <th width="50%">Conteúdo</th>
</tr>
</thead>
<tbody>
<tr><td align="center"><code>dados_enriquecidos_ia.csv</code></td><td align="center">Ofertas do dia com variação e probabilidade da IA</td></tr>
<tr><td align="center"><code>metricas_random_forest.csv</code></td><td align="center">Métricas fora da amostra do dia</td></tr>
<tr><td align="center"><code>validacao_ia_retroativo.csv</code></td><td align="center">Métricas em todos os dias anteriores da base</td></tr>
<tr><td align="center"><code>graficos_artigo/</code></td><td align="center">Gráficos da distribuição por classificação</td></tr>
</tbody>
</table>

</div>

---

## Conformidade com termos de uso

- **KaBuM!:** o `robots.txt` proíbe `/busca/*?` e `*?query=*`. A coleta usa o endpoint do catálogo com parâmetro de consulta. Ressalva mantida no artigo.
- **Amazon:** as Condições de Uso proíbem a coleta automatizada de dados. A loja é mantida nesta versão **apenas por propósito acadêmico, sem fim comercial**. Para uso em produção, a coleta da Amazon deve ser suspensa ou substituída pela Product Advertising API oficial.

---

## Trabalhos futuros

- Janela ancorada de longo prazo (ex.: menor preço dos últimos 90 dias) para mitigar o viés de ancoragem promocional em períodos como Black Friday.
- Catálogo mestre de produtos (SKU) para substituir a correspondência de nomes.
- Reativar coleta de Pichau e Terabyte.
- Monitoramento intradiário com múltiplas coletas por dia.

---

<div align="center">

**Projeto acadêmico · Reutilização livre com citação da fonte**

<a href="#chips-company">⬆ voltar ao topo</a>

</div>
