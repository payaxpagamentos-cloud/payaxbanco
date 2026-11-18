# PLAY TECH VIP nas Smart TVs

Três apps, cada um usando o **player nativo do aparelho**:

| Pasta | Aparelhos | Player | Interface |
|---|---|---|---|
| [`samsung-tizen/`](samsung-tizen) | Samsung (Tizen 6.0+) | **AVPlay**, o player nativo do sistema | vai dentro do app |
| [`lg-webos/`](lg-webos) | LG (webOS 5.0+) | pipeline de mídia do webOS (o `<video>` da TV) | vai dentro do app |
| [`android-tv/`](android-tv) | **TCL**, Google TV, Philips, Sony, Fire TV* | **ExoPlayer (Media3)**, nativo do Android | WebView + player nativo |

\* o Fire TV usa a mesma base Android; a publicação é na Amazon Appstore.

Nas TVs da Samsung e da LG, **app nativo é app web**: é esse o SDK oficial dos dois fabricantes
(Tizen Web App e webOS Web App). O que muda num app de verdade é de onde vem a interface e quem
decodifica o vídeo — e os dois pontos estão resolvidos aqui: a interface é empacotada no
aparelho e a reprodução usa o player do sistema.

## Como o vídeo toca em cada um

- **Samsung**: o `motor-nativo.js` detecta `webapis.avplay` e troca o `<video>` pelo AVPlay,
  mantendo os mesmos controles na tela. É o AVPlay que decodifica — é o caminho que a Samsung
  exige para HLS ao vivo, 4K e DRM.
- **LG**: o `<video>` do webOS já é o decodificador do aparelho; o HLS vai pelo hls.js, que o
  webOS roda com aceleração.
- **Android TV**: a página detecta `window.PlayTechVipNative` e entrega a reprodução ao app: abre a
  `PlayerActivity` com **ExoPlayer** em tela cheia, com os controles nativos da TV. A posição
  volta para a página, então "continuar assistindo", audiência e limite de telas seguem valendo.
- **Qualquer outro aparelho**: o player da própria PLAY TECH VIP (hls.js + `<video>`).

## Montar os apps da Samsung e da LG

```bash
# na pasta tv/ — leva a interface para dentro do pacote e aponta para o seu servidor
npm run empacotar-tv https://seu-dominio/tv
```

Isso gera `tv-apps/samsung-tizen/dist/` e `tv-apps/lg-webos/dist/` com a interface, o hls.js,
o `config.js` apontando para o servidor e, no caso da Samsung, a chamada do `webapis.js`.

```bash
# Samsung — com o Tizen Studio instalado
tizen build-web -- tv-apps/samsung-tizen/dist
tizen package -t wgt -s <seu-perfil-de-assinatura> -- tv-apps/samsung-tizen/dist/.buildResult
tizen install -n PlayTechVip.wgt -t <nome-da-tv> -- .

# LG — com a CLI da LG (npm i -g @webos-tools/cli)
ares-package tv-apps/lg-webos/dist
ares-install br.com.playtechvip.app_1.0.0_all.ipk -d <nome-da-tv>
ares-launch br.com.playtechvip.app -d <nome-da-tv>
```

Publicação: **Samsung Seller Portal** (seller.samsungapps.com) e **LG Seller Lounge**
(seller.lgappstv.com). Os dois pedem o pacote, as artes e uma conta de teste para a avaliação.

> Ao abrir o `dist` fora de uma TV Samsung, o navegador acusa 404 em `$WEBAPIS/webapis/webapis.js`.
> É esperado: esse caminho só existe dentro da TV, e o código só usa o AVPlay quando ele responde.

## Montar o app da TCL / Android TV

Abra `android-tv/` no **Android Studio** (Giraffe ou mais novo), troque o endereço em
`app/src/main/res/values/strings.xml` e rode numa TV em modo desenvolvedor:

```bash
cd android-tv
./gradlew assembleRelease
adb connect <ip-da-tv>:5555
adb install app/build/outputs/apk/release/app-release.apk
```

Publicação: **Google Play Console**, ficha "Android TV" (o banner 320×180 já está em
`res/drawable-xhdpi/banner.png`). Assine com a chave de vocês: o `build.gradle.kts` vem com a
chave de depuração só para testar.

## O que o controle remoto faz

| Tecla | O que acontece |
|---|---|
| Setas | Andam pelo foco (fileiras, canais, botões do player) |
| OK | Abre o que está em foco |
| Voltar | Fecha o player ou a janela; na tela inicial, sai do app |
| Play/Pause | Toca e pausa |
| ⏩ / ⏪ | Avançam e voltam 30 segundos |
| Stop | Fecha o player |

A interface entra sozinha no modo TV (fontes maiores, margens de 10 pés, foco bem visível).
Para conferir no computador, abra o app com `?tv=1`.

## O que foi testado e o que não foi

**Testado em navegador real, aqui:**

- navegação por controle remoto, foco, botão Voltar da Samsung (código 10009) e teclas de mídia,
  simulando uma TV Tizen em 1920×1080;
- o **modo empacotado** completo: interface servida de outra origem (como fica dentro do
  aparelho) falando com a API do servidor — login, 40 artes carregadas e vídeo tocando.

**Não testado, por falta de aparelho e de SDK neste ambiente:**

- a troca para o **AVPlay** da Samsung (o código tem reserva: se o AVPlay falhar, o `<video>`
  assume);
- o **ExoPlayer** do app Android TV (o projeto compila com Media3 1.4.1, mas o build precisa do
  SDK do Android);
- a geração dos pacotes `.wgt`, `.ipk` e `.apk`, que dependem do Tizen Studio, da CLI da LG e do
  Android Studio.

Esses três pontos precisam de uma primeira rodada numa TV de verdade.
