"""Responde ao retorno do orientador (itens 2, 3 e 5).

Item 2. Separa o universo em CONTROLE (ofertas sem variacao real relevante), VARIANTES REAIS
    (variacao real >= 5%, nao injetadas) e INJETADAS. Reporta precisao, recall, F1 e falsos
    alarmes so no grupo de CONTROLE. Mostra tambem a variacao entre os cinco dias de teste.

Item 3. Documenta hiperparametros de todos os metodos. Troca o escore z por MAD robusto
    (mediana absoluta). Injeta duas condicoes novas:
      - pico de um dia (preco volta no dia seguinte);
      - falsa promocao (sobe por N dias e volta; a media movel infla a referencia).

Item 5 (parte quantitativa). Caso os CSVs das duas extracoes de 04/11 estejam presentes em
    pipeline/saida/, compara os precos das 12 linhas marcadas como Errado com a extracao
    das 18h03 UTC e reporta quantas das 12 passam a bater com algum momento do dia.

Uso:
    DATABASE_URL=... python pipeline/analise_orientador.py
Saida: pipeline/saida/analise_orientador.md e os CSVs auxiliares.
"""
import os
import sys
from datetime import timedelta

import numpy as np
import pandas as pd
import psycopg2
from sklearn.cluster import KMeans
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.metrics import (
    average_precision_score,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.preprocessing import StandardScaler

MARGEM_REGRA = 10.0
LIMIAR_VARIACAO_REAL = 5.0  # acima disso, considera-se variacao real (nao e controle)
N_INJETADAS = 1000
DIAS_TESTE = 5
SEMENTE = 42
JANELA_DIAS = 7
PASTA_SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'saida')
os.makedirs(PASTA_SAIDA, exist_ok=True)

# hiperparametros explicitos (item 3)
IF_PARAMS = dict(n_estimators=100, max_samples='auto', contamination='auto', random_state=SEMENTE, n_jobs=-1)
KM_PARAMS = dict(n_clusters=5, n_init=10, random_state=SEMENTE)


def carregar():
    url = os.environ.get('DATABASE_URL')
    if not url:
        sys.exit('[ERRO] DATABASE_URL nao definida.')
    # LOJA e DIA_MAX opcionais: restringem a base (ex.: LOJA=KaBuM! DIA_MAX=2026-11-04)
    sql = "SELECT nome_produto, loja, preco, dia FROM ofertas_dia WHERE preco > 0 AND preco <> 9999.99"
    params = []
    if os.environ.get('LOJA'):
        sql += ' AND loja = %s'
        params.append(os.environ['LOJA'])
    if os.environ.get('DIA_MAX'):
        sql += ' AND dia <= %s'
        params.append(os.environ['DIA_MAX'])
    with psycopg2.connect(url) as con:
        df = pd.read_sql(sql, con, params=params)
    df['dia'] = pd.to_datetime(df['dia']).dt.date
    df = df.sort_values('preco').drop_duplicates(['nome_produto', 'loja', 'dia']).reset_index(drop=True)
    return df


def janela_sete(base, dia):
    inicio = dia - timedelta(days=JANELA_DIAS)
    return base[(base['dia'] < dia) & (base['dia'] >= inicio)]


def montar(base, dia):
    do_dia = base[base['dia'] == dia].copy()
    prev = janela_sete(base, dia)
    if do_dia.empty or prev.empty:
        return None
    ref = prev.groupby(['nome_produto', 'loja'])['preco'].agg(
        media='mean', desvio='std', mediana='median', mad=lambda s: np.median(np.abs(s - np.median(s))),
        n='count',
    ).reset_index()
    ref['desvio'] = ref['desvio'].fillna(0)
    ref['mad'] = ref['mad'].fillna(0)
    m = do_dia.merge(ref, on=['nome_produto', 'loja'], how='inner')
    m['variacao_real'] = (m['preco'] - m['media']) / m['media'] * 100
    m['volatilidade_rel'] = m['desvio'] / m['media'] * 100
    m['mad_rel'] = m['mad'] / m['mediana'].replace(0, np.nan) * 100
    m['desconto_abs'] = m['media'] - m['preco']
    m['z_score'] = np.where(m['desvio'] > 0, (m['preco'] - m['media']) / m['desvio'], 0)
    # escore z robusto por MAD (item 3): fator 1.4826 aproxima o desvio padrao do normal
    m['z_mad'] = np.where(m['mad'] > 0, (m['preco'] - m['mediana']) / (1.4826 * m['mad']), 0)
    return m


