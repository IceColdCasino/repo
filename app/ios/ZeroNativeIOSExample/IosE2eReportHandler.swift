import Foundation
import WebKit

/// Receives partial full-game E2E results from the WebView harness.
final class IosE2eReportHandler: NSObject, WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "iosE2eReport",
              let body = message.body as? [String: Any] else {
            return
        }
        let report = E2ETestRunner.makeReport(from: body)
        E2ETestRunner.writeReport(report)
    }
}
