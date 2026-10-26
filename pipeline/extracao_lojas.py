import os
import random
import re
import sys
import time
from datetime import datetime
from urllib.parse import quote_plus
from zoneinfo import ZoneInfo

import pandas as pd
import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

# Todas as ofertas de uma execucao recebem a hora de Brasilia em que ela comecou: o dia segue o
# calendario do Brasil, e nao o UTC do servidor.
DATA_COLETA = datetime.now(ZoneInfo('America/Sao_Paulo')).strftime('%Y-%m-%d %H:%M:%S')

# A saida fica em pipeline/saida/ e e lida pelo passo de importacao do workflow.
diretorio_atual = os.path.dirname(os.path.abspath(__file__))
pasta_saida = os.path.join(diretorio_atual, 'saida')
os.makedirs(pasta_saida, exist_ok=True)
caminho_csv = os.path.join(pasta_saida, 'ofertas_consolidadas.csv')

categorias_alvo = {
    "placa de vídeo": "Placas de vídeo",
    "processador ryzen": "Processadores",
    "processador intel": "Processadores",
    "placa mãe": "Placas Mãe",
    "memória ram": "Memórias Ram",
    "hd interno": "Armazenamento",
    "ssd": "Armazenamento",
    "fonte": "Fontes",
    "teclado": "Teclados",
    "fone-de-ouvido": "Audio",
    "microfone": "Audio",
    "mouse": "Mouses",
    "headset": "Audio"
}


def extrair_kabum(alvos):
    base_url = "https://servicespub.prod.api.aws.grupokabum.com.br/catalog/v2/products"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.kabum.com.br'
    }

    ofertas_totais = []

    with requests.Session() as session:
        session.headers.update(headers)

        for termo, categoria in alvos.items():
            print(f"\n[KaBuM] Extraindo: {categoria} (Busca: '{termo}')")
            pagina = 1

            while True:
                params = {'query': termo, 'page_number': pagina, 'page_size': 50}

                try:
                    session.headers.update({'Referer': f'https://www.kabum.com.br/busca/{termo}?page_number={pagina}'})
                    response = session.get(base_url, params=params, timeout=30)

                    if response.status_code in (403, 404):
                        break

                    response.raise_for_status()
                    itens = response.json().get('data', [])

                    if not itens:
                        break

                    for item in itens:
                        attr = item.get('attributes', {})
                        preco = float(attr.get('price_with_discount', 0))
                        if preco == 0:
                            preco = float(attr.get('price', 0))

                        if attr.get('available') and preco > 0:
                            slug = str(attr.get('product_link', '')).lstrip('/')
                            ofertas_totais.append({
                                'id_produto_externo': str(item['id']),
                                'nome_produto': str(attr.get('title', '')),
                                'categoria_produto': categoria,
                                'preco': preco,
                                'nome_loja': 'KaBuM!',
                                'url_oferta': f"https://www.kabum.com.br/produto/{item['id']}/{slug}",
                                'data_coleta': DATA_COLETA
                            })

                    time.sleep(random.uniform(1.0, 2.5))
                    pagina += 1

                except Exception as e:
                    print(f"  -> Falha na página {pagina}: {e}")
                    break

    print(f"  -> Total de {len(ofertas_totais)} ofertas coletadas na KaBuM.")
    return ofertas_totais


def salvar_diagnostico(termo, html):
    """Guarda o HTML de uma pagina da Amazon que veio sem produtos, para investigar depois."""
    nome = re.sub(r'[^a-z0-9]+', '_', termo.lower()).strip('_')
    with open(os.path.join(pasta_saida, f'amazon_vazia_{nome}.html'), 'w', encoding='utf-8') as f:
        f.write(html)


MAX_RODADAS_AMAZON = 6
ESPERA_ENTRE_RODADAS = 300  # 5 min; a espera cresce a cada rodada (5, 10, 15... min)


