"""Revisao pedida pelo orientador (criticas 1, 2, 3 e 5).

1. Isolation Forest com mais atributos e escore z por produto e loja, com o mesmo
   numero de ofertas marcadas que a regra de variacao (comparacao justa).
2. Agrupamento de nomes por TF-IDF: limiares de 0,35 a 0,65, teste de injecao com
   cada correspondencia e amostra de 100 pares para conferencia manual.
3. Referencia por produto e loja. Sem coleta anterior na mesma loja, a oferta fica
   como "Sem historico". Compara com a referencia por produto (versao anterior).
5. Criterio de acerto para "Boa compra" e amostras de 100 ofertas marcadas e 100
   normais para conferencia manual.

Uso (somente leitura no banco):
    DATABASE_URL=... python pipeline/revisao_orientador.py
Saida: pipeline/saida/revisao/revisao.md e os CSVs de amostra.
"""
import os
import re
import sys

import numpy as np
import pandas as pd
import psycopg2
from sklearn.cluster import KMeans
from sklearn.ensemble import IsolationForest
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import roc_auc_score, silhouette_score
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.preprocessing import StandardScaler

SEMENTE = 42
JANELA_DIAS = 7
N_INJETADAS = 1000
CONDICOES = [-5, -10, -20, +30]
LIMIARES_TFIDF = [0.35, 0.45, 0.55, 0.65]
LIMITE_PADRAO_TFIDF = 0.45   # valor usado em ml_model.py
N_AMOSTRA = 100
DIAS_TESTE = 5
PASTA_SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'saida', 'revisao')

# copiado de pipeline/ml_model.py (ml_model roda o pipeline inteiro ao ser importado)
CATEGORIAS = [
    r'teclado\s+para\s+notebook', r'teclado\s+mecan[íi]co', r'teclado\s+gamer', r'teclado',
    r'placa\s+de\s+v[íi]deo', r'placa\s+m[ãa]e', r'mem[óo]ria\s+ram', r'mem[óo]ria',
    r'fonte\s+de\s+alimenta[çc][ãa]o', r'fonte', r'gabinete\s+gamer', r'gabinete',
    r'mouse\s+gamer', r'mouse', r'headset\s+gamer', r'headset', r'monitor\s+gamer', r'monitor',
    r'ssd\s+nvme', r'ssd', r'hd\s+externo', r'disco\s+r[íi]gido',
    r'cooler\s+para\s+processador', r'water\s+cooler', r'processador', r'microfone'
]


def extrair_modelo_principal(nome):
    nome = str(nome).strip()
    regex = r'^(?:' + '|'.join(CATEGORIAS) + r')\s*(?:[-|]\s*)?'
    nome_limpo = re.sub(regex, '', nome, flags=re.IGNORECASE)
    nome_limpo = re.sub(r'\s+', ' ', nome_limpo).strip().title()
    if not nome_limpo or nome_limpo == '-':
        return nome.title()
    return nome_limpo


def preparar_base(bruto):
    """Uma oferta por produto, loja e dia (a de menor preco), sem o preco de preenchimento 9999,99."""
    base = bruto.copy()
    base['dia'] = pd.to_datetime(base['dia'])
    base = base[(base['preco'] > 0) & (base['preco'] != 9999.99)]
    base = base.sort_values('preco').drop_duplicates(['nome_produto', 'loja', 'dia'])
    return base.reset_index(drop=True)


def carregar(url):
    with psycopg2.connect(url) as conexao:
        bruto = pd.read_sql('SELECT nome_produto, loja, preco, dia, url FROM ofertas_dia', conexao)
    return preparar_base(bruto)


def janela(base, dia):
    """Coletas dos JANELA_DIAS dias anteriores ao dia avaliado (o proprio dia nao entra)."""
    inicio = dia - pd.Timedelta(days=JANELA_DIAS)
    return base[(base['dia'] < dia) & (base['dia'] >= inicio)]


def classificar(variacao):
    """Faixas da regra de variacao (mesmos limites da aplicacao)."""
    faixas = np.select([variacao <= -10, variacao <= -5, variacao < 5, variacao < 10],
                       ['Boa compra', 'Queda moderada', 'Preço normal', 'Alta moderada'],
                       default='Evitar')
    return pd.Series(faixas, index=variacao.index).where(variacao.notna(), 'Sem histórico')


