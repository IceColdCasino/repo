import Foundation
import WebKit

final class ZeroNativeAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private let rootPath: String
    private let entryPath: String
    private let spaFallback: Bool

    init(rootPath: String, entryPath: String, spaFallback: Bool = true) {
        self.rootPath = Self.resolvedAssetRoot(rootPath)
        self.entryPath = entryPath
        self.spaFallback = spaFallback
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(NSError(domain: "ZeroNativeAssetScheme", code: 1))
            return
        }
        guard let relative = Self.safeAssetPath(for: url, entryPath: entryPath) else {
            urlSchemeTask.didFailWithError(NSError(domain: "ZeroNativeAssetScheme", code: 2))
            return
        }

        var fileURL = URL(fileURLWithPath: rootPath).appendingPathComponent(relative)
        var isDirectory: ObjCBool = false
        if !FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory) || isDirectory.boolValue {
            if spaFallback {
                fileURL = URL(fileURLWithPath: rootPath).appendingPathComponent(entryPath)
            } else {
                NSLog("[ZeroNativeAssetScheme] missing asset %@ -> %@", url.absoluteString, fileURL.path)
                urlSchemeTask.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
                return
            }
        }

        do {
            var data = try Data(contentsOf: fileURL)
            if fileURL.pathExtension.lowercased() == "html" || fileURL.pathExtension.lowercased() == "htm" {
                data = Self.injectBaseHref(into: data)
            }
            let mime = Self.mimeType(for: fileURL.pathExtension)
            let headers: [String: String] = [
                "Content-Type": mime,
                "Content-Length": String(data.count),
                "Access-Control-Allow-Origin": "*",
            ]
            let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            ) ?? URLResponse(
                url: url,
                mimeType: mime,
                expectedContentLength: data.count,
                textEncodingName: mime.hasPrefix("text/") ? "utf-8" : nil
            )
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            NSLog("[ZeroNativeAssetScheme] failed %@ -> %@ (%@)", url.absoluteString, fileURL.path, error.localizedDescription)
            urlSchemeTask.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private static func resolvedAssetRoot(_ rootPath: String) -> String {
        if rootPath.isEmpty || rootPath == "." {
            return Bundle.main.resourcePath ?? rootPath
        }
        if rootPath.hasPrefix("/") {
            return rootPath
        }
        if let resourcePath = Bundle.main.resourcePath {
            let resourceRoot = (resourcePath as NSString).appendingPathComponent(rootPath)
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: resourceRoot, isDirectory: &isDirectory), isDirectory.boolValue {
                return resourceRoot
            }
        }
        return rootPath
    }

    private static func safeAssetPath(for url: URL, entryPath: String) -> String? {
        var path = url.path.removingPercentEncoding ?? url.path
        if path.isEmpty || path == "/" {
            return entryPath
        }
        while path.hasPrefix("/") {
            path.removeFirst()
        }
        if path.isEmpty {
            return entryPath
        }
        for segment in path.split(separator: "/") {
            if segment == "." || segment == ".." || segment.contains("\\") {
                return nil
            }
        }
        return path
    }

    private static func injectBaseHref(into data: Data) -> Data {
        guard var html = String(data: data, encoding: .utf8), !html.contains("<base ") else {
            return data
        }
        html = html.replacingOccurrences(of: "<head>", with: "<head><base href=\"zero://app/\">")
        return html.data(using: .utf8) ?? data
    }

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "wasm": return "application/wasm"
        default: return "application/octet-stream"
        }
    }
}