def coletar_termo_amazon(driver, termo, categoria):
    """Coleta todas as paginas de um termo. Devolve None se a primeira pagina veio sem produtos."""
    ofertas = []
    pagina = 1
    max_paginas = 70
    while pagina <= max_paginas:
        url_busca = f"https://www.amazon.com.br/s?k={quote_plus(termo)}&page={pagina}"
        print(f"     Acessando página {pagina}...")
        driver.get(url_busca)
        time.sleep(random.uniform(3.0, 5.0))
        html = driver.page_source
        blocos = BeautifulSoup(html, "html.parser").select('div[data-component-type="s-search-result"]')

        if not blocos:
            if pagina == 1:
                salvar_diagnostico(termo, html)
                return None
            print(f"     -> Fim dos resultados na página {pagina}.")
            break

        produtos_nesta_pagina = 0
        for bloco in blocos:
            asin = bloco.get("data-asin")
            cabecalho = bloco.select_one("h2")
            if not asin or cabecalho is None:
                continue

            titulo = cabecalho.get("aria-label") or cabecalho.get_text(" ", strip=True)
            titulo = re.sub(r"^An[uú]ncio patrocinado\s*[–-]\s*", "", titulo)

            elemento_preco = bloco.select_one("span.a-price:not(.a-text-price) span.a-offscreen")
            if elemento_preco is None:
                continue

            preco_limpo = elemento_preco.get_text().replace('R$', '').replace('.', '').replace(',', '.').strip()
            try:
                ofertas.append({
                    'id_produto_externo': asin,
                    'nome_produto': titulo,
                    'categoria_produto': categoria,
                    'preco': float(preco_limpo),
                    'nome_loja': 'Amazon',
                    'url_oferta': f"https://www.amazon.com.br/dp/{asin}",
                    'data_coleta': DATA_COLETA
                })
                produtos_nesta_pagina += 1
            except ValueError:
                continue

        print(f"     -> {produtos_nesta_pagina} produtos extraídos na página {pagina}.")
        pagina += 1
    return ofertas


def extrair_amazon(alvos):
    print("\n[Amazon] Iniciando extração via Selenium com paginação...")
    ofertas_totais = []

    chrome_options = Options()
    chrome_options.add_argument('--headless')
    chrome_options.add_argument('--disable-gpu')
    chrome_options.add_argument('--no-sandbox')
    chrome_options.add_argument('--disable-dev-shm-usage')
    chrome_options.add_argument('user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    chrome_options.add_argument('--log-level=3')
    chrome_options.add_experimental_option('excludeSwitches', ['enable-logging'])

    driver = None
    try:
        driver = webdriver.Chrome(options=chrome_options)
        pendentes = list(alvos.items())

        for rodada in range(1, MAX_RODADAS_AMAZON + 1):
            if not pendentes:
                break
            print(f"  -> Rodada {rodada}: {len(pendentes)} termo(s)")
            falharam = []
            for termo, categoria in pendentes:
                print(f"  -> Buscando: '{termo}'...")
                resultado = coletar_termo_amazon(driver, termo, categoria)
                if resultado is None:
                    print("     -> Página 1 sem produtos: o termo volta na próxima rodada.")
                    falharam.append((termo, categoria))
                else:
                    ofertas_totais.extend(resultado)
            pendentes = falharam

            if pendentes and rodada < MAX_RODADAS_AMAZON:
                espera = ESPERA_ENTRE_RODADAS * rodada
                print(f"  -> {len(pendentes)} termo(s) sem resposta. Aguardando {espera // 60} min...")
                time.sleep(espera)

        if pendentes:
            print("  -> Sem resposta da Amazon para: " + ', '.join(t for t, _ in pendentes))
    except Exception as e:
        print(f"  -> Falha na Amazon: {e}")
    finally:
        if driver is not None:
            driver.quit()

    print(f"  -> Total de {len(ofertas_totais)} ofertas coletadas na Amazon.")
    return ofertas_totais


def main():
    resultados = extrair_kabum(categorias_alvo) + extrair_amazon(categorias_alvo)

    # sem contingencia: se nada foi coletado, o passo falha e a base nao recebe dados falsos
    if not resultados:
        print("\n[ERRO] Nenhuma oferta coletada. Nada foi gravado.")
        sys.exit(1)

    df_ofertas = pd.DataFrame(resultados)
    df_ofertas.to_csv(caminho_csv, index=False, sep=';', encoding='utf-8-sig')
    print(f"\n[SUCESSO] {len(df_ofertas)} ofertas salvas em: {caminho_csv}")


if __name__ == '__main__':
    main()
