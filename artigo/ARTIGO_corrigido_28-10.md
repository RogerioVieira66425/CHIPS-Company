# PIPELINE ANALÍTICO PARA COMPARAÇÃO E AVALIAÇÃO DE PREÇOS DE HARDWARE NO COMÉRCIO ELETRÔNICO BRASILEIRO

**ANALYTICAL PIPELINE FOR PRICE COMPARISON AND EVALUATION OF HARDWARE PRICES IN BRAZILIAN E-COMMERCE**

**PIPELINE ANALÍTICO PARA LA COMPARACIÓN Y EVALUACIÓN DE PRECIOS DE HARDWARE EN EL COMERCIO ELECTRÓNICO BRASILEÑO**

---

## RESUMO

O crescimento do comércio eletrônico multiplicou as lojas virtuais que vendem componentes de hardware, mas espalhou as informações de preço entre plataformas que não se comunicam, o que dificulta saber se uma oferta é de fato vantajosa. Este artigo descreve o desenvolvimento e a validação de um pipeline analítico que coleta, armazena, avalia e apresenta preços de hardware em lojas virtuais. A solução foi organizada em quatro camadas: extração automatizada por web scraping (KaBuM! e Amazon), armazenamento relacional em PostgreSQL hospedado no Supabase, tratamento analítico e apresentação em uma aplicação web. A avaliação de cada oferta compara o preço atual com a média das coletas dos sete dias anteriores: quedas ou altas de 10% ou mais recebem destaque, e variações entre 5% e 10% recebem uma faixa moderada. A validação utilizou oito dias de coleta (20 a 27/10/2026), com 22.887 registros brutos na coleta de 25/10 e 20.924 ofertas únicas gravadas. Em um teste de injeção de variações conhecidas, a regra foi comparada ao Isolation Forest, utilizado em uma versão anterior: a regra ordenou melhor as variações em todos os dias testados (AUC entre 0,975 e 0,991, contra 0,922 a 0,968 do modelo). Com a regra de 10%, quedas de 20% foram detectadas em 99,3% dos casos, com 1,8% de falsos alarmes. Os resultados mostram que a arquitetura pode operar em níveis gratuitos de nuvem e que a avaliação por variação é simples de explicar, e, no teste retroativo, 98,4% das ofertas classificadas como boa compra e 98,5% das classificadas como evitar permaneceram fora da faixa habitual de preço no dia seguinte.

**PALAVRAS-CHAVE:** Engenharia de Dados. Banco de Dados Relacional. Web Scraping. Variação de Preços. Comércio Eletrônico. Hardware.

## ABSTRACT

The growth of e-commerce has multiplied the online stores that sell hardware components, but it has also scattered price information across platforms that do not communicate, making it hard to tell whether an offer is truly advantageous. This article describes the development and validation of an analytical pipeline that collects, stores, evaluates and presents hardware prices from online stores. The solution is organized in four layers: automated extraction through web scraping (KaBuM! and Amazon), relational storage in PostgreSQL hosted on Supabase, analytical processing, and presentation in a web application. The evaluation of each offer compares the current price with the average of the collections from the seven previous days: drops or rises of 10% or more are highlighted, and variations between 5% and 10% fall in a moderate band. Validation used eight days of collection (October 20 to 27, 2026), with 22,887 raw records in the October 25 collection and 20,924 unique offers stored. In an injection test of known price variations, the rule was compared with the Isolation Forest, used in a previous version: the rule ranked the variations better on every day tested (AUC between 0.975 and 0.991, against 0.922 to 0.968 for the model). With the 10% rule, drops of 20% were detected in 99.3% of cases, with 1.8% false alarms. The results show that the architecture can run on free cloud tiers and that the variation-based evaluation is simple to explain. In the retroactive test, 98.4% of the offers classified as good purchases and 98.5% of those classified as avoid remained outside the usual price range on the following day.

**KEYWORDS:** Data Engineering. Relational Database. Web Scraping. Price Variation. E-commerce. Hardware.

## RESUMEN