def classificar_dia(base, dia, por_loja=True):
    """Referencia = media dos 7 dias anteriores, por produto e loja (ou so por produto)."""
    hoje = base[base['dia'] == dia].copy()
    chave = ['nome_produto', 'loja'] if por_loja else ['nome_produto']
    ref = janela(base, dia).groupby(chave)['preco'].mean().rename('media').reset_index()
    hoje = hoje.merge(ref, on=chave, how='left')
    hoje['variacao'] = (hoje['preco'] - hoje['media']) / hoje['media'] * 100
    hoje['situacao'] = classificar(hoje['variacao'])
    return hoje


def mapa_tfidf(base, dia, limiar):
    """Nome de hoje -> nome de coleta anterior mais parecido (TF-IDF), se a similaridade chegar ao limiar."""
    prev = janela(base, dia)
    nomes_prev = np.array(sorted(prev['nome_produto'].unique()))
    nomes_hoje = np.array(sorted(base.loc[base['dia'] == dia, 'nome_produto'].unique()))
    if len(nomes_prev) == 0 or len(nomes_hoje) == 0:
        return {}, {}
    vetor = TfidfVectorizer(analyzer='word', ngram_range=(1, 2), lowercase=True)
    matriz = vetor.fit_transform([extrair_modelo_principal(n) for n in nomes_prev])
    sim = cosine_similarity(vetor.transform([extrair_modelo_principal(n) for n in nomes_hoje]), matriz)
    melhor = sim.argmax(axis=1)
    valor = sim.max(axis=1)
    mapa, similaridade = {}, {}
    for nome, i, s in zip(nomes_hoje, melhor, valor):
        if s >= limiar:
            mapa[nome] = nomes_prev[i]
            similaridade[nome] = s
    return mapa, similaridade


def referencia_por_nome(base, dia, mapa, how='inner'):
    """Oferta de hoje com a media da coleta anterior do nome atribuido, na mesma loja."""
    hoje = base[base['dia'] == dia].copy()
    hoje['nome_ref'] = hoje['nome_produto'].map(mapa).fillna(hoje['nome_produto'])
    ref = janela(base, dia).groupby(['nome_produto', 'loja'])['preco'].agg(
        media='mean', desvio='std', mediana='median').reset_index()
    ref = ref.rename(columns={'nome_produto': 'nome_ref'})
    return hoje.merge(ref, on=['nome_ref', 'loja'], how=how).reset_index(drop=True)


def atributos(d):
    """Atributos do Isolation Forest e do K-Means: variacao, volatilidade, variacao sobre a mediana e loja."""
    variacao = ((d['preco'] - d['media']) / d['media'] * 100).values
    volatilidade = (d['desvio'] / d['media'] * 100).fillna(0).values
    variacao_mediana = ((d['preco'] - d['mediana']) / d['mediana'] * 100).fillna(0).values
    lojas = pd.get_dummies(d['loja']).astype(float).values
    return np.column_stack([variacao, volatilidade, variacao_mediana, lojas]), variacao


def escolher_k(hoje):
    """Numero de grupos do K-Means pela silhueta (2 a 8), calculado uma vez no primeiro dia de teste."""
    x, _ = atributos(hoje)
    xs = StandardScaler().fit_transform(x)
    melhor_k, melhor_s = 2, -1.0
    for k in range(2, 9):
        rotulos = KMeans(n_clusters=k, random_state=SEMENTE, n_init=10).fit_predict(xs)
        s = silhouette_score(xs, rotulos, sample_size=min(5000, len(xs)), random_state=SEMENTE)
        if s > melhor_s:
            melhor_k, melhor_s = k, s
    return melhor_k


