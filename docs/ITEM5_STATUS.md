
ITEM 5 — Teste de 12 links errados vs extração 18:03 UTC

STATUS: Requer dados que foram perdidos na limpeza de máquina

DEPENDÊNCIAS:
1. Arquivo ofertas_2026-11-04.xlsx com 100 links conferidos (50 Boa Compra + 50 Preço Normal)
   - Estado: PERDIDO na limpeza de máquina de 04/11
   - Deveria conter: 12 linhas marcadas como "Errado" (falso positivo de IA)

2. CSV de extração 18:03 UTC de 04/11/2026
   - Estado: PERDIDO na limpeza
   - Deveria conter: ofertas_2026-11-04_1803.csv do pipeline

3. CSV de extração padrão 12:20 UTC de 04/11/2026
   - Estado: PERDIDO na limpeza
   - Deveria conter: ofertas_2026-11-04.csv do pipeline

ALTERNATIVAS POSSÍVEIS:
A) Regenerar dados do Supabase (se ainda estiverem lá):
   - Query: SELECT * FROM ofertas_dia WHERE dia = '2026-11-04'
   - Precisa procurar pelos 12 links específicos na base
   - Comparar preços em momentos diferentes do dia

B) Procurar em backups:
   - OneDrive backup (se houver)
   - GitHub Actions artifacts (pode estar em runs antigos)
   - WSL/Docker volumes (improvável)

C) Documentar como limitação do trabalho:
   - Item 5 não pôde ser completado devido à perda de dados
   - Incluir no artigo como erro humano de backup

PRÓXIMOS PASSOS:
1. Verificar se Supabase ainda tem dados de 04/11
2. Se sim: executar queries e reconstruir o teste
3. Se não: adicionar nota no artigo sobre limitação
