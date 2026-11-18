# PLAY TV nas Smart TVs

Três projetos prontos para empacotar a PLAY TV como aplicativo de TV:

| Pasta | Aparelhos | Como é o app |
|---|---|---|
| [`samsung-tizen/`](samsung-tizen) | Samsung (Tizen 6.0+) | App web da Samsung que abre o servidor da PLAY TV. |
| [`lg-webos/`](lg-webos) | LG (webOS 5.0+) | App web da LG que abre o servidor da PLAY TV. |
| [`android-tv/`](android-tv) | **TCL**, Google TV, Philips, Sony, Fire TV* | App Android (Kotlin) com WebView em tela cheia. |

\* o Fire TV usa a mesma base Android, mas a publicação é na Amazon Appstore.

Os três são **cascas**: abrem o endereço do seu servidor já em modo TV (`?tv=1`). Toda a interface,
o player e as atualizações continuam vindo do servidor — publicar conteúdo novo **não exige**
republicar o app na loja.

## Antes de empacotar

1. Publique a PLAY TV num domínio com **HTTPS** (as TVs bloqueiam conteúdo sem criptografia).
2. Aponte o app para esse endereço:
   - Samsung e LG: edite `config.js` → `window.PLAYTV_SERVIDOR = 'https://seu-dominio/tv'`.
   - Android TV: edite `app/src/main/res/values/strings.xml` → `<string name="servidor">`.
3. Troque os identificadores pelos seus: `tizen:application id` e `package` (Samsung),
   `id` do `appinfo.json` (LG) e `applicationId` (Android).

## Samsung (Tizen)

```bash
# Tizen Studio instalado (https://developer.tizen.org)
tizen build-web -- samsung-tizen
tizen package -t wgt -s <seu-perfil-de-assinatura> -- samsung-tizen/.buildResult
# instalar numa TV em modo desenvolvedor (Apps > 12345 > Developer Mode)
tizen install -n PlayTV.wgt -t <nome-da-tv> -- .
```

Publicação: **Samsung Seller Portal** (seller.samsungapps.com) → Smart TV. A Samsung pede o
pacote `.wgt`, descrição, capturas de tela e uma conta de teste para a avaliação deles.

## LG (webOS)

```bash
# CLI da LG instalada (npm i -g @webos-tools/cli)
ares-package lg-webos
ares-install br.com.playtv.app_1.0.0_all.ipk -d <nome-da-tv>
ares-launch br.com.playtv.app -d <nome-da-tv>
```

Publicação: **LG Seller Lounge** (seller.lgappstv.com). A LG também pede o `.ipk`, as artes e
uma conta de teste.

## TCL / Android TV

Abra a pasta `android-tv/` no **Android Studio** (Giraffe ou mais novo) e rode em um emulador
de TV ou numa TV em modo desenvolvedor:

```bash
cd android-tv
./gradlew assembleRelease          # gera o APK
adb connect <ip-da-tv>:5555        # TV com depuração por rede ligada
adb install app/build/outputs/apk/release/app-release.apk
```

Publicação: **Google Play Console**, ficha "Android TV" (a Play exige o banner 320×180, que já
está em `res/drawable-xhdpi/banner.png`, e a navegação 100% por controle remoto — que a PLAY TV
já faz). Assine o APK/AAB com a chave de vocês antes de enviar: o `build.gradle.kts` vem com a
chave de depuração só para testar.

## O que o controle remoto faz

Isto vale nos três apps e também em qualquer navegador aberto com `?tv=1`:

| Tecla | O que acontece |
|---|---|
| Setas | Andam pelo foco (fileiras, canais, botões do player) |
| OK / Enter | Abre o que está em foco |
| Voltar | Fecha o player ou a janela; na tela inicial, sai do app |
| Play/Pause | Toca e pausa |
| ⏩ / ⏪ | Avançam e voltam 30 segundos |
| Stop | Fecha o player |

A interface entra sozinha no modo TV quando reconhece o aparelho (Tizen, webOS, Android TV,
Fire TV, VIDAA e afins): fontes maiores, margens de 10 pés e foco bem visível.

## Testado até onde dá

A navegação por controle remoto, o foco, o botão Voltar das TVs (código 10009 da Samsung) e as
teclas de mídia **foram testados num navegador real** simulando uma Samsung Tizen em 1920×1080.

O empacotamento em si (`.wgt`, `.ipk` e APK) **não foi executado aqui**: ele depende do Tizen
Studio, da CLI da LG e do SDK do Android, que não existem neste ambiente. Os projetos estão
completos e seguem a estrutura que cada ferramenta espera, mas a primeira build precisa ser
feita por vocês, numa máquina com essas ferramentas instaladas.