El crecimiento del comercio electrónico multiplicó las tiendas virtuales que venden componentes de hardware, pero también dispersó la información de precios entre plataformas que no se comunican, lo que dificulta saber si una oferta es realmente ventajosa. Este artículo describe el desarrollo y la validación de un pipeline analítico que recolecta, almacena, evalúa y presenta precios de hardware en tiendas virtuales. La solución se organizó en cuatro capas: extracción automatizada mediante web scraping (KaBuM! y Amazon), almacenamiento relacional en PostgreSQL alojado en Supabase, tratamiento analítico y presentación en una aplicación web. La evaluación de cada oferta compara el precio actual con el promedio de las recolecciones de los siete días anteriores: las bajas o alzas de 10% o más se destacan, y las variaciones entre 5% y 10% se clasifican en una banda moderada. La validación utilizó ocho días de recolección (del 20 al 27 de octubre de 2026), con 22.887 registros brutos en la recolección del 25 de octubre y 20.924 ofertas únicas almacenadas. En una prueba de inyección de variaciones conocidas, la regla se comparó con el Isolation Forest, utilizado en una versión anterior: la regla ordenó mejor las variaciones en todos los días probados (AUC entre 0,975 y 0,991, frente a 0,922 a 0,968 del modelo). Con la regla de 10%, las bajas de 20% se detectaron en el 99,3% de los casos, con 1,8% de falsas alarmas. Los resultados muestran que la arquitectura puede operar en niveles gratuitos de la nube y que la evaluación por variación es simple de explicar. En la prueba retroactiva, el 98,4% de las ofertas clasificadas como buena compra y el 98,5% de las clasificadas como evitar permanecieron fuera del rango habitual de precio al día siguiente.

**PALABRAS CLAVE:** Ingeniería de Datos. Base de Datos Relacional. Web Scraping. Variación de Precios. Comercio Electrónico. Hardware.

---

## 1. INTRODUÇÃO

Em 2025, o comércio eletrônico brasileiro faturou R$ 295,6 bilhões, um recorde que supera em 20% o resultado de 2024 (FECOMERCIOSP, 2026). Com essa expansão, o consumidor passou a contar com um número muito maior de lojas virtuais para comprar produtos eletrônicos. Bakos (1997) observava que a multiplicação dos canais de venda reduz o custo de busca, mas alertava que, quando os preços ficam espalhados por plataformas que não se integram, a assimetria de informação pode aumentar em vez de diminuir.

No mercado de hardware, que inclui processadores, placas de vídeo, memórias e placas-mãe, esse problema é especialmente evidente. Os lançamentos são frequentes, os preços oscilam com rapidez e a disponibilidade de um mesmo componente muda de uma loja para outra. Nesse cenário, olhar apenas para o menor preço exibido no momento da compra diz pouco sobre a qualidade da oferta, porque não revela se aquele valor está acima ou abaixo do que costuma ser praticado para o item (KRUPCZAK; VEIGA, 2024).

Desse contexto surge o problema que orienta este trabalho: como oferecer ao consumidor uma visão consolidada e historicamente contextualizada dos preços de componentes de hardware, que permita avaliar se o preço atual está acima, abaixo ou dentro do padrão do próprio produto? Para responder a essa questão, definiu-se como objetivo geral desenvolver e documentar uma plataforma de dados capaz de comparar preços de produtos eletrônicos entre diferentes lojas, integrando coleta automatizada, armazenamento, avaliação por variação de preço e apresentação dos resultados ao usuário.

Para alcançar esse objetivo, foram estabelecidos os seguintes objetivos específicos: (i) construir um pipeline de extração automatizada de preços em lojas virtuais, com execução diária em nuvem; (ii) armazenar os dados em um banco relacional organizado por dia de coleta; (iii) tratar as variações de preço de modo a não confundir oscilações habituais com mudanças relevantes; (iv) avaliar cada oferta em relação ao histórico recente do próprio produto e comparar essa avaliação com um modelo de detecção de anomalias; e (v) disponibilizar as informações em uma aplicação web voltada à decisão do consumidor.

A relevância do trabalho pode ser observada sob dois aspectos. No plano prático, a solução poupa o consumidor de consultar várias lojas manualmente e transforma dados dispersos em indicadores fáceis de interpretar. No plano acadêmico, o projeto reúne em um único pipeline conteúdos centrais da formação em Engenharia de Computação, como modelagem de dados, automação de processos, estatística aplicada e desenvolvimento web, além de um teste comparativo entre um método simples e um método de aprendizado de máquina.

Além desta introdução, o artigo está organizado em quatro seções. A primeira apresenta o referencial teórico. A segunda descreve a metodologia e cada camada do pipeline. A terceira apresenta e discute os resultados. A quarta reúne as considerações finais, as limitações e as sugestões de trabalhos futuros.

## 2. REFERENCIAL TEÓRICO

### 2.1 Comparação de preços e custo de busca no comércio eletrônico

