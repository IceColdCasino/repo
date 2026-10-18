import UIKit
import WebKit

final class ZeroNativeBridgeMessageHandler: NSObject, WKScriptMessageHandler {
    weak var host: ZeroNativeHostViewController?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "zeroNativeBridge", let body = message.body as? String else { return }
        host?.dispatchBridgeMessage(body)
    }
}

final class ZeroNativeHostViewController: UIViewController, WKNavigationDelegate {
    private let webView: WKWebView
    private let bridgeHandler: ZeroNativeBridgeMessageHandler
    private var webViewBottomConstraint: NSLayoutConstraint?
    private var nativeApp: UnsafeMutableRawPointer?
    private var bridgeDisplayLink: CADisplayLink?
    private var assetRootPath: String = ""
    private var assetEntryPath: String = "index.html"
    private var e2eMode: E2ETestMode?
    private var e2eStarted = false
    private var e2eFinished = false
    private let e2eStatusMarker: UILabel = {
        let label = UILabel(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        label.isAccessibilityElement = true
        label.accessibilityIdentifier = "e2e-status-running"
        label.accessibilityLabel = "e2e-status-running"
        label.alpha = 0.01
        label.isUserInteractionEnabled = false
        return label
    }()

    init(webView: WKWebView, bridgeHandler: ZeroNativeBridgeMessageHandler, e2eMode: E2ETestMode? = nil) {
        self.webView = webView
        self.bridgeHandler = bridgeHandler
        self.e2eMode = e2eMode
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        bridgeHandler.host = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        let webViewBottomConstraint = webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        self.webViewBottomConstraint = webViewBottomConstraint
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webViewBottomConstraint,
        ])

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardFrameWillChange),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillHide),
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )

        assetRootPath = Bundle.main.bundlePath
        webView.navigationDelegate = self
        if e2eMode != nil {
            view.addSubview(e2eStatusMarker)
            view.bringSubviewToFront(e2eStatusMarker)
        }
        startNativeApp()
        startBridgeDisplayLink()
        loadBundledFrontend()
        if case .smoke? = e2eMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.runNativeSmokeIfNeeded()
            }
        }
        if case .nativeShuffleProve? = e2eMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.runNativeShuffleProveIfNeeded()
            }
        }
        if case .nativeRegisterProve? = e2eMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.runNativeRegisterProveIfNeeded()
            }
        }
        if case .nativeRegisterThenShuffle? = e2eMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.runNativeRegisterThenShuffleIfNeeded()
            }
        }
        if case .nativeBridgePhase? = e2eMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.runNativeBridgePhaseIfNeeded()
            }
        }
    }

    private func runNativeSmokeIfNeeded() {
        guard case .smoke? = e2eMode, !e2eStarted, let nativeApp else { return }
        e2eStarted = true
        setE2EStatus(identifier: "e2e-status-running")
        finishE2E(report: E2ETestRunner.runNativeSmoke(app: nativeApp))
    }

    private func runNativeShuffleProveIfNeeded() {
        guard case .nativeShuffleProve? = e2eMode, !e2eStarted, let nativeApp else { return }
        e2eStarted = true
        setE2EStatus(identifier: "e2e-status-running")
        // Stop display-link delivery so pollBridgeResponse can take async zk.prove responses.
        stopBridgeDisplayLink()
        let report = E2ETestRunner.runNativeShuffleProve(app: nativeApp)
        finishE2E(report: report)
    }

    private func runNativeRegisterProveIfNeeded() {
        guard case .nativeRegisterProve? = e2eMode, !e2eStarted, let nativeApp else { return }
        e2eStarted = true
        setE2EStatus(identifier: "e2e-status-running")
        stopBridgeDisplayLink()
        let report = E2ETestRunner.runNativeRegisterProve(app: nativeApp)
        finishE2E(report: report)
    }

    private func runNativeRegisterThenShuffleIfNeeded() {
        guard case .nativeRegisterThenShuffle? = e2eMode, !e2eStarted, let nativeApp else { return }
        e2eStarted = true
        setE2EStatus(identifier: "e2e-status-running")
        stopBridgeDisplayLink()
        let report = E2ETestRunner.runNativeRegisterThenShuffle(app: nativeApp)
        finishE2E(report: report)
    }

    private func runNativeBridgePhaseIfNeeded() {
        guard case .nativeBridgePhase(let phaseName)? = e2eMode, !e2eStarted, let nativeApp else { return }
        e2eStarted = true
        setE2EStatus(identifier: "e2e-status-running")
        stopBridgeDisplayLink()
        let report = E2ETestRunner.runNativeBridgePhase(app: nativeApp, phaseName: phaseName)
        finishE2E(report: report)
    }

    /// During native ZK E2E, pollBridgeResponse owns bridge responses; display link must not consume them.
    private var holdsBridgeResponsesForNativeE2E: Bool {
        switch e2eMode {
        case .nativeShuffleProve?, .nativeRegisterProve?, .nativeRegisterThenShuffle?, .nativeBridgePhase?:
            return e2eStarted && !e2eFinished
        default:
            return false
        }
    }

    static func makeWebView(assetRootPath: String, assetEntryPath: String, bridgeHandler: ZeroNativeBridgeMessageHandler) -> WKWebView {
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(bridgeHandler, name: "zeroNativeBridge")
        controller.add(IosE2eReportHandler(), name: "iosE2eReport")
        let bridgeScript = WKUserScript(
            source: ZeroNativeBridgeScript.source,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        controller.addUserScript(bridgeScript)
        config.userContentController = controller
        if #available(iOS 14.0, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = true
        }
        config.preferences.javaScriptEnabled = true
        let distRoot = (assetRootPath as NSString).appendingPathComponent("frontend/dist")
        config.setURLSchemeHandler(
            ZeroNativeAssetSchemeHandler(rootPath: distRoot, entryPath: assetEntryPath, spaFallback: true),
            forURLScheme: "zero"
        )
        let webView = WKWebView(frame: .zero, configuration: config)
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        return webView
    }

    private func startNativeApp() {
        nativeApp = zero_native_app_create()
        guard let nativeApp else { return }
        assetRootPath.withCString { pointer in
            zero_native_app_set_asset_root(nativeApp, pointer, UInt(assetRootPath.utf8.count))
        }
        if let zkeyRoot = E2ETestRunner.zkeyRootFromLaunchArguments() {
            zkeyRoot.withCString { pointer in
                zero_native_app_set_zkey_root(nativeApp, pointer, UInt(zkeyRoot.utf8.count))
            }
        }
        assetEntryPath.withCString { pointer in
            zero_native_app_set_asset_entry(nativeApp, pointer, UInt(assetEntryPath.utf8.count))
        }
        zero_native_app_start(nativeApp)
        readLoadedAssetPaths()
    }

    private func readLoadedAssetPaths() {
        guard let nativeApp else { return }
        var rootBuffer = [CChar](repeating: 0, count: 4096)
        let rootLen = zero_native_app_loaded_asset_root(nativeApp, &rootBuffer, rootBuffer.count)
        if rootLen > 0 {
            assetRootPath = String(cString: rootBuffer)
        }
        var entryBuffer = [CChar](repeating: 0, count: 256)
        let entryLen = zero_native_app_loaded_asset_entry(nativeApp, &entryBuffer, entryBuffer.count)
        if entryLen > 0 {
            assetEntryPath = String(cString: entryBuffer)
        }
    }

    private func loadBundledFrontend() {
        let entry = E2ETestRunner.entryPath(baseEntry: assetEntryPath)
        let url = URL(string: "zero://app/\(entry)")!
        webView.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let e2eMode, !e2eStarted, e2eMode.usesWebViewRunner else { return }
        guard let url = webView.url?.absoluteString, url.hasPrefix("zero://app") else { return }
        e2eStarted = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.runInAppE2E(mode: e2eMode)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("[ZeroNativeHost] navigation failed: %@", error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("[ZeroNativeHost] provisional navigation failed: %@", error.localizedDescription)
    }

    private func runInAppE2E(mode: E2ETestMode) {
        setE2EStatus(identifier: "e2e-status-running")
        let body = E2ETestRunner.runnerAsyncBody(mode: mode)
        let finish: (Any?, Error?) -> Void = { [weak self] value, error in
            guard let self else { return }
            if let error {
                let report = E2ETestReport(
                    passed: false,
                    cases: [
                        E2ETestCaseResult(
                            name: "runner.evaluateJavaScript",
                            ok: false,
                            detail: error.localizedDescription,
                            durationMs: 0
                        ),
                    ],
                    finishedAt: ISO8601DateFormatter().string(from: Date())
                )
                self.finishE2E(report: report)
                return
            }
            guard let payload = value as? [String: Any] else {
                let report = E2ETestReport(
                    passed: false,
                    cases: [
                        E2ETestCaseResult(
                            name: "runner.result",
                            ok: false,
                            detail: "Unexpected JS result type",
                            durationMs: 0
                        ),
                    ],
                    finishedAt: ISO8601DateFormatter().string(from: Date())
                )
                self.finishE2E(report: report)
                return
            }
            self.finishE2E(report: E2ETestRunner.makeReport(from: payload))
        }

        if #available(iOS 15.0, *) {
            webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value):
                    finish(value, nil)
                case .failure(let error):
                    finish(nil, error)
                }
            }
        } else {
            webView.evaluateJavaScript(E2ETestRunner.runnerScript(mode: mode), completionHandler: finish)
        }
    }

    private func finishE2E(report: E2ETestReport) {
        guard !e2eFinished else { return }
        e2eFinished = true
        E2ETestRunner.writeReport(E2ETestReport(
            passed: report.passed,
            cases: report.cases,
            finishedAt: report.finishedAt,
            complete: true
        ))
        let statusId = report.passed ? "e2e-status-passed" : "e2e-status-failed"
        setE2EStatus(identifier: statusId)
        for entry in report.cases {
            let status = entry.ok ? "PASS" : "FAIL"
            print("[ios-e2e] \(status) \(entry.name) (\(entry.durationMs)ms) \(entry.detail ?? "")")
        }
        print("[ios-e2e] finished passed=\(report.passed)")
        guard e2eMode != nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            exit(report.passed ? 0 : 1)
        }
    }

    private func setE2EStatus(identifier: String) {
        e2eStatusMarker.accessibilityIdentifier = identifier
        e2eStatusMarker.accessibilityLabel = identifier
    }

    func dispatchBridgeMessage(_ message: String) {
        guard let nativeApp else { return }
        message.withCString { pointer in
            zero_native_app_bridge_dispatch(nativeApp, pointer, UInt(message.utf8.count))
        }
        zero_native_app_frame(nativeApp)
        deliverBridgeResponses()
    }

    private func deliverBridgeResponses() {
        if holdsBridgeResponsesForNativeE2E { return }
        guard let nativeApp else { return }
        while true {
            let length = BridgeResponseBuffer.withBuffer { buffer, capacity in
                zero_native_app_take_bridge_response(nativeApp, buffer, capacity)
            }
            if length == 0 { break }
            if length >= BridgeResponseBuffer.capacity {
                NSLog("[ZeroNativeHost] bridge response truncated at %d bytes", length)
            }
            let response = BridgeResponseBuffer.withBuffer { buffer, _ in
                String(decoding: UnsafeBufferPointer(start: buffer, count: length).map { UInt8(bitPattern: $0) }, as: UTF8.self)
            }
            deliverBridgeResponseJson(response)
            zero_native_app_frame(nativeApp)
        }
    }

    /// Deliver bridge JSON without embedding raw JSON in JS source (avoids parse failures / hangs).
    private func deliverBridgeResponseJson(_ response: String) {
        guard let data = response.data(using: .utf8) else { return }
        let b64 = data.base64EncodedString()
        let js = """
        (function(){
          try {
            if(window.zero&&window.zero._complete){
              window.zero._complete(JSON.parse(atob('\(b64)')));
            }
          } catch(e) {
            console.error('[zero-native] bridge complete failed', e);
          }
        })();
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func activateNativeApp() {
        guard let nativeApp else { return }
        zero_native_app_activate(nativeApp)
        if !holdsBridgeResponsesForNativeE2E {
            startBridgeDisplayLink()
        }
    }

    func deactivateNativeApp() {
        guard let nativeApp else { return }
        zero_native_app_deactivate(nativeApp)
        stopBridgeDisplayLink()
    }

    private func startBridgeDisplayLink() {
        guard bridgeDisplayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tickBridge))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        bridgeDisplayLink = link
    }

    private func stopBridgeDisplayLink() {
        bridgeDisplayLink?.invalidate()
        bridgeDisplayLink = nil
    }

    @objc private func tickBridge() {
        guard nativeApp != nil else { return }
        zero_native_app_frame(nativeApp)
        if !holdsBridgeResponsesForNativeE2E {
            deliverBridgeResponses()
        }
    }

    @objc private func keyboardFrameWillChange(_ notification: Notification) {
        guard let frameValue = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue else { return }
        let keyboardFrame = view.convert(frameValue.cgRectValue, from: nil)
        let overlap = max(0, view.bounds.maxY - keyboardFrame.minY)
        webViewBottomConstraint?.constant = -overlap
        animateKeyboardLayout(notification)
        syncNativeLayout()
    }

    @objc private func keyboardWillHide(_ notification: Notification) {
        webViewBottomConstraint?.constant = 0
        animateKeyboardLayout(notification)
        syncNativeLayout()
    }

    private func animateKeyboardLayout(_ notification: Notification) {
        let userInfo = notification.userInfo ?? [:]
        let duration = (userInfo[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let curve = (userInfo[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 0
        let options = UIView.AnimationOptions(rawValue: curve << 16)
        UIView.animate(withDuration: duration, delay: 0, options: options) {
            self.view.layoutIfNeeded()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        syncNativeLayout()
    }

    private func syncNativeLayout() {
        guard let nativeApp else { return }
        let scale = Float(view.window?.screen.scale ?? UIScreen.main.scale)
        zero_native_app_resize(nativeApp, Float(webView.bounds.width), Float(webView.bounds.height), scale, nil)
        zero_native_app_frame(nativeApp)
        if !holdsBridgeResponsesForNativeE2E {
            deliverBridgeResponses()
        }
    }

    deinit {
        stopBridgeDisplayLink()
        NotificationCenter.default.removeObserver(self)
        guard let nativeApp else { return }
        zero_native_app_stop(nativeApp)
        zero_native_app_destroy(nativeApp)
    }
}
