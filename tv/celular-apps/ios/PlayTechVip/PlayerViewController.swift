import UIKit
import AVKit

/**
 Reprodução no iPhone e no iPad com o AVPlayer — o player do próprio iOS.

 Vem de graça com ele: AirPlay para a TV, janela flutuante (picture-in-picture),
 controles na tela de bloqueio, legendas e decodificação por hardware, inclusive 4K.
 A posição é devolvida à página para o "continuar assistindo" seguir funcionando.
 */
final class PlayerViewController: AVPlayerViewController, AVPlayerViewControllerDelegate {

  private let endereco: URL
  private let aoVivo: Bool
  private let posicaoInicial: Double
  private var observador: Any?
  private var concluido = false

  /// Avisa a página de tempo em tempo (segundos, duração).
  var aoProgresso: ((Int, Int) -> Void)?
  /// Avisa a página quando o assinante fecha (segundos, terminou?).
  var aoFechar: ((Int, Bool) -> Void)?

  init(url: URL, titulo: String, subtitulo: String, aoVivo: Bool, posicao: Double) {
    self.endereco = url
    self.aoVivo = aoVivo
    self.posicaoInicial = posicao
    super.init(nibName: nil, bundle: nil)

    let item = AVPlayerItem(url: url)
    // Nome do título na tela de bloqueio e no AirPlay.
    let info = AVMutableMetadataItem()
    info.identifier = .commonIdentifierTitle
    info.value = titulo as NSString
    let sub = AVMutableMetadataItem()
    sub.identifier = .iTunesMetadataTrackSubTitle
    sub.value = subtitulo as NSString
    item.externalMetadata = [info, sub]

    let p = AVPlayer(playerItem: item)
    p.allowsExternalPlayback = true
    player = p
    allowsPictureInPicturePlayback = true
    if #available(iOS 14.2, *) { canStartPictureInPictureAutomaticallyFromInline = true }
    delegate = self
    videoGravity = .resizeAspect
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("sem storyboard") }

  override func viewDidLoad() {
    super.viewDidLoad()
    if !aoVivo, posicaoInicial > 0 {
      player?.seek(to: CMTime(seconds: posicaoInicial, preferredTimescale: 1))
    }
    player?.play()

    // Andamento a cada 15 segundos, como no app Android.
    observador = player?.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 15, preferredTimescale: 1), queue: .main
    ) { [weak self] tempo in
      guard let self else { return }
      let duracao = self.player?.currentItem?.duration.seconds ?? 0
      self.aoProgresso?(Int(tempo.seconds), duracao.isFinite ? Int(duracao) : 0)
    }

    NotificationCenter.default.addObserver(
      self, selector: #selector(terminou), name: .AVPlayerItemDidPlayToEndTime, object: player?.currentItem
    )
  }

  @objc private func terminou() {
    concluido = true
    fechar()
  }

  private func fechar() {
    let segundos = Int(player?.currentTime().seconds ?? 0)
    aoFechar?(segundos, concluido)
    dismiss(animated: true)
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    // Em janela flutuante o vídeo continua; fechando de vez, para e avisa a página.
    if !isBeingDismissed { return }
    if let observador { player?.removeTimeObserver(observador) }
    observador = nil
    if !concluido {
      let segundos = Int(player?.currentTime().seconds ?? 0)
      aoFechar?(segundos, false)
    }
    player?.pause()
  }

  // Volta do modo janela flutuante para a tela cheia sem perder a cena.
  func playerViewController(
    _ playerViewController: AVPlayerViewController,
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completion: @escaping (Bool) -> Void
  ) {
    completion(true)
  }
}
