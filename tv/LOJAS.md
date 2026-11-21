# Publicar a PLAY TECH VIP nas lojas

Tudo o que a Apple e o Google pedem, pronto: pacotes assinados, artes no tamanho certo, textos
para copiar e colar e as respostas dos formulários. O que falta é o que só o cliente pode fazer —
criar as contas de desenvolvedor e apertar o botão de enviar.

| Loja | App | Pacote | Conta necessária |
|---|---|---|---|
| Google Play | Celular e tablet Android | `.aab` | Google Play Console — US$ 25, uma vez |
| Google Play | Android TV (TCL, Google TV, Sony, Philips) | `.aab` | a mesma conta |
| App Store | iPhone e iPad | `.ipa` pelo Xcode | Apple Developer Program — US$ 99/ano |
| Samsung TV Store | Samsung (Tizen) | `.wgt` | Samsung Seller Portal — gratuito |
| LG Content Store | LG (webOS) | `.ipk` | LG Seller Lounge — gratuito |

---

## 1. Antes de qualquer envio

**a) Aponte os apps para o servidor do cliente**

```bash
node scripts/empacotar-apps.js https://play.seudominio.com.br
```

**b) Preencha as páginas de política.** `public/privacidade.html` e `public/termos.html` têm os
dados da empresa entre colchetes — razão social, CNPJ, endereço, e-mails e foro. As duas lojas
exigem a **URL da política de privacidade**, e ela precisa abrir sem login:

```
https://play.seudominio.com.br/privacidade.html
https://play.seudominio.com.br/termos.html
```

**c) Crie a chave de publicação do Android** (uma vez na vida do app):

```bash
keytool -genkeypair -v -keystore playtechvip.jks -keyalg RSA -keysize 4096 \
  -validity 10000 -alias playtechvip
cp celular-apps/android/key.properties.exemplo celular-apps/android/key.properties
# preencha o caminho do .jks e as senhas; repita em tv-apps/android-tv/
```

> **Guarde o `.jks` e as senhas como se fossem a escritura do negócio.** Sem eles, a Google Play
> não aceita nenhuma atualização do app, para sempre. Uma cópia no cofre, outra fora do escritório.

**d) Crie a conta de teste do avaliador.** Os dois revisores precisam entrar e assistir:
um assinante com assinatura ativa, e-mail e senha simples, que não expire.

---

## 2. Google Play — celular e tablet

```bash
cd celular-apps/android
./gradlew bundleRelease      # app/build/outputs/bundle/release/app-release.aab
```

| Item | Valor |
|---|---|
| Nome do pacote | `br.com.playtechvip.celular` |
| Versão | `versionCode 1` · `versionName 1.0.0` (suba os dois a cada envio) |
| API alvo | **36** (Android 16) — exigência da Play para app novo e atualização |
| API mínima | 24 (Android 7) |

**Ficha da loja** (copie e cole):

- **Nome:** `PLAY TECH VIP`
- **Descrição curta** (até 80 caracteres):
  `Canais de TV ao vivo, filmes e séries do seu provedor, no celular e na TV.`
- **Descrição completa:**

```
A PLAY TECH VIP é o streaming do seu provedor de internet: canais de TV ao vivo e um
catálogo de filmes e séries, no mesmo aplicativo.

• Canais ao vivo com a programação de cada emissora, hora a hora
• Guia completo, para saber o que está no ar e o que vem depois
• Filmes e séries para assistir quando quiser, com legendas
• Qualidade até 4K, conforme o seu plano, com troca sem perder a cena
• Perfis para cada pessoa da casa, com classificação por idade
• Continue de onde parou, em qualquer aparelho
• Minha lista para guardar o que você quer ver depois

Para usar é preciso ser assinante do serviço no seu provedor. O aplicativo não vende
assinatura: a contratação é feita direto com o provedor.
```

- **Categoria:** Entretenimento · **Tags:** TV ao vivo, filmes, séries
- **Classificação indicativa:** responda ao questionário da Play de acordo com o catálogo
  contratado; para catálogo com títulos adultos, a resposta leva a **18+**
- **Site:** `https://play.seudominio.com.br` · **Privacidade:** `.../privacidade.html`

**Artes** (prontas em `dist/lojas/`):

| O que | Arquivo | Tamanho |
|---|---|---|
| Ícone | `marca/icone-app-512.png` | 512 × 512 |
| Gráfico de destaque | `lojas/play-destaque-1024x500.png` | 1024 × 500 |
| Capturas de celular (7) | `lojas/play-celular/*.png` | 1080 × 1920 |

**Segurança dos dados** (formulário da Play) — as respostas certas para este app:

| Pergunta | Resposta |
|---|---|
| Coleta dados? | Sim |
| Quais | Nome, e-mail, telefone · atividade no app (o que assistiu) · ID do dispositivo e IP |
| Para quê | Funcionalidade do app, gerenciamento da conta, segurança |
| Compartilha com terceiros? | **Não** |
| Os dados são criptografados em trânsito? | **Sim** (HTTPS) |
| Dá para pedir exclusão dos dados? | **Sim** — dentro do app, em *Minha conta → Excluir minha conta* |
| Anúncios? | **Não** |

---

## 3. Google Play — Android TV

```bash
cd tv-apps/android-tv
./gradlew bundleRelease
```

