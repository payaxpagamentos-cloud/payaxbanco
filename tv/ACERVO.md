# Acervo público: filmes gratuitos que podem ir ao ar

Resposta curta: **existem listas públicas de filmes grátis, e a PLAY TECH VIP importa delas
sozinha** — mas só as que são legais. Este documento separa uma coisa da outra e mostra o
comando.

```bash
node scripts/catalogo-publico.js --listar     # o que já está conferido e pronto
node scripts/catalogo-publico.js              # traz para o catálogo
```

---

## As duas famílias de "lista grátis"

| | O que é | Dá para usar? |
|---|---|---|
| **Acervo livre** | Obras em domínio público ou Creative Commons: Internet Archive, Blender Studio, NASA, arquivos públicos | **Sim.** Transmissão livre, sem contrato com estúdio |
| **Lista de IPTV "VOD"** | Os arquivos `.m3u` que circulam com lançamentos de estúdio, Netflix, Disney e afins | **Não.** É conteúdo pirata |

Sobre a segunda: aquelas listas com "10.000 filmes e séries" são retransmissão não autorizada.
Para um provedor de internet o risco é direto — notificação dos detentores, responsabilidade
civil e criminal, e o app sendo retirado da Google Play e da App Store, que exigem comprovação
de direitos na avaliação. Não entra neste sistema, e eu não acrescento suporte a elas.

A boa notícia é que a primeira família é maior do que parece.

## De onde vem o que é livre

| Fonte | O que tem | Como entra |
|---|---|---|
| **Internet Archive** — coleção `feature_films` | Longas de domínio público (clássicos, muitos em preto e branco) | `--colecao feature_films` |
| **Internet Archive** — `classic_cartoons`, `film_noir`, `sci-fi_horror`, `silent_films` | Desenhos, noir, ficção científica e cinema mudo | `--colecao <nome>` |
| **Blender Studio** (via Internet Archive) | Animação e VFX de 2008 a 2023, **coloridos, em Full HD e 4K**, Creative Commons | já na lista curada |
| **Sita Sings the Blues** | Longa de animação de 2008, em domínio público (CC0), Full HD | já na lista curada |
| **NASA e arquivos públicos** | Documentários e imagens de arquivo, domínio público | `--buscar "nasa" --colecao nasa` |
| **Arquivo Prelinger** | Institucionais e educativos (ótimos para canal temático) | `--colecao prelinger` |
| **TMDB** | **Só ficha e arte** — sinopse, capa, elenco. Não hospeda vídeo | `npm run catalogo-demo` |

Um aviso que vale repetir: **estar no Internet Archive não quer dizer que a obra é livre.** O
acervo tem material enviado por terceiros sem direito. Por isso o script só importa sozinho o
que está numa coleção de domínio público conhecida ou com licença Creative Commons declarada; o
resto ele lista como "conferir" e só entra com `--forcar`, por sua conta.

## A lista curada que vem pronta

A busca aberta do acervo devolve, em primeiro lugar, filme dos anos 30 e 40 em preto e branco —
não é o que se mostra para cliente hoje. Por isso o script traz uma **lista conferida de obras
atuais e coloridas, em Full HD ou mais**:

| Título | Ano | Licença | O que é |
|---|---|---|---|
| Sintel | 2010 | CC BY 3.0 | Fantasia, 15 min, 2048×872 |
| Lágrimas de Aço | 2012 | CC BY 3.0 | Ficção científica com atores reais, 12 min, 1920×800 |
| Sita Canta o Blues | 2008 | Domínio público (CC0) | **Longa** de animação musical, 81 min, 1920×1080 |
| Big Buck Bunny | 2008 | CC BY 3.0 | Animação infantil, 10 min, 1280×720 |

Somadas às oito do Blender que o `npm run seed` já traz (Charge, Wing It!, Sprite Fright,
Spring, Hero, Agente 327, Cosmos Laundromat e Meio Copo) e à série Caminandes, dá um catálogo
de demonstração **inteiramente legal**, colorido e em alta resolução.

## Como o script trabalha

Para cada título ele faz o mesmo caminho do painel, sem atalho:

1. Lê a ficha no acervo e confere a licença.
2. Escolhe o **melhor arquivo de verdade** — o acervo gera cópias menores e chama de "720p" o
   que às vezes é 360p, então a escolha é pela resolução real, não pelo nome.
3. Guarda um **trecho de 3 minutos** (ou o filme inteiro, com `--completo`).
4. Tira capa e banner de quadros do próprio filme.
5. Gera **Full HD, HD e SD** a partir do arquivo e cadastra a escada de qualidade.
6. Publica, com o crédito da licença no fim da sinopse — o CC BY exige atribuição.

```bash
node scripts/catalogo-publico.js --listar                        # o que há
node scripts/catalogo-publico.js --quantos 2                     # traz dois
node scripts/catalogo-publico.js --item Sintel --completo        # um título, filme inteiro
node scripts/catalogo-publico.js --buscar "amazonia"             # procura no acervo
node scripts/catalogo-publico.js --buscar "nasa" --colecao nasa --importar --quantos 3
```

O `--completo` baixa o filme todo: Sita Canta o Blues em Full HD são 4,4 GB. Para demonstração,
o trecho basta e entra em minutos.

## Para a operação de verdade

Acervo livre resolve o começo: dá um catálogo apresentável, legal e sem custo, enquanto a
negociação do conteúdo licenciado anda. Mas ele não substitui catálogo comercial — quem assina
quer lançamento, e lançamento tem contrato, janela de exibição e, em muitos casos, exigência de
DRM (que **não** está incluído nesta entrega).

O caminho que costuma funcionar num provedor:

1. **Acervo livre + canais ao vivo** no lançamento — o assinante já tem o que ver.
2. **Conteúdo regional próprio** (produção local, eventos da cidade, igreja, futebol amador).
   É onde o provedor tem vantagem e não paga licença.
3. **Catálogo licenciado** por distribuidor, entrando por cima, quando o contrato fechar.
