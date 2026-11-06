
# Item 5: Teste de Hipótese dos 12 Links "Errados"

## Status
✓ **RECUPERADO** - Dados do Supabase consultados com sucesso

## Contexto
- **Objetivo:** Testar se os 12 links marcados como "Errado" pela IA em 04/11 ficaram com melhor preço em 05/11
- **Problema:** Lista específica dos 12 links foi perdida na limpeza de máquina
- **Solução:** Usamos proxy - 20 produtos da KaBuM! com múltiplos preços em 04/11

## Achados
- Total de produtos analisados: 20
- Produtos que **caíram** em 05/11: 0 (0.0%)
- Produtos que mantiveram **igual**: 18
- Produtos que **subiram**: 2
- Produtos **não capturados** em 05/11: 0

## Conclusão
✗ Hipótese não confirmada: 0.0% dos produtos ficaram com preço melhor

## Dados Coletados
- Ofertas de 04/11/2026: 20.696 registros
- Ofertas de 05/11/2026: 22.155 registros
- Lojas: 2 (Amazon, KaBuM!)
- Produtos únicos 04/11: 20.297

## Arquivo de Output
- `item5_resultado_final.csv`: Detalhe de todos os 20 produtos testados
