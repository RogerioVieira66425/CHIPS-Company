"""Calibracao do contamination e comparacao com uma regra simples.

O contamination do Isolation Forest so define o ponto de corte. Por isso, a qualidade
do modelo e medida pela ordenacao das ofertas (AUC), que nao depende do contamination.
Comparamos essa ordenacao com a regra mais simples possivel: o valor absoluto da variacao.

Testes em varios dias, para escolher o contamination num dia e avaliar em outro:
- positivos: ofertas com variacao injetada (-5%, -10%, -20%, +30%)
- negativos: ofertas sem alteracao

Uso (somente leitura no banco):
    DATABASE_URL=... python pipeline/calibracao.py
"""
import os
import sys

import numpy as np
import pandas as pd
import psycopg2
from sklearn.ensemble import IsolationForest
from sklearn.metrics import roc_auc_score

from validacao import carregar, referencia_janela

SEMENTE = 42
N_INJETADAS = 1000
CONDICOES = [-5, -10, -20, +30]
CONTAMINATIONS = [0.01, 0.02, 0.047, 0.10, 0.15, 0.20]


def preparar(serie, dia):
    dia = pd.Timestamp(dia)
    hoje = serie[serie['dia'] == dia].copy()
    janela = referencia_janela(serie, dia)
    media = janela.groupby('nome_produto')['preco'].mean()
    hoje = hoje[hoje['nome_produto'].isin(media.index)].copy()
    hoje['media_janela'] = hoje['nome_produto'].map(media)
    return hoje


def avaliar_dia(serie, dia, rng):
    d = preparar(serie, dia)
    escolhidas = rng.choice(d.index.values, size=N_INJETADAS * len(CONDICOES), replace=False)
    d['injetada'] = False
    d['fator'] = 0.0
    for i, cond in enumerate(CONDICOES):
        idx = escolhidas[i * N_INJETADAS:(i + 1) * N_INJETADAS]
        d.loc[idx, 'injetada'] = True
        d.loc[idx, 'fator'] = cond
        d.loc[idx, 'preco'] = d.loc[idx, 'preco'] * (1 + cond / 100)
    d['variacao'] = (d['preco'] - d['media_janela']) / d['media_janela'] * 100
    x = d[['variacao']].values
    rotulo = d['injetada'].astype(int).values

    resultado = {'dia': str(pd.Timestamp(dia).date()), 'n': len(d),
                 'auc_regra': roc_auc_score(rotulo, np.abs(d['variacao'].values))}
    modelo = IsolationForest(contamination=0.1, random_state=SEMENTE).fit(x)
    # score menor = mais isolado (mais anomalo); invertido para AUC
    score = -modelo.score_samples(x)
    resultado['auc_iforest'] = roc_auc_score(rotulo, score)

    for c in CONTAMINATIONS:
        m = IsolationForest(contamination=c, random_state=SEMENTE).fit(x)
        alerta = (m.predict(x) == -1) & (np.abs(d['variacao'].values) > 5.0)
        recall = alerta[rotulo == 1].mean() * 100
        fpr = alerta[rotulo == 0].mean() * 100
        resultado[f'recall_{c}'] = recall
        resultado[f'fpr_{c}'] = fpr
    return resultado


def main():
    serie = carregar()
    dias = sorted(serie['dia'].unique())[-5:]  # ultimos 5 dias da base
    rng = np.random.default_rng(SEMENTE)
    linhas = []
    for dia in dias:
        linhas.append(avaliar_dia(serie, dia, rng))
    df = pd.DataFrame(linhas)

    print('\nAUC (quanto mais perto de 1, melhor separa mudanca real de ruido):')
    print(df[['dia', 'n', 'auc_regra', 'auc_iforest']].round(3).to_string(index=False))

    print('\nRecall e falsos alarmes por contamination (media dos dias):')
    tabela = []
    for c in CONTAMINATIONS:
        tabela.append({'contamination': c,
                       'recall_%': round(df[f'recall_{c}'].mean(), 1),
                       'falsos_alarmes_%': round(df[f'fpr_{c}'].mean(), 2)})
    print(pd.DataFrame(tabela).to_string(index=False))

    saida = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'saida')
    os.makedirs(saida, exist_ok=True)
    df.to_csv(os.path.join(saida, 'calibracao.csv'), index=False, sep=';', decimal=',')


if __name__ == '__main__':
    if not os.environ.get('DATABASE_URL'):
        sys.exit('[ERRO] DATABASE_URL nao definida.')
    main()
