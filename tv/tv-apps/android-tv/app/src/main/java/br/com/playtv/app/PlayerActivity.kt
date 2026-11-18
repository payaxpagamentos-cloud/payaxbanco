package br.com.playtv.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView

/**
 * Reprodução nativa da PLAY TV na Android TV (TCL, Google TV e afins).
 *
 * Usa o ExoPlayer (Media3), que é o player nativo do Android: decodificação por hardware,
 * HLS ao vivo, troca de faixa automática e os controles que o usuário da TV já conhece.
 * A posição é devolvida à página para o "continuar assistindo" seguir funcionando.
 */
@UnstableApi
class PlayerActivity : AppCompatActivity() {

  private var player: ExoPlayer? = null
  private lateinit var tela: PlayerView
  private val relogio = Handler(Looper.getMainLooper())
  private var aoVivo = false

  private val tique = object : Runnable {
    override fun run() {
      player?.let { p ->
        val segundos = p.currentPosition / 1000
        val duracao = if (p.duration > 0) p.duration / 1000 else 0
        PontePlayer.aoProgresso?.invoke(segundos, duracao)
      }
      relogio.postDelayed(this, 15_000)
    }
  }

  override fun onCreate(estado: Bundle?) {
    super.onCreate(estado)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    tela = PlayerView(this).apply {
      keepScreenOn = true
      useController = true
      controllerShowTimeoutMs = 3500
    }
    setContentView(tela)

    val url = intent.getStringExtra("url").orEmpty()
    val titulo = intent.getStringExtra("titulo").orEmpty()
    val subtitulo = intent.getStringExtra("subtitulo").orEmpty()
    aoVivo = intent.getBooleanExtra("aoVivo", false)
    val posicao = intent.getLongExtra("posicao", 0L)

    val fonteHttp = DefaultHttpDataSource.Factory()
      .setUserAgent("PlayTV-AndroidTV/1.0")
      .setAllowCrossProtocolRedirects(true)

    val midia = MediaItem.Builder()
      .setUri(Uri.parse(url))
      .setMediaMetadata(
        androidx.media3.common.MediaMetadata.Builder()
          .setTitle(titulo)
          .setSubtitle(subtitulo)
          .build()
      )
      .build()

    // HLS para canais ao vivo; arquivo progressivo (MP4) para o catálogo.
    val fonte: MediaSource = if (url.contains(".m3u8")) {
      HlsMediaSource.Factory(fonteHttp).createMediaSource(midia)
    } else {
      ProgressiveMediaSource.Factory(fonteHttp).createMediaSource(midia)
    }

    player = ExoPlayer.Builder(this)
      .setMediaSourceFactory(DefaultMediaSourceFactory(fonteHttp))
      .build()
      .also { p ->
        tela.player = p
        p.setMediaSource(fonte)
        if (!aoVivo && posicao > 0) p.seekTo(posicao * 1000)
        p.playWhenReady = true
        p.prepare()
        p.addListener(object : Player.Listener {
          override fun onPlaybackStateChanged(estadoPlayer: Int) {
            if (estadoPlayer == Player.STATE_ENDED) encerrar(concluido = true)
          }
        })
      }

    relogio.post(tique)
  }

  /** Voltar fecha a reprodução e devolve a posição para a página. */
  override fun onKeyDown(codigo: Int, evento: KeyEvent): Boolean {
    if (codigo == KeyEvent.KEYCODE_BACK) {
      encerrar(concluido = false)
      return true
    }
    return super.onKeyDown(codigo, evento)
  }

  private fun encerrar(concluido: Boolean) {
    val segundos = (player?.currentPosition ?: 0L) / 1000
    setResult(
      Activity.RESULT_OK,
      Intent().putExtra("segundos", segundos).putExtra("concluido", concluido)
    )
    finish()
  }

  override fun onStop() {
    super.onStop()
    player?.playWhenReady = false
  }

  override fun onDestroy() {
    relogio.removeCallbacks(tique)
    player?.release()
    player = null
    super.onDestroy()
  }
}
