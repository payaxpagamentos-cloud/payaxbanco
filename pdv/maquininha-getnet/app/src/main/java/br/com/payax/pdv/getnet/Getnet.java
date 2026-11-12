package br.com.payax.pdv.getnet;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Tradução entre o Payax PDV e a aplicação de pagamento da Getnet (POS Digital).
 *
 * A chamada é por deeplink, com os parâmetros no Bundle do Intent, e o resultado volta no onActivityResult
 * (API de Pagamento - POS Digital - Getnet, versão 4.0.8).
 *
 * Cuidado com os nomes: no retorno da Getnet, "nsu" é o CV impresso no comprovante, "cvNumber" é o número
 * usado para estornar e "authorizationCode" é a AUT da bandeira. O PDV guarda os três.
 */
final class Getnet {
    static final String DEEPLINK_PAGAMENTO = "getnet://pagamento/v1/payment";
    static final String DEEPLINK_ESTORNO = "getnet://pagamento/v1/refund";
    static final String DEEPLINK_INFO = "getnet://pagamento/v1/getinfos";

    /** Resultados da aplicação de pagamento: 0 sucesso, 1 negada, 2 cancelada, 3 falha, 4 desconhecido. */
    static final String SUCESSO = "0";
    static final String NEGADA = "1";
    static final String CANCELADA = "2";

    private Getnet() { }

    /** Valor em 12 dígitos, com os dois últimos sendo os centavos: R$ 12,34 vira "000000001234". */
    static String valorGetnet(long centavos) {
        String digitos = Long.toString(Math.max(0, centavos));
        StringBuilder saida = new StringBuilder();
        for (int i = digitos.length(); i < 12; i++) saida.append('0');
        return saida.append(digitos).toString();
    }

    /**
     * Monta a chamada de pagamento a partir da cobrança que veio do PDV.
     *
     * @param creditoParceladoLojista true = parcelado no lojista ("creditMerchant"), false = no emissor ("creditIssuer")
     */
    static Intent intentDePagamento(JSONObject cobranca, boolean creditoParceladoLojista) throws JSONException {
        String forma = cobranca.optString("forma", "credito");
        long centavos = cobranca.optLong("valor_centavos", 0);
        int parcelas = Math.max(1, cobranca.optInt("parcelas", 1));

        Bundle dados = new Bundle();
        dados.putString("amount", valorGetnet(centavos));
        dados.putString("currencyCode", "986");
        if ("debito".equals(forma)) {
            dados.putString("paymentType", "debit");
        } else if ("credito".equals(forma)) {
            dados.putString("paymentType", "credit");
            if (parcelas > 1) {
                dados.putString("creditType", creditoParceladoLojista ? "creditMerchant" : "creditIssuer");
                dados.putString("installments", Integer.toString(parcelas));
            }
        } else {
            // O deeplink de pagamento do POS Digital 4.0.8 aceita credit, debit e voucher — PIX não entra aqui.
            throw new JSONException("Forma de pagamento não suportada pela maquininha: " + forma);
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(DEEPLINK_PAGAMENTO));
        intent.putExtras(dados);
        return intent;
    }

    /** Traduz o que a Getnet devolveu para o que o PDV espera em POST /resultado. */
    static JSONObject resultadoParaPdv(String referencia, Intent retorno) throws JSONException {
        JSONObject corpo = new JSONObject();
        corpo.put("referencia", referencia);
        if (retorno == null || retorno.getExtras() == null) {
            corpo.put("status", "cancelada");
            corpo.put("mensagem", "A maquininha não devolveu resposta.");
            return corpo;
        }
        Bundle extras = retorno.getExtras();
        String resultado = texto(extras.getString("result"));
        String detalhes = texto(extras.getString("resultDetails"));

        if (SUCESSO.equals(resultado)) {
            corpo.put("status", "aprovada");
        } else if (CANCELADA.equals(resultado)) {
            corpo.put("status", "cancelada");
        } else {
            // Negada (1), falha (3) e desconhecido (4): para o PDV o pagamento não aconteceu.
            corpo.put("status", "negada");
        }
        corpo.put("nsu", texto(extras.getString("nsu")));                      // CV impresso no comprovante
        corpo.put("cv", texto(extras.getString("cvNumber")));                  // usado para estornar no mesmo dia
        corpo.put("autorizacao", texto(extras.getString("authorizationCode"))); // AUT da bandeira
        corpo.put("bandeira", texto(extras.getString("brand")));
        corpo.put("cartao_final", texto(extras.getString("cardLastDigits")));
        String nsuLocal = texto(extras.getString("nsuLocal"));
        corpo.put("mensagem", (detalhes.isEmpty() ? "" : detalhes) + (nsuLocal.isEmpty() ? "" : " · DOC " + nsuLocal));
        return corpo;
    }

    private static String texto(String v) {
        return v == null ? "" : v.trim();
    }
}
