"""Validacao do modelo de classificacao de precos.

Dois testes sobre a base real (tabela ofertas_dia):

1. Injecao: aplica quedas e altas conhecidas em ofertas reais do ultimo dia e mede
   quantas o Isolation Forest (mesma configuracao do ml_model.py) detecta, e quantos
   falsos alarmes gera nas ofertas nao alteradas.
2. Retroativo: para ofertas que a regra historica marcaria como "Boa compra" ou
   "Evitar" em um dia, verifica o preco do dia seguinte: continuou fora do normal
   ou voltou para a faixa habitual?

Uso (somente leitura no banco):
    DATABASE_URL=... python pipeline/validacao.py
Os resultados sao impressos e salvos em pipeline/saida/validacao.md.
"""
import os
import sys

import numpy as np
import pandas as pd
import psycopg2
from sklearn.ensemble import IsolationForest

SEMENTE = 42
JANELA_DIAS = 7
LIMITE_RELEVANCIA = 5.0      # so vira anomalia variacao acima de 5%
CONTAMINACAO = 0.047          # mesmo valor do ml_model.py
N_INJETADAS = 1000           # ofertas alteradas por condicao
CONDICOES = [-5, -10, -20, +30]


def carregar():
    url = os.environ.get('DATABASE_URL')
    if not url:
        sys.exit('[ERRO] DATABASE_URL nao definida.')
    with psycopg2.connect(url) as conexao:
        bruto = pd.read_sql('SELECT nome_produto, loja, preco, dia FROM ofertas_dia', conexao)
    bruto['dia'] = pd.to_datetime(bruto['dia'])
    # uma observacao por produto, loja e dia: o menor preco do dia
    return bruto.groupby(['nome_produto', 'loja', 'dia'], as_index=False)['preco'].min()


def referencia_janela(serie, dia):
    """Media e mediana das coletas dos JANELA_DIAS anteriores a 'dia' (sem incluir o proprio dia)."""
    inicio = dia - pd.Timedelta(days=JANELA_DIAS)
    anteriores = serie[(serie['dia'] < dia) & (serie['dia'] >= inicio)]
    return anteriores


def teste_injecao(serie, dia_alvo):
    dia_alvo = pd.Timestamp(dia_alvo)
    hoje = serie[serie['dia'] == dia_alvo].copy()
    janela = referencia_janela(serie, dia_alvo)
    media = janela.groupby('nome_produto')['preco'].mean()
    hoje = hoje[hoje['nome_produto'].isin(media.index)].copy()
    hoje['media_janela'] = hoje['nome_produto'].map(media)
    if len(hoje) < 100:
        sys.exit('[ERRO] poucas ofertas com historico no dia escolhido.')

    resultados = {}
    rng = np.random.default_rng(SEMENTE)
    for condicao in CONDICOES:
        d = hoje.copy()
        escolhidas = rng.choice(d.index.values, size=min(N_INJETADAS, len(d)), replace=False)
        d['injetada'] = d.index.isin(escolhidas)
        d.loc[d['injetada'], 'preco'] = d.loc[d['injetada'], 'preco'] * (1 + condicao / 100)
        d['variacao'] = (d['preco'] - d['media_janela']) / d['media_janela'] * 100
        modelo = IsolationForest(contamination=CONTAMINACAO, random_state=SEMENTE)
        previsao = modelo.fit_predict(d[['variacao']].values)
        alerta = (previsao == -1) & (d['variacao'].abs().values > LIMITE_RELEVANCIA)
        d['alerta'] = alerta
        resultados[condicao] = {
            'injetadas': int(d['injetada'].sum()),
            'detectadas': int((d['injetada'] & d['alerta']).sum()),
            'falsos_alarmes': int((~d['injetada'] & d['alerta']).sum()),
            'nao_injetadas': int((~d['injetada']).sum()),
        }
    return resultados


