# Seções corrigidas do artigo

Os itens marcados com **[CONFIRMAR]** ou **[preencher]** precisam de dados ou conferência antes do envio.

---

## 3.2 Arquitetura do sistema

O sistema foi organizado em quatro camadas. A **extração** é feita por scripts em Python: a KaBuM! é consultada pela API pública de catálogo, e a Amazon, por navegação automatizada com Selenium. O **armazenamento** usa PostgreSQL, hospedado no Supabase, com uma tabela principal (`ofertas_dia`) em que cada linha é uma oferta observada em um dia. O **tratamento** ocorre em duas etapas: a importação do dia, que remove duplicatas e grava os registros, e a análise com Isolation Forest (scikit-learn), que gera tabelas e gráficos de apoio. A **apresentação** é uma aplicação web em Node.js, hospedada no Render, que consulta diretamente essa tabela.

A atualização é executada diariamente pelo GitHub Actions, às 00:00 do horário de Brasília. As ferramentas utilizadas são: Python 3.10 (requests, BeautifulSoup, Selenium, pandas, scikit-learn, matplotlib e seaborn), Node.js 22 (servidor e importador) e PostgreSQL no Supabase **[CONFIRMAR: versão exata]**.

## 3.3 Coleta e deduplicação

Foram monitoradas duas lojas virtuais de hardware: KaBuM! e Amazon Brasil. As lojas Pichau e Terabyte foram incluídas nas primeiras versões da coleta, mas deixaram de ser coletadas, porque a estrutura de suas páginas mudou e o processo de extração não se manteve estável **[CONFIRMAR: confirme se essa é a razão]**. Para cada oferta são registrados: identificador do produto na loja, nome do anúncio, categoria, preço, loja, URL do anúncio e data da coleta.

Uma mesma oferta pode aparecer em mais de uma página ou categoria durante a coleta. Por isso, dentro de um mesmo arquivo diário, registros com o mesmo identificador, loja, data, nome e preço são contados uma única vez. A data de cada coleta segue o horário de Brasília: uma primeira versão usava o horário do servidor, em UTC, e as coletas noturnas caíam no dia seguinte, o que foi corrigido.

A coleta da Amazon apresentou bloqueios intermitentes: em algumas execuções, a primeira página de cada termo era devolvida sem produtos. Para tratar esse caso, os termos sem resposta são repetidos em rodadas posteriores, com intervalos crescentes entre as tentativas. Mesmo assim, há dias sem dados dessa loja, o que é tratado como limitação (Seção 5).

## 3.4 Armazenamento e indicadores históricos

Os dados ficam em uma única tabela, `ofertas_dia`, com uma linha por oferta e por dia de coleta. A série histórica de um produto é reconstruída pelo nome do anúncio, e os indicadores são calculados a cada consulta: menor, mediana, média e maior preço, além do preço mínimo de cada dia, usado no gráfico de evolução.

Ao avaliar uma oferta, a referência usada pelo site é a mediana de todas as coletas disponíveis do produto, inclusive a própria coleta que está sendo avaliada. Essa escolha simplifica o cálculo, mas significa que a avaliação não é feita apenas com dados anteriores à data analisada. Essa limitação é discutida na Seção 5.

## 3.5 Classificação da situação de compra

A classificação foi implementada em dois componentes.

**a) Regra histórica (aplicação web).** A avaliação exibida ao consumidor segue as regras abaixo, aplicadas ao conjunto de coletas do produto:

- **Sem histórico:** produtos com menos de dois dias de coleta.
- **Preço constante:** quando todas as coletas têm o mesmo valor, a oferta recebe "Preço médio".
- **Boa compra:** preço até 2% acima do menor valor já observado, ou preço abaixo de 95% da mediana.
- **Evitar:** preço acima de 105% da mediana.
- **Preço médio:** nos demais casos.

**b) Isolation Forest (etapa de análise do pipeline).** Para cada oferta do dia, calcula-se a variação percentual em relação à média das coletas anteriores do mesmo produto (dados até o dia anterior). O Isolation Forest (Liu; Ting; Zhou, 2008) é treinado sobre essas variações, com contaminação de 2%, e marca as ofertas isoladas como anomalias. Também são classificadas como "Boa Compra" e "Evitar" as variações de, respectivamente, até -10% e a partir de +10%. Esse resultado é gravado em arquivo de análise e não é exibido na aplicação web.

Portanto, a classificação apresentada ao consumidor é a regra histórica do item (a). O Isolation Forest compõe a etapa de análise do pipeline **[CONFIRMAR: indique se algum resultado do modelo foi usado no texto]**.

## 3.6 Aplicação web

A aplicação é de acesso livre, sem cadastro, em português, inglês e espanhol. O fluxo do usuário, representado na Figura 1, tem três telas principais:

