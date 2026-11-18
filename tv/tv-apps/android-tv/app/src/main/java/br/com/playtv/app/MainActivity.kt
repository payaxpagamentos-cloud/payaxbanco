package br.com.playtv.app

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * PLAY TV na Android TV (TCL, Google TV e afins).
 *
 * O app é uma casca: ele abre a PLAY TV do servidor de vocês em tela cheia, já no modo TV
 * (?tv=1), e repassa o controle remoto para a página — as setas, o OK, o Voltar e as teclas
 * de mídia são tratados lá dentro, como em qualquer outro aparelho.
 */
class MainActivity : AppCompatActivity() {

  private lateinit var raiz: FrameLayout
  private lateinit var navegador: WebView
  private var telaCheiaDoVideo: View? = null

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(estado: Bundle?) {
    super.onCreate(estado)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    raiz = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
    navegador = WebView(this).apply {
      setBackgroundColor(Color.BLACK)
      layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        loadWithOverviewMode = true
        useWideViewPort = true
        mediaPlaybackRequiresUserGesture = false   // o vídeo começa sozinho, como numa TV
        cacheMode = WebSettings.LOAD_DEFAULT
        userAgentString = "$userAgentString PlayTV-AndroidTV/1.0"
      }
      webViewClient = object : WebViewClient() {
        override fun onReceivedError(v: WebView?, req: WebResourceRequest?, erro: WebResourceError?) {
          if (req?.isForMainFrame == true) {
            Toast.makeText(this@MainActivity, R.string.sem_conexao, Toast.LENGTH_LONG).show()
          }
        }
      }
      // Vídeo em tela cheia pedido pela página.
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

    raiz.addView(navegador)
    setContentView(raiz)
    navegador.loadUrl(getString(R.string.servidor))
  }

  /**
   * O Voltar do controle: primeiro a página decide (fechar o player, sair da janela);
   * só sai do app quando não há mais para onde voltar.
   */
  override fun onKeyDown(codigo: Int, evento: KeyEvent): Boolean {
    if (codigo == KeyEvent.KEYCODE_BACK) {
      if (telaCheiaDoVideo != null) {
        navegador.webChromeClient?.onHideCustomView()
        return true
      }
      if (navegador.canGoBack()) {
        navegador.goBack()
        return true
      }
    }
    return super.onKeyDown(codigo, evento)
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