def teste_retroativo(serie):
    """Para cada oferta classificada pela regra historica, olha o preco do dia seguinte."""
    serie = serie.sort_values(['nome_produto', 'loja', 'dia']).copy()
    dias = sorted(serie['dia'].unique())
    contagem = {'Boa compra': [0, 0, 0], 'Evitar': [0, 0, 0]}  # [total, voltou ao normal, continuou fora]
    for i, dia in enumerate(dias[:-1]):
        atual = serie[serie['dia'] == dia]
        seguinte = serie[serie['dia'] == dias[i + 1]][['nome_produto', 'loja', 'preco']].rename(columns={'preco': 'preco_seguinte'})
        janela = referencia_janela(serie, pd.Timestamp(dia))
        if janela.empty:
            continue
        estat = janela.groupby(['nome_produto', 'loja'])['preco'].agg(['min', 'max', 'median']).reset_index()
        # preco constante na janela nao e avaliado (igual ao site): so precos que variaram entram
        estat = estat[estat['max'] > estat['min']]
        m = atual.merge(estat, on=['nome_produto', 'loja']).merge(seguinte, on=['nome_produto', 'loja'])
        boa = (m['preco'] <= m['min'] * 1.02) | (m['preco'] < m['median'] * 0.95)
        evitar = (~boa) & (m['preco'] > m['median'] * 1.05)
        for rotulo, mascara in [('Boa compra', boa), ('Evitar', evitar)]:
            sub = m[mascara]
            if rotulo == 'Boa compra':
                voltou = sub['preco_seguinte'] >= sub['median'] * 0.95
            else:
                voltou = sub['preco_seguinte'] <= sub['median'] * 1.05
            contagem[rotulo][0] += len(sub)
            contagem[rotulo][1] += int(voltou.sum())
            contagem[rotulo][2] += int((~voltou).sum())
    return contagem


def main():
    serie = carregar()
    dia_alvo = serie['dia'].max()
    print(f'Base: {serie["dia"].nunique()} dias, {len(serie)} observacoes.')

    injecao = teste_injecao(serie, dia_alvo)
    linhas = [f'# Validacao do modelo', '', f'Dia de teste: {dia_alvo.date()}. Janela: {JANELA_DIAS} dias. '
              f'Limite de relevancia: {LIMITE_RELEVANCIA}%. Contamination: {CONTAMINACAO}.', '',
              '## 1. Injecao de variacoes conhecidas', '',
              '| Variacao injetada | Ofertas alteradas | Detectadas (recall) | Falsos alarmes nas nao alteradas |',
              '|---|---|---|---|']
    for condicao, r in injecao.items():
        recall = 100.0 * r['detectadas'] / r['injetadas'] if r['injetadas'] else 0
        fpr = 100.0 * r['falsos_alarmes'] / r['nao_injetadas'] if r['nao_injetadas'] else 0
        linhas.append(f'| {condicao:+d}% | {r["injetadas"]} | {r["detectadas"]} ({recall:.1f}%) | '
                      f'{r["falsos_alarmes"]} ({fpr:.2f}%) |')

    retro = teste_retroativo(serie)
    linhas += ['', '## 2. Teste retroativo', '',
               'Ofertas classificadas pela regra historica em um dia, e o preco no dia seguinte.', '',
               '| Classificacao | Ofertas | Voltou a faixa habitual | Continuou fora |',
               '|---|---|---|---|']
    for rotulo, (total, voltou, continuou) in retro.items():
        pct_v = 100.0 * voltou / total if total else 0
        pct_c = 100.0 * continuou / total if total else 0
        linhas.append(f'| {rotulo} | {total} | {voltou} ({pct_v:.1f}%) | {continuou} ({pct_c:.1f}%) |')

    texto = '\n'.join(linhas) + '\n'
    print(texto)
    saida = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'saida')
    os.makedirs(saida, exist_ok=True)
    with open(os.path.join(saida, 'validacao.md'), 'w', encoding='utf-8') as f:
        f.write(texto)


if __name__ == '__main__':
    main()