A teoria do custo de busca sustenta que, quanto maior o esforço necessário para obter informações sobre preços, maior a dispersão tolerada no mercado. Bakos (1997) argumenta que os mercados eletrônicos reduzem esse custo e tendem a intensificar a concorrência por preço, desde que o consumidor tenha acesso a uma visão comparável das ofertas. Esse benefício depende de um agregador que colete e padronize os dados. Sem ele, o aumento no número de lojas pode produzir o efeito contrário, pois obriga o consumidor a visitar cada site para montar, por conta própria, um panorama dos preços.

### 2.2 Coleta automatizada de dados na web

A coleta automatizada de dados na web (web scraping) consiste na extração programática de informações publicadas em páginas da internet, convertendo conteúdo semiestruturado em dados estruturados passíveis de análise (MITCHELL, 2018). Em aplicações de monitoramento de preços, essa técnica permite construir séries históricas sem depender de interfaces oficiais das lojas, mas exige tratamento das diferenças de estrutura entre sites, das mudanças de layout e das limitações de acesso impostas pelas plataformas. Trabalhos brasileiros já empregaram a técnica para comparação de preços no comércio eletrônico (OLIVEIRA, 2022).

### 2.3 Armazenamento e modelagem de dados

Um banco relacional organiza os dados em tabelas com chaves e restrições, o que permite consultas consistentes sobre o histórico de preços. Para cenários analíticos, em que as leituras são muito mais frequentes que as escritas, a literatura de data warehouse recomenda a modelagem dimensional em esquema estrela, na qual uma tabela fato guarda as medidas de um processo e tabelas dimensão guardam o contexto dessas medidas (KIMBALL; ROSS, 2013). Neste trabalho, a estrutura adotada é uma tabela de ofertas por dia de coleta, que concentra o fato (o preço observado) e os atributos de produto e loja. A escolha reflete o volume atual da base, de algumas centenas de milhares de registros, em que um esquema estrela completo ainda não traria ganho proporcional à complexidade.

### 2.4 Valores atípicos e viés de antecipação

Dois problemas estatísticos merecem atenção nesse tipo de sistema. O primeiro são os valores atípicos (outliers), que podem surgir de erros de cadastro, de promoções isoladas ou de falhas na extração. Hawkins (1980) os define como observações que se afastam tanto das demais que levantam a suspeita de terem sido produzidas por outro mecanismo. O segundo é o viés de antecipação (look-ahead bias), um caso particular do vazamento de dados (data leakage). Ele ocorre quando uma informação que só estaria disponível depois do momento analisado é usada para calcular uma métrica ou avaliar um evento anterior, o que gera resultados otimistas demais e impossíveis de reproduzir na prática (KAUFMAN et al., 2012). Em uma série de preços, isso equivale a calcular a referência de uma oferta usando coletas posteriores a ela.

### 2.5 Detecção de anomalias e Isolation Forest

Uma forma simples de identificar valores atípicos é aplicar limites fixos de variação em relação a uma referência. Essa abordagem é fácil de implementar e de explicar, mas trata todos os produtos da mesma maneira. A detecção de anomalias por aprendizado de máquina procura contornar essa limitação ao aprender, a partir dos próprios dados, o que é um comportamento usual para cada item.

Entre os métodos não supervisionados, destaca-se o Isolation Forest (LIU; TING; ZHOU, 2008). O algoritmo parte da ideia de que observações anômalas são raras e diferentes das demais e, por isso, podem ser separadas com menos partições aleatórias. A implementação utilizada é a do scikit-learn (PEDREGOSA et al., 2011). Um ponto importante é que o parâmetro de contaminação, que define a fração de observações marcadas como anômalas, determina apenas o limiar de decisão: a ordenação das observações não depende dele. Por isso, a qualidade do modelo pode ser avaliada pela área sob a curva ROC (AUC), que mede a capacidade de separar observações alteradas das não alteradas em todos os limiares possíveis (FAWCETT, 2006).

## 3. METODOLOGIA

### 3.1 Caracterização da pesquisa

Trata-se de uma pesquisa aplicada, de abordagem quantitativa e caráter exploratório, cujo resultado é um artefato de software: o pipeline analítico proposto para o problema apresentado na introdução. A validação foi feita com dados reais de oito dias de coleta, de 20 a 27 de outubro de 2026, e com um teste de injeção de variações conhecidas, descrito na seção 4.3.

### 3.2 Extração dos dados

A camada de extração coleta os preços em lojas virtuais que atuam no Brasil. Foram definidos 13 termos de busca, associados a nove categorias de produto: placas de vídeo, processadores, placas-mãe, memórias RAM, armazenamento, fontes, teclados, mouses e áudio. Na KaBuM!, a coleta utiliza a interface de catálogo em formato JSON consumida pelo próprio site, percorrendo as páginas de resultados. Na Amazon, a navegação é automatizada com Selenium (SELENIUM PROJECT, 2026) e o conteúdo HTML é interpretado com a biblioteca BeautifulSoup (RICHARDSON, 2026). Os coletores da Pichau e da Terabyte participaram apenas da coleta de 20 de outubro de 2026 e estão desativados na versão atual. Cada execução gera um arquivo com o identificador do produto na loja, o nome, a categoria, a loja, o preço, o endereço da oferta e a data e hora da coleta.

