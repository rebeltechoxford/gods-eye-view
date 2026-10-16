import UIKit

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var privacyCover: UIView?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UINavigationController(rootViewController: ConsoleViewController())
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        guard let window, privacyCover == nil else { return }
        window.endEditing(true)
        let cover = UIView(frame: window.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = UIColor(red: 0.03, green: 0.08, blue: 0.13, alpha: 1)
        cover.accessibilityIdentifier = "inactivePrivacyCover"
        let label = UILabel()
        label.text = "GEV TAK\nSession paused"
        label.textColor = .white
        label.font = .preferredFont(forTextStyle: .title2)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        cover.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
        ])
        window.addSubview(cover)
        privacyCover = cover
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        privacyCover?.removeFromSuperview()
        privacyCover = nil
    }
}
