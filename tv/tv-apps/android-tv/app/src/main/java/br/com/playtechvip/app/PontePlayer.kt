package br.com.playtechvip.app

/**
 * Ponte entre o player nativo (PlayerActivity) e a página da PLAY TECH VIP que roda no WebView.
 * A tela de reprodução avisa aqui o andamento; a MainActivity repassa para o JavaScript.
 */
object PontePlayer {
  /** Chamado enquanto o vídeo toca: posição e duração, em segundos. */
  var aoProgresso: ((segundos: Long, duracao: Long) -> Unit)? = null
}