Como a Amazon bloqueou requisições de servidores de nuvem em algumas execuções, a coleta dessa loja passou a repetir os termos que retornaram sem produtos, em rodadas posteriores com intervalos crescentes. Na coleta de 25 de outubro, a Amazon respondeu em todas as rodadas necessárias, com 1.620 ofertas brutas, após seis rodadas.

### 3.3 Armazenamento

Os dados são armazenados em um banco PostgreSQL hospedado no Supabase, em uma tabela de ofertas (ofertas_dia), na qual cada linha representa uma oferta observada em um dia de coleta. O identificador do produto é armazenado como texto, pois as lojas usam formatos distintos: a KaBuM! utiliza números, a Amazon, códigos alfanuméricos do tipo ASIN. A carga de cada dia substitui os registros daquele dia, sem alterar os demais, de modo que uma nova execução para o mesmo dia não duplica dados.

### 3.4 Deduplicação e tratamento

Antes da gravação, os registros de cada arquivo diário passam por uma deduplicação. A chave utilizada é o conjunto formado pelo identificador do produto, a loja, a data, o nome e o preço: registros idênticos nessa chave são contados uma vez. Também são descartados os registros com preço de preenchimento (9.999,99) e os registros incompletos. Na coleta de 25 de outubro, o log da importação registrou 20.924 linhas válidas, 5 descartadas e 1.959 repetidas, todas gravadas no banco. Sobre um total de 22.887 registros brutos, a perda foi de 1.963 registros. A soma dos valores do log (22.888) supera em uma unidade o total de registros brutos, diferença que o próprio log não explica [CONFIRMAR].

### 3.5 Avaliação da oferta: regra de variação

Cada oferta recebe uma avaliação com base na variação do seu preço em relação à média das coletas dos sete dias anteriores ao dia avaliado. Seja P o preço atual da oferta e M a média dos preços do mesmo produto nessa janela, a variação é dada pela Equação 1:

V = (P − M) / M × 100        (1)

A janela contém somente coletas anteriores à oferta avaliada, o que evita o viés de antecipação. O cálculo é feito em Python com a biblioteca pandas (MCKINNEY, 2010), a partir dos registros gravados no banco. A classificação é definida pelos seguintes limites:

- **Boa compra:** V ≤ −10%, isto é, queda de 10% ou mais;
- **Queda moderada:** −10% < V ≤ −5%;
- **Preço normal:** −5% < V < +5%;
- **Alta moderada:** +5% ≤ V < +10%;
- **Evitar:** V ≥ +10%, isto é, alta de 10% ou mais;
- **Sem histórico:** produtos sem coleta anterior na janela.

A tela da aplicação exibe essa classificação. Quando a classificação gravada pelo pipeline não está disponível, a aplicação utiliza uma regra de reserva, que compara o preço com a mediana das coletas anteriores do produto. Essa regra de reserva é usada somente em casos excepcionais.

### 3.6 Modelo alternativo: Isolation Forest

Na versão anterior do pipeline, a classificação era feita pelo Isolation Forest, com a variação de cada oferta como única variável, parâmetro de contaminação de 0,047 e limite de relevância de 5%. Essa versão foi substituída pela regra de variação, pelos motivos apresentados na seção de resultados. O Isolation Forest permanece descrito neste artigo como alternativa avaliada.

### 3.7 Automação do pipeline

A execução diária é feita pelo GitHub Actions (GITHUB, 2026), todos os dias às 03:00 UTC, correspondentes à meia-noite do horário de Brasília. O fluxo de trabalho executa, nessa ordem: a extração das lojas; a gravação do dia no banco; a avaliação das ofertas, cujo resultado é gravado em cada registro do dia; e a publicação dos arquivos de resultado como artefato da execução. O fluxo também pode ser iniciado manualmente, inclusive em modo somente de análise, sem nova coleta.

### 3.8 Aplicação web

A camada de apresentação é uma aplicação web hospedada na plataforma Render, com servidor em Node.js e interface em HTML, CSS e JavaScript. O usuário pode buscar um produto, comparar o menor preço em cada loja, filtrar e ordenar as ofertas e consultar a página de análise, que mostra o preço da oferta, a referência de preço, a variação, a avaliação, o histórico de preços em períodos de 7 e 30 dias e o melhor preço de cada loja. A interface é disponibilizada em português, inglês e espanhol.

