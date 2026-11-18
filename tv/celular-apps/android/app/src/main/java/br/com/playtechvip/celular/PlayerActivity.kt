package br.com.playtechvip.celular

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Rational
import android.view.View
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
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
 * Reprodução no celular e no tablet, com o ExoPlayer (Media3) — o player nativo do Android.
 *
 * Diferenças para a versão de TV: a tela gira com o aparelho, o vídeo vai para
 * **janela flutuante** (picture-in-picture) quando o assinante sai do app, e a barra de
 * status some durante a reprodução.
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

  private fun temJanelaFlutuante() =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
      && packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  override fun onCreate(estado: Bundle?) {
    super.onCreate(estado)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR

    // Tela cheia de verdade: sem barra de status nem de navegação enquanto o vídeo roda.
    WindowCompat.setDecorFitsSystemWindows(window, false)
    WindowInsetsControllerCompat(window, window.decorView).apply {
      hide(WindowInsetsCompat.Type.systemBars())
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

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
      .setUserAgent("PlayTechVip-Android/1.0")
      .setAllowCrossProtocolRedirects(true)

    val midia = MediaItem.Builder()
      .setUri(Uri.parse(url))
      .setMediaMetadata(MediaMetadata.Builder().setTitle(titulo).setSubtitle(subtitulo).build())
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

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() = encerrar(concluido = false)
    })

    relogio.post(tique)
  }

  /** Sair do app com o vídeo tocando manda para a janela flutuante, em vez de parar. */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    val tocando = player?.isPlaying == true
    if (tocando && temJanelaFlutuante()) {
      val formato = player?.videoFormat
      val proporcao = if (formato != null && formato.width > 0 && formato.height > 0) {
        Rational(formato.width, formato.height)
      } else {
        Rational(16, 9)
      }
      runCatching {
        enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(proporcao).build())
      }
    }
  }

  override fun onPictureInPictureModeChanged(naJanela: Boolean, config: Configuration) {
    super.onPictureInPictureModeChanged(naJanela, config)
    // Na janela flutuante não cabem controles: só a imagem.
    tela.useController = !naJanela
    if (naJanela) tela.hideController()
  }

  private fun encerrar(concluido: Boolean) {
    val segundos = (player?.currentPosition ?: 0L) / 1000
    setResult(Activity.RESULT_OK, Intent().putExtra("segundos", segundos).putExtra("concluido", concluido))
    finish()
  }

  override fun onStop() {
    super.onStop()
    // Em janela flutuante o vídeo continua; fora dela, pausa ao sair.
    val naJanela = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode
    if (!naJanela) player?.playWhenReady = false
  }

  override fun onDestroy() {
    relogio.removeCallbacks(tique)
    player?.release()
    player = null
    super.onDestroy()
  }

  @Suppress("unused")
  private fun esconderBarras(view: View) {
    WindowInsetsControllerCompat(window, view).hide(WindowInsetsCompat.Type.systemBars())
  }
}
