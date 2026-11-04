import os
import sys
from datetime import timedelta

import matplotlib
matplotlib.use('Agg')  # sem janela: roda no servidor do GitHub

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2
import seaborn as sns
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, precision_score, recall_score, roc_auc_score
diretorio_atual = os.path.dirname(os.path.abspath(__file__))
pasta_saida = os.path.join(diretorio_atual, 'saida')
pasta_graficos = os.path.join(pasta_saida, 'graficos_artigo')
os.makedirs(pasta_graficos, exist_ok=True)

MARGEM = 10.0         # variacao de 10% ou mais: Boa compra / Evitar


def carregar_ofertas():
    url = os.environ.get('DATABASE_URL')
    if not url:
        sys.exit('[ERRO] DATABASE_URL nao definida.')
    # colunas renomeadas para o formato que o restante do script usa
    sql = ('SELECT nome_produto, preco, loja AS id_loja, url AS url_oferta, coletado_em AS data_coleta '
           'FROM ofertas_dia')
    with psycopg2.connect(url) as conexao:
        return pd.read_sql(sql, conexao)


print("Lendo as ofertas de ofertas_dia...")
df_completo = carregar_ofertas()

if df_completo.empty:
    sys.exit('[ERRO] A tabela ofertas_dia esta vazia. Rode a coleta e a importacao primeiro.')

df_completo['data_coleta'] = pd.to_datetime(df_completo['data_coleta'])
df_completo = df_completo.sort_values(by='data_coleta')

ultima_data = df_completo['data_coleta'].max()
df_hoje = df_completo[df_completo['data_coleta'].dt.date == ultima_data.date()].copy()
# janela de 7 dias anteriores ao dia avaliado: nenhuma coleta posterior entra na referencia
inicio_janela = (ultima_data - pd.Timedelta(days=7)).date()
memoria_precos = df_completo[(df_completo['data_coleta'].dt.date < ultima_data.date()) &
                             (df_completo['data_coleta'].dt.date >= inicio_janela)].copy()

if memoria_precos.empty:
    print("\n[AVISO] Só existe um dia de coleta: não há histórico para comparar.")
    memoria_precos = df_hoje.copy()
    produtos_novos_flag = True
else:
    produtos_novos_flag = False

# produto e identificado pelo nome exato da oferta, como no site (ia.js): sem agrupamento por similaridade
df_hoje['nome_produto_padronizado'] = df_hoje['nome_produto']

print("Calculando média e volatilidade por produto E loja (7 dias anteriores)...")
# referencia por produto e loja: sem coleta anterior na mesma loja, a oferta fica sem historico
stats_historico = memoria_precos.groupby(['nome_produto', 'id_loja'])['preco'].agg(['mean', 'std']).reset_index()
stats_historico.rename(columns={'nome_produto': 'nome_produto_padronizado',
                                'mean': 'preco_referencia_base',
                                'std': 'volatilidade_base'}, inplace=True)
stats_historico['volatilidade_base'] = stats_historico['volatilidade_base'].fillna(0)

df = df_hoje.merge(stats_historico, on=['nome_produto_padronizado', 'id_loja'], how='left')
df = df.rename(columns={'nome_produto': 'nome_oferta_original'})

produtos_novos = df['preco_referencia_base'].isna()
df.loc[produtos_novos, 'preco_referencia_base'] = df.loc[produtos_novos, 'preco']
df.loc[produtos_novos, 'volatilidade_base'] = 0

df['variacao_vs_base'] = (df['preco'] - df['preco_referencia_base']) / df['preco_referencia_base'] * 100
# escore z so informativo (CSV); a classificacao usa apenas a regra de variacao
df['z_score'] = np.where(df['volatilidade_base'] > 0,
                         (df['preco'] - df['preco_referencia_base']) / df['volatilidade_base'],
                         0)

df['preco_referencia_base'] = df['preco_referencia_base'].round(2)
df['volatilidade_base'] = df['volatilidade_base'].round(2)
df['z_score'] = df['z_score'].round(2)
df['variacao_vs_base'] = df['variacao_vs_base'].round(2)
df['preco'] = df['preco'].round(2)

