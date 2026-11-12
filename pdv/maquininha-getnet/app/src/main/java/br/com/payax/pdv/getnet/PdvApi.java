package br.com.payax.pdv.getnet;

import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Conversa com o Payax PDV pela API das maquininhas.
 *
 *   GET  {base}/api/integracao/terminal/cobranca    -> próxima cobrança (204 = nada a fazer)
 *   POST {base}/api/integracao/terminal/resultado   -> devolve o que aconteceu no cartão
 *
 * Em todas as chamadas vai o cabeçalho X-Api-Key com a chave da maquininha (sai no painel, em Maquininhas).
 */
class PdvApi {
    private static final String TAG = "PdvApi";
    private static final int TIMEOUT_MS = 15000;

    private final String base;
    private final String chave;

    PdvApi(String enderecoPdv, String chave) {
        String b = enderecoPdv == null ? "" : enderecoPdv.trim();
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        this.base = b + "/api/integracao/terminal";
        this.chave = chave == null ? "" : chave.trim();
    }

    /** Dados do aparelho, para conferir endereço e chave. Devolve null quando a chave não vale. */
    JSONObject quemSou() throws Exception {
        Resposta r = chamar("GET", "", null);
        return r.codigo == 200 ? new JSONObject(r.corpo) : null;
    }

    /** Próxima cobrança esperando esta maquininha, ou null quando não há nada. */
    JSONObject proximaCobranca() throws Exception {
        Resposta r = chamar("GET", "/cobranca", null);
        if (r.codigo == 204) return null;
        if (r.codigo != 200) throw new Exception("PDV respondeu " + r.codigo + (r.corpo.isEmpty() ? "" : ": " + r.corpo));
        return new JSONObject(r.corpo);
    }

    /** Resultado do cartão. Repetir o mesmo resultado não dá erro: o PDV aceita o reenvio. */
    void enviarResultado(JSONObject resultado) throws Exception {
        Resposta r = chamar("POST", "/resultado", resultado.toString());
        if (r.codigo != 200) throw new Exception("PDV respondeu " + r.codigo + (r.corpo.isEmpty() ? "" : ": " + r.corpo));
    }

    private Resposta chamar(String metodo, String caminho, String corpo) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(base + caminho).openConnection();
        try {
            con.setRequestMethod(metodo);
            con.setConnectTimeout(TIMEOUT_MS);
            con.setReadTimeout(TIMEOUT_MS);
            con.setRequestProperty("X-Api-Key", chave);
            con.setRequestProperty("Accept", "application/json");
            if (corpo != null) {
                con.setDoOutput(true);
                con.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                OutputStream saida = con.getOutputStream();
                saida.write(corpo.getBytes(StandardCharsets.UTF_8));
                saida.close();
            }
            int codigo = con.getResponseCode();
            InputStream entrada = codigo >= 400 ? con.getErrorStream() : con.getInputStream();
            String texto = ler(entrada);
            Log.d(TAG, metodo + " " + caminho + " -> " + codigo);
            return new Resposta(codigo, texto);
        } finally {
            con.disconnect();
        }
    }

    private static String ler(InputStream entrada) throws Exception {
        if (entrada == null) return "";
        BufferedReader leitor = new BufferedReader(new InputStreamReader(entrada, StandardCharsets.UTF_8));
        StringBuilder texto = new StringBuilder();
        String linha;
        while ((linha = leitor.readLine()) != null) texto.append(linha);
        leitor.close();
        return texto.toString();
    }

    private static class Resposta {
        final int codigo;
        final String corpo;
        Resposta(int codigo, String corpo) { this.codigo = codigo; this.corpo = corpo; }
    }
}
