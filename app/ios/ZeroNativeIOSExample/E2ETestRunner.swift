import Foundation

struct E2ETestCaseResult: Codable {
    let name: String
    let ok: Bool
    let detail: String?
    let durationMs: Int
}

struct E2ETestReport: Codable {
    let passed: Bool
    let cases: [E2ETestCaseResult]
    let finishedAt: String
    /// Incremental WebView reports set this false; finishE2E always writes true.
    let complete: Bool
    let progress: String?

    init(passed: Bool, cases: [E2ETestCaseResult], finishedAt: String, complete: Bool = true, progress: String? = nil) {
        self.passed = passed
        self.cases = cases
        self.finishedAt = finishedAt
        self.complete = complete
        self.progress = progress
    }
}


enum BridgeResponseBuffer {
    static let capacity = 1024 * 1024
    private static let storage: UnsafeMutablePointer<CChar> = {
        let ptr = UnsafeMutablePointer<CChar>.allocate(capacity: capacity)
        ptr.initialize(repeating: 0, count: capacity)
        return ptr
    }()

    static func withBuffer<R>(_ body: (UnsafeMutablePointer<CChar>, Int) -> R) -> R {
        body(storage, capacity)
    }
}

enum E2ETestMode: Equatable {
    case smoke
    case prove
    case nativeShuffleProve
    case nativeRegisterProve
    case nativeRegisterThenShuffle
    case nativeBridgePhase(name: String)
    case server(baseURL: String)
    case fullGame(baseURL: String)

    static func fromLaunchArguments() -> E2ETestMode? {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-e2e_automation") else { return nil }
        if args.contains("-e2e_native_register_then_shuffle") { return .nativeRegisterThenShuffle }
        if let index = args.firstIndex(of: "-e2e_bridge_phase"), index + 1 < args.count {
            return .nativeBridgePhase(name: args[index + 1])
        }
        if args.contains("-e2e_native_shuffle_prove") { return .nativeShuffleProve }
        if args.contains("-e2e_native_register_prove") { return .nativeRegisterProve }
        if args.contains("-e2e_prove") { return .prove }
        if args.contains("-e2e_full_game") {
            if let index = args.firstIndex(of: "-e2e_full_game"), index + 1 < args.count {
                return .fullGame(baseURL: args[index + 1])
            }
            if let envURL = ProcessInfo.processInfo.environment["E2E_API_BASE"], !envURL.isEmpty {
                return .fullGame(baseURL: envURL)
            }
            return .fullGame(baseURL: "http://127.0.0.1:3847")
        }
        if let index = args.firstIndex(of: "-e2e_server"), index + 1 < args.count {
            return .server(baseURL: args[index + 1])
        }
        if let envURL = ProcessInfo.processInfo.environment["E2E_API_BASE"], !envURL.isEmpty {
            return .server(baseURL: envURL)
        }
        return .smoke
    }

    var entryQuery: String {
        switch self {
        case .smoke:
            return "iosE2e=1"
        case .prove:
            return "iosE2e=1&iosE2eProve=1"
        case .nativeShuffleProve:
            return "iosE2e=1"
        case .nativeRegisterProve:
            return "iosE2e=1"
        case .nativeRegisterThenShuffle:
            return "iosE2e=1"
        case .nativeBridgePhase:
            return "iosE2e=1"
        case .server:
            return "iosE2e=1&iosE2eServer=1"
        case .fullGame(let url):
            let encoded = url.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? url
            // Solana dual-native serves assets on :5178 (not :3850). Prefer E2E_BACKEND env,
            // then known Solana origins — never treat Vite/static preview as local Bun.
            let envBackend = ProcessInfo.processInfo.environment["E2E_BACKEND"] ?? ""
            let backend: String
            if envBackend == "solana"
                || url.contains(":3850")
                || url.contains(":5178")
                || url.contains("solana")
            {
                backend = "solana"
            } else {
                backend = "local"
            }
            var q =
                // No e2eShowdownSeat pin — preferred winner (macOS or iOS) submits showdown.
                "iosE2e=1&iosE2eFullGame=1&nativeE2e=1&e2eSeat=1&e2eWallet=new&e2eAutoPlay=1&backend=\(backend)&apiBase=\(encoded)"
            if backend == "solana" {
                q += "&noChainWorker=1"
            }
            return q
        }
    }

