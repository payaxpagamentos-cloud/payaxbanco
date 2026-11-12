package br.com.payax.pdv.getnet;

import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Aplicativo da maquininha Getnet (Santander) para o Payax PDV.
 *
 * O que ele faz, em repetição:
 *   1. pergunta ao PDV se há cobrança esperando esta maquininha;
 *   2. chama a aplicação de pagamento da Getnet pelo deeplink, já com valor, forma e parcelas;
 *   3. devolve ao PDV o que aconteceu (aprovada, negada ou cancelada), com NSU, CV, AUT e bandeira.
 *
 * Se a internet cair depois de o cartão passar, o resultado fica guardado aqui e é reenviado até o PDV
 * confirmar: nenhum pagamento aprovado se perde.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "PdvGetnet";
    private static final int PEDIDO_PAGAMENTO = 1001;
    private static final long INTERVALO_MS = 2000;

    private static final String PREFS = "pdv-getnet";
    private static final String P_URL = "url";
    private static final String P_CHAVE = "chave";
    private static final String P_LOJISTA = "parcelado_lojista";
    private static final String P_PENDENTE = "resultado_pendente";

    private final Handler relogio = new Handler(Looper.getMainLooper());
    private final ExecutorService fundo = Executors.newSingleThreadExecutor();

    private TextView situacao;
    private TextView detalhe;
    private TextView rodape;
    private SharedPreferences prefs;
    private PdvApi api;
    private boolean emPagamento = false;
    private String referenciaAtual = null;

    @Override
    protected void onCreate(@Nullable Bundle estado) {
        super.onCreate(estado);
        setContentView(R.layout.activity_main);
        situacao = findViewById(R.id.situacao);
        detalhe = findViewById(R.id.detalhe);
        rodape = findViewById(R.id.rodape);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        Button configurar = findViewById(R.id.configurar);
        configurar.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { abrirConfiguracao(); }
        });

        api = new PdvApi(prefs.getString(P_URL, ""), prefs.getString(P_CHAVE, ""));
        if (prefs.getString(P_CHAVE, "").isEmpty()) abrirConfiguracao();
        else conferirLigacao();
    }

    @Override
    protected void onResume() {
        super.onResume();
        relogio.removeCallbacksAndMessages(null);
        relogio.postDelayed(ciclo, 600);
    }

    @Override
    protected void onPause() {
        super.onPause();
        relogio.removeCallbacksAndMessages(null);
    }

    // ---------- laço principal ----------
    private final Runnable ciclo = new Runnable() {
        @Override public void run() {
            if (!emPagamento) {
                if (temResultadoPendente()) reenviarPendente();
                else buscarCobranca();
            }
            relogio.postDelayed(this, INTERVALO_MS);
        }
    };

    private void buscarCobranca() {
        if (prefs.getString(P_CHAVE, "").isEmpty()) return;
        fundo.execute(new Runnable() {
            @Override public void run() {
                try {
                    final JSONObject cobranca = api.proximaCobranca();
                    if (cobranca == null) {
                        naTela("Maquininha pronta", "Esperando uma cobrança do PDV…");
                        return;
                    }
                    relogio.post(new Runnable() {
                        @Override public void run() { iniciarPagamento(cobranca); }
                    });
                } catch (Exception e) {
                    Log.w(TAG, "falha ao buscar cobrança", e);
                    naTela("Sem comunicação com o PDV", e.getMessage() == null ? "" : e.getMessage());
                }
            }
        });
    }

    private void iniciarPagamento(JSONObject cobranca) {
        try {
            referenciaAtual = cobranca.optString("referencia", "");
            boolean lojista = prefs.getBoolean(P_LOJISTA, true);
            Intent intent = Getnet.intentDePagamento(cobranca, lojista);
            emPagamento = true;
            naTela("Siga na maquininha", descricao(cobranca));
            startActivityForResult(intent, PEDIDO_PAGAMENTO);
        } catch (Exception e) {
            emPagamento = false;
            Log.e(TAG, "não foi possível chamar a aplicação de pagamento", e);
            // Sem o app de pagamento (ou com forma não suportada), devolve a recusa para o PDV não ficar esperando.
            JSONObject recusa = new JSONObject();
            try {
                recusa.put("referencia", referenciaAtual);
                recusa.put("status", "negada");
                recusa.put("mensagem", "Maquininha: " + (e.getMessage() == null ? "falha ao abrir o pagamento" : e.getMessage()));
            } catch (Exception ignorada) { /* não acontece */ }
            guardarPendente(recusa);
            reenviarPendente();
        }
    }

    @Override
    protected void onActivityResult(int pedido, int resultado, @Nullable Intent retorno) {
        super.onActivityResult(pedido, resultado, retorno);
        if (pedido != PEDIDO_PAGAMENTO) return;
        emPagamento = false;
        try {
            JSONObject corpo = Getnet.resultadoParaPdv(referenciaAtual, retorno);
            naTela(rotuloDoStatus(corpo.optString("status")), corpo.optString("mensagem", ""));
            guardarPendente(corpo);
            reenviarPendente();
        } catch (Exception e) {
            Log.e(TAG, "falha ao ler o retorno da Getnet", e);
            naTela("Falha ao ler o retorno", e.getMessage() == null ? "" : e.getMessage());
        }
    }

    private String rotuloDoStatus(String status) {
        if ("aprovada".equals(status)) return "Pagamento aprovado";
        if ("cancelada".equals(status)) return "Pagamento cancelado";
        return "Pagamento não aprovado";
    }

    // ---------- resultado que ainda não chegou ao PDV ----------
    private boolean temResultadoPendente() {
        return !prefs.getString(P_PENDENTE, "").isEmpty();
    }

    private void guardarPendente(JSONObject corpo) {
        prefs.edit().putString(P_PENDENTE, corpo.toString()).apply();
    }

    private void reenviarPendente() {
        final String guardado = prefs.getString(P_PENDENTE, "");
        if (guardado.isEmpty()) return;
        fundo.execute(new Runnable() {
            @Override public void run() {
                try {
                    api.enviarResultado(new JSONObject(guardado));
                    prefs.edit().remove(P_PENDENTE).apply();
                } catch (Exception e) {
                    // Fica guardado e o laço tenta de novo: o PDV aceita o mesmo resultado repetido.
                    Log.w(TAG, "resultado ainda não entregue ao PDV", e);
                    naTela("Enviando ao PDV…", "Sem comunicação. Vou tentar de novo.");
                }
            }
        });
    }

    // ---------- configuração ----------
    private void abrirConfiguracao() {
        LinearLayout caixa = new LinearLayout(this);
        caixa.setOrientation(LinearLayout.VERTICAL);
        int margem = (int) (16 * getResources().getDisplayMetrics().density);
        caixa.setPadding(margem, margem, margem, 0);

        final EditText campoUrl = new EditText(this);
        campoUrl.setHint("https://seudominio.com.br/pdv");
        campoUrl.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        campoUrl.setText(prefs.getString(P_URL, ""));

        final EditText campoChave = new EditText(this);
        campoChave.setHint("pdv_xxxxxxxx_...");
        campoChave.setText(prefs.getString(P_CHAVE, ""));

        final CheckBox lojista = new CheckBox(this);
        lojista.setText("Crédito parcelado pelo lojista (desmarque para parcelar no emissor)");
        lojista.setChecked(prefs.getBoolean(P_LOJISTA, true));

        caixa.addView(campoUrl);
        caixa.addView(campoChave);
        caixa.addView(lojista);

        new AlertDialog.Builder(this)
                .setTitle("Ligar esta maquininha ao PDV")
                .setView(caixa)
                .setCancelable(false)
                .setPositiveButton("Salvar", (dialogo, qual) -> {
                    prefs.edit()
                            .putString(P_URL, campoUrl.getText().toString().trim())
                            .putString(P_CHAVE, campoChave.getText().toString().trim())
                            .putBoolean(P_LOJISTA, lojista.isChecked())
                            .apply();
                    api = new PdvApi(prefs.getString(P_URL, ""), prefs.getString(P_CHAVE, ""));
                    conferirLigacao();
                })
                .setNegativeButton("Voltar", null)
                .show();
    }

    /** Confere endereço e chave e mostra de qual maquininha e empresa este aparelho é. */
    private void conferirLigacao() {
        naTela("Conferindo a ligação com o PDV…", "");
        fundo.execute(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject quem = api.quemSou();
                    if (quem == null) {
                        naTela("Chave recusada pelo PDV", "Gere outra chave no painel, em Maquininhas.");
                        return;
                    }
                    JSONObject terminal = quem.optJSONObject("terminal");
                    JSONObject empresa = quem.optJSONObject("empresa");
                    final String nome = terminal == null ? "maquininha" : terminal.optString("nome");
                    final String daEmpresa = empresa == null ? "" : empresa.optString("nome");
                    naTela("Maquininha pronta", "Esperando uma cobrança do PDV…");
                    relogio.post(new Runnable() {
                        @Override public void run() { rodape.setText(nome + (daEmpresa.isEmpty() ? "" : " · " + daEmpresa)); }
                    });
                } catch (Exception e) {
                    naTela("Sem comunicação com o PDV", e.getMessage() == null ? "" : e.getMessage());
                }
            }
        });
    }

    private String descricao(JSONObject cobranca) {
        long centavos = cobranca.optLong("valor_centavos", 0);
        int parcelas = Math.max(1, cobranca.optInt("parcelas", 1));
        String forma = "debito".equals(cobranca.optString("forma")) ? "Débito" : "Crédito";
        String valor = String.format(java.util.Locale.getDefault(), "R$ %.2f", centavos / 100.0);
        return forma + (parcelas > 1 ? " " + parcelas + "x" : "") + " · " + valor;
    }

    private void naTela(final String titulo, final String texto) {
        relogio.post(new Runnable() {
            @Override public void run() {
                situacao.setText(titulo);
                detalhe.setText(texto == null ? "" : texto);
            }
        });
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        relogio.removeCallbacksAndMessages(null);
        fundo.shutdownNow();
    }
}
