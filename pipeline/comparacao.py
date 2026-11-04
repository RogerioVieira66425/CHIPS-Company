"""Compara o pipeline antigo (Isolation Forest, contamination 0,047, limite de 5%) com o novo
(regra de variacao: queda ou alta de 10% ou mais), no mesmo teste de injecao.

Para cada dia (ultimos 5 da base), injeta variacoes conhecidas em 1000 ofertas por condicao
e mede, por condicao, a taxa de deteccao (recall) e a taxa de falsos alarmes nas ofertas
nao alteradas. A media e tirada sobre os dias.

Uso (somente leitura no banco):
    DATABASE_URL=... python pipeline/comparacao.py
"""
import os
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

from calibracao import CONDICOES, N_INJETADAS, SEMENTE, preparar
from validacao import carregar

CONTAMINATION_ANTIGO = 0.047
LIMITE_ANTIGO = 5.0
MARGEM_NOVO = 10.0


def avaliar_dia(serie, dia, rng):
    d = preparar(serie, dia)
    escolhidas = rng.choice(d.index.values, size=N_INJETADAS * len(CONDICOES), replace=False)
    d['condicao'] = np.nan
    for i, cond in enumerate(CONDICOES):
        idx = escolhidas[i * N_INJETADAS:(i + 1) * N_INJETADAS]
        d.loc[idx, 'condicao'] = cond
        d.loc[idx, 'preco'] = d.loc[idx, 'preco'] * (1 + cond / 100)
    d['variacao'] = (d['preco'] - d['media_janela']) / d['media_janela'] * 100

    x = d[['variacao']].values
    antigo = (IsolationForest(contamination=CONTAMINATION_ANTIGO, random_state=SEMENTE).fit_predict(x) == -1) \
        & (d['variacao'].abs().values > LIMITE_ANTIGO)
    novo = (d['variacao'] <= -MARGEM_NOVO) | (d['variacao'] >= MARGEM_NOVO)

    linhas = []
    for cond in CONDICOES:
        injetadas = d['condicao'] == cond
        linhas.append({'condicao': cond,
                       'recall_antigo': antigo[injetadas.values].mean() * 100,
                       'recall_novo': novo[injetadas.values].mean() * 100})
    nao_alteradas = d['condicao'].isna().values
    fpr = {'fpr_antigo': antigo[nao_alteradas].mean() * 100,
           'fpr_novo': novo.values[nao_alteradas].mean() * 100}
    return linhas, fpr


def main():
    serie = carregar()
    dias = sorted(serie['dia'].unique())[-5:]
    rng = np.random.default_rng(SEMENTE)
    todas, fprs = [], []
    for dia in dias:
        linhas, fpr = avaliar_dia(serie, dia, rng)
        todas += [dict(l, dia=str(pd.Timestamp(dia).date())) for l in linhas]
        fprs.append(fpr)

    df = pd.DataFrame(todas)
    resumo = df.groupby('condicao')[['recall_antigo', 'recall_novo']].mean().round(1)
    fpr_medio = pd.DataFrame(fprs).mean().round(2)

    print(f'Dias avaliados: {len(dias)} ({str(pd.Timestamp(dias[0]).date())} a {str(pd.Timestamp(dias[-1]).date())})')
    print('\nRecall (% das ofertas alteradas detectadas), media dos dias:')
    print(resumo.rename(index=lambda c: f'{c:+d}%').to_string())
    print('\nFalsos alarmes (% das ofertas nao alteradas marcadas), media dos dias:')
    print(f'  antigo (Isolation Forest, contamination 0,047): {fpr_medio["fpr_antigo"]}%')
    print(f'  novo (regra de 10%):                             {fpr_medio["fpr_novo"]}%')

    saida = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'saida')
    os.makedirs(saida, exist_ok=True)
    df.to_csv(os.path.join(saida, 'comparacao.csv'), index=False, sep=';', decimal=',')


if __name__ == '__main__':
    if not os.environ.get('DATABASE_URL'):
        sys.exit('[ERRO] DATABASE_URL nao definida.')
    main()
