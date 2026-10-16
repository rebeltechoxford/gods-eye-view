import UIKit
import WebKit

@MainActor
final class ConsoleViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, UIDocumentPickerDelegate {
    private static let endpointKey = "approvedConsoleOrigin"
    private var endpoint: EndpointOrigin?
    private var webView: WKWebView?
    private var entryPanel: UIStackView!
    private var entryContainer: UIScrollView!
    private var endpointField: UITextField!
    private var clearingWebsite = false
    private var backItem: UIBarButtonItem!
    private var downloadPending = false
    private var mainNavigationMayDownload = false
    private var activeDownload: WKDownload?
    private var exportFile: URL?
    private var downloadTimer: Timer?
    private let exportRoot = FileManager.default.temporaryDirectory.appendingPathComponent("GEVTAKExports", isDirectory: true)

    override func viewDidLoad() {
        super.viewDidLoad()
        // A terminated app may leave an unfinished export. Never resume it.
        removeTemporaryExports()
        title = "GEV TAK"
        view.backgroundColor = .systemBackground
        backItem = UIBarButtonItem(image: UIImage(systemName: "chevron.backward"), style: .plain, target: self, action: #selector(goBack))
        backItem.accessibilityLabel = "Back in console"
        navigationItem.leftBarButtonItem = backItem
        let settings = UIBarButtonItem(image: UIImage(systemName: "server.rack"), style: .plain, target: self, action: #selector(changeServer))
        settings.accessibilityLabel = "Private server settings"
        let reload = UIBarButtonItem(barButtonSystemItem: .refresh, target: self, action: #selector(reloadConsole))
        reload.accessibilityLabel = "Reload private console"
        navigationItem.rightBarButtonItems = [settings, reload]
        buildEntryPanel()
        if let saved = UserDefaults.standard.string(forKey: Self.endpointKey),
           let origin = try? EndpointOrigin(saved) {
            open(origin)
        } else {
            showEntry()
        }
    }

    private func buildEntryPanel() {
        let heading = UILabel()
        heading.text = "Connect to your private console"
        heading.font = .preferredFont(forTextStyle: .title2)
        heading.numberOfLines = 0
        let explanation = UILabel()
        explanation.text = "Enter the approved HTTPS origin supplied by your administrator. Your operator token stays in the website login. A trusted server certificate and reachable private network are required."
        explanation.font = .preferredFont(forTextStyle: .body)
        explanation.numberOfLines = 0
        endpointField = UITextField()
        endpointField.placeholder = "https://gev.internal:8443"
        endpointField.accessibilityLabel = "Approved private HTTPS origin"
        endpointField.accessibilityIdentifier = "serverEndpoint"
        endpointField.borderStyle = .roundedRect
        endpointField.keyboardType = .URL
        endpointField.autocorrectionType = .no
        endpointField.autocapitalizationType = .none
        endpointField.textContentType = .URL
        endpointField.font = .preferredFont(forTextStyle: .body)
        let connect = UIButton(type: .system)
        connect.setTitle("Open private console", for: .normal)
        connect.accessibilityIdentifier = "openPrivateConsole"
        connect.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        connect.addTarget(self, action: #selector(saveEndpoint), for: .touchUpInside)
        connect.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        endpointField.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        let limit = UILabel()
        limit.text = "Keep the app visible for device GPS. Offline maps and reliable background TAK connections are not provided by this package."
        limit.numberOfLines = 0
        limit.font = .preferredFont(forTextStyle: .footnote)
        limit.textColor = .secondaryLabel
        entryPanel = UIStackView(arrangedSubviews: [heading, explanation, endpointField, connect, limit])
        entryPanel.axis = .vertical
        entryPanel.spacing = 18
        entryPanel.translatesAutoresizingMaskIntoConstraints = false
        entryContainer = UIScrollView()
        entryContainer.translatesAutoresizingMaskIntoConstraints = false
        entryContainer.keyboardDismissMode = .interactive
        entryContainer.addSubview(entryPanel)
        view.addSubview(entryContainer)
        NSLayoutConstraint.activate([
            entryContainer.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            entryContainer.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            entryContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            entryContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            entryPanel.leadingAnchor.constraint(equalTo: entryContainer.contentLayoutGuide.leadingAnchor, constant: 24),
            entryPanel.trailingAnchor.constraint(equalTo: entryContainer.contentLayoutGuide.trailingAnchor, constant: -24),
            entryPanel.topAnchor.constraint(equalTo: entryContainer.contentLayoutGuide.topAnchor, constant: 24),
            entryPanel.bottomAnchor.constraint(equalTo: entryContainer.contentLayoutGuide.bottomAnchor, constant: -24),
            entryPanel.widthAnchor.constraint(equalTo: entryContainer.frameLayoutGuide.widthAnchor, constant: -48),
        ])
    }

    private func showEntry() {
        entryContainer.isHidden = false
        backItem.isEnabled = false
        endpointField.text = nil
    }

    @objc private func saveEndpoint() {
        do {
            let origin = try EndpointOrigin(endpointField.text ?? "")
            UserDefaults.standard.set(origin.string, forKey: Self.endpointKey)
            view.endEditing(true)
            open(origin)
        } catch { showMessage("Check the server address", String(describing: error)) }
    }

    private func open(_ origin: EndpointOrigin) {
        endpoint = origin
        entryContainer.isHidden = true
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let console = WKWebView(frame: .zero, configuration: configuration)
        if #available(iOS 16.4, *) { console.isInspectable = false }
        console.navigationDelegate = self
        console.uiDelegate = self
        console.allowsBackForwardNavigationGestures = true
        console.translatesAutoresizingMaskIntoConstraints = false
        console.accessibilityIdentifier = "privateConsole"
        webView = console
        view.insertSubview(console, belowSubview: entryContainer)
        NSLayoutConstraint.activate([
            console.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            console.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            console.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            console.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        // The server redirects unauthenticated root requests to /login. A valid
        // cookie resumes the console without forcing another login form.
        console.load(URLRequest(url: origin.url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    @objc private func goBack() { if webView?.canGoBack == true { webView?.goBack() } }
    @objc private func reloadConsole() { webView?.reloadFromOrigin() }

    @objc private func changeServer() {
        guard endpoint != nil, !clearingWebsite else { return }
        let alert = UIAlertController(title: "Change private server?", message: "First use TAK → NETWORK → Sign out to revoke your server session. Continue clears this device's WebKit cookies and website data. It does not confirm server-side sign-out.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Clear this device", style: .destructive) { [weak self] _ in self?.clearDevice() })
        present(alert, animated: true)
    }

    private func clearDevice() {
        clearingWebsite = true
        cancelExport()
        webView?.stopLoading()
        // Replace the document to retire its sockets and capture requests.
        webView?.loadHTMLString("<!doctype html><title>Session cleared</title>", baseURL: nil)
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView?.removeFromSuperview()
        webView = nil
        endpoint = nil
        UserDefaults.standard.removeObject(forKey: Self.endpointKey)
        WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { [weak self] in
            Task { @MainActor in
                self?.clearingWebsite = false
                self?.showEntry()
            }
        }
    }

    private func showMessage(_ title: String, _ message: String) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    private func offerExternal(_ url: URL) {
        guard EndpointOrigin.isExternalHTTPS(url), presentedViewController == nil else { return }
        let alert = UIAlertController(title: "Open another site?", message: "This opens another app and sends it the following URL and any attached information:\n\n\(url.absoluteString)", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Open", style: .default) { _ in UIApplication.shared.open(url) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if clearingWebsite && url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if navigationAction.shouldPerformDownload || url.scheme?.lowercased() == "blob" {
            guard mayPresent(for: webView, frame: navigationAction.sourceFrame),
                  endpoint?.permitsDownload(url) == true, canBeginExport
            else { decisionHandler(.cancel); return }
            downloadPending = true
            decisionHandler(.download)
            return
        }
        if navigationAction.targetFrame?.isMainFrame == false {
            // Preserve GEV's public embedded media; no native capabilities are
            // granted to these frames by the media delegate below.
            decisionHandler(["https", "about", "blob", "data"].contains(url.scheme?.lowercased() ?? "") ? .allow : .cancel)
            return
        }
        guard endpoint?.contains(url) == true else {
            decisionHandler(.cancel)
            offerExternal(url)
            return
        }
        if navigationAction.targetFrame == nil {
            decisionHandler(.cancel)
            webView.load(URLRequest(url: url))
        } else {
            mainNavigationMayDownload = navigationAction.targetFrame?.isMainFrame == true &&
                mayPresent(for: webView, frame: navigationAction.sourceFrame)
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame,
           let url = navigationResponse.response.url,
           endpoint?.contains(url) != true {
            decisionHandler(.cancel)
        } else if navigationResponse.isForMainFrame && !navigationResponse.canShowMIMEType {
            guard mainNavigationMayDownload, canBeginExport else { decisionHandler(.cancel); return }
            downloadPending = true
            decisionHandler(.download)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { backItem.isEnabled = webView.canGoBack }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        showMessage("Secure connection unavailable", "Check your approved server address, private network and the phone's trusted certificate chain. Certificate errors are not bypassed. Use Reload after correcting the connection.")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showMessage("Console stopped", "WebKit stopped the page. Reload the console and reconnect if needed. Tactical data from the old page is not restored.")
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let allowed = UIApplication.shared.applicationState == .active && frame.isMainFrame &&
            endpoint?.contains(protocol: origin.protocol, host: origin.host, port: origin.port) == true
        decisionHandler(allowed ? .prompt : .deny)
    }

    private func mayPresent(for candidate: WKWebView, frame: WKFrameInfo) -> Bool {
        candidate === webView && !clearingWebsite && presentedViewController == nil &&
        UIApplication.shared.applicationState == .active && frame.isMainFrame &&
        endpoint?.contains(protocol: frame.securityOrigin.protocol, host: frame.securityOrigin.host, port: frame.securityOrigin.port) == true
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
        guard mayPresent(for: webView, frame: frame) else { completionHandler(); return }
        let alert = consoleDialog(message)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        guard mayPresent(for: webView, frame: frame) else { completionHandler(false); return }
        let alert = consoleDialog(message)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) {
        guard mayPresent(for: webView, frame: frame) else { completionHandler(nil); return }
        let alert = consoleDialog(prompt)
        alert.addTextField { field in
            field.text = defaultText.map { String($0.prefix(4096)) }
            field.autocorrectionType = .no
            field.autocapitalizationType = .none
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
            completionHandler(alert?.textFields?.first?.text)
        })
        present(alert, animated: true)
    }

    private func consoleDialog(_ message: String) -> UIAlertController {
        UIAlertController(title: endpoint?.string ?? "Private console", message: String(message.prefix(4096)), preferredStyle: .alert)
    }

    private var canBeginExport: Bool {
        !downloadPending && activeDownload == nil && exportFile == nil &&
        presentedViewController == nil && UIApplication.shared.applicationState == .active && !clearingWebsite
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { receive(download, from: webView) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { receive(download, from: webView) }

    private func receive(_ download: WKDownload, from candidate: WKWebView) {
        guard candidate === webView, downloadPending, activeDownload == nil,
              let url = download.originalRequest?.url, endpoint?.permitsDownload(url) == true
        else {
            if candidate === webView { downloadPending = false }
            download.cancel(nil)
            return
        }
        downloadPending = false
        activeDownload = download
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        guard download === activeDownload, !clearingWebsite,
              let url = response.url, endpoint?.permitsDownload(url) == true,
              ExportPolicy.accepts(length: response.expectedContentLength),
              (response as? HTTPURLResponse).map({ (200...299).contains($0.statusCode) }) ?? true,
              presentedViewController == nil, UIApplication.shared.applicationState == .active
        else {
            completionHandler(nil)
            cancelExport()
            showMessage("Export unavailable", "Only approved-origin files with a known size of at most 256 MiB can be saved while the app is active.")
            return
        }
        let filename = ExportPolicy.filename(suggestedFilename)
        let alert = UIAlertController(title: "Save a private export?", message: "\(filename)\n\nThis file may contain private TAK information. Save only to an authorized location. Files up to 256 MiB are supported; the app does not keep a saved copy.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            completionHandler(nil)
            self?.cancelExport()
        })
        alert.addAction(UIAlertAction(title: "Choose save location", style: .default) { [weak self] _ in
            guard let self, self.activeDownload === download, !self.clearingWebsite,
                  UIApplication.shared.applicationState == .active
            else { completionHandler(nil); return }
            do {
                let directory = self.exportRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                var root = self.exportRoot
                try root.setResourceValues(values)
                let destination = directory.appendingPathComponent(filename, isDirectory: false)
                self.exportFile = destination
                self.downloadTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                    Task { @MainActor in self?.checkDownloadSize() }
                }
                completionHandler(destination)
            } catch {
                completionHandler(nil)
                self.cancelExport()
                self.showMessage("Export unavailable", "The temporary protected file could not be created.")
            }
        })
        present(alert, animated: true)
    }

    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping @MainActor @Sendable (WKDownload.RedirectPolicy) -> Void) {
        let allowed = download === activeDownload && request.url.map { endpoint?.contains($0) == true } == true
        decisionHandler(allowed ? .allow : .cancel)
    }

    private func checkDownloadSize() {
        guard let download = activeDownload else { return }
        let size = exportFile.flatMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize }.map(Int64.init) ?? 0
        if download.progress.completedUnitCount > ExportPolicy.maximumBytes || size > ExportPolicy.maximumBytes {
            cancelExport()
            showMessage("Export stopped", "This export exceeds the 256 MiB limit.")
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard download === activeDownload else { return }
        downloadTimer?.invalidate()
        downloadTimer = nil
        activeDownload = nil
        guard let file = exportFile,
              let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              ExportPolicy.accepts(length: Int64(size)), !clearingWebsite,
              UIApplication.shared.applicationState == .active, presentedViewController == nil
        else { cancelExport(); return }
        do {
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
            let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
            picker.delegate = self
            present(picker, animated: true)
        } catch { cancelExport() }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard download === activeDownload else { return }
        cancelExport()
        showMessage("Export unavailable", "The download did not finish. Return to the console and try the export again.")
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { cancelExport() }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { cancelExport() }

    private func cancelExport() {
        let download = activeDownload
        activeDownload = nil
        downloadPending = false
        downloadTimer?.invalidate()
        downloadTimer = nil
        download?.delegate = nil
        download?.cancel(nil)
        exportFile = nil
        removeTemporaryExports()
    }

    private func removeTemporaryExports() {
        // The root is a fixed app-owned directory under this sandbox's tmp.
        // No suggested filename, URL, or document-picker destination enters it.
        let expected = FileManager.default.temporaryDirectory.standardizedFileURL.appendingPathComponent("GEVTAKExports", isDirectory: true)
        guard exportRoot.standardizedFileURL == expected else { return }
        try? FileManager.default.removeItem(at: expected)
    }
    // No authentication-challenge override, script-message handlers, injected
    // scripts, native HTTP transport, or JavaScript evaluation are installed.
}