# rotulos iguais aos da aplicacao (public/app.js e public/idiomas.js): Boa Compra = queda de 10% ou mais
df['situacao_compra'] = 'Sem Histórico (Novo)'
if not produtos_novos_flag:
    df.loc[~produtos_novos, 'situacao_compra'] = 'Preço Médio'
    df.loc[(~produtos_novos) & (df['variacao_vs_base'] <= -MARGEM), 'situacao_compra'] = 'Boa Compra'
    df.loc[(~produtos_novos) & (df['variacao_vs_base'] >= MARGEM), 'situacao_compra'] = 'Evitar'
    df.loc[(~produtos_novos) & (df['variacao_vs_base'] <= -5) & (df['variacao_vs_base'] > -MARGEM), 'situacao_compra'] = 'Queda Moderada'
    df.loc[(~produtos_novos) & (df['variacao_vs_base'] >= 5) & (df['variacao_vs_base'] < MARGEM), 'situacao_compra'] = 'Alta Moderada'

# --- RANDOM FOREST FORA DA AMOSTRA ---
# Treino: ofertas dos dias anteriores ao dia avaliado, com atributos calculados so com coletas anteriores a cada dia.
# Teste: ofertas do dia avaliado. A classificacao gravada NAO muda: o modelo gera uma probabilidade de Boa Compra
# e uma metrica de desempenho fora da amostra, comparada com o proprio rotulo da regra.
# Atributos SEM a variacao: a variacao define o rotulo, e inclui-la tornaria o teste trivial.
FEATURES = ['volatilidade_relativa', 'n_coletas_anteriores', 'log_preco_referencia']


def montar_atributos(base, dia):
    """Atributos das ofertas do dia `dia`, com a referencia calculada apenas com os 7 dias anteriores a ele."""
    do_dia = base[base['data_coleta'].dt.date == dia]
    inicio = dia - timedelta(days=7)
    janela = base[(base['data_coleta'].dt.date < dia) & (base['data_coleta'].dt.date >= inicio)]
    colunas = ['nome_produto', 'id_loja', 'url_oferta'] + FEATURES + ['rotulo_regra']
    if do_dia.empty or janela.empty:
        return pd.DataFrame(columns=colunas)
    ref = janela.groupby(['nome_produto', 'id_loja'])['preco'].agg(['mean', 'std', 'count']).reset_index()
    ref['std'] = ref['std'].fillna(0)
    m = do_dia.merge(ref, on=['nome_produto', 'id_loja'], how='inner')
    variacao = (m['preco'] - m['mean']) / m['mean'] * 100
    m['volatilidade_relativa'] = m['std'] / m['mean'] * 100
    m['n_coletas_anteriores'] = m['count']
    m['log_preco_referencia'] = np.log(m['mean'])
    m['rotulo_regra'] = (variacao <= -MARGEM).astype(int)
    return m[colunas]


dias_anteriores = sorted({d for d in df_completo['data_coleta'].dt.date.unique() if d < ultima_data.date()})
partes_treino = [montar_atributos(df_completo, d) for d in dias_anteriores]
partes_treino = [p for p in partes_treino if not p.empty]
treino = pd.concat(partes_treino, ignore_index=True) if partes_treino else pd.DataFrame()
teste = montar_atributos(df_completo, ultima_data.date())

df['prob_ia_boa_compra'] = np.nan
df['previsao_ia_boa_compra'] = np.nan
if produtos_novos_flag or treino.empty or treino['rotulo_regra'].nunique() < 2 or teste.empty:
    print("[AVISO] Sem dias anteriores suficientes para treinar o Random Forest: a IA nao foi aplicada hoje.")
else:
    print(f"Treinando o Random Forest com {len(treino)} ofertas de {len(dias_anteriores)} dias anteriores...")
    rf = RandomForestClassifier(n_estimators=100, random_state=42, class_weight='balanced', min_samples_leaf=20)
    rf.fit(treino[FEATURES].fillna(0), treino['rotulo_regra'])

    prob = rf.predict_proba(teste[FEATURES].fillna(0))[:, 1]
    prev = rf.predict(teste[FEATURES].fillna(0))
    saida_ia = teste[['nome_produto', 'id_loja', 'url_oferta']].copy()
    saida_ia['prob_ia_boa_compra'] = prob.round(4)
    saida_ia['previsao_ia_boa_compra'] = prev
    saida_ia = saida_ia.drop_duplicates(['nome_produto', 'id_loja', 'url_oferta'])
    saida_ia = saida_ia.rename(columns={'nome_produto': 'nome_produto_padronizado'})
    n_antes = len(df)
    df = df.drop(columns=['prob_ia_boa_compra', 'previsao_ia_boa_compra']).merge(
        saida_ia, on=['nome_produto_padronizado', 'id_loja', 'url_oferta'], how='left')
    assert len(df) == n_antes, 'merge da IA duplicou ofertas'

    # desempenho fora da amostra no dia avaliado, contra o rotulo da regra de 10%
    y_teste = teste['rotulo_regra'].values
    metricas = {
        'data_avaliada': str(ultima_data.date()),
        'dias_treino': len(dias_anteriores),
        'ofertas_treino': len(treino),
        'ofertas_teste': len(teste),
        'taxa_boa_compra_regra': round(float(y_teste.mean()), 4),
        'acuracia': round(accuracy_score(y_teste, prev), 4),
        'precisao': round(precision_score(y_teste, prev, zero_division=0), 4),
        'recall': round(recall_score(y_teste, prev, zero_division=0), 4),
        'auc': round(roc_auc_score(y_teste, prob), 4) if len(np.unique(y_teste)) > 1 else np.nan,
    }
    print("Metricas fora da amostra (Random Forest x regra de 10%):")
    for chave, valor in metricas.items():
        print(f"  {chave}: {valor}")
    pd.DataFrame([metricas]).to_csv(os.path.join(pasta_saida, 'metricas_random_forest.csv'), sep=';', index=False,
                                    encoding='utf-8-sig', decimal=',')

