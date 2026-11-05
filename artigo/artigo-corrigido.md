# Texto corrigido: classificação, resultados e considerações finais

Os trechos abaixo substituem os correspondentes do documento "Artigo TCC (1).docx". Os números são os da coleta de 25/10/2026 e da análise feita sobre a base limpa. Itens marcados com **[CONFIRMAR]** dependem de conferência.

---

## CLASSIFICAÇÃO COM O USO DE APRENDIZADO DE MÁQUINA

A classificação das ofertas de hardware é uma etapa importante para transformar os dados históricos de preços em informações que apoiem a decisão de compra. O sistema combina duas abordagens. A primeira é uma regra histórica, aplicada na aplicação web e exibida ao consumidor. A segunda é o algoritmo Isolation Forest, executado na etapa de análise do pipeline e registrado em arquivo de apoio, sem exibição direta na interface.

A regra histórica compara o preço de cada oferta com as coletas anteriores do mesmo produto. Produtos com menos de dois dias de coleta recebem a indicação "Sem histórico". Quando todas as coletas têm o mesmo valor, a oferta recebe "Preço médio". Nos demais casos, a oferta é "Boa compra" se o preço estiver até 2% acima do menor valor já observado ou abaixo de 95% da mediana; é "Evitar" se estiver acima de 105% da mediana; e "Preço médio" nos demais casos. Como a mediana inclui a própria coleta avaliada, essa referência não é independente do valor avaliado, o que é discutido na seção de considerações finais.

O Isolation Forest (LIU; TING; ZHOU, 2008) é um método não supervisionado que identifica observações isoladas com poucas divisões aleatórias. No pipeline, a variável analisada é a variação percentual do preço do dia em relação à média dos preços anteriores do mesmo produto, usando somente dados de dias anteriores. A correspondência entre os nomes dos produtos de um dia e os dos dias anteriores é feita por TF-IDF, com limiar de similaridade de 0,45. O modelo usa taxa de contaminação de 2%. Ofertas com variação igual ou inferior a -10% são marcadas como "Boa Compra", e as iguais ou superiores a +10%, como "Evitar"; as ofertas isoladas pelo algoritmo são marcadas como "Anomalia (isolada por IA)".

Não se utiliza volatilidade como variável do modelo. A interpretação das anomalias como possíveis promoções (variação negativa) ou aumentos de preço (variação positiva) é uma leitura exploratória, que depende do comportamento histórico do produto. A identificação de uma anomalia não implica, por si só, uma vantagem comercial.

---

## RESULTADOS E DISCUSSÃO

A coleta mais recente do pipeline, realizada em 25/10/2026, reuniu 22.887 ofertas brutas: 21.267 da KaBuM! e 1.620 da Amazon. Após a deduplicação, que considera o identificador externo do produto, a loja, a data, o nome e o preço, foram gravadas 20.924 ofertas, com 1.959 registros repetidos e 5 descartados por dados incompletos. A Tabela 1 detalha esses volumes por loja.

**Tabela 1.** Ofertas coletadas e gravadas por loja na coleta de 25/10/2026.

| Loja | Coletadas (bruto) | Gravadas (após deduplicação) | Perdas | Perdas (%) |
|---|---|---|---|---|
| KaBuM! | 21.267 | 19.607 | 1.660 | 7,8% |
| Amazon | 1.620 | 1.317 | 303 | 18,7% |
| Total | 22.887 | 20.924 | 1.963 | 8,6% |

*Fonte: elaborado pelos autores (2026), a partir do log de execução e da base do sistema. As perdas correspondem à diferença entre as ofertas coletadas e as gravadas, e incluem repetições e registros descartados.*

A Amazon apresentou perda relativa maior, o que é coerente com a repetição de anúncios entre páginas e categorias de busca. A coleta da Amazon também apresentou bloqueios intermitentes: em algumas rodadas, a primeira página de termos inteiros voltou sem produtos. Por isso, o processo repete os termos sem resposta em rodadas posteriores, com intervalos crescentes, até que cada termo seja coletado ou se esgote o número de rodadas. **[CONFIRMAR: número de rodadas necessárias na coleta de 25/10]**.

Pichau e Terabyte não compõem a coleta atual. Essas lojas foram monitoradas em versões anteriores do pipeline, mas não há dados delas nas coletas que sustentam os resultados deste trabalho.

