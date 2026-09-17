# Meus Investimentos

Sistema local (roda no seu computador) para acompanhar a sua carteira de investimentos,
com login e senha. Nada sai da sua máquina: os dados ficam no arquivo `investimentos.db`
dentro desta pasta.

## Como usar

1. Dê dois cliques em **INICIAR.bat** (ou rode `node server.js` no terminal).
2. O navegador abre em http://localhost:3000
3. Na primeira vez, clique em **Criar conta** (nome, e-mail e senha de 8+ caracteres).
4. Para encerrar, feche a janela preta do terminal (ou Ctrl+C).

Requisito: Node.js 22 ou superior (você já tem o 24 instalado). Não precisa instalar bibliotecas.

## O que dá para fazer

- **Adicionar ativo**: ticker, classe (Ações, FIIs, Renda Fixa, ETF, BDR, Cripto, Exterior, Outros) e preço atual.
- **Lançamentos**: compra, venda e provento (dividendo/JCP), com quantidade, preço, taxas e data.
- **Preço médio automático**: calculado a partir das compras (incluindo taxas); vendas reduzem a posição pelo preço médio e geram lucro/prejuízo realizado.
- **Painel**: patrimônio atual, total investido, lucro/prejuízo não realizado, rentabilidade %, resultado realizado e proventos recebidos.
- **Alocação por classe**: gráfico de rosca com o percentual de cada classe.
- **Atualizar cotação**: edite o campo "Preço atual" direto na tabela e pressione Enter.

## Estrutura

| Arquivo | Função |
|---|---|
| `server.js` | Servidor HTTP, autenticação e API |
| `db.js` | Banco SQLite e criação das tabelas |
| `public/index.html` | Telas de login e do painel |
| `public/app.js` | Lógica da interface |
| `public/estilo.css` | Visual |
| `investimentos.db` | Seus dados (faça backup deste arquivo) |

## Segurança

- Senhas guardadas com `scrypt` + salt aleatório (nunca em texto puro).
- Sessão por cookie `HttpOnly`, válida por 7 dias.
- O servidor escuta só em `127.0.0.1`, ou seja, não fica exposto na rede.
- Se esquecer a senha, não há recuperação por e-mail: basta criar outra conta ou apagar o `investimentos.db` para começar do zero.

Esta ferramenta é para organização e acompanhamento pessoal — não é recomendação de investimento.