## 4. RESULTADOS E DISCUSSÃO

### 4.1 Volume das coletas

A base reúne oito dias de coleta, de 20 a 27 de outubro de 2026, totalizando 167.832 ofertas gravadas. A Tabela 1 mostra o volume por dia e por loja, após a deduplicação.

**Tabela 1.** Ofertas gravadas por dia e por loja, após a deduplicação.

| Dia | KaBuM! | Amazon | Pichau | Terabyte | Total |
|---|---|---|---|---|---|
| 20/10 | 18.496 | 2.680 | 142 | 63 | 21.381 |
| 21/10 | 18.952 | – | – | – | 18.952 |
| 22/10 | 18.963 | 2.574 | – | – | 21.537 |
| 23/10 | 19.637 | – | – | – | 19.637 |
| 24/10 | 19.549 | 2.682 | – | – | 22.231 |
| 25/10 | 19.607 | 1.317 | – | – | 20.924 |
| 26/10 | 19.388 | 1.648 | – | – | 21.036 |
| 27/10 | 19.433 | 2.701 | – | – | 22.134 |
| **Total** | **154.025** | **13.602** | **142** | **63** | **167.832** |

*Fonte: elaborado pelos autores (2026), a partir da base do sistema.*

A Amazon não aparece nos dias 21 e 23 de outubro, por bloqueios durante a coleta, e a Pichau e a Terabyte aparecem apenas em 20 de outubro. Na coleta de 25 de outubro, que serve de referência para a validação, foram obtidos 22.887 registros brutos (21.267 da KaBuM! e 1.620 da Amazon), dos quais 20.924 foram gravados, com perda de 1.963 registros (8,6%). Na base, 25.297 pares produto-loja aparecem ao longo do período; desses, 13.682 (54,1%) foram observados em todos os oito dias, e 1.961 (7,8%) em um único dia.

A cobertura por produto é, em média, de 6,6 observações por par produto-loja (167.832 ofertas divididas por 25.297 pares), o que equivale a cerca de 5,8 observações por semana. A distribuição, porém, é desigual, e essa desigualdade afeta a classificação. Os 1.961 pares observados em um único dia não podem ser comparados com o próprio histórico. Na coleta de 27 de outubro, 131 dos 1.648 pares produto-loja com ao menos uma oferta classificada como destaque (8,0%) tinham apenas uma ou duas coletas anteriores na mesma loja, o que torna a média de referência pouco estável. Além disso, 241 desses pares não tinham nenhuma coleta anterior na mesma loja. A contagem é feita por par produto-loja, porque uma mesma loja pode oferecer mais de uma oferta do mesmo produto no dia; a Tabela 2, ao contrário, conta ofertas. Isso ocorre porque a referência é calculada pelo nome do produto entre todas as lojas, de modo que essas ofertas são comparadas com o histórico de outras lojas.

### 4.2 Classificação das ofertas

A Tabela 2 mostra a distribuição das avaliações na coleta de 27 de outubro de 2026, com 22.134 ofertas, classificadas pela regra de variação.

**Tabela 2.** Distribuição das ofertas por classificação da regra de variação (coleta de 27/10/2026, n = 22.134).

| Classificação | Ofertas (n) | % |
|---|---|---|
| Preço normal | 20.171 | 91,1% |
| Evitar (alta de 10% ou mais) | 611 | 2,8% |
| Boa compra (queda de 10% ou mais) | 440 | 2,0% |
| Alta moderada (5% a 10%) | 421 | 1,9% |
| Queda moderada (5% a 10%) | 302 | 1,4% |
| Sem histórico | 189 | 0,9% |
| **Total** | **22.134** | **100,0%** |

*Fonte: elaborado pelos autores (2026).*

A grande maioria das ofertas (91,1%) não apresentou variação relevante em relação à média dos sete dias anteriores, o que é esperado para um mercado em que a maior parte dos preços permanece estável. As classificações de destaque somam cerca de 8% das ofertas, distribuídas entre quedas e altas.

### 4.3 Comparação entre o Isolation Forest e a regra de variação

Para decidir entre os dois métodos, comparou-se a capacidade de cada um de ordenar ofertas alteradas acima das não alteradas. Em cada um dos cinco últimos dias da base (23 a 27 de outubro), foram injetadas variações conhecidas em 1.000 ofertas reais por condição. Como a injeção é feita sobre preços reais, o teste preserva o comportamento habitual dos produtos e mede apenas a sensibilidade de cada método a mudanças controladas. A AUC mede a probabilidade de uma oferta alterada receber uma pontuação de anomalia maior que uma oferta não alterada.

