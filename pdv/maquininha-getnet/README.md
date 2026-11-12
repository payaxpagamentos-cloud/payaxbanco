# Maquininha Getnet (Santander) no Payax PDV

Aplicativo Android que roda **na maquininha** (POS Digital / Get Smart da Getnet, a adquirente do Santander) e
liga o aparelho ao PDV. Ele faz três coisas, em repetição:

1. pergunta ao PDV se há cobrança esperando **esta** maquininha;
2. chama a aplicação de pagamento da Getnet pelo deeplink, já com o valor, a forma e as parcelas — o cliente só
   encosta ou insere o cartão;
3. devolve ao PDV o que aconteceu: aprovada, negada ou cancelada, com NSU, CV, autorização, bandeira e os
   últimos dígitos do cartão.

Se a internet cair **depois** de o cartão passar, o resultado fica guardado no aparelho e é reenviado até o PDV
confirmar — o PDV aceita o mesmo resultado repetido, então nenhum pagamento aprovado se perde.

## O que você precisa antes

- Uma maquininha **POS Digital** da Getnet com a aplicação **Pagamento** instalada (vem de fábrica).
- Acesso de parceiro no **Get Store** (portal do desenvolvedor da Getnet) para publicar o aplicativo no
  aparelho e para a homologação. A integração em si é por *deeplink*: **não exige o SDK**.
- O endereço do PDV (ex.: `https://seudominio.com.br/pdv`) e a **chave da maquininha**, que sai no painel do
  PDV em *Maquininhas › Nova maquininha* (adquirente **Getnet**, integração **Aplicativo na maquininha**).

## Compilar

Abra esta pasta no Android Studio (ou rode `gradle assembleRelease` com o Android SDK instalado). Não há
dependência além do `androidx.appcompat`. O APK sai em `app/build/outputs/apk/`.

Para instalar direto num aparelho de teste, com depuração USB ligada:

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```

Em produção, publique pelo canal da Getnet (Get Store/MDM) — é o caminho que a operadora aceita.

## Configurar

Abra o aplicativo na maquininha, toque em **Configurar** e informe:

| Campo | O que é |
|---|---|
| Endereço do PDV | `https://seudominio.com.br/pdv` (o mesmo que o navegador abre) |
| Chave da maquininha | `pdv_<prefixo>_<segredo>`, do painel do PDV |
| Crédito parcelado pelo lojista | marcado = `creditMerchant` (juros do lojista); desmarcado = `creditIssuer` (juros do emissor) |

A tela mostra "Maquininha pronta" quando a chave é aceita, com o nome do aparelho e da empresa.

## Modo Quiosque (totem)

O `AndroidManifest.xml` já traz `kiosk_mode = 1`, então este aplicativo aparece na lista do **Modo Quiosque**
do POS Digital (app *Configurar* da maquininha). Nesse modo o aparelho só abre este app, a tela fica sempre
ligada e é preciso senha para sair — é o que a Getnet recomenda para terminal de autoatendimento.

Há também, comentado no manifesto, o `priority_pay = 1`, que esconde os atalhos de Pagamento, Pré-autorização e
Estorno do app da Getnet. **Atenção:** se ligar isso, a Getnet exige que o seu aplicativo ofereça pagamento e
estorno por conta própria, porque o operador perde o acesso direto àquelas telas. Por isso vem desligado.

## Como os campos são traduzidos

| PDV | Getnet (deeplink `getnet://pagamento/v1/payment`) |
|---|---|
| `valor_centavos` | `amount`, com 12 dígitos: R$ 12,34 → `000000001234` |
| `forma: "debito"` | `paymentType: "debit"` |
| `forma: "credito"`, 1 parcela | `paymentType: "credit"` (sem `creditType`) |
| `forma: "credito"`, 2+ parcelas | `paymentType: "credit"` + `creditType: "creditMerchant"` ou `"creditIssuer"` + `installments` |
| — | `currencyCode: "986"` (real) |

No retorno (`onActivityResult`):

| Getnet | PDV | Para que serve |
|---|---|---|
| `result` 0 / 2 / 1, 3, 4 | `status` aprovada / cancelada / negada | situação da cobrança |
| `nsu` | `nsu` | CV impresso no comprovante |
| `cvNumber` | `cv` | é o número que a Getnet pede para **estornar** |
| `authorizationCode` | `autorizacao` | AUT da bandeira |
| `brand`, `cardLastDigits` | `bandeira`, `cartao_final` | saem no comprovante do PDV |
| `resultDetails`, `nsuLocal` | `mensagem` | motivo da recusa e o DOC do comprovante |

## Limites desta integração

- **PIX não entra pelo deeplink de pagamento** desta versão da API (ele aceita crédito, débito e voucher). Por
  isso, no painel do PDV, a maquininha Getnet já nasce aceitando só **débito e crédito** — a tela do cliente não
  oferece PIX nesse PDV.
- **Estorno** pelo deeplink (`getnet://pagamento/v1/refund`) só vale **no mesmo dia** e pede o `cvNumber`. O PDV
  guarda esse número em cada cobrança; hoje o estorno é feito no próprio aparelho ou no portal da Getnet.
- O aplicativo foi escrito a partir da documentação oficial *API de Pagamento - POS Digital - Getnet* (v4.0.8) e
  **ainda não foi testado num aparelho**. Antes de produção, confirme com a Getnet: a versão da API instalada na
  maquininha, se o deeplink está liberado para o seu estabelecimento e a homologação do app.

## Testando sem a maquininha

Enquanto o aparelho não chega, `../scripts/maquininha-simulada.js` responde às cobranças como o aparelho
responderia — o balcão e o totem funcionam de ponta a ponta, inclusive a baixa no IXC.
