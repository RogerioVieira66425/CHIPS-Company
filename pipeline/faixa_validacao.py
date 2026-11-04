"""Valida a faixa moderada (5% a 10%) com o mesmo teste de injecao.

Para cada condicao, mede a taxa de ofertas alteradas que caem em:
- alerta moderado: variacao com modulo de 5% ou mais (inclui a faixa de 5% a 10%)
- alerta forte: variacao com modulo de 10% ou mais (Boa compra / Evitar)
e os falsos alarmes nas ofertas nao alteradas, pelos dois criterios.

Uso (somente leitura no banco):
    DATABASE_URL=... python pipeline/faixa_validacao.py
"""
import os
import sys

import numpy as np
import pandas as pd

from calibracao import CONDICOES, N_INJETADAS, SEMENTE, preparar
from validacao import carregar

LIMITE_MODERADO = 5.0
LIMITE_FORTE = 10.0


def avaliar_dia(serie, dia, rng):
    d = preparar(serie, dia)
    escolhidas = rng.choice(d.index.values, size=N_INJETADAS * len(CONDICOES), replace=False)
    d['condicao'] = np.nan
    for i, cond in enumerate(CONDICOES):
        idx = escolhidas[i * N_INJETADAS:(i + 1) * N_INJETADAS]
        d.loc[idx, 'condicao'] = cond
        d.loc[idx, 'preco'] = d.loc[idx, 'preco'] * (1 + cond / 100)
    d['variacao'] = (d['preco'] - d['media_janela']) / d['media_janela'] * 100
    mod = d['variacao'].abs() >= LIMITE_MODERADO
    forte = d['variacao'].abs() >= LIMITE_FORTE
    nao = d['condicao'].isna().values
    linhas = []
    for cond in CONDICOES:
        inj = (d['condicao'] == cond).values
        linhas.append({'condicao': cond,
                       'recall_moderado': mod.values[inj].mean() * 100,
                       'recall_forte': forte.values[inj].mean() * 100})
    fpr = {'fpr_moderado': mod.values[nao].mean() * 100,
           'fpr_forte': forte.values[nao].mean() * 100}
    return linhas, fpr


def main():
    serie = carregar()
    dias = sorted(serie['dia'].unique())[-5:]
    rng = np.random.default_rng(SEMENTE)
    todas, fprs = [], []
    for dia in dias:
        linhas, fpr = avaliar_dia(serie, dia, rng)
        todas += linhas
        fprs.append(fpr)
    df = pd.DataFrame(todas)
    resumo = df.groupby('condicao')[['recall_moderado', 'recall_forte']].mean().round(1)
    fpr_medio = pd.DataFrame(fprs).mean().round(2)
    print(f'Dias avaliados: {len(dias)}')
    print('\nRecall (% das ofertas alteradas que caem no alerta), media dos dias:')
    print(resumo.rename(index=lambda c: f'{c:+d}%').to_string())
    print('\nFalsos alarmes (% das ofertas nao alteradas), media dos dias:')
    print(f'  alerta moderado (>= 5%):  {fpr_medio["fpr_moderado"]}%')
    print(f'  alerta forte (>= 10%):    {fpr_medio["fpr_forte"]}%')


if __name__ == '__main__':
    if not os.environ.get('DATABASE_URL'):
        sys.exit('[ERRO] DATABASE_URL nao definida.')
    main()