**Tabela 3.** AUC por dia: regra de variação absoluta e Isolation Forest.

| Dia | AUC da regra | AUC do Isolation Forest |
|---|---|---|
| 23/10 | 0,991 | 0,968 |
| 24/10 | 0,982 | 0,942 |
| 25/10 | 0,986 | 0,947 |
| 26/10 | 0,987 | 0,946 |
| 27/10 | 0,975 | 0,922 |

*Fonte: elaborado pelos autores (2026).*

A regra ordenou melhor as ofertas em todos os dias testados. Como o parâmetro de contaminação não altera a ordenação, essa diferença não pode ser atribuída à escolha do parâmetro. A Tabela 4 compara os dois métodos com o limiar de decisão de cada um, em média sobre os cinco dias.

**Tabela 4.** Taxa de detecção (recall) das variações injetadas e falsos alarmes, em média sobre os cinco dias.

| Variação injetada | Isolation Forest (contamination 0,047) | Regra de 10% |
|---|---|---|
| −5% | 2,7% | 2,2% |
| −10% | 4,0% | 45,2% |
| −20% | 7,1% | 99,3% |
| +30% | 8,9% | 99,5% |
| **Falsos alarmes** (ofertas não alteradas marcadas) | **2,6%** | **1,8%** |

*Fonte: elaborado pelos autores (2026).*

A regra de 10% detecta quase todas as mudanças de 20% ou mais e tem menos falsos alarmes que o modelo. A queda de 10% é detectada em cerca de metade dos casos. Isso ocorre porque a referência é a média da janela, e uma variação injetada de exatamente −10% sobre o preço atual nem sempre equivale a −10% sobre essa média. A variação de −5% não é detectada, como esperado, porque está abaixo do limiar de 10%.

A Tabela 5 mostra o efeito da faixa moderada de 5%, adotada na versão atual.

**Tabela 5.** Taxa de detecção com alerta moderado (variação de 5% ou mais) e alerta forte (10% ou mais), em média sobre os cinco dias.

| Variação injetada | Alerta moderado (≥ 5%) | Alerta forte (≥ 10%) |
|---|---|---|
| −5% | 83,4% | 2,2% |
| −10% | 99,0% | 45,2% |
| −20% | 99,8% | 99,3% |
| +30% | 99,8% | 99,5% |
| **Falsos alarmes** | **3,4%** | **1,8%** |

*Fonte: elaborado pelos autores (2026).*

A faixa de 5% detecta quase todas as quedas de 5% ou mais, ao custo de cerca de 1,6 ponto percentual a mais de ofertas destacadas. Como essas ofertas adicionais têm variação real de 5% a 10%, elas não são erros de classificação, mas uma escolha de quanto a aplicação deve destacar.

### 4.4 Teste retroativo

Para verificar se uma classificação se sustenta, as ofertas classificadas como boa compra e como evitar entre 21 e 26 de outubro foram acompanhadas no dia seguinte, com a média dos sete dias anteriores ao dia classificado como referência. Foram classificadas 556 ofertas como boa compra e 656 como evitar, considerando apenas produtos cujo preço variou na janela; dessas, 377 e 453, respectivamente, tinham coleta no dia seguinte. A Tabela 6 mostra o resultado.

**Tabela 6.** Preço no dia seguinte das ofertas classificadas pela regra de variação (dias 21 a 26/10/2026).

| Classificação | Ofertas com dia seguinte (n) | Voltou à faixa normal (−5% a +5%) | Continuou fora da faixa | Mediana da variação no dia seguinte |
|---|---|---|---|---|
| Boa compra | 377 | 1,6% | 98,4% | −15,7% |
| Evitar | 453 | 1,5% | 98,5% | +14,7% |

*Fonte: elaborado pelos autores (2026).*

Nesse teste, a grande maioria das ofertas permaneceu fora da faixa normal no dia seguinte: 98,4% das classificadas como boa compra e 98,5% das classificadas como evitar. A mediana da variação no dia seguinte foi de −15,7% para as boas compras e de +14,7% para as de evitar, o que indica que o preço tende a se manter no novo patamar, e não a retornar à média do produto. Esse resultado difere do obtido na versão anterior do teste, que usava a regra histórica de reserva e indicava reversão para 76,5% das boas compras; a comparação entre as duas versões não foi decomposta e não deve ser lida como efeito isolado de uma das mudanças. O teste cobre seis dias de classificação e apenas um dia seguinte por oferta, e deve ser repetido com mais dados antes de qualquer conclusão definitiva.

