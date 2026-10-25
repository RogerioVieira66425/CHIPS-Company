'use strict';
/* Idiomas do site.
   -------------------------------------------------------------------------
   Um dicionario por idioma e uma funcao t() para buscar o texto. A escolha
   fica salva no navegador; sem escolha, o site adota o idioma do sistema.
   Os textos do HTML sao marcados com data-i18n (conteudo) e data-i18n-ph
   (placeholder de campo). */

const I18N = (function () {
  const TEXTOS = {
    pt: {
      'capa.titulo': 'Onde está mais barato?',
      'capa.sub': 'Digite o equipamento que você quer e o sistema procura nas lojas, compara o preço final e mostra onde compensa comprar.',
      'capa.placeholder': 'teclado mecânico redragon, rtx 4060, headset hyperx...',
      'busca.botao': 'Buscar',
      'busca.topoPlaceholder': 'buscar outro produto...',
      'busca.recentes': 'Buscas recentes:',

      'res.eyebrow': 'Resultado da busca',
      'analise.eyebrow': 'Análise do produto',
      'analise.voltar': '← Voltar à busca',
      'analise.precoAtual': 'Preço desta oferta',
      'analise.referencia': 'Preço de referência',
      'analise.variacao': 'Variação em relação à referência',
      'analise.situacao': 'Avaliação da IA',
      'analise.posicao': 'Onde esta oferta está entre todas',
      'analise.estatisticas': 'Números do produto',
      'analise.historico': 'Histórico de preço',
      'analise.verAcompanhamento': 'Ver acompanhamento deste produto',
      'analise.porLoja': 'Melhor preço de cada loja',
      'analise.loja': 'Loja',
      'analise.ofertas': 'Ofertas',
      'analise.menor': 'Menor',
      'analise.mediana': 'Mediana',
      'analise.maior': 'Maior',
      'analise.media': 'Média',
      'analise.ofertasTotal': 'Ofertas encontradas',
      'analise.lojasTotal': 'Lojas',
      'analise.todas': 'Todas as ofertas deste produto',
      'analise.anuncio': 'Anúncio',
      'analise.preco': 'Preço',
      'analise.variacao2': 'Variação',
      'analise.situacao2': 'Avaliação',
      'analise.resumoSub': '{n} ofertas de {lojas} loja(s) para este produto.',
      'analise.referenciaSub': 'mediana das referências da base',
      'analise.semReferencia': 'sem referência informada',
      'analise.variacaoSub': 'negativo = abaixo da referência',
      'analise.menorDe': 'menor:',
      'analise.maiorDe': ': maior',
      'analise.maisBaratoQue': 'mais barato que {pct} das ofertas',
      'analise.historicoAcompanhado': 'Este produto é acompanhado: o histórico de preço das coletas aparece na tela de acompanhamento.',
      'analise.historicoVazio': 'Este produto tem coleta em um só dia. O gráfico de evolução aparece quando houver coletas em dias diferentes.',
      'situacao.boa': 'Boa compra',
      'situacao.boa.dica': 'preço abaixo da faixa usual deste produto',
      'situacao.media': 'Preço médio',
      'situacao.media.dica': 'preço dentro da faixa usual',
      'situacao.novo': 'Sem histórico',
      'situacao.novo.dica': 'não há referência suficiente para comparar',
      'situacao.evitar': 'Evitar',
      'situacao.evitar.dica': 'preço acima da faixa usual deste produto',
      'situacao.anomalia': 'Anomalia',
      'situacao.anomalia.dica': 'valor fora da faixa usual, isolado pela IA: confira antes de comprar',
      'origem.servidor': 'servidor',
      'origem.banco': 'banco de ofertas',
      'origem.agente': 'agente coletor',
      'insight.economia': 'Comprando na {lojaMin} em vez da {lojaMax} você economiza {dif} — {pct} do valor mais caro.',
      'insight.variacao': 'O menor preço de cada loja vai de {min} na {lojaMin} a {max} na {lojaMax} — {dif} de diferença, ainda que sejam modelos diferentes.',
      'insight.mediana': 'A oferta recomendada está {pct} abaixo da mediana das {n} ofertas ({mediana}).',
      'insight.medianaPerto': 'A oferta recomendada ({valor}) está perto da mediana das {n} ofertas ({mediana}): o preço segue o padrão da busca.',
      'insight.descontos': '{n} das {total} ofertas estão com preço reduzido; o maior corte é de {pct} na {loja}.',
      'insight.semDescontos': 'Nenhuma loja informou preço anterior nesta busca, então não dá para dizer se os valores estão em promoção.',
      'res.analise': 'Análise',
      'res.analiseDica': 'Ver o histórico de preço deste produto',
      'analise.semHistorico': 'Ainda não há histórico de preço deste produto: ele começa quando o produto entra no acompanhamento.',
      'res.titulo': '{n} ofertas para',
      'res.meta': '{lojas} loja(s) comparadas · {data}',
      'res.menorPorLoja': 'Menor preço em cada loja',
      'res.diferenca': 'diferença para o mais barato',
      'res.maisBarato': 'mais barato',
      'res.menorPreco': 'Menor preço',
      'res.maisVantajoso': 'Mais vantajoso',
      'res.irLoja': 'Ir à {loja}',
      'res.semLojas': 'Nenhuma loja para comparar.',
      'res.maiorDesconto': 'Maior desconto',
      'res.semDesconto': 'nenhuma oferta com preço anterior informado',
      'res.faixaPreco': 'Faixa de preço',
      'res.faixaSub': 'entre as {n} ofertas encontradas',
      'res.filtros': 'Filtros',
      'res.todas': 'Todas as ofertas',
      'res.contagem': '{n} oferta(s)',
      'res.vazioTitulo': 'Nenhuma oferta com esses filtros',
      'res.vazioBuscaTitulo': 'Nenhuma oferta para essa busca',
      'res.vazioBuscaTexto': 'Tente outro termo: o modelo exato costuma funcionar melhor.',
      'res.vazioTexto': 'Tente outra faixa de preço ou outra loja.',
      'ordem.menorPreco': 'Menor preço',
      'ordem.maiorPreco': 'Maior preço',
      'ordem.maiorDesconto': 'Maior desconto',

      'estado.procurando': 'Procurando "{termo}" nas lojas',
      'estado.consultando': 'Consultando as lojas',
      'estado.preparando': 'Preparando a consulta',
      'estado.lojas': 'KaBuM!, Pichau, Terabyte, Patoloco, Setup Ninja e Amazon',
      'estado.tempo': 'cada loja responde no seu tempo — costuma levar de 10 a 30 segundos',
      'estado.fila': 'a busca entrou na fila do coletor',
      'estado.semResposta': 'Nenhuma loja respondeu a tempo. O coletor precisa estar rodando para atender buscas neste site.',
      'estado.semOfertas': 'Nenhuma oferta encontrada para "{termo}".',
      'estado.semFiltro': 'Nenhuma oferta com esses filtros. Tente afrouxar um deles.',

      'veredito.melhor': 'Mais vantajoso: {loja}',
      'veredito.freteIncluso': 'inclui frete de {valor}',
      'veredito.freteGratis': 'frete grátis ou não informado',
      'veredito.condicao': 'produto {condicao}',
      'veredito.parcelas': 'até {n}x',
      'veredito.comprar': 'Ir à loja e comprar ↗',
      'veredito.comparacao': 'Comparação entre lojas',
      'veredito.economia': 'Comprando aqui em vez da loja mais cara você economiza {valor} ({pct}).',
      'veredito.modelosDiferentes': 'As lojas trouxeram modelos diferentes para esta busca, então não dá para falar em economia: a lista abaixo mostra a opção mais barata de cada loja. Para comparar o mesmo produto, busque pelo modelo exato (ex.: "redragon kumara k552").',
      'veredito.maisBarato': 'Existe oferta mais barata ({valor} na {loja}), mas o sistema não a recomenda por causa da condição do produto ou da reputação do vendedor.',
      'veredito.consulta': 'Consulta feita em {data}',
      'veredito.origem': ' · coleta pelo {origem}',

      'filtro.marca': 'Marca',
      'filtro.categoria': 'Categoria',
      'filtro.loja': 'Loja',
      'filtro.preco': 'Preço',
      'filtro.todas': 'Todas',
      'filtro.qualquer': 'Qualquer',
      'faixa.ate': 'Até {valor}',
      'faixa.entre': '{de} a {ate}',
      'faixa.acima': 'Acima de {valor}',
      'filtro.limpar': 'Limpar filtros',
      'filtro.resumoTudo': '{total} oferta(s) encontradas',
      'filtro.resumoParcial': '{n} de {total} oferta(s)',
      'filtro.outras': 'Outras',
      'filtro.outros': 'Outros',

      'tabela.titulo': 'Todas as ofertas encontradas',
      'tabela.loja': 'Loja',
      'tabela.produto': 'Produto',
      'tabela.precoEra': 'Preço que era',
      'tabela.precoAtual': 'Preço atual',
      'tabela.desconto': 'Desconto',
      'tabela.aPagar': 'Valor a pagar',
      'tabela.anuncio': 'Anúncio',
      'tabela.condicao': 'Condição',
      'tabela.vendedor': 'Vendedor',
      'tabela.preco': 'Preço',
      'tabela.frete': 'Frete',
      'tabela.total': 'Total',
      'tabela.comprar': 'comprar ↗',
      'tabela.gratis': 'grátis',
      'tabela.verAnuncio': 'ver anúncio',
      'tabela.vazio': 'Nenhuma oferta encontrada para esse termo.',

      'condicao.novo': 'novo',
      'condicao.usado': 'usado',

      'pagina.anterior': '← Anterior',
      'pagina.proxima': 'Próxima →',
      'pagina.info': 'mostrando {de}–{ate} de {total} ofertas',

      'rodape.frase': 'Engenharia de Computação e Soluções Digitais',
      'idioma.rotulo': 'Idioma',
    },

    en: {
      'capa.titulo': 'Where is it cheapest?',
      'capa.sub': 'Type the gear you want and the system searches the stores, compares the final price and shows where it pays off to buy.',
      'capa.placeholder': 'redragon mechanical keyboard, rtx 4060, hyperx headset...',
      'busca.botao': 'Search',
      'busca.topoPlaceholder': 'search another product...',
      'busca.recentes': 'Recent searches:',

      'res.eyebrow': 'Search result',
      'analise.eyebrow': 'Product analysis',
      'analise.voltar': '← Back to search',
      'analise.precoAtual': 'Price of this offer',
      'analise.referencia': 'Reference price',
      'analise.variacao': 'Change against the reference',
      'analise.situacao': 'AI assessment',
      'analise.posicao': 'Where this offer sits among all',
      'analise.estatisticas': 'Product figures',
      'analise.historico': 'Price history',
      'analise.verAcompanhamento': "See this product's tracking",
      'analise.porLoja': 'Best price at each store',
      'analise.loja': 'Store',
      'analise.ofertas': 'Offers',
      'analise.menor': 'Lowest',
      'analise.mediana': 'Median',
      'analise.maior': 'Highest',
      'analise.media': 'Average',
      'analise.ofertasTotal': 'Offers found',
      'analise.lojasTotal': 'Stores',
      'analise.todas': 'All offers for this product',
      'analise.anuncio': 'Listing',
      'analise.preco': 'Price',
      'analise.variacao2': 'Change',
      'analise.situacao2': 'Assessment',
      'analise.resumoSub': '{n} offers from {lojas} store(s) for this product.',
      'analise.referenciaSub': 'median of the database references',
      'analise.semReferencia': 'no reference provided',
      'analise.variacaoSub': 'negative = below the reference',
      'analise.menorDe': 'lowest:',
      'analise.maiorDe': ': highest',
      'analise.maisBaratoQue': 'cheaper than {pct} of the offers',
      'analise.historicoAcompanhado': 'This product is tracked: its price history from the collections appears on the tracking screen.',
      'analise.historicoVazio': 'This product has been collected on one day only. The price evolution chart appears once there are collections on different days.',
      'situacao.boa': 'Good deal',
      'situacao.boa.dica': "price below this product's usual range",
      'situacao.media': 'Average price',
      'situacao.media.dica': 'price within the usual range',
      'situacao.novo': 'No history',
      'situacao.novo.dica': 'not enough reference to compare',
      'situacao.evitar': 'Avoid',
      'situacao.evitar.dica': "price above this product's usual range",
      'situacao.anomalia': 'Anomaly',
      'situacao.anomalia.dica': 'value outside the usual range, flagged by the AI: check before buying',
      'origem.servidor': 'server',
      'origem.banco': 'offers database',
      'origem.agente': 'collector agent',
      'insight.economia': 'Buying at {lojaMin} instead of {lojaMax} saves you {dif} — {pct} of the most expensive price.',
      'insight.variacao': 'The cheapest price in each store ranges from {min} at {lojaMin} to {max} at {lojaMax} — {dif} apart, although they are different models.',
      'insight.mediana': 'The recommended offer is {pct} below the median of the {n} offers ({mediana}).',
      'insight.medianaPerto': 'The recommended offer ({valor}) sits close to the median of the {n} offers ({mediana}): the price follows the pattern of this search.',
      'insight.descontos': '{n} of the {total} offers have a reduced price; the biggest cut is {pct} at {loja}.',
      'insight.semDescontos': 'No store reported a previous price in this search, so there is no way to tell whether these values are on sale.',
      'res.analise': 'Analysis',
      'res.analiseDica': 'See the price history of this product',
      'analise.semHistorico': 'There is no price history for this product yet: it starts once the product is being tracked.',
      'res.titulo': '{n} offers for',
      'res.meta': '{lojas} store(s) compared · {data}',
      'res.menorPorLoja': 'Lowest price in each store',
      'res.diferenca': 'gap to the cheapest one',
      'res.maisBarato': 'cheapest',
      'res.menorPreco': 'Lowest price',
      'res.maisVantajoso': 'Best deal',
      'res.irLoja': 'Go to {loja}',
      'res.semLojas': 'No store to compare.',
      'res.maiorDesconto': 'Biggest discount',
      'res.semDesconto': 'no offer lists a previous price',
      'res.faixaPreco': 'Price range',
      'res.faixaSub': 'across the {n} offers found',
      'res.filtros': 'Filters',
      'res.todas': 'All offers',
      'res.contagem': '{n} offer(s)',
      'res.vazioTitulo': 'No offer matches these filters',
      'res.vazioBuscaTitulo': 'No offers for this search',
      'res.vazioBuscaTexto': 'Try another term: the exact model usually works better.',
      'res.vazioTexto': 'Try another price range or another store.',
      'ordem.menorPreco': 'Lowest price',
      'ordem.maiorPreco': 'Highest price',
      'ordem.maiorDesconto': 'Biggest discount',

      'estado.procurando': 'Looking for "{termo}" in the stores',
      'estado.consultando': 'Checking the stores',
      'estado.preparando': 'Preparing the search',
      'estado.lojas': 'KaBuM!, Pichau, Terabyte, Patoloco, Setup Ninja and Amazon',
      'estado.tempo': 'each store answers at its own pace — usually 10 to 30 seconds',
      'estado.fila': 'the search is queued for the collector',
      'estado.semResposta': 'No store answered in time. The collector must be running to serve searches on this site.',
      'estado.semOfertas': 'No offers found for "{termo}".',
      'estado.semFiltro': 'No offers match these filters. Try loosening one of them.',

      'veredito.melhor': 'Best deal: {loja}',
      'veredito.freteIncluso': 'includes {valor} shipping',
      'veredito.freteGratis': 'free or unlisted shipping',
      'veredito.condicao': '{condicao} product',
      'veredito.parcelas': 'up to {n}x',
      'veredito.comprar': 'Go to the store ↗',
      'veredito.comparacao': 'Store comparison',
      'veredito.economia': 'Buying here instead of the most expensive store saves you {valor} ({pct}).',
      'veredito.modelosDiferentes': 'The stores returned different models for this search, so there is no real saving to report: the list below shows the cheapest option in each store. To compare the same product, search for the exact model (e.g. "redragon kumara k552").',
      'veredito.maisBarato': 'There is a cheaper offer ({valor} at {loja}), but the system does not recommend it because of the product condition or the seller reputation.',
      'veredito.consulta': 'Searched on {data}',
      'veredito.origem': ' · collected by the {origem}',

      'filtro.marca': 'Brand',
      'filtro.categoria': 'Category',
      'filtro.loja': 'Store',
      'filtro.preco': 'Price',
      'filtro.todas': 'All',
      'filtro.qualquer': 'Any',
      'faixa.ate': 'Up to {valor}',
      'faixa.entre': '{de} to {ate}',
      'faixa.acima': 'Above {valor}',
      'filtro.limpar': 'Clear filters',
      'filtro.resumoTudo': '{total} offer(s) found',
      'filtro.resumoParcial': '{n} of {total} offer(s)',
      'filtro.outras': 'Others',
      'filtro.outros': 'Others',

      'tabela.titulo': 'All offers found',
      'tabela.loja': 'Store',
      'tabela.produto': 'Product',
      'tabela.precoEra': 'Was',
      'tabela.precoAtual': 'Current price',
      'tabela.desconto': 'Discount',
      'tabela.aPagar': 'Amount to pay',
      'tabela.anuncio': 'Listing',
      'tabela.condicao': 'Condition',
      'tabela.vendedor': 'Seller',
      'tabela.preco': 'Price',
      'tabela.frete': 'Shipping',
      'tabela.total': 'Total',
      'tabela.comprar': 'buy ↗',
      'tabela.gratis': 'free',
      'tabela.verAnuncio': 'view listing',
      'tabela.vazio': 'No offers found for this term.',

      'condicao.novo': 'new',
      'condicao.usado': 'used',

      'pagina.anterior': '← Previous',
      'pagina.proxima': 'Next →',
      'pagina.info': 'showing {de}–{ate} of {total} offers',

      'rodape.frase': 'Computer Engineering and Digital Solutions',
      'idioma.rotulo': 'Language',
    },

    es: {
      'capa.titulo': '¿Dónde está más barato?',
      'capa.sub': 'Escribe el equipo que quieres y el sistema busca en las tiendas, compara el precio final y muestra dónde conviene comprar.',
      'capa.placeholder': 'teclado mecánico redragon, rtx 4060, headset hyperx...',
      'busca.botao': 'Buscar',
      'busca.topoPlaceholder': 'buscar otro producto...',
      'busca.recentes': 'Búsquedas recientes:',

      'res.eyebrow': 'Resultado de la búsqueda',
      'analise.eyebrow': 'Análisis del producto',
      'analise.voltar': '← Volver a la búsqueda',
      'analise.precoAtual': 'Precio de esta oferta',
      'analise.referencia': 'Precio de referencia',
      'analise.variacao': 'Variación frente a la referencia',
      'analise.situacao': 'Evaluación de la IA',
      'analise.posicao': 'Dónde está esta oferta entre todas',
      'analise.estatisticas': 'Números del producto',
      'analise.historico': 'Historial de precio',
      'analise.verAcompanhamento': 'Ver el seguimiento de este producto',
      'analise.porLoja': 'Mejor precio de cada tienda',
      'analise.loja': 'Tienda',
      'analise.ofertas': 'Ofertas',
      'analise.menor': 'Menor',
      'analise.mediana': 'Mediana',
      'analise.maior': 'Mayor',
      'analise.media': 'Media',
      'analise.ofertasTotal': 'Ofertas encontradas',
      'analise.lojasTotal': 'Tiendas',
      'analise.todas': 'Todas las ofertas de este producto',
      'analise.anuncio': 'Anuncio',
      'analise.preco': 'Precio',
      'analise.variacao2': 'Variación',
      'analise.situacao2': 'Evaluación',
      'analise.resumoSub': '{n} ofertas de {lojas} tienda(s) para este producto.',
      'analise.referenciaSub': 'mediana de las referencias de la base',
      'analise.semReferencia': 'sin referencia informada',
      'analise.variacaoSub': 'negativo = por debajo de la referencia',
      'analise.menorDe': 'menor:',
      'analise.maiorDe': ': mayor',
      'analise.maisBaratoQue': 'más barato que el {pct} de las ofertas',
      'analise.historicoAcompanhado': 'Este producto está en seguimiento: el historial de precio de las recogidas aparece en la pantalla de seguimiento.',
      'analise.historicoVazio': 'Este producto tiene recogida en un solo día. El gráfico de evolución aparece cuando haya recogidas en días distintos.',
      'situacao.boa': 'Buena compra',
      'situacao.boa.dica': 'precio por debajo del rango habitual de este producto',
      'situacao.media': 'Precio medio',
      'situacao.media.dica': 'precio dentro del rango habitual',
      'situacao.novo': 'Sin historial',
      'situacao.novo.dica': 'no hay referencia suficiente para comparar',
      'situacao.evitar': 'Evitar',
      'situacao.evitar.dica': 'precio por encima del rango habitual de este producto',
      'situacao.anomalia': 'Anomalía',
      'situacao.anomalia.dica': 'valor fuera del rango habitual, marcado por la IA: revise antes de comprar',
      'origem.servidor': 'servidor',
      'origem.banco': 'banco de ofertas',
      'origem.agente': 'agente recolector',
      'insight.economia': 'Comprando en {lojaMin} en vez de {lojaMax} ahorras {dif} — {pct} del valor más caro.',
      'insight.variacao': 'El precio más bajo de cada tienda va de {min} en {lojaMin} a {max} en {lojaMax} — {dif} de diferencia, aunque sean modelos distintos.',
      'insight.mediana': 'La oferta recomendada está {pct} por debajo de la mediana de las {n} ofertas ({mediana}).',
      'insight.medianaPerto': 'La oferta recomendada ({valor}) está cerca de la mediana de las {n} ofertas ({mediana}): el precio sigue el patrón de la búsqueda.',
      'insight.descontos': '{n} de las {total} ofertas tienen precio rebajado; el mayor recorte es de {pct} en {loja}.',
      'insight.semDescontos': 'Ninguna tienda informó el precio anterior en esta búsqueda, así que no se puede saber si los valores están en promoción.',
      'res.analise': 'Análisis',
      'res.analiseDica': 'Ver el historial de precios de este producto',
      'analise.semHistorico': 'Todavía no hay historial de precios de este producto: empieza cuando el producto entra en seguimiento.',
      'res.titulo': '{n} ofertas para',
      'res.meta': '{lojas} tienda(s) comparadas · {data}',
      'res.menorPorLoja': 'Precio más bajo en cada tienda',
      'res.diferenca': 'diferencia con el más barato',
      'res.maisBarato': 'más barato',
      'res.menorPreco': 'Precio más bajo',
      'res.maisVantajoso': 'Más conveniente',
      'res.irLoja': 'Ir a {loja}',
      'res.semLojas': 'Ninguna tienda para comparar.',
      'res.maiorDesconto': 'Mayor descuento',
      'res.semDesconto': 'ninguna oferta informa el precio anterior',
      'res.faixaPreco': 'Rango de precio',
      'res.faixaSub': 'entre las {n} ofertas encontradas',
      'res.filtros': 'Filtros',
      'res.todas': 'Todas las ofertas',
      'res.contagem': '{n} oferta(s)',
      'res.vazioTitulo': 'Ninguna oferta con estos filtros',
      'res.vazioBuscaTitulo': 'Ninguna oferta para esta búsqueda',
      'res.vazioBuscaTexto': 'Prueba otro término: el modelo exacto suele funcionar mejor.',
      'res.vazioTexto': 'Prueba con otro rango de precio u otra tienda.',
      'ordem.menorPreco': 'Precio más bajo',
      'ordem.maiorPreco': 'Precio más alto',
      'ordem.maiorDesconto': 'Mayor descuento',

      'estado.procurando': 'Buscando "{termo}" en las tiendas',
      'estado.consultando': 'Consultando las tiendas',
      'estado.preparando': 'Preparando la consulta',
      'estado.lojas': 'KaBuM!, Pichau, Terabyte, Patoloco, Setup Ninja y Amazon',
      'estado.tempo': 'cada tienda responde a su ritmo — suele tardar de 10 a 30 segundos',
      'estado.fila': 'la búsqueda entró en la cola del colector',
      'estado.semResposta': 'Ninguna tienda respondió a tiempo. El colector debe estar en ejecución para atender búsquedas en este sitio.',
      'estado.semOfertas': 'No se encontraron ofertas para "{termo}".',
      'estado.semFiltro': 'Ninguna oferta con estos filtros. Prueba a aflojar uno de ellos.',

      'veredito.melhor': 'Más conveniente: {loja}',
      'veredito.freteIncluso': 'incluye envío de {valor}',
      'veredito.freteGratis': 'envío gratis o no informado',
      'veredito.condicao': 'producto {condicao}',
      'veredito.parcelas': 'hasta {n}x',
      'veredito.comprar': 'Ir a la tienda ↗',
      'veredito.comparacao': 'Comparación entre tiendas',
      'veredito.economia': 'Comprando aquí en vez de la tienda más cara ahorras {valor} ({pct}).',
      'veredito.modelosDiferentes': 'Las tiendas trajeron modelos diferentes para esta búsqueda, así que no se puede hablar de ahorro: la lista de abajo muestra la opción más barata de cada tienda. Para comparar el mismo producto, busca el modelo exacto (ej.: "redragon kumara k552").',
      'veredito.maisBarato': 'Hay una oferta más barata ({valor} en {loja}), pero el sistema no la recomienda por la condición del producto o la reputación del vendedor.',
      'veredito.consulta': 'Consulta hecha el {data}',
      'veredito.origem': ' · recogido por el {origem}',

      'filtro.marca': 'Marca',
      'filtro.categoria': 'Categoría',
      'filtro.loja': 'Tienda',
      'filtro.preco': 'Precio',
      'filtro.todas': 'Todas',
      'filtro.qualquer': 'Cualquiera',
      'faixa.ate': 'Hasta {valor}',
      'faixa.entre': 'De {de} a {ate}',
      'faixa.acima': 'Más de {valor}',
      'filtro.limpar': 'Limpiar filtros',
      'filtro.resumoTudo': '{total} oferta(s) encontradas',
      'filtro.resumoParcial': '{n} de {total} oferta(s)',
      'filtro.outras': 'Otras',
      'filtro.outros': 'Otros',

      'tabela.titulo': 'Todas las ofertas encontradas',
      'tabela.loja': 'Tienda',
      'tabela.produto': 'Producto',
      'tabela.precoEra': 'Precio anterior',
      'tabela.precoAtual': 'Precio actual',
      'tabela.desconto': 'Descuento',
      'tabela.aPagar': 'Importe a pagar',
      'tabela.anuncio': 'Anuncio',
      'tabela.condicao': 'Condición',
      'tabela.vendedor': 'Vendedor',
      'tabela.preco': 'Precio',
      'tabela.frete': 'Envío',
      'tabela.total': 'Total',
      'tabela.comprar': 'comprar ↗',
      'tabela.gratis': 'gratis',
      'tabela.verAnuncio': 'ver anuncio',
      'tabela.vazio': 'No se encontraron ofertas para ese término.',

      'condicao.novo': 'nuevo',
      'condicao.usado': 'usado',

      'pagina.anterior': '← Anterior',
      'pagina.proxima': 'Siguiente →',
      'pagina.info': 'mostrando {de}–{ate} de {total} ofertas',

      'rodape.frase': 'Ingeniería de Computación y Soluciones Digitales',
      'idioma.rotulo': 'Idioma',
    },
  };

  /* Bandeiras desenhadas em SVG: no Windows o emoji de bandeira aparece como
     as letras do pais ("BR"), entao o desenho e feito aqui mesmo. */
  const BANDEIRAS = {
    pt: '<svg viewBox="0 0 28 20" class="bandeira" aria-hidden="true">' +
        '<rect width="28" height="20" fill="#009b3a"/>' +
        '<path d="M14 2.6 25.4 10 14 17.4 2.6 10Z" fill="#fedf00"/>' +
        '<circle cx="14" cy="10" r="4.1" fill="#002776"/>' +
        '<path d="M10.2 8.6a9 9 0 0 1 7.6 1.9" stroke="#fff" stroke-width="1.1" fill="none"/></svg>',
    en: '<svg viewBox="0 0 28 20" class="bandeira" aria-hidden="true">' +
        '<rect width="28" height="20" fill="#b22234"/>' +
        '<g fill="#fff"><rect y="2.3" width="28" height="1.5"/><rect y="5.4" width="28" height="1.5"/>' +
        '<rect y="8.5" width="28" height="1.5"/><rect y="11.6" width="28" height="1.5"/>' +
        '<rect y="14.7" width="28" height="1.5"/><rect y="17.8" width="28" height="1.5"/></g>' +
        '<rect width="12" height="10.8" fill="#3c3b6e"/>' +
        '<g fill="#fff"><circle cx="2.6" cy="2.3" r=".7"/><circle cx="6" cy="2.3" r=".7"/><circle cx="9.4" cy="2.3" r=".7"/>' +
        '<circle cx="4.3" cy="4.6" r=".7"/><circle cx="7.7" cy="4.6" r=".7"/>' +
        '<circle cx="2.6" cy="6.9" r=".7"/><circle cx="6" cy="6.9" r=".7"/><circle cx="9.4" cy="6.9" r=".7"/>' +
        '<circle cx="4.3" cy="9.2" r=".7"/><circle cx="7.7" cy="9.2" r=".7"/></g></svg>',
    es: '<svg viewBox="0 0 28 20" class="bandeira" aria-hidden="true">' +
        '<rect width="28" height="20" fill="#c60b1e"/>' +
        '<rect y="5" width="28" height="10" fill="#ffc400"/>' +
        '<rect x="4.5" y="8" width="3.4" height="4.6" rx=".6" fill="#c60b1e"/></svg>',
  };

  const DISPONIVEIS = [
    ['pt', 'Português'],
    ['en', 'English'],
    ['es', 'Español'],
  ];

  function idiomaSalvo() {
    try {
      const guardado = localStorage.getItem('idioma');
      if (guardado && TEXTOS[guardado]) return guardado;
    } catch (e) { /* navegador sem storage: segue com o padrao */ }

    const doNavegador = String(navigator.language || 'pt').slice(0, 2).toLowerCase();
    return TEXTOS[doNavegador] ? doNavegador : 'pt';
  }

  let atual = idiomaSalvo();

  /* Busca o texto e troca os {marcadores} pelos valores. */
  function t(chave, valores) {
    const dicionario = TEXTOS[atual] || TEXTOS.pt;
    let texto = dicionario[chave] !== undefined ? dicionario[chave] : (TEXTOS.pt[chave] || chave);
    if (valores) {
      Object.keys(valores).forEach((k) => {
        texto = texto.split('{' + k + '}').join(valores[k]);
      });
    }
    return texto;
  }

  /* Aplica o idioma aos textos marcados no HTML. */
  function traduzirPagina() {
    document.documentElement.lang = atual === 'pt' ? 'pt-BR' : atual;
    document.querySelectorAll('[data-i18n]').forEach((e) => {
      e.textContent = t(e.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-ph]').forEach((e) => {
      e.setAttribute('placeholder', t(e.getAttribute('data-i18n-ph')));
    });
  }

  function definir(novo) {
    if (!TEXTOS[novo]) return;
    atual = novo;
    try { localStorage.setItem('idioma', novo); } catch (e) { /* sem storage */ }
    traduzirPagina();
    document.dispatchEvent(new CustomEvent('idioma-mudou', { detail: novo }));
  }

  const idioma = () => atual;
  const formatoData = () => (atual === 'pt' ? 'pt-BR' : atual === 'es' ? 'es-ES' : 'en-US');

  return { t, definir, idioma, traduzirPagina, disponiveis: DISPONIVEIS, bandeiras: BANDEIRAS, formatoData };
})();
