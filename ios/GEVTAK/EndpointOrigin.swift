import Foundation

/// A configured origin, never a login URL, credential, public IP or file path.
struct EndpointOrigin: Equatable {
    enum Invalid: Error, CustomStringConvertible {
        case origin
        var description: String {
            "Enter an HTTPS origin only, using your approved internal DNS name or private IPv4 address. Do not include a path, query, password or token."
        }
    }

    let host: String
    let port: Int

    init(_ input: String) throws {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count <= 2048,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let parts = URLComponents(string: text),
              parts.scheme?.lowercased() == "https",
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/",
              let hostname = parts.host?.lowercased(),
              !hostname.isEmpty, hostname.count <= 253,
              hostname.unicodeScalars.allSatisfy({ $0.isASCII }),
              !hostname.contains(":"), !hostname.hasSuffix("."),
              (1...65535).contains(parts.port ?? 443)
        else { throw Invalid.origin }
        let effectivePort = parts.port ?? 443

        let labels = hostname.split(separator: ".", omittingEmptySubsequences: false)
        if labels.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) {
            guard labels.count == 4,
                  labels.allSatisfy({ Int($0).map { (0...255).contains($0) } == true }),
                  labels.allSatisfy({ $0.count == 1 || !$0.hasPrefix("0") })
            else { throw Invalid.origin }
            let octets = labels.map { Int($0)! }
            guard octets[0] == 10 || octets[0] == 127 ||
                    (octets[0] == 172 && (16...31).contains(octets[1])) ||
                    (octets[0] == 192 && octets[1] == 168)
            else { throw Invalid.origin }
        } else {
            guard labels.allSatisfy({
                $0.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", options: .regularExpression) != nil
            }), !labels.allSatisfy({ label in
                label.allSatisfy(\.isNumber) || label.range(of: "^0x[0-9a-f]+$", options: .regularExpression) != nil
            })
            else { throw Invalid.origin }
        }
        host = hostname
        port = effectivePort
    }

    var string: String { "https://\(host)\(port == 443 ? "" : ":\(port)")" }
    var url: URL { URL(string: string)! }
    var loginURL: URL { url.appendingPathComponent("login") }

    func contains(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" &&
        url.user == nil && url.password == nil &&
        url.host?.lowercased() == host && (url.port ?? 443) == port
    }

    func contains(protocol scheme: String, host hostname: String, port candidate: Int) -> Bool {
        scheme.lowercased() == "https" && hostname.lowercased() == host &&
        (candidate == 0 ? 443 : candidate) == port
    }

    func permitsDownload(_ url: URL) -> Bool {
        if contains(url) { return true }
        guard url.scheme?.lowercased() == "blob",
              let embedded = URL(string: String(url.absoluteString.dropFirst(5)))
        else { return false }
        return contains(embedded)
    }

    static func isExternalHTTPS(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host != nil &&
        url.user == nil && url.password == nil && url.absoluteString.count <= 4096
    }
}

enum ExportPolicy {
    static let maximumBytes: Int64 = 256 * 1024 * 1024

    static func accepts(length: Int64) -> Bool { (0...maximumBytes).contains(length) }

    static func filename(_ suggestion: String) -> String {
        let leaf = suggestion.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? ""
        let scalars = leaf.unicodeScalars.filter {
            !CharacterSet.controlCharacters.contains($0) && $0 != ":"
        }.prefix(120)
        let clean = String(String.UnicodeScalarView(scalars)).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        return clean.isEmpty ? "export.gevmap" : clean
    }
}