    /// Modes that run E2ETestRunner via WebView after frontend load (not native C bridge).
    var usesWebViewRunner: Bool {
        switch self {
        case .prove, .server, .fullGame:
            return true
        case .smoke, .nativeShuffleProve, .nativeRegisterProve, .nativeRegisterThenShuffle, .nativeBridgePhase:
            return false
        }
    }
}

enum E2ETestRunner {
    /// Optional repo root for zkeys on simulator (`-e2e_zkey_root /path` or `-e2e_zkey_root=/path`).
    static func zkeyRootFromLaunchArguments() -> String? {
        let args = ProcessInfo.processInfo.arguments
        for arg in args {
            if arg.hasPrefix("-e2e_zkey_root=") {
                let value = String(arg.dropFirst("-e2e_zkey_root=".count))
                if !value.isEmpty { return value }
            }
        }
        if let index = args.firstIndex(of: "-e2e_zkey_root"), index + 1 < args.count {
            let value = args[index + 1]
            if !value.isEmpty { return value }
        }
        return nil
    }

    static func entryPath(baseEntry: String) -> String {
        guard let mode = E2ETestMode.fromLaunchArguments() else { return baseEntry }
        let separator = baseEntry.contains("?") ? "&" : "?"
        return "\(baseEntry)\(separator)\(mode.entryQuery)"
    }

    /// Async function body for WKWebView.callAsyncJavaScript (iOS 15+).
    static func runnerAsyncBody(mode: E2ETestMode) -> String {
        let proveCheck: String
        if mode == .prove {
            proveCheck = """
            try {
              const t0 = Date.now();
              const prove = await window.zero.invoke('zk.prove', {
                circuitName: 'register_main',
                input: {
                  privateKey: '1626022640429260911195448391915311140851446397727846428019625491664928023589',
                  publicKey: [
                    '10689101058007292548237549314775531833763326939030693586706797898091839170714',
                    '15394185089455923396480931182619841499985092295511166271520109125970094866909'
                  ]
                }
              });
              const ok = prove && Array.isArray(prove.publicSignals) && prove.publicSignals.length > 0 && prove.proof;
              cases.push({
                name: 'zk.prove.register_main',
                ok: !!ok,
                detail: ok ? 'publicSignals=' + prove.publicSignals.length : JSON.stringify(prove),
                durationMs: Date.now() - t0
              });
            } catch (error) {
              cases.push({
                name: 'zk.prove.register_main',
                ok: false,
                detail: String(error),
                durationMs: 0
              });
            }
            """
        } else {
            proveCheck = ""
        }

        let serverCheck: String
        switch mode {
        case .server(let url):
            serverCheck = """
            try {
              const base = \(jsonString(url));
              const healthUrl = base.replace(/\\/$/, '') + '/api/health?backend=local';
              const t0 = Date.now();
              const res = await fetch(healthUrl);
              const body = await res.text();
              cases.push({
                name: 'server.health',
                ok: res.ok,
                detail: body.slice(0, 256),
                durationMs: Date.now() - t0
              });
            } catch (error) {
              cases.push({
                name: 'server.health',
                ok: false,
                detail: String(error),
                durationMs: 0
              });
            }
            """
        case .fullGame(let url):
            serverCheck = """
            try {
              for (let i = 0; i < 120; i++) {
                if (typeof window.__iosE2eRunFullGame === 'function') break;
                await new Promise(function(r) { setTimeout(r, 250); });
              }
              if (typeof window.__iosE2eRunFullGame !== 'function') {
                return { passed: false, cases: [{ name: 'ios.fullGame.hook', ok: false, detail: '__iosE2eRunFullGame missing', durationMs: 0 }] };
              }
              const report = await window.__iosE2eRunFullGame(\(jsonString(url)));
              if (report && Array.isArray(report.cases)) {
                for (const entry of report.cases) { cases.push(entry); }
              } else {
                cases.push({ name: 'ios.fullGame.report', ok: false, detail: JSON.stringify(report), durationMs: 0 });
              }
            } catch (error) {
              cases.push({ name: 'ios.fullGame', ok: false, detail: String(error), durationMs: 0 });
            }
            """
        default:
            serverCheck = ""
        }

        let pingCheck: String
        if case .fullGame = mode {
            pingCheck = ""
        } else {
            pingCheck = """
        try {
          const t0 = Date.now();
          const ping = await window.zero.invoke('zk.ping', {});
          cases.push({
            name: 'zk.ping',
            ok: ping && ping.ok === true,
            detail: JSON.stringify(ping),
            durationMs: Date.now() - t0
          });
        } catch (error) {
          cases.push({ name: 'zk.ping', ok: false, detail: String(error), durationMs: 0 });
        }
        """
        }

        return """
        const cases = [];
        if (!window.zero || typeof window.zero.invoke !== 'function') {
          return { passed: false, cases: [{ name: 'bridge.ready', ok: false, detail: 'window.zero missing', durationMs: 0 }] };
        }
        \(pingCheck)
        \(proveCheck)
        \(serverCheck)
        const passed = cases.every(function(entry) { return entry.ok; });
        return { passed: passed, cases: cases };
        """
    }

