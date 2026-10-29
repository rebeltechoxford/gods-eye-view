import Foundation

@main
struct BundledAppServerTests {
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("<html>GEV local fixture</html>".utf8).write(to: root.appendingPathComponent("index.html"))
        try Data([0, 97, 115, 109]).write(to: root.appendingPathComponent("module.wasm"))
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("outside bundle".utf8).write(to: outside)
        defer { try? FileManager.default.removeItem(at: outside) }
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape.txt"), withDestinationURL: outside)
        let server = BundledAppServer(root: root)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            do {
                try server.start { error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume() }
                }
            } catch { continuation.resume(throwing: error) }
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        func request(_ path: String, method: String = "GET") async throws -> (Data, HTTPURLResponse) {
            var req = URLRequest(url: URL(string: path, relativeTo: BundledAppServer.origin)!)
            req.httpMethod = method
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { fatalError("Expected HTTP") }
            return (data, http)
        }
        for path in ["/", "/index.html?lang=en", "/share/test"] {
            let (data, response) = try await request(path)
            precondition(response.statusCode == 200 && String(data: data, encoding: .utf8)?.contains("GEV local fixture") == true)
        }
        let (wasm, response) = try await request("/module.wasm")
        precondition(wasm == Data([0, 97, 115, 109]))
        precondition(response.mimeType == "application/wasm")
        let (head, headResponse) = try await request("/module.wasm", method: "HEAD")
        precondition(head.isEmpty && headResponse.value(forHTTPHeaderField: "Content-Length") == "4")
        for path in ["/missing", "/escape.txt", "/api/unknown"] {
            let (_, response) = try await request(path)
            precondition(response.statusCode == 404)
        }
        let (_, rejected) = try await request("/", method: "POST")
        precondition(rejected.statusCode == 400)
        let (status, statusResponse) = try await request("/api/tak/status")
        let parsed = try JSONSerialization.jsonObject(with: status) as! [String: Any]
        precondition(statusResponse.statusCode == 200 && parsed["enabled"] as? Bool == false)
        precondition(parsed["multiOperator"] as? Bool == false)
        withExtendedLifetime(server) {}
        print("PASS: bundled HTTP assets, share fallback, HEAD, MIME, traversal boundary and standalone status")
    }
}