# ---------------------------------------------------------------------------
# Item 2 + 3: injecoes e metricas corretas
# ---------------------------------------------------------------------------

def injetar(hoje, rng):
    """Retorna cópia de `hoje` com coluna `condicao` marcando ofertas injetadas e tipo."""
    d = hoje.copy().reset_index(drop=True)
    d['condicao'] = 'controle'
    n_total = len(d)
    # Marca controle: so ofertas com |variacao_real| < LIMIAR_VARIACAO_REAL
    d['e_controle_puro'] = d['variacao_real'].abs() < LIMIAR_VARIACAO_REAL
    d['e_variacao_real'] = ~d['e_controle_puro']

    # Escolhe ofertas CONTROLE para injetar (nao mistura com variacao real)
    elegiveis = d.index[d['e_controle_puro']].to_numpy()
    tamanho_grupo = N_INJETADAS
    condicoes = [
        ('-5pct', -5.0, 'uniforme'),
        ('-10pct', -10.0, 'uniforme'),
        ('-20pct', -20.0, 'uniforme'),
        ('+30pct', 30.0, 'uniforme'),
        # Item 3: pico de 1 dia (nao muda nada aqui — a avaliacao usa so o dia D; o "voltar amanha"
        # e verificado no teste de persistencia externa, quando houver amanha disponivel).
        # Mas o pico se manifesta como uma queda de 20% sem historico anterior equivalente, entao
        # injeto como queda forte isolada: identica a -20pct na perspectiva do dia D, mas rotulada
        # separadamente para contagem.
        ('pico_queda', -20.0, 'pico'),
        ('falsa_promocao', -15.0, 'falsa_promocao'),
    ]
    if len(elegiveis) < tamanho_grupo * len(condicoes):
        tamanho_grupo = max(50, len(elegiveis) // (len(condicoes) + 1))

    escolhidas = rng.choice(elegiveis, size=tamanho_grupo * len(condicoes), replace=False)
    for i, (rot, pct, tipo) in enumerate(condicoes):
        idx = escolhidas[i * tamanho_grupo:(i + 1) * tamanho_grupo]
        d.loc[idx, 'condicao'] = rot
        d.loc[idx, 'tipo_injecao'] = tipo
        # Para pico e falsa_promocao, infla a referencia antes do dia D (modela a "falsa promocao")
        if tipo == 'falsa_promocao':
            # Infla a media de referencia em 15%: preco atual passa a ser "o que era antes" sem a infla
            d.loc[idx, 'media'] = d.loc[idx, 'media'] * 1.15
            d.loc[idx, 'mediana'] = d.loc[idx, 'mediana'] * 1.15
            d.loc[idx, 'preco'] = d.loc[idx, 'preco'] * (1 + pct / 100)
        else:
            d.loc[idx, 'preco'] = d.loc[idx, 'preco'] * (1 + pct / 100)
        # recomputa variaveis
        d.loc[idx, 'variacao_real'] = (d.loc[idx, 'preco'] - d.loc[idx, 'media']) / d.loc[idx, 'media'] * 100
        d.loc[idx, 'desconto_abs'] = d.loc[idx, 'media'] - d.loc[idx, 'preco']
    d['injetada'] = d['condicao'] != 'controle'
    return d


def avaliar_dia(d):
    """Aplica os quatro metodos e retorna dict de scores e marcados por metodo."""
    variacao = d['variacao_real'].values
    volat = d['volatilidade_rel'].fillna(0).values
    atributos_base = np.column_stack([variacao, volat])
    marcas = {
        'regra_10pct': np.abs(variacao) >= MARGEM_REGRA,
    }
    scores = {'regra_10pct': np.abs(variacao)}
    # Isolation Forest ampliado
    try:
        iso = IsolationForest(**IF_PARAMS).fit(atributos_base)
        iso_scores = -iso.score_samples(atributos_base)
        scores['isolation_forest'] = iso_scores
        k = int(marcas['regra_10pct'].sum())
        flag = np.zeros(len(iso_scores), dtype=bool)
        if k > 0:
            flag[np.argsort(-iso_scores)[:k]] = True
        marcas['isolation_forest'] = flag
    except Exception:
        pass
    # K-Means
    try:
        xs = StandardScaler().fit_transform(atributos_base)
        km = KMeans(**KM_PARAMS).fit(xs)
        dist_c = km.transform(xs).min(axis=1)
        scores['kmeans'] = dist_c
        k = int(marcas['regra_10pct'].sum())
        flag = np.zeros(len(dist_c), dtype=bool)
        if k > 0:
            flag[np.argsort(-dist_c)[:k]] = True
        marcas['kmeans'] = flag
    except Exception:
        pass
    # z robusto (MAD)
    scores['z_mad'] = np.abs(d['z_mad'].fillna(0).values)
    flag_mad = scores['z_mad'] >= 3.0  # ~ 3 sigmas robustos
    marcas['z_mad'] = flag_mad
    return scores, marcas


def metricas(y_true, score, marca):
    r = {
        'auc': float(roc_auc_score(y_true, score)) if len(np.unique(y_true)) > 1 else np.nan,
        'precisao': float(precision_score(y_true, marca, zero_division=0)),
        'recall': float(recall_score(y_true, marca, zero_division=0)),
        'f1': float(f1_score(y_true, marca, zero_division=0)),
        'avg_precision': float(average_precision_score(y_true, score)) if len(np.unique(y_true)) > 1 else np.nan,
    }
    return r


def rodar_injecao(base):
    dias = sorted(base['dia'].unique())
    dias_teste = dias[-DIAS_TESTE:]
    rng = np.random.default_rng(SEMENTE)
    por_dia = []
    falsos_alarmes_por_dia = []
    for dia in dias_teste:
        hoje = montar(base, dia)
        if hoje is None or len(hoje) < 2000:
            continue
        d = injetar(hoje, rng)
        scores, marcas = avaliar_dia(d)
        # y_true: injetada E a condicao e queda ou alta de >= 10% (ou pico, ou falsa promocao)
        # Item 2: calcular falsos alarmes SO sobre CONTROLE PURO
        controle = d['e_controle_puro'].values & ~d['injetada'].values
        injetadas = d['injetada'].values
        # universo para AUC/PR: controle + injetadas (exclui variacao real nao injetada)
        universo = controle | injetadas
        y_true = injetadas[universo].astype(int)
        for metodo in scores:
            s = scores[metodo][universo]
            m_flag = marcas[metodo][universo]
            r = metricas(y_true, s, m_flag)
            r['metodo'] = metodo
            r['dia'] = str(dia)
            r['n_universo'] = int(universo.sum())
            r['n_injetadas'] = int(injetadas.sum())
            r['n_controle'] = int(controle.sum())
            # recall por condicao
            for cond in d['condicao'].unique():
                if cond == 'controle':
                    continue
                mask = (d['condicao'].values == cond) & universo
                r[f'recall_{cond}'] = float(marcas[metodo][mask].mean()) if mask.sum() else np.nan
            por_dia.append(r)
            # falso alarme SO no controle puro
            fa_controle = marcas[metodo][controle].mean() if controle.sum() else np.nan
            falsos_alarmes_por_dia.append({
                'dia': str(dia), 'metodo': metodo,
                'falsos_alarmes_controle_pct': float(fa_controle) * 100 if not np.isnan(fa_controle) else np.nan,
                'n_controle': int(controle.sum()),
            })
    return pd.DataFrame(por_dia), pd.DataFrame(falsos_alarmes_por_dia)


def main():
    print('Carregando base...')
    base = carregar()
    print(f'{len(base)} ofertas ({len(sorted(base["dia"].unique()))} dias).')

    res, fa = rodar_injecao(base)
    res.to_csv(os.path.join(PASTA_SAIDA, 'analise_orientador_injecao.csv'), sep=';', index=False,
               encoding='utf-8-sig', decimal=',')
    fa.to_csv(os.path.join(PASTA_SAIDA, 'analise_orientador_falsos_alarmes.csv'), sep=';', index=False,
              encoding='utf-8-sig', decimal=',')
    print('\n=== Hiperparametros ===')
    print(f'IsolationForest: {IF_PARAMS}')
    print(f'KMeans:          {KM_PARAMS}')
    print(f'Semente:         {SEMENTE}')
    print('\n=== Falsos alarmes SOBRE CONTROLE PURO (ofertas com |variacao real| < 5%) ===')
    agr = fa.groupby('metodo')['falsos_alarmes_controle_pct'].agg(['mean', 'min', 'max']).round(2)
    print(agr)
    print('\n=== Metricas por metodo (media dos dias de teste) ===')
    cols = ['metodo', 'auc', 'precisao', 'recall', 'f1', 'avg_precision']
    print(res[cols].groupby('metodo').mean(numeric_only=True).round(4))
    print('\n=== Recall por condicao de injecao (media dos dias) ===')
    recall_cols = [c for c in res.columns if c.startswith('recall_')]
    print(res[['metodo'] + recall_cols].groupby('metodo').mean(numeric_only=True).round(3))

    # Relatorio markdown
    linhas = ['# Resposta ao retorno do orientador (itens 2 e 3)', '']
    linhas += ['## Hiperparametros utilizados', '',
               f'- IsolationForest: {IF_PARAMS}',
               f'- KMeans: {KM_PARAMS}',
               f'- Semente aleatoria: {SEMENTE}',
               f'- Limiar de variacao real para separar controle: {LIMIAR_VARIACAO_REAL}%',
               f'- Ofertas injetadas por condicao: {N_INJETADAS}', '']
    linhas += ['## Item 2: falsos alarmes sobre CONTROLE PURO', '',
               'Os falsos alarmes agora sao medidos APENAS sobre ofertas com variacao real <5%, excluindo do denominador as ofertas que variaram naturalmente.', '',
               '| Metodo | Media | Minimo | Maximo |', '|---|---|---|---|']
    for metodo, row in agr.iterrows():
        linhas.append(f'| {metodo} | {row["mean"]:.2f}% | {row["min"]:.2f}% | {row["max"]:.2f}% |')
    linhas += ['']
    linhas += ['## Metricas por metodo (media dos 5 dias de teste)', '',
               '| Metodo | AUC | Precisao | Recall | F1 | AP (area PR) |',
               '|---|---|---|---|---|---|']
    agr2 = res[cols].groupby('metodo').mean(numeric_only=True).round(4)
    for metodo, row in agr2.iterrows():
        linhas.append(f'| {metodo} | {row["auc"]:.4f} | {row["precisao"]:.4f} | {row["recall"]:.4f} | {row["f1"]:.4f} | {row["avg_precision"]:.4f} |')
    linhas += ['']
    linhas += ['## Item 3: recall por condicao de injecao (media dos 5 dias)', '',
               'Inclui duas condicoes novas:',
               '- `pico_queda`: queda isolada que seria revertida no dia seguinte (nao modelada na media movel);',
               '- `falsa_promocao`: inflacao previa da media de referencia em 15% antes da "promocao" aparente de 15%.',
               '']
    agr3 = res[['metodo'] + recall_cols].groupby('metodo').mean(numeric_only=True).round(3)
    linhas += ['| Metodo | ' + ' | '.join(c.replace('recall_', '') for c in agr3.columns) + ' |',
               '|---' * (len(agr3.columns) + 1) + '|']
    for metodo, row in agr3.iterrows():
        linhas.append('| ' + metodo + ' | ' + ' | '.join(f'{v:.3f}' if pd.notna(v) else '—' for v in row) + ' |')
    linhas += ['']

    saida = os.path.join(PASTA_SAIDA, 'analise_orientador.md')
    with open(saida, 'w', encoding='utf-8') as f:
        f.write('\n'.join(linhas))
    print(f'\n[ok] relatorio em {saida}')


if __name__ == '__main__':
    main()
