package br.com.playtechvip.app

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * Endereço do servidor que o app abre.
 *
 * Normalmente ele vem gravado no app (`strings.xml`, escrito pelo empacotador). Enquanto o
 * endereço ainda é o de exemplo — num APK de teste, antes de o domínio existir —, o app pede
 * o endereço na primeira abertura e guarda no aparelho. Serve para a equipe testar em qualquer
 * servidor sem recompilar.
 */
object Servidor {
  private const val ARQUIVO = "playtechvip"
  private const val CHAVE = "servidor"

  private fun doPacote(ctx: Context) = ctx.getString(R.string.servidor)

  /** O endereço gravado no app ainda é o de exemplo? */
  fun precisaPerguntar(ctx: Context) =
    guardado(ctx).isNullOrBlank() && doPacote(ctx).contains("SEU-DOMINIO", ignoreCase = true)

  fun guardado(ctx: Context): String? =
    ctx.getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE).getString(CHAVE, null)

  fun gravar(ctx: Context, endereco: String) {
    ctx.getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE).edit().putString(CHAVE, endereco).apply()
  }

  fun limpar(ctx: Context) {
    ctx.getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE).edit().remove(CHAVE).apply()
  }

  /** O endereço que vale agora: o digitado, se houver; senão o do pacote. */
  fun atual(ctx: Context): String = guardado(ctx)?.takeIf { it.isNotBlank() } ?: doPacote(ctx)

  /** Arruma o que a pessoa digitou: tira espaços, põe https:// e a barra do fim. */
  fun arrumar(digitado: String): String? {
    var t = digitado.trim()
    if (t.isEmpty()) return null
    if (!t.startsWith("http://") && !t.startsWith("https://")) t = "https://$t"
    if (!t.endsWith("/")) t = "$t/"
    val host = runCatching { android.net.Uri.parse(t).host }.getOrNull()
    if (host.isNullOrBlank() || !host.contains(".")) return null
    return t
  }
}

/** Tela simples de primeira abertura na TV: onde fica o servidor da operação. */
class ServidorActivity : AppCompatActivity() {

  override fun onCreate(estado: Bundle?) {
    super.onCreate(estado)

    val caixa = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setBackgroundColor(Color.BLACK)
      setPadding(120, 80, 120, 80)
      layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    }

    caixa.addView(TextView(this).apply {
      text = getString(R.string.app_name)
      setTextColor(Color.WHITE)
      textSize = 34f
      gravity = Gravity.CENTER
    })
    caixa.addView(TextView(this).apply {
      text = getString(R.string.servidor_explicacao)
      setTextColor(Color.LTGRAY)
      textSize = 20f
      gravity = Gravity.CENTER
      setPadding(0, 24, 0, 24)
    })

    val campo = EditText(this).apply {
      hint = getString(R.string.servidor_exemplo)
      setTextColor(Color.WHITE)
      setHintTextColor(Color.GRAY)
      inputType = InputType.TYPE_TEXT_VARIATION_URI
      setSingleLine()
      setText(Servidor.guardado(this@ServidorActivity) ?: "")
    }
    caixa.addView(campo)

    caixa.addView(Button(this).apply {
      text = getString(R.string.servidor_entrar)
      setOnClickListener {
        val endereco = Servidor.arrumar(campo.text.toString())
        if (endereco == null) {
          Toast.makeText(this@ServidorActivity, R.string.servidor_invalido, Toast.LENGTH_LONG).show()
          return@setOnClickListener
        }
        Servidor.gravar(this@ServidorActivity, endereco)
        startActivity(Intent(this@ServidorActivity, MainActivity::class.java))
        finish()
      }
    })

    setContentView(caixa)
  }
}
