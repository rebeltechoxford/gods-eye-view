import Foundation

@main
enum EndpointOriginTests {
    static func main() throws {
        let origin = try EndpointOrigin(" https://GEV.internal:8443/ ")
        precondition(origin.string == "https://gev.internal:8443")
        precondition(origin.loginURL.absoluteString == "https://gev.internal:8443/login")
        precondition(origin.contains(URL(string: "https://gev.internal:8443/api/tak/status")!))
        precondition(!origin.contains(URL(string: "https://gev.internal/api/tak/status")!))
        precondition(!origin.contains(URL(string: "https://gev.internal.evil.test:8443/")!))
        precondition(!origin.contains(URL(string: "http://gev.internal:8443/")!))
        precondition(!origin.contains(URL(string: "https://user@gev.internal:8443/")!))
        precondition(origin.contains(protocol: "https", host: "gev.internal", port: 8443))
        precondition(!origin.contains(protocol: "https", host: "gev.internal", port: 443))
        let defaultPort = try EndpointOrigin("https://gev.internal:443")
        precondition(defaultPort.string == "https://gev.internal")
        for value in ["https://10.1.2.3", "https://172.16.0.1:8443", "https://192.168.1.4", "https://127.0.0.1:8443", "https://localhost:8443", "https://approved.example.org:8443"] {
            _ = try EndpointOrigin(value)
        }
        for value in ["http://gev.internal", "https://gev.internal/login", "https://gev.internal/?token=secret", "https://user:secret@gev.internal", "https://gev.internal/#private", "https://8.8.8.8", "https://169.254.1.2", "https://100.64.1.2", "https://127.1", "https://0127.0.0.1", "https://0x7f000001", "https://0x8.0x8.0x8.0x8", "https://127.0.0x0.1", "https://gev..internal", "https://-gev.internal", "https://gev.internal:0", "https://gev.internal:65536", "file:///private", "javascript:alert(1)"] {
            do { _ = try EndpointOrigin(value); preconditionFailure("Invalid endpoint accepted") }
            catch is EndpointOrigin.Invalid { }
        }
        precondition(EndpointOrigin.isExternalHTTPS(URL(string: "https://example.invalid/page?q=public")!))
        precondition(!EndpointOrigin.isExternalHTTPS(URL(string: "http://example.invalid")!))
        precondition(!EndpointOrigin.isExternalHTTPS(URL(string: "https://user:secret@example.invalid")!))
        precondition(!EndpointOrigin.isExternalHTTPS(URL(string: "tel:123")!))
        precondition(origin.permitsDownload(URL(string: "blob:https://gev.internal:8443/2D52EF2B")!))
        precondition(origin.permitsDownload(URL(string: "https://gev.internal:8443/map-pack.gevmap")!))
        for value in ["blob:https://gev.internal/2D52EF2B", "blob:https://foreign.internal:8443/2D52EF2B", "blob:null/2D52EF2B", "data:application/octet-stream,private", "file:///tmp/private", "https://gev.internal.evil.test:8443/map.gevmap"] {
            precondition(!origin.permitsDownload(URL(string: value)!))
        }
        precondition(ExportPolicy.filename("../../map.gevmap") == "map.gevmap")
        precondition(ExportPolicy.filename("C:\\secret\\map.gevmap") == "map.gevmap")
        precondition(ExportPolicy.filename(".\n.:") == "export.gevmap")
        precondition(ExportPolicy.filename(".secret.gevmap") == "secret.gevmap")
        precondition(ExportPolicy.filename(String(repeating: "a", count: 300)).count == 120)
        precondition(ExportPolicy.accepts(length: 0))
        precondition(ExportPolicy.accepts(length: ExportPolicy.maximumBytes))
        precondition(!ExportPolicy.accepts(length: -1))
        precondition(!ExportPolicy.accepts(length: ExportPolicy.maximumBytes + 1))
        print("PASS: canonical origin, private IP, malformed endpoint, navigation, external links and bounded export policy")
    }
}