| Item | Valor |
|---|---|
| Nome do pacote | `br.com.playtechvip.app` |
| API alvo | 35 (a Play exige 34+ para TV) |
| API mínima | 23 — alcança TVs antigas |

A ficha é a mesma do celular, com três adições obrigatórias:

| O que | Arquivo | Tamanho |
|---|---|---|
| Banner de TV | `lojas/play-tv-banner-1280x720.png` | 1280 × 720 |
| Capturas de TV | `lojas/play-tv/*.png` | 1920 × 1080 |
| Banner dentro do app | já embutido (`drawable-xhdpi/banner.png`) | 320 × 180 |

Na Play Console, marque o app como **compatível com Android TV** e preencha o formulário de
qualidade de TV (navegação só pelo controle remoto, sem exigir toque — é como o app funciona).

---

## 4. App Store — iPhone e iPad

```bash
cd celular-apps/ios
brew install xcodegen && xcodegen generate
open PlayTechVip.xcodeproj     # Signing & Capabilities → escolha o Team
# Product → Archive → Distribute App → App Store Connect
```

| Item | Valor |
|---|---|
| Bundle ID | `br.com.playtechvip.celular` |
| Versão | `1.0.0` · build `1` |
| iOS mínimo | 14.0 |
| Aparelhos | iPhone e iPad |

**Ficha da loja:**

- **Nome:** `PLAY TECH VIP` · **Subtítulo:** `TV ao vivo, filmes e séries`
- **Palavras-chave:** `tv ao vivo,streaming,filmes,series,provedor,canais,iptv,guia,tv aberta`
- **Descrição:** a mesma da Play (acima)
- **Categoria:** Entretenimento · **Classificação:** 17+ se o catálogo tiver títulos adultos
- **URL de suporte** e **URL de privacidade**: obrigatórias as duas

**Capturas** (prontas em `dist/lojas/`):

| Conjunto | Arquivo | Tamanho |
|---|---|---|
| iPhone 6,9" | `lojas/apple-iphone/*.png` | 1320 × 2868 |
| iPad 13" | `lojas/apple-ipad/*.png` | 2064 × 2752 |

**Privacidade do app** (App Privacy): as mesmas respostas da Play. Marque
*"Dados não usados para rastrear você"* — o app não tem rastreador.

**Notas para o avaliador** (campo *App Review Information*) — isto evita a primeira reprovação:

```
O aplicativo é o cliente de um serviço de streaming contratado junto ao provedor de
internet do assinante. Não há compra dentro do app: a assinatura é contratada e paga
diretamente com o provedor, fora do aplicativo.

Conta de teste com assinatura ativa:
  usuário: [email de teste]
  senha:   [senha de teste]

A exclusão da conta está em: Minha conta → Excluir minha conta.
Política de privacidade: https://play.seudominio.com.br/privacidade.html
```

> **Os dois pontos que mais reprovam app de streaming na primeira tentativa:**
> 1. **Exclusão de conta** (regra 5.1.1(v)). Já está feita, dentro do app, em *Minha conta*.
> 2. **Compra fora do app.** O aplicativo não pode ter botão de compra nem link para pagar
>    por fora. Com a cobrança no provedor/IXC, o app só autentica — e é assim que ele está.

---

## 5. Samsung e LG

```bash
npm run empacotar-tv https://play.seudominio.com.br
tizen build-web -- tv-apps/samsung-tizen/dist
tizen package -t wgt -s <perfil> -- tv-apps/samsung-tizen/dist/.buildResult
ares-package tv-apps/lg-webos/dist
```

As duas lojas pedem: pacote, ícone, capturas de 1920 × 1080 (use `dist/lojas/play-tv/`),
descrição, classificação e conta de teste. A avaliação costuma levar de 2 a 4 semanas e é
comum pedirem ajuste de navegação pelo controle remoto na primeira rodada.

---

## 6. Direito de imagem nas artes da loja

As capturas e o gráfico de destaque mostram **capas de filmes de estúdio**, que vieram da base
TMDB para o catálogo de demonstração. Dentro do app, isso é catalogação. **Numa peça de
divulgação da loja, é material de terceiro** — e as lojas pedem comprovação de direitos.

Por isso cada arte tem duas versões em `dist/lojas/`:

| Versão | Quando usar |
|---|---|
| `play-destaque-1024x500.png` | Depois que o contrato de distribuição estiver assinado e cobrir a divulgação |
| `play-destaque-1024x500-acervo-livre.png` | **Agora.** Só com títulos de licença livre, sem risco nenhum |

O mesmo vale para o banner de TV. As capturas de tela seguem a mesma lógica: o ideal é gerá-las
de novo quando o catálogo definitivo estiver no ar, com o comando abaixo, para a loja mostrar o
que o assinante realmente vai encontrar.

```bash
# com o servidor no ar e o catálogo definitivo publicado
node scripts/capturas-lojas.js https://play.seudominio.com.br
```

---

## 7. Ordem recomendada

1. **Google Play, celular.** Conta barata, avaliação de 1 a 7 dias.
2. **Google Play, Android TV**, logo em seguida — mesma conta, mesma ficha.
3. **App Store**, em paralelo: a verificação da empresa pela Apple leva dias.
4. **Samsung e LG**, que são as mais demoradas.

O **app instalável pelo navegador (PWA)** não depende de nada disso: assim que o servidor estiver
no ar com HTTPS, o assinante já instala o ícone na tela do celular. É o que sustenta o lançamento
enquanto as lojas avaliam.
