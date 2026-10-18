import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let assetRoot = Bundle.main.bundlePath
        let e2eMode = E2ETestMode.fromLaunchArguments()
        let bridgeHandler = ZeroNativeBridgeMessageHandler()
        let webView = ZeroNativeHostViewController.makeWebView(
            assetRootPath: assetRoot,
            assetEntryPath: "index.html",
            bridgeHandler: bridgeHandler
        )
        let controller = ZeroNativeHostViewController(webView: webView, bridgeHandler: bridgeHandler, e2eMode: e2eMode)
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        (window?.rootViewController as? ZeroNativeHostViewController)?.activateNativeApp()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        (window?.rootViewController as? ZeroNativeHostViewController)?.deactivateNativeApp()
    }
}