def testar_dia(hoje, rng, k_kmeans):
    """Injeta variacoes conhecidas e mede a deteccao de cada metodo, com o mesmo numero de marcadas."""
    d = hoje.copy()
    n = min(N_INJETADAS, len(d) // len(CONDICOES))
    if n < 50:
        return None
    d['condicao'] = np.nan
    escolhidas = rng.choice(len(d), size=n * len(CONDICOES), replace=False)
    for i, c in enumerate(CONDICOES):
        idx = escolhidas[i * n:(i + 1) * n]
        d.loc[idx, 'condicao'] = c
        d.loc[idx, 'preco'] = d.loc[idx, 'preco'] * (1 + c / 100)

    x, variacao = atributos(d)
    z = ((d['preco'] - d['media']) / d['desvio']).replace([np.inf, -np.inf], np.nan).fillna(0).abs().values

    injetada = d['condicao'].notna().values
    regra = np.abs(variacao) >= 10
    k = int(regra.sum())
    s_if = -IsolationForest(random_state=SEMENTE).fit(x).score_samples(x)
    s_z = z
    xs = StandardScaler().fit_transform(x)
    s_km = KMeans(n_clusters=k_kmeans, random_state=SEMENTE, n_init=10).fit(xs).transform(xs).min(axis=1)

    def marcar_top(score):
        flag = np.zeros(len(score), dtype=bool)
        if k > 0:
            flag[np.argsort(-score)[:k]] = True
        return flag

    metodos = {
        'Regra de variacao (módulo de V >= 10%)': (np.abs(variacao), regra),
        'Isolation Forest ampliado': (s_if, marcar_top(s_if)),
        'Escore z por produto e loja': (s_z, marcar_top(s_z)),
        f'K-Means ({k_kmeans} grupos, distancia ao centro)': (s_km, marcar_top(s_km)),
    }
    resultado = {}
    for nome, (score, flag) in metodos.items():
        r = {'auc': roc_auc_score(injetada, score)}
        for c in CONDICOES:
            r[f'recall_{c}'] = flag[d['condicao'].values == c].mean() * 100
        r['falsos_alarmes'] = flag[~injetada].mean() * 100
        resultado[nome] = r
    return resultado


def medias_dos_dias(linhas):
    """Media simples dos dias para cada metodo."""
    tabela = {}
    for dia_resultado in linhas:
        for metodo, valores in dia_resultado.items():
            tabela.setdefault(metodo, []).append(valores)
    return {m: pd.DataFrame(v).mean() for m, v in tabela.items()}


def retroativo(base, por_loja):
    """Ofertas marcadas em um dia: o preco no dia seguinte voltou a faixa habitual ou nao."""
    dias = sorted(base['dia'].unique())
    chave = ['nome_produto', 'loja'] if por_loja else ['nome_produto']
    contagem = {'Boa compra': [0, 0, 0], 'Evitar': [0, 0, 0]}  # total, voltou, continuou
    for i, dia in enumerate(dias[:-1]):
        hoje = classificar_dia(base, dia, por_loja)
        estat = janela(base, dia).groupby(chave)['preco'].agg(
            minimo='min', maximo='max', mediana='median').reset_index()
        estat = estat[estat['maximo'] > estat['minimo']]  # preco constante nao e avaliado
        seguinte = base[base['dia'] == dias[i + 1]][['nome_produto', 'loja', 'preco']].rename(
            columns={'preco': 'preco_seg'})
        m = hoje.merge(estat, on=chave).merge(seguinte, on=['nome_produto', 'loja'])
        for rotulo in contagem:
            sub = m[m['situacao'] == rotulo]
            if rotulo == 'Boa compra':
                voltou = sub['preco_seg'] >= sub['mediana'] * 0.95
            else:
                voltou = sub['preco_seg'] <= sub['mediana'] * 1.05
            contagem[rotulo][0] += len(sub)
            contagem[rotulo][1] += int(voltou.sum())
            contagem[rotulo][2] += int((~voltou).sum())
    return contagem


def criterio_boa_compra(base):
    """Acerto: o preco marcado e o menor do produto nos dias seguintes, e o menor de todo o periodo."""
    dias = sorted(base['dia'].unique())
    minimo_todo = base.groupby('nome_produto')['preco'].min()
    partes = []
    for i, dia in enumerate(dias[:-1]):
        hoje = classificar_dia(base, dia, por_loja=True)
        minimo_seguinte = base[base['dia'] > dia].groupby('nome_produto')['preco'].min()
        hoje = hoje.assign(min_seguintes=hoje['nome_produto'].map(minimo_seguinte),
                           min_todo=hoje['nome_produto'].map(minimo_todo))
        partes.append(hoje[['dia', 'nome_produto', 'loja', 'preco', 'situacao', 'url',
                            'min_seguintes', 'min_todo']])
    d = pd.concat(partes).dropna(subset=['min_seguintes']).copy()
    d['acerto_dias_seguintes'] = d['preco'] <= d['min_seguintes']
    d['acerto_periodo'] = d['preco'] <= d['min_todo']
    return d


def executar(base):
    """Roda as quatro analises sobre a base (DataFrame com nome_produto, loja, preco, dia, url)."""
    dias = sorted(base['dia'].unique())
    dias_teste = dias[-DIAS_TESTE:]
    rng = np.random.default_rng(SEMENTE)
    relatorio = ['# Revisao do orientador', '', f'Base: {len(dias)} dias, {len(base)} ofertas '
                 f'(de {pd.Timestamp(dias[0]).date()} a {pd.Timestamp(dias[-1]).date()}). '
                 f'Dias de teste: {len(dias_teste)}. Semente: {SEMENTE}.', '']

    # 1) comparacao justa com o Isolation Forest (correspondencia exata, referencia por produto e loja)
    por_dia = []
    k_kmeans = escolher_k(referencia_por_nome(base, dias_teste[0], {}, how='inner'))
    for dia in dias_teste:
        hoje = referencia_por_nome(base, dia, {}, how='inner')
        r = testar_dia(hoje, rng, k_kmeans)
        if r:
            por_dia.append(r)
    medias = medias_dos_dias(por_dia)
    linhas = ['| Metodo | AUC | Recall -5% | Recall -10% | Recall -20% | Recall +30% | Falsos alarmes |',
              '|---|---|---|---|---|---|---|']
    for metodo, m in medias.items():
        linhas.append(f'| {metodo} | {m["auc"]:.3f} | {m["recall_-5"]:.1f}% | {m["recall_-10"]:.1f}% | '
                      f'{m["recall_-20"]:.1f}% | {m["recall_30"]:.1f}% | {m["falsos_alarmes"]:.2f}% |')
    relatorio += ['## 1. Isolation Forest ampliado e escore z, com o mesmo numero de marcadas', '',
                  'Recall: % das ofertas alteradas marcadas. Falsos alarmes: % das nao alteradas marcadas. '
                  'Os metodos de ranking marcam o mesmo numero de ofertas que a regra em cada dia. '
                  f'Numero de grupos do K-Means escolhido pela silhueta: {k_kmeans}, fixo nos dias de teste.', ''] + linhas + ['']

    # 2) TF-IDF: limiares, injecao com cada correspondencia e amostra de pares
    linhas = ['| Correspondencia | Nomes agrupados (media por dia) | AUC regra | Recall -10% | Recall -20% | Recall +30% | Falsos alarmes |',
              '|---|---|---|---|---|---|---|']
    mapas = {}
    for limiar in [None] + LIMIARES_TFIDF:
        rotulo = 'Exata (sem agrupamento)' if limiar is None else f'TF-IDF, limiar {limiar:.2f}'
        agrupados, resultados = [], []
        for dia in dias_teste:
            mapa, _ = ({}, {}) if limiar is None else mapa_tfidf(base, dia, limiar)
            agrupados.append(sum(1 for k, v in mapa.items() if k != v))
            hoje = referencia_por_nome(base, dia, mapa, how='inner')
            r = testar_dia(hoje, rng, k_kmeans)
            if r:
                resultados.append(r)
        m = medias_dos_dias(resultados)['Regra de variacao (módulo de V >= 10%)']
        linhas.append(f'| {rotulo} | {np.mean(agrupados):.0f} | {m["auc"]:.3f} | {m["recall_-10"]:.1f}% | '
                      f'{m["recall_-20"]:.1f}% | {m["recall_30"]:.1f}% | {m["falsos_alarmes"]:.2f}% |')
        if limiar == LIMITE_PADRAO_TFIDF:
            mapas['padrao'] = mapa_tfidf(base, dias[-1], limiar)
    relatorio += ['## 2. Correspondencia TF-IDF (regra de variacao, referencia por produto e loja)', ''] + linhas + ['']

    if 'padrao' in mapas:
        mapa, similaridade = mapas['padrao']
        pares = pd.DataFrame([{'nome_hoje': k, 'nome_atribuido': v, 'similaridade': round(similaridade[k], 3),
                               'url': base.loc[base['nome_produto'] == k, 'url'].iloc[0]}
                              for k, v in mapa.items() if k != v])
        if len(pares) > 0:
            amostra = pares.sample(n=min(N_AMOSTRA, len(pares)), random_state=SEMENTE)
            amostra['mesmo_produto_S_N'] = ''
            amostra.to_csv(os.path.join(PASTA_SAIDA, 'amostra_pares_tfidf.csv'), index=False, sep=';', encoding='utf-8-sig')
            relatorio += [f'Amostra de pares agrupados (limiar 0,45): {len(amostra)} de {len(pares)} '
                          f'em amostra_pares_tfidf.csv. Preencher a coluna mesmo_produto_S_N.', '']

    # 3) referencia por loja: distribuicao no ultimo dia e retroativo nas duas versoes
    ultimo = dias[-1]
    loja = classificar_dia(base, ultimo, por_loja=True)['situacao'].value_counts()
    produto = classificar_dia(base, ultimo, por_loja=False)['situacao'].value_counts()
    tabela2 = pd.DataFrame({'Por produto e loja': loja, 'Por produto (anterior)': produto}).fillna(0).astype(int)
    relatorio += [f'## 3. Distribuicao das faixas em {pd.Timestamp(ultimo).date()}', '',
                  tabela2.to_string(), '']
    linhas = ['| Referencia | Classificacao | Ofertas | Voltou a faixa habitual | Continuou fora |',
              '|---|---|---|---|---|']
    for por_loja, nome in [(True, 'Por produto e loja'), (False, 'Por produto (anterior)')]:
        for rotulo, (total, voltou, continuou) in retroativo(base, por_loja).items():
            pct_v = 100.0 * voltou / total if total else 0
            pct_c = 100.0 * continuou / total if total else 0
            linhas.append(f'| {nome} | {rotulo} | {total} | {voltou} ({pct_v:.1f}%) | {continuou} ({pct_c:.1f}%) |')
    relatorio += ['## 3b. Teste retroativo nas duas referencias', ''] + linhas + ['']

    # 5) criterio de acerto para Boa compra e amostras para conferencia manual
    d = criterio_boa_compra(base)
    resumo = d.groupby('situacao')[['acerto_dias_seguintes', 'acerto_periodo']].mean() * 100
    resumo['ofertas'] = d.groupby('situacao').size()
    relatorio += ['## 5. Criterio de acerto (% das ofertas em que o preco marcado foi o menor)', '',
                  resumo.round(1).to_string(), '']
    for faixa, nome in [('Boa compra', 'amostra_boa_compra.csv'), ('Preço normal', 'amostra_preco_normal.csv')]:
        sub = d[d['situacao'] == faixa]
        if len(sub) > 0:
            amostra = sub.sample(n=min(N_AMOSTRA, len(sub)), random_state=SEMENTE).copy()
            amostra['conferido_manual'] = ''
            amostra.to_csv(os.path.join(PASTA_SAIDA, nome), index=False, sep=';', encoding='utf-8-sig')
    relatorio += ['Amostras para conferencia manual: amostra_boa_compra.csv e amostra_preco_normal.csv '
                  '(coluna conferido_manual).', '']
    return '\n'.join(relatorio)


def main():
    url = os.environ.get('DATABASE_URL')
    if not url:
        sys.exit('[ERRO] DATABASE_URL nao definida.')
    base = carregar(url)
    os.makedirs(PASTA_SAIDA, exist_ok=True)
    texto = executar(base)
    with open(os.path.join(PASTA_SAIDA, 'revisao.md'), 'w', encoding='utf-8') as f:
        f.write(texto)
    print(texto)


if __name__ == '__main__':
    main()
