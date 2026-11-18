# PLAY TECH VIP — entrega

Plataforma de streaming com **canais ao vivo** e **catálogo sob demanda**, com app para navegador,
celular e Smart TV, e painel próprio para a operação.

O `README.md` tem o detalhe técnico. Este documento é o resumo prático: o que está pronto, como
colocar no ar, o que a operação faz no dia a dia e o que ainda depende de terceiros.

---

## 1. Como abrir agora

```bash
cd tv
npm install
npm run seed      # dados de demonstração (precisa de ffmpeg e internet)
npm start
```

| Onde | Endereço |
|---|---|
| App do assinante | http://localhost:3600/ |
| Painel da operação | http://localhost:3600/admin/ |

**Acessos de demonstração**

| Perfil | Entrar com | Senha |
|---|---|---|
| Operação (tudo) | admin@playtechvip.com.br | admin123 |
| Curadoria (só conteúdo) | curadoria@playtechvip.com.br | play2026 |
| Assinante plano Cinema 4K | rogerio@exemplo.com.br | cliente2026 |
| Assinante plano Família | marina@exemplo.com.br | cliente2026 |
| Assinante suspenso (teste de bloqueio) | andrade@exemplo.com.br | cliente2026 |

> Troque todas essas senhas antes de abrir para o público. Em produção, `TV_SECRET` e
> `TV_ADMIN_SENHA` são obrigatórios e o servidor recusa subir sem eles.

---

## 2. Colocar no ar

```bash
cp .env.exemplo .env     # preencha TV_SECRET, TV_ADMIN_SENHA e DOMINIO
docker compose up -d
```

Sobe a plataforma e um proxy que **emite e renova o certificado HTTPS sozinho**. Antes, aponte o
domínio para o servidor e deixe as portas 80 e 443 abertas.

Conferência de ponta a ponta depois de subir (API, HTTPS, páginas, acesso e conteúdo no ar):

```bash
BASE=https://play.seudominio.com.br ADMIN=admin@provedor.com.br SENHA='...' npm run conferir
```

Backup diário (banco + vídeos), guardando as 7 cópias mais recentes:

```
20 3 * * * cd /caminho/do/tv && npm run backup /var/backups/playtechvip >> /var/log/playtechvip-backup.log 2>&1
```

---

## 3. O dia a dia da operação

**Publicar um filme ou série**
1. Catálogo → Novo título → digite o nome e clique em **Buscar ficha e artes na base de filmes**:
   sinopse, ano, duração, classificação, gêneros, elenco, direção e as artes oficiais vêm prontas
   (precisa do token gratuito do TMDB em `TV_TMDB_TOKEN`). Sem o token, preencha à mão.
2. Aba *Arquivos e artes*: envie a capa (2:3), o banner (16:9) e o vídeo.
3. Em *Conversão automática*, clique em **Gerar as versões menores** — o servidor cria Full HD, HD
   e SD a partir do arquivo enviado. Um 4K vira quatro qualidades.
4. **Publicar**. O título entra nas fileiras da home e na busca.

**Ligar um canal ao vivo**
1. Canais → escolha o canal (os 15 abertos já estão cadastrados e desligados).
2. Cole o endereço do sinal (`.m3u8`) que a emissora fornece **ou** o endereço do player oficial dela.
3. **Testar sinal** → se responder, ligue o canal. A plataforma confere os sinais a cada 15 minutos
   e marca no painel quem saiu do ar.

**Grade de programação**: Grade (EPG) aceita cadastro manual ou um arquivo XMLTV, que a plataforma
reimporta sozinha uma vez por dia.

**Encher o catálogo sem contrato**: `npm run catalogo-publico` traz filmes de domínio público e
Creative Commons (coloridos, em Full HD), com capa, banner e as quatro qualidades geradas na
importação. O que é legal e o que não é está em `ACERVO.md`.

**Cobrança**: fatura mensal com PIX copia e cola e QR Code. A baixa do pagamento é feita pela
operação, em Faturas (a integração automática com o banco ficou fora do escopo).

---

## 4. O que está pronto