colunas_finais = ['nome_produto_padronizado', 'nome_oferta_original', 'id_loja', 'preco',
                  'preco_referencia_base', 'volatilidade_base', 'z_score', 'variacao_vs_base',
                  'situacao_compra', 'prob_ia_boa_compra', 'previsao_ia_boa_compra', 'url_oferta']
df_final = df[colunas_finais].sort_values(by=['nome_produto_padronizado', 'preco'])

caminho_final = os.path.join(pasta_saida, 'dados_enriquecidos_ia.csv')
df_final.to_csv(caminho_final, sep=';', index=False, encoding='utf-8-sig', decimal=',')
print(f"[SUCESSO] Tabela salva em: {caminho_final}")


def gravar_classificacao(df_classificado, dia):
    """Grava a classificacao do modelo em cada oferta do dia, para o site exibir o mesmo criterio."""
    url = os.environ.get('DATABASE_URL')
    if not url:
        sys.exit('[ERRO] DATABASE_URL nao definida: a classificacao nao foi gravada.')
    linhas = list(zip(df_classificado['situacao_compra'].astype(str),
                      df_classificado['url_oferta'].astype(str),
                      df_classificado['id_loja'].astype(str)))
    with psycopg2.connect(url) as conexao, conexao.cursor() as cur:
        cur.execute('CREATE TEMP TABLE ml_classificacao (situacao text, url text, loja text) ON COMMIT DROP')
        cur.executemany('INSERT INTO ml_classificacao (situacao, url, loja) VALUES (%s, %s, %s)', linhas)
        cur.execute('UPDATE ofertas_dia o SET situacao = c.situacao FROM ml_classificacao c '
                    'WHERE o.dia = %s AND o.url = c.url AND o.loja = c.loja', (dia,))
        atualizadas = cur.rowcount
    print(f"[SUCESSO] Classificacao gravada em {atualizadas} ofertas de {dia}.")


gravar_classificacao(df_final, ultima_data.strftime('%Y-%m-%d'))

print("Gerando gráfico...")
plt.figure(figsize=(10, 5))
# mesmas cores de public/estilo.css (classes situacao-*), para o grafico e o site coincidirem
cores = {'Boa Compra': '#12805c', 'Preço Médio': '#c99a00', 'Evitar': '#c8102e',
         'Anomalia (Isolada por IA)': '#b7791f', 'Sem Histórico (Novo)': '#5e6774',
         'Queda Moderada': '#5fa86a', 'Alta Moderada': '#e07a7a'}
ordem = ['Boa Compra', 'Queda Moderada', 'Preço Médio', 'Alta Moderada', 'Evitar', 'Sem Histórico (Novo)']
ax = sns.countplot(data=df, x='situacao_compra', hue='situacao_compra', palette=cores, order=ordem,
                   legend=False)
plt.title('Diagnóstico de preços por classificação', fontsize=14, fontweight='bold')
plt.ylabel('Volume de ofertas', fontsize=12)
plt.xlabel('Classificação', fontsize=12)
plt.xticks(rotation=15)
for p in ax.patches:
    ax.annotate(f'{int(p.get_height())}', (p.get_x() + p.get_width() / 2., p.get_height()),
                ha='center', va='center', xytext=(0, 5), textcoords='offset points')
plt.tight_layout()
plt.savefig(os.path.join(pasta_graficos, 'figura1_classificacao_final.png'), dpi=150)
print("[SUCESSO] Gráfico salvo.")
