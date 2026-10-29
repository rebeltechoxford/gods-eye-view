import Foundation
import Network

/// Read-only loopback hosting for the complete bundled GEV build. No upstream
/// proxy, credentials, filesystem writes, or TAK transport is exposed here.
final class BundledAppServer {
    static let port: UInt16 = 41973
    static let origin = URL(string: "http://127.0.0.1:41973")!
    private let queue = DispatchQueue(label: "uk.rebeltechoxford.gevtak.bundle")
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private let root: URL

    init(root: URL) { self.root = root.resolvingSymlinksInPath().standardizedFileURL }

    func start(completion: @escaping (Error?) -> Void) throws {
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path) else {
            throw CocoaError(.fileNoSuchFile)
        }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        var answered = false
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                if !answered { answered = true; DispatchQueue.main.async { completion(nil) } }
            case .failed(let error):
                if !answered { answered = true; DispatchQueue.main.async { completion(error) } }
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self, self.connections.count < 64 else { connection.cancel(); return }
            let id = UUID()
            self.connections[id] = connection
            connection.start(queue: self.queue)
            self.queue.asyncAfter(deadline: .now() + 15) { self.close(id) }
            self.receive(id, buffer: Data())
        }
        listener.start(queue: queue)
    }

    private func close(_ id: UUID) { connections.removeValue(forKey: id)?.cancel() }

    private func receive(_ id: UUID, buffer: Data) {
        guard let connection = connections[id] else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] bytes, _, done, error in
            guard let self else { return }
            var buffer = buffer
            if let bytes { buffer.append(bytes) }
            guard buffer.count <= 16384 else { self.close(id); return }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)),
               let header = String(data: buffer[..<end.lowerBound], encoding: .utf8) {
                self.respond(id, header: header)
            } else if done || error != nil { self.close(id) }
            else { self.receive(id, buffer: buffer) }
        }
    }

    private func respond(_ id: UUID, header: String) {
        let lines = header.components(separatedBy: "\r\n")
        let request = (lines.first ?? "").split(separator: " ")
        let host = lines.dropFirst().first { $0.lowercased().hasPrefix("host:") }?
            .dropFirst(5).trimmingCharacters(in: .whitespaces).lowercased()
        guard request.count == 3, ["GET", "HEAD"].contains(String(request[0])),
              host == "127.0.0.1:\(Self.port)", request[1].hasPrefix("/"),
              !request[1].hasPrefix("//"),
              let parts = URLComponents(string: String(request[1])) else {
            send(id, code: 400, body: Data()); return
        }
        let path = parts.path
        if path == "/api/tak/status" {
            send(id, code: 200, body: Data("{\"enabled\":false,\"multiOperator\":false}".utf8), type: "application/json", head: request[0] == "HEAD")
            return
        }
        if path.hasPrefix("/api/") {
            send(id, code: 404, body: Data("{\"error\":\"This service requires a connected gateway\"}".utf8), type: "application/json")
            return
        }
        let relative = path == "/" || path.hasPrefix("/share/") ? "index.html" : String(path.dropFirst())
        let file = root.appendingPathComponent(relative).resolvingSymlinksInPath().standardizedFileURL
        guard !path.contains("\0"), file.path.hasPrefix(root.path + "/"),
              let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= 128 * 1024 * 1024, let body = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            send(id, code: 404, body: Data()); return
        }
        let types = ["html":"text/html", "js":"text/javascript", "mjs":"text/javascript",
                     "css":"text/css", "json":"application/json", "webmanifest":"application/manifest+json",
                     "wasm":"application/wasm", "svg":"image/svg+xml", "png":"image/png",
                     "jpg":"image/jpeg", "jpeg":"image/jpeg", "webp":"image/webp",
                     "woff2":"font/woff2", "woff":"font/woff", "glb":"model/gltf-binary"]
        send(id, code: 200, body: body, type: types[file.pathExtension] ?? "application/octet-stream", head: request[0] == "HEAD")
    }

    private func send(_ id: UUID, code: Int, body: Data, type: String = "text/plain", head: Bool = false) {
        guard let connection = connections[id] else { return }
        var data = Data("HTTP/1.1 \(code) \(code == 200 ? "OK" : "Unavailable")\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\n\r\n".utf8)
        if !head { data.append(body) }
        connection.send(content: data, completion: .contentProcessed { [weak self] _ in self?.close(id) })
    }
}
