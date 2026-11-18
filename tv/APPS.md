# PLAY TECH VIP — os aplicativos

Um servidor, seis formas de assistir. Todas falam com a mesma API e usam o mesmo catálogo,
os mesmos planos e o mesmo limite de telas.

| Onde | O que é | Pasta | Player |
|---|---|---|---|
| **Celular e tablet (qualquer um)** | App instalável pelo navegador (PWA) | `public/` | player da plataforma |
| **Android (celular e tablet)** | App nativo para a Google Play | `celular-apps/android/` | **ExoPlayer** do aparelho |
| **iPhone e iPad** | App nativo para a App Store | `celular-apps/ios/` | **AVPlayer** do iOS |
| **Samsung** | App Tizen para a Samsung TV Store | `tv-apps/samsung-tizen/` | **AVPlay** do sistema |
| **LG** | App webOS para a LG Content Store | `tv-apps/lg-webos/` | `<video>` do webOS |
| **TCL, Google TV, Sony, Philips** | App Android TV para a Google Play | `tv-apps/android-tv/` | **ExoPlayer** do aparelho |

Um comando aponta todos eles para o servidor de vocês:

```bash
node scripts/empacotar-apps.js https://play.seudominio.com.br
```

---

## 1. Celular sem loja: o app instalável (PWA)

É o caminho mais rápido para o assinante ter o ícone na tela inicial — **não depende de
aprovação de loja nem de conta de desenvolvedor**, e atualiza sozinho quando vocês publicam
uma versão nova no servidor.

O que o assinante vê:

- **Android**: ao abrir a PLAY TECH VIP no Chrome, aparece o convite "Instalar". Em dois toques
  o app vira ícone na tela inicial e passa a abrir **em tela cheia, sem a barra do navegador**.
- **iPhone e iPad**: no Safari, *Compartilhar → Adicionar à Tela de Início*. O app mostra esse
  passo a passo sozinho, com as telas na ordem.

O que vem junto: ícone e nome próprios, abertura em tela cheia, atalhos para "Canais ao vivo",
"Guia" e "Minha lista" ao segurar o ícone, e um **service worker** que guarda os arquivos do app
— abre rápido e não fica em branco quando a rede oscila. Vídeo e catálogo nunca são guardados:
isso continua vindo do servidor, com o link assinado de sempre.

Exige **HTTPS** (o navegador só instala em site seguro) — o `docker compose` já entrega isso.

## 2. Android, celular e tablet

Projeto em `celular-apps/android/`. É a casca nativa: abre a plataforma numa WebView e, no play,
entrega o vídeo ao **ExoPlayer (Media3)** do aparelho.

O que o app nativo acrescenta ao PWA:

- decodificação por hardware, inclusive **4K**;
- **janela flutuante** (picture-in-picture): sai do app e o vídeo continua num cantinho da tela;
- controles na tela de bloqueio e áudio em segundo plano;
- presença na **Google Play**, com ícone, ficha e avaliações.

```bash
cd celular-apps/android
./gradlew assembleDebug      # APK de teste, para instalar no celular pelo cabo
./gradlew bundleRelease      # .aab para enviar à Google Play
```

**Os APKs de teste já vêm compilados** em `dist/`:

| Arquivo | Para |
|---|---|
| `PLAYTECHVIP-celular-android-teste.apk` | celular e tablet Android |
| `PLAYTECHVIP-androidtv-teste.apk` | TCL, Google TV e demais Android TV |

Instale direto no aparelho (no celular, abra o arquivo e autorize "instalar de fonte
desconhecida"; na TV, `adb install -r arquivo.apk`). **Na primeira abertura o app pergunta o
endereço do servidor** — é o que permite testar em qualquer instalação sem recompilar. Para
trocar depois, o aviso de "sem internet" tem o botão *Trocar o endereço do servidor*.

Esses dois APKs estão assinados com a **chave de depuração** do Android: servem para testar,
não para publicar. Para a loja, rode `./gradlew bundleRelease` com a chave de vocês.

Antes de publicar: troque a assinatura de teste pela chave de vocês (`app/build.gradle.kts`,
bloco `signingConfig`) e suba a versão em `versionCode`/`versionName`.

Alcance: **Android 7 (API 24) em diante** — praticamente todo aparelho em uso hoje.

## 3. iPhone e iPad

Projeto em `celular-apps/ios/`, descrito em `project.yml` (XcodeGen) para viver no repositório
como texto, e não como um arquivo binário do Xcode.

```bash
cd celular-apps/ios
brew install xcodegen        # uma vez
xcodegen generate            # gera PlayTechVip.xcodeproj
open PlayTechVip.xcodeproj   # escolha o time em Signing & Capabilities e rode
```

A reprodução usa o **AVPlayer** do iOS, e com ele vêm de graça: **AirPlay** para a TV, **janela
flutuante**, controles na tela de bloqueio e legendas do sistema.

Para publicar é preciso **macOS com Xcode** e uma conta no **Apple Developer Program**
(US$ 99/ano). O envio é pelo Xcode (*Product → Archive → Distribute*) ou pelo Transporter.

Alcance: **iOS 14 em diante** (iPhone 6s e mais novos).

## 4. Smart TVs

O detalhe de cada uma está em [`tv-apps/README.md`](tv-apps/README.md). Em resumo:

```bash
npm run empacotar-tv https://play.seudominio.com.br   # Samsung e LG
cd tv-apps/android-tv && ./gradlew assembleRelease     # TCL, Google TV, Sony, Philips
```

---

## O que cada loja exige

| Loja | Conta | Custo | Prazo típico de avaliação |
|---|---|---|---|
| Google Play (Android e Android TV) | Google Play Console | US$ 25, uma vez | 1 a 7 dias |
| App Store (iPhone e iPad) | Apple Developer Program | US$ 99/ano | 1 a 3 dias |
| Samsung TV Store | Samsung Seller Portal | gratuito | 2 a 4 semanas |
| LG Content Store | LG Seller Lounge | gratuito | 2 a 4 semanas |
| Amazon Appstore (Fire TV) | Amazon Developer | gratuito | 1 a 5 dias |

Todas pedem as mesmas coisas: ícone e artes, descrição, política de privacidade publicada numa
URL, classificação indicativa e **uma conta de teste** com assinatura ativa, para o avaliador
conseguir entrar e assistir. Vale deixar essa conta criada antes de enviar.

Duas exigências que costumam reprovar app de streaming na primeira tentativa:

1. **Conteúdo licenciado.** As lojas pedem a comprovação de que vocês podem distribuir os títulos
   e os canais. Tenham os contratos à mão.
2. **Pagamento dentro do app.** Se o app vender assinatura na própria tela, Apple e Google
   cobram a comissão delas. Com a cobrança no IXC, o app só **autentica** — e é por isso que ele
   não deve ter botão de compra, só o aviso de onde contratar.

## Ordem recomendada

1. **PWA no ar junto com o servidor.** O assinante já instala no celular no mesmo dia.
2. **Android** (celular e TV) na Google Play: conta barata, avaliação rápida.
3. **iPhone**, com a conta Apple criada em paralelo (a verificação da empresa leva dias).
4. **Samsung e LG**, que são as mais demoradas e as que mais pedem ajustes.
