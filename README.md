<div align="center">

# CHIPS Company

### Pipeline analítico para comparação e avaliação de preços de hardware no e-commerce brasileiro

[![Status](https://img.shields.io/badge/status-em%20produção-brightgreen)](https://meus-investimentos-x7dn.onrender.com)
[![Automação](https://img.shields.io/badge/automação-GitHub%20Actions-blue?logo=github)](https://github.com/RogerioVieira66425/CHIPS-Company/actions)
[![Banco](https://img.shields.io/badge/PostgreSQL-Supabase-336791?logo=postgresql&logoColor=white)](https://supabase.com)
[![Hospedagem](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=white)](https://render.com)
[![Licença](https://img.shields.io/badge/uso-acadêmico-lightgrey)]()

**TCC em Engenharia de Computação — Faculdade de Tecnologia Pitágoras**
Autor: **Rogério Vieira**
Artigo associado: **RECIMA21 (2026)**

**[Ver o site →](https://meus-investimentos-x7dn.onrender.com)**

</div>

---

## O problema

O comércio eletrônico brasileiro movimentou R$ 295,6 bilhões em 2025 (FecomercioSP). O consumidor passou a contar com dezenas de lojas virtuais para comprar componentes de hardware (placas de vídeo, processadores, memória, SSDs), mas os preços ficam espalhados por plataformas que não se comunicam — então saber se uma oferta é mesmo vantajosa exige abrir cada site, hora a hora.

O **CHIPS Company** resolve isso em quatro camadas: **coleta automatizada**, **armazenamento histórico**, **avaliação analítica** e **apresentação em aplicação web**.

---

## Arquitetura

```
 ┌────────────────┐    ┌──────────────────┐    ┌─────────────────────┐    ┌─────────────────┐
 │   Coletores    │───▶│   Importador     │───▶│      Análise        │───▶│  Aplicação Web  │
 │  KaBuM! API    │    │  (Node.js)       │    │  ml_model.py        │    │ Node + HTML/CSS │
 │  Amazon        │    │  deduplica       │    │  • Regra ±10%/±5%   │    │  pt · en · es   │
 │  (Selenium)    │    │  filtra < R$ 1   │    │  • Random Forest    │    │  Render         │
 └────────────────┘    └─────────┬────────┘    └──────────┬──────────┘    └─────────────────┘
                                 │                        │                       ▲
                                 ▼                        ▼                       │
                        ┌──────────────────────────────────────────┐              │
                        │       Supabase · PostgreSQL              │──────────────┘
                        │       tabela: ofertas_dia                │
                        │       (situacao, prob_ia_boa_compra)     │
                        └──────────────────────────────────────────┘
```

Tudo roda em **nuvens gratuitas**: GitHub Actions dispara o pipeline diariamente às 03:00 UTC, grava no Supabase (plano gratuito) e o Render serve a aplicação web.

---

## Como a avaliação funciona

Cada oferta é comparada à **média dos preços dos sete dias anteriores do mesmo produto, na mesma loja**. A variação V = (P − M) / M × 100 define a faixa:

| Faixa | Condição | Cor no site |
|---|---|---|
| **Boa compra** | V ≤ −10% | Verde escuro |
| Queda moderada | −10% < V ≤ −5% | Verde claro |
| Preço normal | −5% < V < +5% | Amarelo |
| Alta moderada | +5% ≤ V < +10% | Laranja |
| **Evitar** | V ≥ +10% | Vermelho |
| Sem histórico | produto novo na loja | Cinza |

Em paralelo, um **Random Forest** (treinado com os dias anteriores) estima a probabilidade de a oferta ser uma boa compra. Quando prob ≥ 0,5, o site mostra o selo **"Sugerida pela IA"** — sem alterar as cinco faixas da regra.

---

## Resultados (validação em 16 dias, 20/10/2026 a 04/11/2026)

### Regra de variação × métodos alternativos (AUC no teste de injeção)

| Método | AUC | Falsos alarmes |
|---|---|---|
| **Regra de variação** (10%) | **0,953** | 5,5% |
| K-Means (5 grupos) | 0,884 | 11,9% |
| Isolation Forest ampliado | 0,850 | 11,3% |
| Escore z por produto e loja | 0,514 | 16,6% |

### Random Forest fora da amostra (14 dias)

| Métrica | Média | Mínimo | Máximo |
|---|---|---|---|
| AUC vs regra do site | **0,999** | 0,998 | 1,000 |
| Recall vs regra | 99,7% | 97,1% | 100,0% |
| **Persistência no dia seguinte** | **72,3%** | 49,2% | 88,0% |

> **Persistência:** entre as ofertas marcadas como Boa Compra pela IA, 3 em cada 4 mantêm o preço abaixo de 95% da mediana histórica no dia seguinte.

### Variação de preço dentro do mesmo dia (KaBuM!, 04/11/2026)

Duas extrações no mesmo dia (12h20 e 18h03 UTC): **7,5%** das 19.279 ofertas em comum mudaram de preço em ~6 horas. Placas-mãe (29,8%), armazenamento (20,9%) e memórias RAM (17,1%) são as categorias mais voláteis.

---

## Stack técnica

<table>
<tr>
<td align="center" width="140"><b>Coleta</b><br><sub>Python · requests · Selenium · BeautifulSoup</sub></td>
<td align="center" width="140"><b>Importação</b><br><sub>Node.js · pg</sub></td>
<td align="center" width="140"><b>Banco</b><br><sub>PostgreSQL · Supabase</sub></td>
<td align="center" width="140"><b>ML</b><br><sub>scikit-learn · pandas · numpy</sub></td>
<td align="center" width="140"><b>Web</b><br><sub>Express · HTML/CSS/JS · Render</sub></td>
<td align="center" width="140"><b>CI/CD</b><br><sub>GitHub Actions (cron 03:00 UTC)</sub></td>
</tr>
</table>

---

## Estrutura do repositório

```
📁 pipeline/
   ├── extracao_lojas.py          # Coleta KaBuM! e Amazon
   ├── ml_model.py                # Regra de variação + Random Forest (grava no banco)
   ├── revisao_orientador.py      # Testes de injeção, retroativo, TF-IDF e silhueta
   └── validar_ia_retroativo.py   # Valida a IA fora da amostra em TODOS os dias
📁 scripts/
   └── importar-csv.js            # Importa o CSV para o Supabase (dedup, filtros)
📁 public/
   ├── app.js                     # Interface
   ├── estilo.css                 # Tema (incluindo o selo "Sugerida pela IA")
   └── idiomas.js                 # Português · English · Español
📄 server.js, ia.js, db.js        # Servidor Express + consulta ao banco
📄 .github/workflows/pipeline.yml # Cron diário
📄 artigo/                        # Artigo RECIMA21 (.docx e fontes)
```

---

## Como rodar localmente

**Pré-requisitos:** Node.js 22+, Python 3.10+, variável de ambiente `DATABASE_URL` com a string de conexão do Supabase.

```bash
# 1. Instalar dependências
npm install
pip install pandas numpy scikit-learn requests selenium beautifulsoup4 matplotlib seaborn psycopg2-binary

# 2. Rodar o servidor local (porta 3000)
npm start

# 3. (opcional) Rodar o pipeline manualmente
python pipeline/extracao_lojas.py
node scripts/importar-csv.js --adicionar pipeline/saida/ofertas_consolidadas.csv
python pipeline/ml_model.py
```

Ou dispare o workflow do GitHub Actions no modo somente análise:

```bash
gh workflow run pipeline.yml -f somente_analise=true
```

---

## Reprodutibilidade

- **Semente aleatória:** 42 em todos os experimentos (Random Forest, K-Means, injeção).
- **Base histórica:** reconstruída em cada execução; a janela de referência usa apenas os 7 dias **anteriores** ao dia avaliado, para evitar vazamento temporal (look-ahead bias).
- **Artefatos:** cada execução salva em `pipeline/saida/` e também como artifact do workflow:
  - `dados_enriquecidos_ia.csv` — todas as ofertas do dia com variação e probabilidade da IA
  - `metricas_random_forest.csv` — métricas fora da amostra do dia
  - `validacao_ia_retroativo.csv` — métricas de todos os dias anteriores da base
  - `graficos_artigo/figura1_classificacao_final.png` — gráfico de distribuição

---

## Conformidade com termos de uso

- **KaBuM!**: o robots.txt proíbe `/busca/*?` e `*?query=*`; a coleta usa o endpoint do catálogo com parâmetro de consulta. Ressalva mantida no artigo.
- **Amazon**: as Condições de Uso proíbem coleta automatizada de dados. A loja é mantida nesta versão do trabalho **apenas por propósito acadêmico, sem fim comercial**. Para uso em produção comercial, a coleta da Amazon deve ser suspensa ou substituída pela Product Advertising API oficial.

---

## Artigo e trabalhos futuros

O artigo associado foi submetido à revista **RECIMA21** e está em `artigo/ARTIGO_atualizado_04-11.docx`.

Trabalhos futuros apontados:

- Janela ancorada de longo prazo (ex.: menor preço dos últimos 90 dias) para mitigar o viés de ancoragem promocional em períodos como Black Friday.
- Catálogo mestre de produtos (SKU) para substituir a correspondência de nomes.
- Reativar coleta de Pichau e Terabyte.
- Monitoramento intradiário com múltiplas coletas por dia.

---

<div align="center">

### Licença e uso

Projeto acadêmico. Reutilização livre com citação da fonte.

**Autor:** Rogério Vieira · **Orientação:** [preencher]
**Contato:** [rogerio66425@gmail.com](mailto:rogerio66425@gmail.com)

[⬆ voltar ao topo](#chips-company)

</div>
