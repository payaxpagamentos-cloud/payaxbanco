import UIKit

/// Endereço do servidor da PLAY TECH VIP.
/// Troque pelo domínio de vocês (precisa ser https). O empacotador faz isso sozinho:
/// `node scripts/empacotar-apps.js https://play.seudominio.com.br`
let SERVIDOR = "https://SEU-DOMINIO/"

/**
 Onde o app procura a plataforma.

 Normalmente o endereço vem gravado no app (a constante acima). Enquanto ele ainda é o de
 exemplo — numa versão de teste, antes de o domínio existir —, o app pergunta o endereço na
 primeira abertura e guarda no aparelho, para a equipe testar sem recompilar.
 */
enum Servidor {
  private static let chave = "playtechvip.servidor"

  static var guardado: String? {
    UserDefaults.standard.string(forKey: chave)
  }

  static var precisaPerguntar: Bool {
    (guardado?.isEmpty ?? true) && SERVIDOR.localizedCaseInsensitiveContains("SEU-DOMINIO")
  }

  static var atual: String {
    if let g = guardado, !g.isEmpty { return g }
    return SERVIDOR
  }

  static func gravar(_ endereco: String) {
    UserDefaults.standard.set(endereco, forKey: chave)
  }

  static func limpar() {
    UserDefaults.standard.removeObject(forKey: chave)
  }

  /// Arruma o que a pessoa digitou: tira espaços, põe https:// e a barra do fim.
  static func arrumar(_ digitado: String) -> String? {
    var t = digitado.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return nil }
    if !t.hasPrefix("http://") && !t.hasPrefix("https://") { t = "https://" + t }
    if !t.hasSuffix("/") { t += "/" }
    guard let url = URL(string: t), let host = url.host, host.contains(".") else { return nil }
    return t
  }

  /// Pergunta o endereço e devolve o que foi digitado.
  static func perguntar(em tela: UIViewController, aoConfirmar: @escaping (String) -> Void) {
    let aviso = UIAlertController(
      title: "PLAY TECH VIP",
      message: "Digite o endereço da PLAY TECH VIP do seu provedor.",
      preferredStyle: .alert
    )
    aviso.addTextField { campo in
      campo.placeholder = "play.seuprovedor.com.br"
      campo.keyboardType = .URL
      campo.autocapitalizationType = .none
      campo.autocorrectionType = .no
      campo.text = guardado ?? ""
    }
    aviso.addAction(UIAlertAction(title: "Entrar", style: .default) { _ in
      guard let digitado = aviso.textFields?.first?.text, let endereco = arrumar(digitado) else {
        perguntarDeNovo(em: tela, aoConfirmar: aoConfirmar)
        return
      }
      gravar(endereco)
      aoConfirmar(endereco)
    })
    tela.present(aviso, animated: true)
  }

  private static func perguntarDeNovo(em tela: UIViewController, aoConfirmar: @escaping (String) -> Void) {
    let erro = UIAlertController(
      title: "Endereço inválido",
      message: "Exemplo: play.seuprovedor.com.br",
      preferredStyle: .alert
    )
    erro.addAction(UIAlertAction(title: "Tentar de novo", style: .default) { _ in
      perguntar(em: tela, aoConfirmar: aoConfirmar)
    })
    tela.present(erro, animated: true)
  }
}