- **Início:** campo de busca com sugestões enquanto o usuário digita e lista de buscas recentes.
- **Resultados:** listagem das ofertas com filtros por marca, categoria, loja e preço, ordenação, paginação e destaque do menor preço.
- **Análise do produto:** preço da oferta, preço de referência (mediana das coletas), variação, avaliação, faixa de preços, gráfico de histórico (com os períodos Tudo, 7 dias e 30 dias), menor preço por loja e lista de todas as ofertas do produto.

O sistema também corrige erros de digitação, sugerindo termos alternativos, e informa quando não há resultados ou quando o histórico é insuficiente.

*Figura 1. Fluxograma de navegação do usuário na aplicação web. Fonte: elaborado pelos autores (2026).*

---

## 4. Resultados e discussão

### 4.1 Execução do pipeline

Durante o período analisado, de 20 a 26 de outubro de 2026, a base reuniu coletas diárias de **[CONFIRMAR: número de dias e lojas por dia]**. A Tabela 1 resume as execuções.

**Tabela 1.** Ofertas gravadas por dia e por loja.

| Dia | KaBuM! | Amazon | Total |
|---|---|---|---|
| 20/10 | [preencher] | [preencher] | [preencher] |
| 21/10 | [preencher] | [preencher] | [preencher] |
| 22/10 | [preencher] | [preencher] | [preencher] |
| 23/10 | [preencher] | [preencher] | [preencher] |
| 24/10 | [preencher] | [preencher] | [preencher] |
| 25/10 | [preencher] | [preencher] | [preencher] |

*Fonte: elaborado pelos autores (2026), a partir da base do sistema.*

### 4.2 Deduplicação

Dentro de cada arquivo diário, a deduplicação removeu **[CONFIRMAR: número]** registros repetidos, o que corresponde a **[CONFIRMAR: percentual]** das linhas brutas. A taxa de repetição variou entre as lojas **[CONFIRMAR: detalhar por loja]**.

### 4.3 Classificação das ofertas

A Tabela 2 mostra a distribuição das avaliações. **[CONFIRMAR: indique a base de cálculo, por exemplo, o arquivo `dados_enriquecidos_ia.csv` de qual execução.]**

**Tabela 2.** Distribuição das ofertas por avaliação.

| Avaliação exibida | Ofertas (n) | % |
|---|---|---|
| Boa compra | [preencher] | [preencher] |
| Preço médio | [preencher] | [preencher] |
| Evitar | [preencher] | [preencher] |
| Sem histórico | [preencher] | [preencher] |
| **Total** | [preencher] | 100,0% |

*Fonte: elaborado pelos autores (2026).*

Como a história de preços do período tem poucos dias, boa parte dos produtos apresenta preço constante, e a maioria recebe "Preço médio". Esse é o principal limite de interpretação dos resultados neste estudo.

### 4.4 Aplicação em funcionamento

As Figuras 2 a 4 ilustram a aplicação. A Figura 2 mostra a tela inicial. A Figura 3 mostra os resultados de uma busca, com o destaque da oferta de menor preço. A Figura 4 apresenta a análise de produto em três situações: (a) "Boa compra", quando o preço atual está próximo do menor valor observado; (b) "Evitar", quando o preço atual está acima da mediana **[CONFIRMAR: percentual exato, conforme a tela]**; (c) "Preço médio", quando o preço permaneceu estável no período.

*Figuras 2 a 4: capturas da aplicação web. Fonte: elaborado pelos autores (2026).*

---

## 5. Considerações finais

O objetivo do estudo foi especificar, implementar e avaliar um pipeline analítico para comparação de preços de hardware. Os objetivos foram alcançados nos limites descritos: a coleta e a importação diária são automatizadas e executadas em nuvem pelo GitHub Actions; os dados ficam em uma base PostgreSQL; a aplicação web apresenta ao consumidor o histórico de preços, a avaliação da oferta e a comparação entre lojas.

Como limitações, destacam-se:

- o curto período de histórico, o que limita a identificação de tendências;
- a ausência de uma base rotulada para medir a precisão das avaliações;
- a dependência da estrutura das páginas das lojas, e os bloqueios intermitentes da Amazon, que deixaram alguns dias sem dados dessa loja;
- a inclusão da própria coleta no cálculo da mediana, o que reduz a independência entre a referência e a observação avaliada;
- a cobertura de apenas duas lojas;
- as cotas da infraestrutura gratuita.

Trabalhos futuros podem incluir a recuperação da cobertura de outras lojas, uma referência de preço calculada apenas com dados anteriores à data avaliada e a validação das avaliações com um conjunto de ofertas rotuladas por especialistas.

---

## Pontos a conferir antes do envio

- Todos os itens **[CONFIRMAR]** e **[preencher]**.
- Os DOIs das referências, que não foram verificados.
- A declaração de uso de IA, se ela for mantida.
