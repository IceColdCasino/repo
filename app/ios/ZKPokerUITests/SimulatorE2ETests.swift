import XCTest

/// XCUITest suite that launches ZKPoker on the iOS Simulator with `-e2e_automation`.
/// The app runs bridge checks in-process and exposes `e2e-status-passed` / `e2e-status-failed`
/// accessibility identifiers when finished.
final class SimulatorE2ETests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func waitForE2ECompletion(app: XCUIApplication, timeout: TimeInterval) {
        let passed = app.otherElements["e2e-status-passed"]
        let failed = app.otherElements["e2e-status-failed"]
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if passed.exists { return }
            if failed.exists {
                XCTFail("In-app E2E reported failure (see simulator Documents/e2e-results.json)")
                return
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTFail("E2E runner did not finish within \(timeout)s")
    }

    func testBridgeSmoke() throws {
        throw XCTSkip("Default CI uses simctl + e2e-results.json (npm run test:ios:simulator). Set IOS_E2E_USE_XCUITEST=1 for this target.")
    }

    func testBridgeProve() throws {
        if ProcessInfo.processInfo.environment["IOS_E2E_PROVE"] != "1" {
            throw XCTSkip("Set IOS_E2E_PROVE=1 to run register_main prove on simulator (slow; needs iOS witness dylibs)")
        }
        let app = XCUIApplication()
        app.launchArguments += ["-e2e_automation", "-e2e_prove"]
        app.launch()
        // Groth16 prove on simulator can take several minutes.
        waitForE2ECompletion(app: app, timeout: 600)
    }

    func testRemoteServerHealth() throws {
        guard ProcessInfo.processInfo.environment["E2E_API_BASE"] != nil else {
            throw XCTSkip("Set E2E_API_BASE to run remote server health E2E")
        }
        let baseURL = ProcessInfo.processInfo.environment["E2E_API_BASE"] ?? "http://127.0.0.1:3847"
        let app = XCUIApplication()
        app.launchArguments += ["-e2e_automation", "-e2e_server", baseURL]
        app.launchEnvironment["E2E_API_BASE"] = baseURL
        waitForE2ECompletion(app: app, timeout: 180)
    }
}