### 4.5 Viabilidade da arquitetura

A arquitetura operou durante todo o período sem custo dedicado de nuvem, com o Supabase em seu plano gratuito e o GitHub Actions para a automação diária. O banco ocupava 118 MB ao final da análise, com cerca de 13 MB de crescimento por dia, o que aproxima o limite de armazenamento do plano gratuito. Com o limite de 500 MB do plano gratuito do Supabase, a estimativa é de cerca de 29 dias de coleta até atingi-lo, mantido o ritmo atual. Esse é um limite prático do modelo adotado e precisa ser tratado nas considerações finais.

## 5. CONSIDERAÇÕES FINAIS

Este trabalho apresentou o desenvolvimento e a validação de um pipeline analítico de quatro camadas para comparar preços de hardware entre lojas virtuais. A solução integra a extração automatizada dos dados, o armazenamento em um banco relacional no Supabase, a avaliação das ofertas por variação em relação às coletas dos sete dias anteriores e a apresentação dos resultados em uma aplicação web. A validação com oito dias de coleta confirmou a viabilidade técnica da arquitetura e mostrou que a regra de variação é mais simples e mais sensível a mudanças grandes do que o Isolation Forest utilizado em uma versão anterior.

Os objetivos específicos foram atingidos dentro dos limites descritos. A coleta e a gravação diárias são automatizadas. Os dados são organizados por dia de coleta em uma tabela única. A avaliação das ofertas é feita por uma regra explicável, com quatro faixas de variação além da faixa de preço normal, e um grupo sem histórico. A aplicação web apresenta ao consumidor o histórico de preços, a avaliação de cada oferta e a comparação entre lojas.

Entre as limitações, destacam-se:

- o período curto de observação, de oito dias, o que limita a identificação de tendências e de promoções recorrentes;
- a baixa cobertura por produto, com média de 6,6 observações por par produto-loja, que enfraquece a média de referência para itens observados em poucos dias;
- a ausência de um conjunto de ofertas rotuladas por especialistas, o que impede medir a precisão da avaliação em relação ao valor real de uma compra;
- o fato de a regra ter sido validada com variações injetadas, que são artificiais, e de o teste retroativo cobrir apenas um dia seguinte para cada oferta;
- a dependência da estrutura das páginas das lojas e os bloqueios intermitentes da Amazon a servidores de nuvem, que deixaram dias sem dados dessa loja;
- a cobertura de apenas duas lojas na coleta atual;
- o crescimento da base dentro do limite de armazenamento do plano gratuito do Supabase;
- a aderência aos termos de uso das lojas. Quanto ao robots.txt, verificado em 29/10/2026: o da KaBuM! proíbe, para todos os robôs, buscas com parâmetros de consulta (`/busca/*?` e `*?query=*`), e a coleta pela API do catálogo usa parâmetro de consulta; o da Amazon não proíbe buscas por palavra-chave (`/s?k=`), mas proíbe o acesso de alguns robôs de IA. O exame das Condições de Uso ainda não foi concluído, e a adequação da coleta a essas restrições deve ser verificada antes de qualquer uso comercial.

Como trabalhos futuros, sugerem-se: (i) ampliar a série histórica e repetir os testes de injeção e retroativo com mais dias; (ii) avaliar limiares de variação por categoria de produto; (iii) reativar a coleta da Pichau e da Terabyte e garantir a presença das quatro lojas em todas as execuções; (iv) definir a política de retenção de dados e o plano de armazenamento; e (v) examinar formalmente os termos de uso e a política de acesso automatizado de cada loja.

---

## REFERÊNCIAS

BAKOS, J. Yannis. Reducing buyer search costs: implications for electronic marketplaces. *Management Science*, v. 43, n. 12, p. 1676-1692, 1997.

FAWCETT, Tom. An introduction to ROC analysis. *Pattern Recognition Letters*, v. 27, n. 8, p. 861-874, 2006. DOI: https://doi.org/10.1016/j.patrec.2005.10.010.

FECOMERCIOSP. *Radiografia do comércio eletrônico*. São Paulo: FecomercioSP, 2026. Disponível em: https://pesquisas.fecomercio.com.br/wp-content/uploads/2026/07/Ebook_radiografia_comercio_eletronico_V2.pdf. Acesso em: 28 out. 2026.

GITHUB. *GitHub Actions documentation*. 2026. Disponível em: https://docs.github.com/en/actions. Acesso em: 28 out. 2026.

HAWKINS, Douglas M. *Identification of outliers*. London: Chapman and Hall, 1980.

