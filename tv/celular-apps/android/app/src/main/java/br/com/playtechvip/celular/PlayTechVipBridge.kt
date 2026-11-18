package br.com.playtechvip.celular

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * O que a página da PLAY TECH VIP enxerga como `window.PlayTechVipNative`.
 * Quando existe, o player da página se cala e quem toca é o ExoPlayer nativo.
 */
class PlayTechVipBridge(private val tela: MainActivity) {

  /** A página pede para tocar: { url, titulo, subtitulo, aoVivo, posicao, sessaoId } */
  @JavascriptInterface
  fun tocar(json: String) {
    val d = JSONObject(json)
    tela.abrirPlayerNativo(
      url = d.optString("url"),
      titulo = d.optString("titulo"),
      subtitulo = d.optString("subtitulo"),
      aoVivo = d.optBoolean("aoVivo", false),
      posicao = d.optLong("posicao", 0L)
    )
  }

  /** A página pede para fechar (por exemplo, a sessão caiu em outra tela). */
  @JavascriptInterface
  fun fechar() {
    tela.fecharPlayerNativo()
  }

  /** Nome do aparelho, para a lista de telas em uso. */
  @JavascriptInterface
  fun aparelho(): String = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}".trim()
}
