package br.com.playtechvip.celular

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.media3.common.util.UnstableApi
import org.json.JSONObject

/**
 * PLAY TECH VIP no celular e no tablet Android.
 *
 * O app é a casca: abre a PLAY TECH VIP do servidor de vocês em tela cheia e, quando o
 * assinante dá play, entrega o vídeo ao ExoPlayer do aparelho — decodificação por hardware,
 * janela flutuante e os controles que o Android já conhece.
 */
@UnstableApi
class MainActivity : AppCompatActivity() {

  private lateinit var raiz: FrameLayout
  private lateinit var navegador: WebView
  private lateinit var avisoSemRede: View
  private var telaCheiaDoVideo: View? = null

  /** Volta da reprodução nativa: devolve à página onde o assinante parou. */
  private val playerNativo = registerForActivityResult(
    androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
  ) { r ->
    val segundos = r.data?.getLongExtra("segundos", 0L) ?: 0L
    val concluido = r.data?.getBooleanExtra("concluido", false) ?: false
    avisarPagina(JSONObject().put("tipo", "fim").put("segundos", segundos).put("concluido", concluido))
  }

  fun abrirPlayerNativo(url: String, titulo: String, subtitulo: String, aoVivo: Boolean, posicao: Long) {
    runOnUiThread {
      PontePlayer.aoProgresso = { s, d ->
        avisarPagina(JSONObject().put("tipo", "progresso").put("segundos", s).put("duracao", d))
      }
      playerNativo.launch(
        Intent(this, PlayerActivity::class.java)
          .putExtra("url", url)
          .putExtra("titulo", titulo)
          .putExtra("subtitulo", subtitulo)
          .putExtra("aoVivo", aoVivo)
          .putExtra("posicao", posicao)
      )
    }
  }

  fun fecharPlayerNativo() {
    runOnUiThread { PontePlayer.aoProgresso = null }
  }

  private fun avisarPagina(evento: JSONObject) {
    runOnUiThread {
      navegador.evaluateJavascript("window.playtechvipNativoEvento && window.playtechvipNativoEvento($evento)", null)
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(estado: Bundle?) {
    super.onCreate(estado)
    // APK de teste ainda sem domínio gravado: pergunta o endereço antes de abrir.
    if (Servidor.precisaPerguntar(this)) {
      startActivity(Intent(this, ServidorActivity::class.java))
      finish()
      return
    }
    // A página desenha até a borda da tela e respeita o recorte com env(safe-area-inset-*).
    WindowCompat.setDecorFitsSystemWindows(window, false)

    raiz = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
    navegador = WebView(this).apply {
      setBackgroundColor(Color.BLACK)
      layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        loadWithOverviewMode = true
        useWideViewPort = true
        mediaPlaybackRequiresUserGesture = false
        cacheMode = WebSettings.LOAD_DEFAULT
        userAgentString = "$userAgentString PlayTechVip-Android/1.0"
      }
      addJavascriptInterface(PlayTechVipBridge(this@MainActivity), "PlayTechVipNative")
      webViewClient = object : WebViewClient() {
        /** Link para fora do nosso domínio abre no navegador, não dentro do app. */
        override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
          val nosso = Uri.parse(Servidor.atual(this@MainActivity)).host ?: return false
          val destino = req.url.host ?: return false
          if (destino.equals(nosso, ignoreCase = true)) return false
          startActivity(Intent(Intent.ACTION_VIEW, req.url))
          return true
        }

        override fun onReceivedError(v: WebView?, req: WebResourceRequest?, erro: WebResourceError?) {
          if (req?.isForMainFrame == true) mostrarAvisoSemRede(true)
        }

        override fun onPageFinished(v: WebView?, url: String?) {
          mostrarAvisoSemRede(false)
        }
      }
      // Vídeo em tela cheia pedido pela própria página (quando o player nativo não entra).
      webChromeClient = object : WebChromeClient() {
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
          telaCheiaDoVideo = view
          raiz.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
          navegador.visibility = View.GONE
        }

        override fun onHideCustomView() {
          telaCheiaDoVideo?.let { raiz.removeView(it) }
          telaCheiaDoVideo = null
          navegador.visibility = View.VISIBLE
        }
      }
    }

    avisoSemRede = montarAvisoSemRede()
    raiz.addView(navegador)
    raiz.addView(avisoSemRede)
    setContentView(raiz)
    ViewCompat.setOnApplyWindowInsetsListener(raiz) { v, insets -> insets.also { v.setPadding(0, 0, 0, 0) } }

    // Voltar: primeiro fecha o que estiver aberto na página; sem histórico, sai do app.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (telaCheiaDoVideo != null) {
          navegador.webChromeClient?.onHideCustomView()
          return
        }
        if (navegador.canGoBack()) {
          navegador.goBack()
          return
        }
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
      }
    })

    navegador.loadUrl(Servidor.atual(this))
  }

  /** Tela simples de "sem internet", com o botão de tentar de novo. */
  private fun montarAvisoSemRede(): View {
    val caixa = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = android.view.Gravity.CENTER
      setBackgroundColor(Color.BLACK)
      visibility = View.GONE
      layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      setPadding(48, 48, 48, 48)
    }
    caixa.addView(TextView(this).apply {
      text = getString(R.string.sem_conexao)
      setTextColor(Color.WHITE)
      textSize = 16f
      gravity = android.view.Gravity.CENTER
    })
    caixa.addView(Button(this).apply {
      text = getString(R.string.tentar)
      setOnClickListener {
        mostrarAvisoSemRede(false)
        navegador.reload()
      }
    })
    caixa.addView(Button(this).apply {
      text = getString(R.string.trocar_servidor)
      setOnClickListener {
        Servidor.limpar(this@MainActivity)
        startActivity(Intent(this@MainActivity, ServidorActivity::class.java))
        finish()
      }
    })
    return caixa
  }

  private fun mostrarAvisoSemRede(mostrar: Boolean) {
    avisoSemRede.visibility = if (mostrar) View.VISIBLE else View.GONE
    navegador.visibility = if (mostrar) View.GONE else View.VISIBLE
  }

  override fun onPause() {
    super.onPause()
    navegador.onPause()
  }

  override fun onResume() {
    super.onResume()
    navegador.onResume()
  }

  override fun onDestroy() {
    navegador.destroy()
    super.onDestroy()
  }
}