A classificação foi aplicada às 20.924 ofertas gravadas no dia 25/10/2026, com o histórico de coletas anteriores disponível na base. A Tabela 2 mostra a distribuição resultante.

**Tabela 2.** Distribuição das ofertas por classificação do Isolation Forest (n = 20.924).

| Classificação do modelo | Exibição na interface | Ofertas (n) | % |
|---|---|---|---|
| Preço médio (comportamento normal) | Preço médio | 20.115 | 96,1% |
| Anomalia (isolada por IA) | Anomalia | 416 | 2,0% |
| Boa Compra (variação ≤ -10%) | Boa compra | 170 | 0,8% |
| Sem histórico | Sem histórico | 135 | 0,6% |
| Evitar (variação ≥ +10%) | Evitar | 88 | 0,4% |
| **Total** | | **20.924** | **100,0%** |

*Fonte: elaborado pelos autores (2026).*

A maioria das ofertas (96,1%) não apresentou variação considerada atípica. Esse resultado reflete, em parte, o curto período de histórico: sete dias de coleta, dos quais alguns produtos apresentam preço constante. Por isso, a distribuição não deve ser lida como uma estimativa da frequência de promoções no mercado. A interpretação das anomalias como oportunidade ou aumento deve ser validada com mais dias de coleta.

Na aplicação web, a avaliação exibida ao consumidor é a regra histórica descrita na seção de classificação. Quando a oferta tem preço anterior informado, o desconto é exibido em relação à mediana das coletas do próprio produto.

As Figuras 2 a 4 ilustram a aplicação web. A Figura 2 mostra a tela inicial. A Figura 3 apresenta os resultados de uma busca, com a oferta de menor preço, a comparação entre lojas e o desconto em relação à mediana. A Figura 4 mostra a página de análise de um produto, com o histórico de preços e a avaliação da oferta. **[CONFIRMAR: indicar, nas figuras, os casos reais escolhidos]**.

---

## CONSIDERAÇÕES FINAIS

Este artigo apresentou a especificação e a validação de um pipeline analítico de quatro camadas para comparação de preços de hardware: extração automatizada de ofertas de duas lojas virtuais, armazenamento em banco PostgreSQL hospedado no Supabase, tratamento com deduplicação e análise por Isolation Forest, e apresentação em aplicação web de acesso livre. A automação diária é executada pelo GitHub Actions. A validação com dados reais, de 20 a 25 de outubro de 2026, com 20.924 ofertas gravadas na coleta mais recente, confirma a viabilidade técnica da arquitetura e evidencia desafios de integração, como a instabilidade da coleta da Amazon e a heterogeneidade dos identificadores entre lojas.

Os objetivos específicos foram alcançados nos limites descritos. A coleta e a importação diária são automatizadas. Os dados são integrados em uma tabela de ofertas por dia. A classificação combina uma regra histórica, exibida ao consumidor, e o Isolation Forest, registrado na análise. A aplicação web apresenta o histórico de preços, a avaliação de cada oferta e a comparação entre lojas.

Como limitações, destacam-se:

- o curto período de histórico, de sete dias de coleta, o que limita a identificação de tendências e de promoções recorrentes;
- a ausência de uma base rotulada para medir a precisão das classificações;
- a referência de preço da regra histórica inclui a própria coleta avaliada, o que reduz a independência entre a referência e o valor analisado;
- a cobertura de apenas duas lojas, sendo que a Amazon apresenta bloqueios intermitentes e perdas maiores na deduplicação;
- a dependência da estrutura das páginas das lojas;
- as cotas da infraestrutura gratuita.

Como trabalhos futuros, destacam-se: (i) a validação das classificações com um conjunto de ofertas rotuladas; (ii) a definição de uma referência de preço calculada apenas com dados anteriores à data avaliada; (iii) a recuperação da cobertura de outras lojas; e (iv) a avaliação da distribuição das classificações por loja e categoria de produto, à medida que o histórico cresce.

---

## Notas para revisão

- Os percentuais de perda por loja são calculados pela diferença entre ofertas coletadas e gravadas, o que inclui repetições e registros descartados. Se preferir um número de repetição puro por loja, é preciso medir isso no próprio log.
- A referência ao número de rodadas da Amazon precisa ser conferida no log da execução.
- As referências bibliográficas devem ser conferidas, com seus DOIs, antes do envio.
