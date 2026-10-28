import os
import re
import sys

import matplotlib
matplotlib.use('Agg')  # sem janela: roda no servidor do GitHub

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2
import seaborn as sns
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

diretorio_atual = os.path.dirname(os.path.abspath(__file__))
pasta_saida = os.path.join(diretorio_atual, 'saida')
pasta_graficos = os.path.join(pasta_saida, 'graficos_artigo')
os.makedirs(pasta_graficos, exist_ok=True)


def extrair_modelo_principal(nome):
    nome = str(nome).strip()
    categorias = [
        r'teclado\s+para\s+notebook', r'teclado\s+mecan[íi]co', r'teclado\s+gamer', r'teclado',
        r'placa\s+de\s+v[íi]deo', r'placa\s+m[ãa]e', r'mem[óo]ria\s+ram', r'mem[óo]ria',
        r'fonte\s+de\s+alimenta[çc][ãa]o', r'fonte', r'gabinete\s+gamer', r'gabinete',
        r'mouse\s+gamer', r'mouse', r'headset\s+gamer', r'headset', r'monitor\s+gamer', r'monitor',
        r'ssd\s+nvme', r'ssd', r'hd\s+externo', r'disco\s+r[íi]gido',
        r'cooler\s+para\s+processador', r'water\s+cooler', r'processador', r'microfone'
    ]
    regex = r'^(?:' + '|'.join(categorias) + r')\s*(?:[-|]\s*)?'
    nome_limpo = re.sub(regex, '', nome, flags=re.IGNORECASE)
    nome_limpo = re.sub(r'\s+', ' ', nome_limpo).strip().title()
    if not nome_limpo or nome_limpo == '-':
        return nome.title()
    return nome_limpo


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

print("Padronizando nomes com TF-IDF...")
memoria_precos['nome_limpo'] = memoria_precos['nome_produto'].apply(extrair_modelo_principal)
df_hoje['nome_limpo'] = df_hoje['nome_produto'].apply(extrair_modelo_principal)

nomes_base_originais = memoria_precos['nome_produto'].tolist()
nomes_base_limpos = memoria_precos['nome_limpo'].tolist()

vetorizador = TfidfVectorizer(analyzer='word', ngram_range=(1, 2), lowercase=True)
matriz_base = vetorizador.fit_transform(nomes_base_limpos)


def buscar_produto_tfidf(linha, limite=0.45):
    vetor_pesquisa = vetorizador.transform([linha['nome_limpo']])
    similaridades = cosine_similarity(vetor_pesquisa, matriz_base)[0]
    indice_maior = np.argmax(similaridades)
    if similaridades[indice_maior] >= limite:
        return nomes_base_originais[indice_maior]
    return linha['nome_produto']


df_hoje['nome_produto_padronizado'] = df_hoje.apply(buscar_produto_tfidf, axis=1)

medias_historicas = memoria_precos.groupby('nome_produto')['preco'].mean().reset_index()
medias_historicas.rename(columns={'preco': 'preco_referencia_base'}, inplace=True)

df = df_hoje.merge(medias_historicas, left_on='nome_produto_padronizado', right_on='nome_produto',
                   how='left', suffixes=('_x', ''))

produtos_novos = df['preco_referencia_base'].isna()
df.loc[produtos_novos, 'preco_referencia_base'] = df.loc[produtos_novos, 'preco']
df['variacao_vs_base'] = ((df['preco'] - df['preco_referencia_base']) / df['preco_referencia_base']) * 100

print("Treinando Isolation Forest...")
# regra de variacao frente aos 7 dias anteriores (substitui o Isolation Forest, que nao
# superou a variacao absoluta na validacao): queda >= 10% = Boa Compra, alta >= 10% = Evitar
MARGEM = 10.0
df['situacao_compra'] = 'Sem Histórico (Novo)'
if not produtos_novos_flag:
    df.loc[~produtos_novos, 'situacao_compra'] = 'Preço Médio'
    df.loc[(~produtos_novos) & (df['variacao_vs_base'] <= -MARGEM), 'situacao_compra'] = 'Boa Compra'
    df.loc[(~produtos_novos) & (df['variacao_vs_base'] >= MARGEM), 'situacao_compra'] = 'Evitar'
    df.loc[(~produtos_novos) & (df['variacao_vs_base'] <= -5) & (df['variacao_vs_base'] > -MARGEM), 'situacao_compra'] = 'Queda Moderada'
    df.loc[(~produtos_novos) & (df['variacao_vs_base'] >= 5) & (df['variacao_vs_base'] < MARGEM), 'situacao_compra'] = 'Alta Moderada'

if 'nome_produto_x' in df.columns:
    df.rename(columns={'nome_produto_x': 'nome_oferta_original'}, inplace=True)
else:
    df.rename(columns={'nome_produto': 'nome_oferta_original'}, inplace=True)

colunas_finais = [c for c in ['nome_produto_padronizado', 'nome_oferta_original', 'id_loja', 'preco',
                              'preco_referencia_base', 'variacao_vs_base', 'situacao_compra', 'url_oferta']
                  if c in df.columns]
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
cores = {'Boa Compra': '#2ca02c', 'Preço Médio': '#1f77b4', 'Evitar': '#ff7f0e',
         'Anomalia (Isolada por IA)': '#d62728', 'Sem Histórico (Novo)': '#7f7f7f'}
ordem = ['Boa Compra', 'Preço Médio', 'Evitar', 'Anomalia (Isolada por IA)', 'Sem Histórico (Novo)']
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
