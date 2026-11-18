import UIKit
import WebKit
import AVKit

/**
 PLAY TECH VIP no iPhone e no iPad.

 O app é a casca: abre a PLAY TECH VIP do servidor de vocês em tela cheia e, quando o
 assinante dá play, entrega o vídeo ao AVPlayer do próprio iOS — decodificação por hardware,
 AirPlay, janela flutuante e os controles que o aparelho já conhece.
 */
final class TelaPrincipal: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {

  private var navegador: WKWebView!
  private var avisoSemRede: UIView!
  private var tocandoAgora: PlayerViewController?

  // MARK: - Ponte com a página

  /// O que a página enxerga como `window.PlayTechVipNative`, com a mesma cara do app Android.
  private var ponteJS: String {
    let aparelho = "\(UIDevice.current.model)".replacingOccurrences(of: "\"", with: "")
    return """
    window.PlayTechVipNative = {
      tocar: function (json) { window.webkit.messageHandlers.playtechvip.postMessage({ acao: 'tocar', dados: json }); },
      fechar: function () { window.webkit.messageHandlers.playtechvip.postMessage({ acao: 'fechar' }); },
      aparelho: function () { return "\(aparelho)"; }
    };
    """
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    config.allowsPictureInPictureMediaPlayback = true

    let conteudo = WKUserContentController()
    conteudo.add(self, name: "playtechvip")
    conteudo.addUserScript(WKUserScript(source: ponteJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    config.userContentController = conteudo

    navegador = WKWebView(frame: .zero, configuration: config)
    navegador.navigationDelegate = self
    navegador.isOpaque = false
    navegador.backgroundColor = .black
    navegador.scrollView.backgroundColor = .black
    navegador.scrollView.bounces = false
    navegador.allowsBackForwardNavigationGestures = true
    if #available(iOS 16.4, *) { navegador.isInspectable = false }
    navegador.customUserAgent = (navegador.value(forKey: "userAgent") as? String ?? "") + " PlayTechVip-iOS/1.0"

    navegador.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(navegador)
    NSLayoutConstraint.activate([
      navegador.topAnchor.constraint(equalTo: view.topAnchor),
      navegador.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      navegador.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      navegador.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])

    montarAvisoSemRede()
    // Áudio continua tocando com o app em segundo plano e na janela flutuante.
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    try? AVAudioSession.sharedInstance().setActive(true)

    abrir()
  }

  private func abrir() {
    // Versão de teste ainda sem domínio gravado: pergunta o endereço antes de abrir.
    if Servidor.precisaPerguntar {
      Servidor.perguntar(em: self) { [weak self] _ in self?.abrir() }
      return
    }
    guard let url = URL(string: Servidor.atual) else { return }
    navegador.load(URLRequest(url: url))
  }

  override var prefersHomeIndicatorAutoHidden: Bool { true }
  override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

  // MARK: - Reprodução nativa

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let corpo = message.body as? [String: Any], let acao = corpo["acao"] as? String else { return }
    if acao == "fechar" {
      tocandoAgora?.dismiss(animated: true)
      tocandoAgora = nil
      return
    }
    guard acao == "tocar",
          let json = corpo["dados"] as? String,
          let dados = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
          let endereco = dados["url"] as? String,
          let url = URL(string: endereco)
    else { return }

    let tela = PlayerViewController(
      url: url,
      titulo: dados["titulo"] as? String ?? "",
      subtitulo: dados["subtitulo"] as? String ?? "",
      aoVivo: dados["aoVivo"] as? Bool ?? false,
      posicao: (dados["posicao"] as? NSNumber)?.doubleValue ?? 0
    )
    tela.aoProgresso = { [weak self] segundos, duracao in
      self?.avisarPagina(["tipo": "progresso", "segundos": segundos, "duracao": duracao])
    }
    tela.aoFechar = { [weak self] segundos, concluido in
      self?.avisarPagina(["tipo": "fim", "segundos": segundos, "concluido": concluido])
      self?.tocandoAgora = nil
    }
    tocandoAgora = tela
    tela.modalPresentationStyle = .fullScreen
    present(tela, animated: true)
  }

  private func avisarPagina(_ evento: [String: Any]) {
    guard let dados = try? JSONSerialization.data(withJSONObject: evento),
          let json = String(data: dados, encoding: .utf8) else { return }
    navegador.evaluateJavaScript("window.playtechvipNativoEvento && window.playtechvipNativoEvento(\(json))")
  }

  // MARK: - Links e falhas

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    // Link para fora do nosso domínio abre no Safari, não dentro do app.
    if let destino = action.request.url, let nosso = URL(string: Servidor.atual)?.host,
       let host = destino.host, host.caseInsensitiveCompare(nosso) != .orderedSame,
       action.navigationType == .linkActivated {
      UIApplication.shared.open(destino)
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    avisoSemRede.isHidden = false
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    avisoSemRede.isHidden = false
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    avisoSemRede.isHidden = true
  }

  private func montarAvisoSemRede() {
    let caixa = UIView()
    caixa.backgroundColor = .black
    caixa.isHidden = true
    caixa.translatesAutoresizingMaskIntoConstraints = false

    let texto = UILabel()
    texto.text = "Sem internet. Confira a conexão do aparelho e tente de novo."
    texto.textColor = .white
    texto.numberOfLines = 0
    texto.textAlignment = .center

    let botao = UIButton(type: .system)
    botao.setTitle("Tentar de novo", for: .normal)
    botao.addAction(UIAction { [weak self] _ in
      self?.avisoSemRede.isHidden = true
      self?.abrir()
    }, for: .touchUpInside)

    let trocar = UIButton(type: .system)
    trocar.setTitle("Trocar o endereço do servidor", for: .normal)
    trocar.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      Servidor.limpar()
      Servidor.perguntar(em: self) { _ in
        self.avisoSemRede.isHidden = true
        self.abrir()
      }
    }, for: .touchUpInside)

    let pilha = UIStackView(arrangedSubviews: [texto, botao, trocar])
    pilha.axis = .vertical
    pilha.spacing = 16
    pilha.translatesAutoresizingMaskIntoConstraints = false
    caixa.addSubview(pilha)
    view.addSubview(caixa)
    avisoSemRede = caixa

    NSLayoutConstraint.activate([
      caixa.topAnchor.constraint(equalTo: view.topAnchor),
      caixa.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      caixa.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      caixa.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      pilha.centerXAnchor.constraint(equalTo: caixa.centerXAnchor),
      pilha.centerYAnchor.constraint(equalTo: caixa.centerYAnchor),
      pilha.leadingAnchor.constraint(equalTo: caixa.leadingAnchor, constant: 32),
      pilha.trailingAnchor.constraint(equalTo: caixa.trailingAnchor, constant: -32),
    ])
  }
}
