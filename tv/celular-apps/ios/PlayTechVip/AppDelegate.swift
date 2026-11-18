import UIKit

/// Entrada do app: abre a tela principal (a PLAY TECH VIP dentro de um WKWebView).
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {

  var window: UIWindow?

  func application(_ application: UIApplication,
                   didFinishLaunchingWithOptions opcoes: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let janela = UIWindow(frame: UIScreen.main.bounds)
    janela.rootViewController = TelaPrincipal()
    janela.backgroundColor = .black
    janela.makeKeyAndVisible()
    window = janela
    return true
  }

  /// O app gira livre; a tela de reprodução decide a orientação dela.
  func application(_ application: UIApplication,
                   supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
    .all
  }
}