    /// JavaScript executed in the WebView after the frontend loads.
    static func runnerScript(mode: E2ETestMode) -> String {
        return "(async function() { return await (async function() {\n\(runnerAsyncBody(mode: mode))\n})(); })();"
    }

    static func writeReport(_ report: E2ETestReport) {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return
        }
        let url = documents.appendingPathComponent("e2e-results.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(report) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// Write partial results so the host harness can read progress if the app crashes mid-prove.
    private static func writeIncrementalReport(cases: [E2ETestCaseResult]) {
        writeReport(E2ETestReport(
            passed: cases.allSatisfy(\.ok),
            cases: cases,
            finishedAt: ISO8601DateFormatter().string(from: Date()),
            complete: false
        ))
    }

    static func makeReport(from payload: [String: Any]) -> E2ETestReport {
        let passed = payload["passed"] as? Bool ?? false
        let complete = payload["complete"] as? Bool ?? false
        let progress = payload["progress"] as? String
        let rawCases = payload["cases"] as? [[String: Any]] ?? []
        let cases = rawCases.map { entry -> E2ETestCaseResult in
            E2ETestCaseResult(
                name: entry["name"] as? String ?? "unknown",
                ok: entry["ok"] as? Bool ?? false,
                detail: entry["detail"] as? String,
                durationMs: entry["durationMs"] as? Int ?? 0
            )
        }
        let formatter = ISO8601DateFormatter()
        return E2ETestReport(passed: passed, cases: cases, finishedAt: formatter.string(from: Date()), complete: complete, progress: progress)
    }

    private static func jsonString(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let encoded = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return encoded
    }

    /// Smoke test via native C bridge (no WebView). Reliable under simctl launch.
    static func runNativeSmoke(app: UnsafeMutableRawPointer) -> E2ETestReport {
        let started = Date()
        let envelope = #"{"id":"1","command":"zk.ping","payload":null}"#
        envelope.withCString { pointer in
            zero_native_app_bridge_dispatch(app, pointer, UInt(envelope.utf8.count))
        }
        zero_native_app_frame(app)

        let length = BridgeResponseBuffer.withBuffer { buffer, capacity in
            zero_native_app_take_bridge_response(app, buffer, capacity)
        }
        let durationMs = Int(Date().timeIntervalSince(started) * 1000)

        guard length > 0 else {
            return E2ETestReport(
                passed: false,
                cases: [
                    E2ETestCaseResult(
                        name: "zk.ping",
                        ok: false,
                        detail: "no bridge response",
                        durationMs: durationMs
                    ),
                ],
                finishedAt: ISO8601DateFormatter().string(from: Date())
            )
        }

        let response = BridgeResponseBuffer.withBuffer { buffer, _ in
            String(decoding: UnsafeBufferPointer(start: buffer, count: length).map { UInt8(bitPattern: $0) }, as: UTF8.self)
        }
        let ok: Bool
        if let data = response.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let result = json["result"] as? [String: Any],
           result["ok"] as? Bool == true {
            ok = true
        } else {
            ok = false
        }

        return E2ETestReport(
            passed: ok,
            cases: [
                E2ETestCaseResult(
                    name: "zk.ping",
                    ok: ok,
                    detail: response,
                    durationMs: durationMs
                ),
            ],
            finishedAt: ISO8601DateFormatter().string(from: Date())
        )
    }

    private static func pollBridgeResponse(
        app: UnsafeMutableRawPointer,
        requestId: String,
        timeoutSeconds: Double
    ) -> (response: String?, durationMs: Int) {
        precondition(Thread.isMainThread, "bridge poll must run on main thread")
        let started = Date()
        let deadline = started.addingTimeInterval(timeoutSeconds)
        var lastSeen = ""
        while Date() < deadline {
            zero_native_app_frame(app)
            let length = BridgeResponseBuffer.withBuffer { buffer, capacity in
                zero_native_app_take_bridge_response(app, buffer, capacity)
            }
            if length > 0 {
                let response = BridgeResponseBuffer.withBuffer { buffer, _ in
                    String(decoding: UnsafeBufferPointer(start: buffer, count: length).map { UInt8(bitPattern: $0) }, as: UTF8.self)
                }
                if response.contains("\"id\":\"\(requestId)\"") {
                    return (response, Int(Date().timeIntervalSince(started) * 1000))
                }
                lastSeen = response
            }
            RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
            RunLoop.main.run(mode: .common, before: Date(timeIntervalSinceNow: 0.05))
        }
        return (lastSeen.isEmpty ? nil : lastSeen, Int(Date().timeIntervalSince(started) * 1000))
    }

    private static func bridgeResultOk(_ response: String) -> Bool {
        guard let data = response.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        if json["ok"] as? Bool == true {
            return true
        }
        if let result = json["result"] as? [String: Any] {
            return result["proof"] != nil
        }
        return false
    }

    private static let phaseTimeoutSeconds: Double = 30
    private static let maxPhaseTimeoutSeconds: Double = 120

    private static func heavyPhaseTimeoutSeconds(phaseName: String) -> Double {
        let envKey = phaseName.contains("showdown") ? "IOS_E2E_SHOWDOWN_TIMEOUT" : "IOS_E2E_SHARE_TIMEOUT"
        let defaultVal = phaseName.contains("showdown") ? 120.0 : 60.0
        let args = ProcessInfo.processInfo.arguments
        for arg in args {
            if arg.hasPrefix("-\(envKey.lowercased())=") {
                let value = String(arg.dropFirst("-\(envKey.lowercased())=".count))
                if let seconds = Double(value), seconds > 0 {
                    return min(max(seconds, 1), maxPhaseTimeoutSeconds)
                }
            }
        }
        let seconds = Double(ProcessInfo.processInfo.environment[envKey] ?? String(defaultVal)) ?? defaultVal
        return min(max(seconds, 1), maxPhaseTimeoutSeconds)
    }

    private static func shuffleTimeoutSeconds() -> Double {
        let args = ProcessInfo.processInfo.arguments
        for arg in args {
            if arg.hasPrefix("-e2e_shuffle_timeout=") {
                let value = String(arg.dropFirst("-e2e_shuffle_timeout=".count))
                if let seconds = Double(value), seconds > 0 {
                    let timeout = min(max(seconds, 1), phaseTimeoutSeconds)
                    NSLog("[ios-e2e] shuffle timeout from arg %@ (%.0fs)", arg, timeout)
                    return timeout
                }
            }
        }
        if let index = args.firstIndex(of: "-e2e_shuffle_timeout"), index + 1 < args.count {
            let seconds = Double(args[index + 1]) ?? phaseTimeoutSeconds
            let timeout = min(max(seconds, 1), phaseTimeoutSeconds)
            NSLog("[ios-e2e] shuffle timeout from launch args %.0f", timeout)
            return timeout
        }
        let seconds = Double(ProcessInfo.processInfo.environment["IOS_E2E_SHUFFLE_TIMEOUT"] ?? "30") ?? phaseTimeoutSeconds
        NSLog("[ios-e2e] shuffle timeout from env %.0f", seconds)
        return min(max(seconds, 1), phaseTimeoutSeconds)
    }

    private static func registerTimeoutSeconds() -> Double {
        let args = ProcessInfo.processInfo.arguments
        for arg in args {
            if arg.hasPrefix("-e2e_register_timeout=") {
                let value = String(arg.dropFirst("-e2e_register_timeout=".count))
                if let seconds = Double(value), seconds > 0 {
                    return min(max(seconds, 1), phaseTimeoutSeconds)
                }
            }
        }
        if let index = args.firstIndex(of: "-e2e_register_timeout"), index + 1 < args.count {
            let seconds = Double(args[index + 1]) ?? phaseTimeoutSeconds
            return min(max(seconds, 1), phaseTimeoutSeconds)
        }
        let seconds = Double(ProcessInfo.processInfo.environment["IOS_E2E_REGISTER_TIMEOUT"] ?? "30") ?? phaseTimeoutSeconds
        return min(max(seconds, 1), phaseTimeoutSeconds)
    }

    private static func bridgePhaseTimeoutSeconds(for phaseName: String) -> Double {
        if phaseName.contains("shuffle") {
            return shuffleTimeoutSeconds()
        }
        if phaseName.contains("showdown") {
            return heavyPhaseTimeoutSeconds(phaseName: phaseName)
        }
        if phaseName.contains("share") {
            return heavyPhaseTimeoutSeconds(phaseName: phaseName)
        }
        return registerTimeoutSeconds()
    }

    /// Native register prove (on-device witness + Groth16; poll bridge on main).
    static func runNativeRegisterProve(app: UnsafeMutableRawPointer) -> E2ETestReport {
        let started = Date()
        var cases: [E2ETestCaseResult] = []

        guard let fixtureURL = Bundle.main.url(forResource: "register_prove_payload", withExtension: "json", subdirectory: "testdata") else {
            cases.append(E2ETestCaseResult(
                name: "native.register.fixture",
                ok: false,
                detail: "missing testdata/register_prove_payload.json in bundle",
                durationMs: 0
            ))
            writeIncrementalReport(cases: cases)
            return E2ETestReport(
                passed: false,
                cases: cases,
                finishedAt: ISO8601DateFormatter().string(from: Date())
            )
        }
        guard let payloadData = try? Data(contentsOf: fixtureURL),
              let payloadJSON = String(data: payloadData, encoding: .utf8) else {
            cases.append(E2ETestCaseResult(
                name: "native.register.fixture",
                ok: false,
                detail: "failed to read register prove fixture",
                durationMs: 0
            ))
            writeIncrementalReport(cases: cases)
            return E2ETestReport(
                passed: false,
                cases: cases,
                finishedAt: ISO8601DateFormatter().string(from: Date())
            )
        }
        let envelope = "{\"id\":\"3\",\"command\":\"zk.prove\",\"payload\":\(payloadJSON)}"
        NSLog("[ios-e2e] native register prove dispatch (on-device witness, %d bytes)", envelope.utf8.count)
        envelope.withCString { pointer in
            zero_native_app_bridge_dispatch(app, pointer, UInt(envelope.utf8.count))
        }
        zero_native_app_frame(app)

        let timeout = registerTimeoutSeconds()
        let polled = pollBridgeResponse(app: app, requestId: "3", timeoutSeconds: timeout)
        let durationMs = Int(Date().timeIntervalSince(started) * 1000)
        guard let response = polled.response else {
            cases.append(E2ETestCaseResult(
                name: "native.register.prove",
                ok: false,
                detail: "timed out after \(Int(timeout))s waiting for zk.prove response",
                durationMs: durationMs
            ))
            writeIncrementalReport(cases: cases)
            return E2ETestReport(
                passed: false,
                cases: cases,
                finishedAt: ISO8601DateFormatter().string(from: Date())
            )
        }
        let ok = bridgeResultOk(response)
        cases.append(E2ETestCaseResult(
            name: "native.register.prove",
            ok: ok,
            detail: String(response.prefix(512)),
            durationMs: durationMs
        ))
        writeIncrementalReport(cases: cases)
        return E2ETestReport(
            passed: cases.allSatisfy(\.ok),
            cases: cases,
            finishedAt: ISO8601DateFormatter().string(from: Date())
        )
    }

    /// Native shuffle prove (on-device witness + Groth16; poll bridge on main).
    static func runNativeShuffleProve(app: UnsafeMutableRawPointer) -> E2ETestReport {
        let started = Date()
        var cases: [E2ETestCaseResult] = []

        guard let fixtureURL = Bundle.main.url(forResource: "shuffle_prove_payload", withExtension: "json", subdirectory: "testdata") else {
            cases.append(E2ETestCaseResult(
                name: "native.shuffle.fixture",
                ok: false,
                detail: "missing testdata/shuffle_prove_payload.json in bundle",
                durationMs: 0
            ))
            writeIncrementalReport(cases: cases)
            return E2ETestReport(
                passed: false,
                cases: cases,
                finishedAt: ISO8601DateFormatter().string(from: Date())
            )
        }
        guard let payloadData = try? Data(contentsOf: fixtureURL),
              let payloadObj = try? JSONSerialization.jsonObject(with: payloadData),
              let payloadJSON = String(data: payloadData, encoding: .utf8) else {
            cases.append(E2ETestCaseResult(
                name: "native.shuffle.fixture",
                ok: false,
                detail: "failed to read shuffle prove fixture",
                durationMs: 0
            ))
            writeIncrementalReport(cases: cases)
            return E2ETestReport(
                passed: false,
                cases: cases,
                finishedAt: ISO8601DateFormatter().string(from: Date())
            )
        }
        _ = payloadObj
        let envelope = "{\"id\":\"2\",\"command\":\"zk.prove\",\"payload\":\(payloadJSON)}"
        NSLog("[ios-e2e] native shuffle prove dispatch (on-device witness, %d bytes)", envelope.utf8.count)
        envelope.withCString { pointer in
            zero_native_app_bridge_dispatch(app, pointer, UInt(envelope.utf8.count))
        }
        zero_native_app_frame(app)

        let timeout = shuffleTimeoutSeconds()
        let polled = pollBridgeResponse(app: app, requestId: "2", timeoutSeconds: timeout)
        let durationMs = Int(Date().timeIntervalSince(started) * 1000)
        guard let response = polled.response else {
            cases.append(E2ETestCaseResult(
                name: "native.shuffle.prove",
                ok: false,
                detail: "timed out after \(Int(timeout))s waiting for zk.prove response",
                durationMs: durationMs
            ))
            writeIncrementalReport(cases: cases)
            return E2ETestReport(
                passed: false,
                cases: cases,
                finishedAt: ISO8601DateFormatter().string(from: Date())
            )
        }
        let ok = bridgeResultOk(response)
        cases.append(E2ETestCaseResult(
            name: "native.shuffle.prove",
            ok: ok,
            detail: String(response.prefix(512)),
            durationMs: durationMs
        ))
        writeIncrementalReport(cases: cases)
        return E2ETestReport(
            passed: cases.allSatisfy(\.ok),
            cases: cases,
            finishedAt: ISO8601DateFormatter().string(from: Date())
        )
    }

    /// Native register prove then shuffle prove, back-to-back in one app launch.
    /// Catches inter-prove state corruption (the class of bug that caused the SIGABRT).
    static func runNativeRegisterThenShuffle(app: UnsafeMutableRawPointer) -> E2ETestReport {
        var cases: [E2ETestCaseResult] = []
        let started = Date()

        guard let registerFixture = Bundle.main.url(forResource: "register_prove_payload", withExtension: "json", subdirectory: "testdata"),
              let shuffleFixture = Bundle.main.url(forResource: "shuffle_prove_payload", withExtension: "json", subdirectory: "testdata"),
              let registerData = try? Data(contentsOf: registerFixture),
              let shuffleData = try? Data(contentsOf: shuffleFixture),
              let registerPayload = String(data: registerData, encoding: .utf8),
              let shufflePayload = String(data: shuffleData, encoding: .utf8),
              !registerPayload.isEmpty, !shufflePayload.isEmpty else {
            cases.append(E2ETestCaseResult(name: "native.register_then_shuffle.fixture", ok: false, detail: "missing register/shuffle prove fixtures", durationMs: 0))
            writeIncrementalReport(cases: cases)
            return E2ETestReport(passed: false, cases: cases, finishedAt: ISO8601DateFormatter().string(from: Date()))
        }

        // Register prove (id "3")
        let registerEnvelope = "{\"id\":\"3\",\"command\":\"zk.prove\",\"payload\":\(registerPayload)}"
        NSLog("[ios-e2e] register_then_shuffle: register dispatch (%d bytes)", registerEnvelope.utf8.count)
        registerEnvelope.withCString { pointer in
            zero_native_app_bridge_dispatch(app, pointer, UInt(registerEnvelope.utf8.count))
        }
        zero_native_app_frame(app)

        let registerTimeout = registerTimeoutSeconds()
        let registerPolled = pollBridgeResponse(app: app, requestId: "3", timeoutSeconds: registerTimeout)
        let registerMs = Int(Date().timeIntervalSince(started) * 1000)
        guard let registerResponse = registerPolled.response, bridgeResultOk(registerResponse) else {
            let detail = registerPolled.response ?? "timed out after \(Int(registerTimeout))s"
            cases.append(E2ETestCaseResult(name: "native.register_then_shuffle.register", ok: false, detail: String(detail.prefix(512)), durationMs: registerMs))
            writeIncrementalReport(cases: cases)
            return E2ETestReport(passed: false, cases: cases, finishedAt: ISO8601DateFormatter().string(from: Date()))
        }
        cases.append(E2ETestCaseResult(name: "native.register_then_shuffle.register", ok: true, detail: nil, durationMs: registerMs))
        writeIncrementalReport(cases: cases)

        // Shuffle prove (id "2") — runs after register, exercising inter-prove state.
        let shuffleEnvelope = "{\"id\":\"2\",\"command\":\"zk.prove\",\"payload\":\(shufflePayload)}"
        NSLog("[ios-e2e] register_then_shuffle: shuffle dispatch (%d bytes)", shuffleEnvelope.utf8.count)
        shuffleEnvelope.withCString { pointer in
            zero_native_app_bridge_dispatch(app, pointer, UInt(shuffleEnvelope.utf8.count))
        }
        zero_native_app_frame(app)

        let shuffleTimeout = shuffleTimeoutSeconds()
        let shufflePolled = pollBridgeResponse(app: app, requestId: "2", timeoutSeconds: shuffleTimeout)
        let totalMs = Int(Date().timeIntervalSince(started) * 1000)
        let shuffleOk: Bool
        let shuffleDetail: String
        if let shuffleResponse = shufflePolled.response {
            shuffleOk = bridgeResultOk(shuffleResponse)
            shuffleDetail = String(shuffleResponse.prefix(512))
        } else {
            shuffleOk = false
            shuffleDetail = "timed out after \(Int(shuffleTimeout))s"
        }
        cases.append(E2ETestCaseResult(name: "native.register_then_shuffle.shuffle", ok: shuffleOk, detail: shuffleDetail, durationMs: totalMs))
        writeIncrementalReport(cases: cases)
        return E2ETestReport(
            passed: cases.allSatisfy(\.ok),
            cases: cases,
            finishedAt: ISO8601DateFormatter().string(from: Date())
        )
    }

    /// Generic bridge-chain phase prove: loads testdata/bridge-chain/{name}_payload.json.
    static func runNativeBridgePhase(app: UnsafeMutableRawPointer, phaseName: String) -> E2ETestReport {
        let started = Date()
        var cases: [E2ETestCaseResult] = []
        let fixtureName = "\(phaseName)_payload"
        guard let fixtureURL = Bundle.main.url(
            forResource: fixtureName,
            withExtension: "json",
            subdirectory: "testdata/bridge-chain"
        ) else {
            cases.append(E2ETestCaseResult(
                name: "bridge.phase.\(phaseName).fixture",
                ok: false,
                detail: "missing testdata/bridge-chain/\(fixtureName).json",
                durationMs: 0
            ))
            writeIncrementalReport(cases: cases)
            return E2ETestReport(passed: false, cases: cases, finishedAt: ISO8601DateFormatter().string(from: Date()))
        }
        guard let payloadData = try? Data(contentsOf: fixtureURL),
              let payloadJSON = String(data: payloadData, encoding: .utf8),
              !payloadJSON.isEmpty else {
            cases.append(E2ETestCaseResult(
                name: "bridge.phase.\(phaseName).fixture",
                ok: false,
                detail: "failed to read \(fixtureName).json",
                durationMs: 0
            ))
            writeIncrementalReport(cases: cases)
            return E2ETestReport(passed: false, cases: cases, finishedAt: ISO8601DateFormatter().string(from: Date()))
        }

        let requestId = "bc-\(phaseName)"
        let envelope = "{\"id\":\"\(requestId)\",\"command\":\"zk.prove\",\"payload\":\(payloadJSON)}"
        NSLog("[ios-e2e] bridge phase %@ dispatch (%d bytes)", phaseName, envelope.utf8.count)
        envelope.withCString { pointer in
            zero_native_app_bridge_dispatch(app, pointer, UInt(envelope.utf8.count))
        }
        zero_native_app_frame(app)

        let timeout = bridgePhaseTimeoutSeconds(for: phaseName)
        let polled = pollBridgeResponse(app: app, requestId: requestId, timeoutSeconds: timeout)
        let durationMs = Int(Date().timeIntervalSince(started) * 1000)
        guard let response = polled.response, bridgeResultOk(response) else {
            let detail = polled.response ?? "timed out after \(Int(timeout))s"
            cases.append(E2ETestCaseResult(
                name: "bridge.phase.\(phaseName).prove",
                ok: false,
                detail: String(detail.prefix(512)),
                durationMs: durationMs
            ))
            writeIncrementalReport(cases: cases)
            return E2ETestReport(passed: false, cases: cases, finishedAt: ISO8601DateFormatter().string(from: Date()))
        }

        cases.append(E2ETestCaseResult(
            name: "bridge.phase.\(phaseName).prove",
            ok: true,
            detail: String(response.prefix(256)),
            durationMs: durationMs
        ))
        writeBridgePhaseArtifact(phaseName: phaseName, bridgeResponse: response)
        writeIncrementalReport(cases: cases)
        return E2ETestReport(
            passed: true,
            cases: cases,
            finishedAt: ISO8601DateFormatter().string(from: Date())
        )
    }

    private static func writeBridgePhaseArtifact(phaseName: String, bridgeResponse: String) {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return
        }
        let url = documents.appendingPathComponent("bridge-phase-artifact.json")
        var artifact: [String: Any] = [
            "phaseName": phaseName,
            "bridgeResponse": bridgeResponse,
            "at": ISO8601DateFormatter().string(from: Date()),
        ]
        if let data = bridgeResponse.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let result = json["result"] as? [String: Any] {
            // zk_bridge returns proofJson / publicSignalsJson (stringified); older paths used objects.
            if let proof = result["proof"] {
                artifact["proof"] = proof
            } else if let proofJson = result["proofJson"] as? String,
                      let proofData = proofJson.data(using: .utf8),
                      let proofObj = try? JSONSerialization.jsonObject(with: proofData) {
                artifact["proof"] = proofObj
            } else {
                artifact["proof"] = NSNull()
            }
            if let signals = result["publicSignals"] {
                artifact["publicSignals"] = signals
            } else if let signalsJson = result["publicSignalsJson"] as? String,
                      let signalsData = signalsJson.data(using: .utf8),
                      let signalsObj = try? JSONSerialization.jsonObject(with: signalsData) {
                artifact["publicSignals"] = signalsObj
            } else {
                artifact["publicSignals"] = NSNull()
            }
            if let payload = json["payload"] as? [String: Any],
               let circuitName = payload["circuitName"] as? String {
                artifact["circuitName"] = circuitName
            }
        }
        if let out = try? JSONSerialization.data(withJSONObject: artifact, options: [.prettyPrinted]) {
            try? out.write(to: url, options: .atomic)
        }
    }
}
