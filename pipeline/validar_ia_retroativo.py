"""Valida o Random Forest fora da amostra em TODOS os dias da base.

Para cada dia D com pelo menos 2 dias anteriores, o modelo e treinado com as
ofertas dos dias < D (atributos calculados so com janelas anteriores) e avaliado
em D. Alem das metricas contra o rotulo da regra de 10%, mede-se tambem a
persistencia: entre as ofertas classificadas como Boa Compra pela IA no dia D, em
quantas o preco permanece abaixo da mediana dos 7 dias anteriores no dia D+1?

Uso:
    DATABASE_URL=... python pipeline/validar_ia_retroativo.py
Saida: pipeline/saida/validacao_ia_retroativo.csv
"""
import os
import sys
from datetime import timedelta

import numpy as np
import pandas as pd
import psycopg2
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, precision_score, recall_score, roc_auc_score

MARGEM = 10.0
LIMIAR_PCT_TREINO = 8.0
LIMIAR_RS_TREINO = 250.0
LIMIAR_PRECO_CARO = 500.0
FEATURES = ['preco', 'desconto_absoluto', 'volatilidade_relativa',
            'preco_referencia_base', 'log_preco_referencia', 'n_coletas_anteriores']
SEMENTE = 42

PASTA_SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'saida')
os.makedirs(PASTA_SAIDA, exist_ok=True)


def carregar():
    url = os.environ.get('DATABASE_URL')
    if not url:
        sys.exit('[ERRO] DATABASE_URL nao definida.')
    with psycopg2.connect(url) as con:
        df = pd.read_sql('SELECT nome_produto, loja, preco, dia FROM ofertas_dia '
                         "WHERE preco > 0 AND preco <> 9999.99", con)
    df['dia'] = pd.to_datetime(df['dia']).dt.date
    # uma oferta por produto, loja e dia (a de menor preco)
    df = df.sort_values('preco').drop_duplicates(['nome_produto', 'loja', 'dia']).reset_index(drop=True)
    return df


def montar(base, dia):
    do_dia = base[base['dia'] == dia]
    inicio = dia - timedelta(days=7)
    janela = base[(base['dia'] < dia) & (base['dia'] >= inicio)]
    if do_dia.empty or janela.empty:
        return None
    ref = janela.groupby(['nome_produto', 'loja'])['preco'].agg(
        media='mean', desvio='std', mediana='median', n='count').reset_index()
    ref['desvio'] = ref['desvio'].fillna(0)
    m = do_dia.merge(ref, on=['nome_produto', 'loja'], how='inner')
    m['preco_referencia_base'] = m['media']
    m['desconto_absoluto'] = (m['media'] - m['preco']).round(2)
    m['volatilidade_relativa'] = (m['desvio'] / m['media'] * 100).round(2)
    m['log_preco_referencia'] = np.log(m['media'])
    m['n_coletas_anteriores'] = m['n']
    m['mediana_janela'] = m['mediana']
    variacao = (m['preco'] - m['media']) / m['media'] * 100
    m['rotulo_regra'] = (variacao <= -MARGEM).astype(int)
    pct_ok = variacao <= -LIMIAR_PCT_TREINO
    rs_ok = (m['desconto_absoluto'] >= LIMIAR_RS_TREINO) & (m['media'] >= LIMIAR_PRECO_CARO)
    m['rotulo_treino'] = (pct_ok | rs_ok).astype(int)
    return m


def main():
    print('Lendo a base...')
    base = carregar()
    dias = sorted(base['dia'].unique())
    print(f'{len(base)} ofertas em {len(dias)} dias.')

    linhas = []
    for i, dia in enumerate(dias):
        anteriores = dias[:i]
        if len(anteriores) < 2:
            continue
        partes = [montar(base, d) for d in anteriores]
        partes = [p for p in partes if p is not None]
        if not partes:
            continue
        treino = pd.concat(partes, ignore_index=True)
        if treino['rotulo_treino'].nunique() < 2:
            continue
        teste = montar(base, dia)
        if teste is None or teste.empty:
            continue
        rf = RandomForestClassifier(n_estimators=100, random_state=SEMENTE, class_weight='balanced',
                                    min_samples_leaf=20)
        rf.fit(treino[FEATURES].fillna(0), treino['rotulo_treino'])
        prob = rf.predict_proba(teste[FEATURES].fillna(0))[:, 1]
        prev = rf.predict(teste[FEATURES].fillna(0))

        y_regra = teste['rotulo_regra'].values
        y_weak = teste['rotulo_treino'].values

        # persistencia: ofertas marcadas pela IA no dia; ver preco no dia seguinte
        persistencia = None
        n_boa_compra_ia = int(prev.sum())
        if i + 1 < len(dias) and n_boa_compra_ia > 0:
            dia_seguinte = dias[i + 1]
            seguinte = base[base['dia'] == dia_seguinte][['nome_produto', 'loja', 'preco']].rename(
                columns={'preco': 'preco_seg'})
            marcadas = teste[prev == 1][['nome_produto', 'loja', 'mediana_janela']].reset_index(drop=True)
            m = marcadas.merge(seguinte, on=['nome_produto', 'loja'], how='inner')
            if not m.empty:
                # persiste quando o preco seguinte continua abaixo de 95% da mediana da janela
                persistiu = (m['preco_seg'] <= m['mediana_janela'] * 0.95).sum()
                persistencia = round(100 * persistiu / len(m), 2)

        reg = {
            'data_avaliada': str(dia),
            'dias_treino': len(anteriores),
            'ofertas_treino': len(treino),
            'ofertas_teste': len(teste),
            'taxa_boa_compra_regra': round(float(y_regra.mean()), 4),
            'taxa_boa_compra_weak': round(float(y_weak.mean()), 4),
            'auc_vs_regra': round(roc_auc_score(y_regra, prob), 4) if len(np.unique(y_regra)) > 1 else np.nan,
            'auc_vs_weak': round(roc_auc_score(y_weak, prob), 4) if len(np.unique(y_weak)) > 1 else np.nan,
            'acuracia_vs_regra': round(accuracy_score(y_regra, prev), 4),
            'precisao_vs_regra': round(precision_score(y_regra, prev, zero_division=0), 4),
            'recall_vs_regra': round(recall_score(y_regra, prev, zero_division=0), 4),
            'marcadas_pela_ia': n_boa_compra_ia,
            'persistencia_dia_seguinte_pct': persistencia,
        }
        linhas.append(reg)
        print(f"  {dia}: AUC vs regra = {reg['auc_vs_regra']}, marcadas={n_boa_compra_ia}, "
              f"persistencia={persistencia}%")

    if not linhas:
        sys.exit('[ERRO] Sem dias suficientes para validar.')
    df = pd.DataFrame(linhas)
    saida = os.path.join(PASTA_SAIDA, 'validacao_ia_retroativo.csv')
    df.to_csv(saida, sep=';', index=False, encoding='utf-8-sig', decimal=',')
    print(f'\nResumo em {len(df)} dias:')
    for coluna in ['auc_vs_regra', 'auc_vs_weak', 'precisao_vs_regra', 'recall_vs_regra',
                   'persistencia_dia_seguinte_pct']:
        val = df[coluna].dropna()
        if not val.empty:
            print(f"  {coluna}: media = {val.mean():.4f} (mediana {val.median():.4f}, "
                  f"min {val.min():.4f}, max {val.max():.4f})")
    print(f'\nCSV completo em {saida}')


if __name__ == '__main__':
    main()