| Área | Entregue |
|---|---|
| App do assinante | Home com destaque e fileiras, Top 10, busca, Minha lista, perfis com classificação etária, continuar assistindo |
| Player | 4K, Full HD, HD e SD com troca sem perder a cena, legendas, velocidade, próximo episódio, limite de telas por plano |
| Canais ao vivo | Transmissão pelos nossos servidores (a origem da emissora não aparece para o assinante), grade por canal, verificação automática de sinal |
| Conversão | A operação envia **um** arquivo e o servidor gera as qualidades menores, em fila, com progresso no painel |
| Assinaturas | Três planos (Essencial HD, Família Full HD, Cinema 4K), faturas, carência, suspensão automática, troca de plano e cancelamento |
| Painel | 13 telas: conteúdo, canais, grade, catálogo, destaques, assinantes, faturas, planos, relatórios, equipe, configurações e auditoria |
| Smart TV | Apps para Samsung (Tizen/AVPlay), LG (webOS) e TCL/Android TV (ExoPlayer), com navegação por controle remoto |
| Celular e tablet | App instalável pelo navegador (ícone na tela inicial, tela cheia, sem loja) e apps nativos de Android e iPhone, com player do aparelho e janela flutuante |
| APKs de teste | `dist/PLAYTECHVIP-celular-android-teste.apk` e `dist/PLAYTECHVIP-androidtv-teste.apk`, compilados e prontos para instalar; pedem o endereço do servidor na primeira abertura |
| Produção | Docker Compose com HTTPS automático, backup e monitoramento por `/api/saude` |
| Testes | 56 testes automáticos, incluindo uma conversão de vídeo de verdade e as guardas de produção |

---

## 5. O que depende do cliente

| Pendência | O que é preciso |
|---|---|
| Token da base de filmes | Uma conta gratuita em themoviedb.org e o token em `TV_TMDB_TOKEN`, para o catálogo trazer cartaz, banner e ficha dos títulos atuais. |
| Conteúdo licenciado | Os arquivos dos filmes e séries contratados. Entram pelo painel. Hoje o catálogo mostra fichas e capas oficiais dos títulos atuais (vindas do TMDB), mas **o vídeo ligado a eles é de demonstração** — a vitrine está pronta, falta o conteúdo. |
| Sinal das emissoras | O endereço `.m3u8` ou o player oficial de cada canal aberto. É um campo por canal. |
| Hospedagem e domínio | Um servidor (VPS ou nuvem) e o domínio apontando para ele. |
| Publicação nas lojas | Contas de desenvolvedor Samsung Seller, LG Seller e Google Play, com as artes de loja e uma conta de teste para a avaliação. |

---

## 6. O que não está incluído

- **DRM (Widevine, FairPlay, PlayReady)** — alguns estúdios exigem para conteúdo licenciado. Hoje a
  proteção é link assinado de curta duração, que resolve o acesso indevido casual, mas não é DRM.
- **Baixa automática do PIX** — fora do escopo por decisão do cliente. O código PIX é gerado; a
  confirmação do pagamento é feita pela operação.
- **Primeira rodada numa TV de verdade** — os três apps estão prontos e o modo controle remoto foi
  testado em navegador simulando uma TV, mas a troca para o AVPlay da Samsung e o ExoPlayer do
  Android TV precisam de um aparelho para a primeira validação.
- **Transcodificação em HLS com faixas (ABR)** — cada qualidade é um arquivo próprio e o player
  troca entre eles; não há uma faixa única que mude de bitrate no meio do pedaço.

---

## 7. Estrutura do código

```
tv/
  server/          API, banco, regras de negócio e rotinas em segundo plano
  public/          App do assinante e painel (sem build: JavaScript de módulo direto)
  tv-apps/         Samsung (Tizen), LG (webOS) e TCL/Android TV
  scripts/         Empacotamento dos apps e backup
  test/            56 testes automáticos (node:test)
  docker-compose.yml, Caddyfile, Dockerfile
```

Sem passo de build e sem framework: Node.js com Express e SQLite no servidor, JavaScript de módulo
no navegador. Os nomes e comentários estão em português, para a equipe do cliente manter.
