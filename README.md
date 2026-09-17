# Meus Investimentos

Sistema com login e senha para acompanhar a carteira de investimentos — e um **Laboratório**
onde cada pessoa monta as próprias telas de análise e publica quando estiver pronta.

Sem bibliotecas externas: só Node.js (SQLite já vem embutido no Node 22.5+).

## Rodar no seu computador

1. Dê dois cliques em **INICIAR.bat** (ou rode `node server.js`).
2. Abra http://localhost:3000 e clique em **Criar conta**.
3. Para encerrar, feche a janela do terminal (ou Ctrl+C).

## O que o sistema faz

### Painel
- Cadastro de ativos (ticker, classe, preço atual) e lançamentos de **compra**, **venda** e **provento**.
- **Preço médio automático** a partir das compras (taxas incluídas). Vendas baixam a posição pelo preço médio e geram lucro/prejuízo realizado.
- Indicadores: patrimônio, total investido, lucro/prejuízo, rentabilidade %, realizado e proventos.
- Alocação por classe e atualização de cotação direto na tabela (digite e pressione Enter).

### Laboratório de telas
Menu **🧪 Laboratório** → *Nova tela* → adicione blocos → veja a **pré-visualização ao vivo** →
**Publicar como tela oficial** (ela passa a aparecer no menu do topo; dá para marcar uma como
*tela inicial*, que abre ao entrar).

Blocos disponíveis:

| Bloco | Para quê |
|---|---|
| Indicador (KPI) | Um número grande, com filtro por classe |
| Gráfico de rosca | Participação por classe ou por ativo |
| Gráfico de barras | Comparar ativos/classes por valor, custo, lucro ou rentabilidade |
| Tabela da carteira | Posições com as colunas, ordem e filtro que você escolher |
| Lista de lançamentos | Histórico filtrado por tipo e classe |
| Metas de alocação | Meta x real, mostrando quanto falta ou sobra em cada classe |
| Texto / anotação | Regras, lembretes, tese da carteira |
| **Código livre** | HTML + CSS + JavaScript seus, com os dados da carteira na mão |

No bloco de código livre você recebe:

```js
dados.carteira.posicoes  // cada ativo: ticker, classe, quantidade, preco_medio, valor_atual, lucro...
dados.carteira.totais    // patrimonio, investido, lucro, rentabilidade, realizado, proventos
dados.transacoes         // histórico de lançamentos
dinheiro(valor)          // formata em R$
```

Cada tela é privada: só quem criou enxerga e edita. O código livre roda dentro de um
`iframe` com `sandbox`, isolado do resto do sistema.

## Publicar na web (Render)

O projeto já vem com `render.yaml`, `package.json` e suporte a disco persistente.

1. Suba o código para um repositório no GitHub (o `git` local já está iniciado com o primeiro commit):
   ```
   git remote add origin https://github.com/SEU-USUARIO/meus-investimentos.git
   git push -u origin main
   ```
2. No Render: **New → Blueprint**, aponte para o repositório. Ele lê o `render.yaml` sozinho.
3. Confirme e aguarde o deploy. A URL fica parecida com `https://meus-investimentos.onrender.com`.
4. Cada amigo entra nessa URL e cria a própria conta.

### Sobre planos e dados
O `render.yaml` está no plano **free**, para testar com os amigos sem custo. Nele:

- **os dados são apagados a cada deploy ou reinício** (contas, carteiras e telas) — o free não tem disco persistente;
- o serviço **dorme após 15 minutos** sem acesso e leva ~30s para acordar no primeiro acesso.

Quando quiser guardar os dados de verdade, troque no `render.yaml` para `plan: starter`
(~US$ 7/mês) e descomente o bloco `disk` + a variável `DB_PATH` que já estão no arquivo:
o banco passa a viver em `/var/data/investimentos.db` e sobrevive aos deploys.

### Conta de administrador
O sistema cria sozinho, no primeiro boot, a conta de administrador:

- **login:** `admin`  **senha:** `admin`

O admin ganha o menu **⚙️ Admin**, que lista todas as contas (com quantos ativos, lançamentos,
telas e se há sessão ativa), permite **definir nova senha** para quem esqueceu e **excluir contas**
com todos os dados. Ele não vê a carteira dos outros pela interface, mas tem poder sobre as contas.

> **Troque essa senha antes de divulgar o site.** No Render: *Environment → Add Environment Variable*
> → `ADMIN_SENHA` = uma senha forte → *Save* (o serviço reinicia e a senha do admin é atualizada).
> Para mudar também o nome do login, use `ADMIN_LOGIN`.

### Segurança em produção
- Senhas com `scrypt` + salt aleatório; nunca em texto puro.
- Cookie de sessão `HttpOnly`, `SameSite=Lax` e `Secure` quando `NODE_ENV=production`.
- Máximo de 8 tentativas de login erradas por e-mail/IP a cada 15 minutos.
- Cada usuário só acessa os próprios ativos, lançamentos e telas (verificado em toda rota).
- Não há recuperação de senha por e-mail: se alguém esquecer, é preciso criar outra conta.

## Estrutura

| Arquivo | Função |
|---|---|
| `server.js` | Servidor HTTP, autenticação e API |
| `db.js` | Banco SQLite e tabelas |
| `public/index.html` | Telas de login, painel, telas publicadas e laboratório |
| `public/app.js` | Painel, navegação e chamadas à API |
| `public/blocos.js` | Motor que transforma blocos em gráficos e tabelas |
| `public/lab.js` | Editor do laboratório |
| `public/estilo.css` | Visual |
| `render.yaml` | Configuração de deploy no Render |

Ferramenta de organização e acompanhamento pessoal — não é recomendação de investimento.