KAUFMAN, Shachar; ROSSET, Saharon; PERLICH, Claudia; STITELMAN, Ori. Leakage in data mining: formulation, detection, and avoidance. *ACM Transactions on Knowledge Discovery from Data*, v. 6, n. 4, p. 1-21, 2012. DOI: https://doi.org/10.1145/2382577.2382579.

KIMBALL, Ralph; ROSS, Margy. *The data warehouse toolkit*: the definitive guide to dimensional modeling. 3. ed. Indianapolis: Wiley, 2013.

KRUPCZAK, Letícia; VEIGA, Claudimar Pereira da. Comportamento de compra online no Brasil: motivações e fatores decisórios. *Ágora: Revista de Divulgação Científica*, v. 29, p. 196-213, 2024. DOI: https://doi.org/10.24302/agora.v29.5435.

LIU, Fei Tony; TING, Kai Ming; ZHOU, Zhi-Hua. Isolation forest. In: IEEE INTERNATIONAL CONFERENCE ON DATA MINING, 8., 2008, Pisa. *Proceedings* [...]. Pisa: IEEE, 2008. p. 413-422. DOI: https://doi.org/10.1109/ICDM.2008.17.

MCKINNEY, Wes. Data structures for statistical computing in Python. In: PYTHON IN SCIENCE CONFERENCE, 9., 2010, Austin. *Proceedings* [...]. Austin: SciPy, 2010. p. 56-61. DOI: https://doi.org/10.25080/Majora-92bf1922-00a.

MITCHELL, Ryan. *Web scraping with Python*: collecting more data from the modern web. 2. ed. Sebastopol: O'Reilly Media, 2018.

OLIVEIRA, Wendel Lima. *Uso de web scraping para mineração de produtos e preços em e-commerce*. 2022. Trabalho de Conclusão de Curso (Bacharelado em Engenharia de Computação) – Universidade Federal de Sergipe, São Cristóvão, 2022.

PEDREGOSA, Fabian et al. Scikit-learn: machine learning in Python. *Journal of Machine Learning Research*, v. 12, p. 2825-2830, 2011.

RICHARDSON, Leonard. *Beautiful Soup documentation*. 2026. Disponível em: https://www.crummy.com/software/BeautifulSoup/bs4/doc/. Acesso em: 28 out. 2026.

SELENIUM PROJECT. *Selenium documentation*. 2026. Disponível em: https://www.selenium.dev/documentation/. Acesso em: 28 out. 2026.

SUPABASE. *Supabase documentation*. 2026. Disponível em: https://supabase.com/docs. Acesso em: 28 out. 2026.

---

## Notas para revisão (não fazem parte do artigo)

- Referências conferidas na web em 28/10/2026: DOIs e links de Fawcett, Krupczak & Veiga, McKinney, FecomercioSP, GitHub Actions, Selenium, Beautiful Soup e Supabase. Não conferido: a autoria de Leonard Richardson na documentação do Beautiful Soup (a busca não trouxe crédito explícito) e o texto completo do relatório da FecomercioSP, cujos números da introdução vieram de cobertura jornalística.
- O único [CONFIRMAR] que resta está na seção 3.4 (diferença de uma unidade no log da importação).
- A Tabela 2 foi recontada em 28/10 a partir dos rótulos gravados no banco, que são os que a aplicação exibe. A versão anterior (446, 603 e 20.173) diferia em até 8 ofertas por classificação. Confirme se a última execução da análise gravou esses rótulos.
- Os números de destaque da seção 4.1 foram recontados por par produto-loja (1.648 pares com ao menos uma oferta em destaque). O valor anterior de 1.637 vinha de uma agregação que mantinha só um rótulo por par.
- Log da importação (execução de 26/10, dados de 25/10): 20.924 válidas, 5 descartadas e 1.959 repetidas, que somam 22.888. O total bruto informado pela coleta é 22.887. A diferença de uma unidade está em aberto e deve ser apontada como limitação de contagem se não for esclarecida.
- A Tabela 6 foi recalculada com a regra de variação e a média dos sete dias anteriores, a mesma referência da aplicação. O resultado da versão anterior (76,5% de reversão) usava a regra histórica e foi descartado.
- A Tabela 6 foi calculada por consulta ao banco: referência = média dos 7 dias anteriores por produto (nome) entre lojas; o filtro de preços constantes foi aplicado por produto e loja, como no teste retroativo de validacao.py. A classificação gravada usa correspondência de nomes por TF-IDF, então confirme se os números batem com ela.
- As referências ao Google Cloud/BigQuery e à Power BI foram retiradas, porque não fazem parte da arquitetura atual.
