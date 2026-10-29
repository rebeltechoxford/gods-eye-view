import UIKit
import WebKit

@MainActor
final class ConsoleViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, UIDocumentPickerDelegate {
    private static let endpointKey = "approvedConsoleOrigin"
    // Keep gateway cookies and storage separate from persistent local maps.
    // iOS 16 lacks named persistent stores, so gateway sessions are ephemeral there.
    private let gatewayStore: WKWebsiteDataStore = {
        if #available(iOS 17.0, *) {
            return WKWebsiteDataStore(forIdentifier: UUID(uuidString: "F9F43D3B-60D8-49F6-AFB8-C8F1263C715C")!)
        }
        return .nonPersistent()
    }()
    private var bundledServer: BundledAppServer?
    private var standalone = false
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
    private weak var exportPrompt: UIAlertController?
    private var declineExport: (() -> Void)?
    private var exportFile: URL?
    private var downloadTimer: Timer?
#if DEBUG
    private var smokeChecksRemaining = 120
#endif
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
        openStandalone()

    }

    private func buildEntryPanel() {
        let heading = UILabel()
        heading.text = "Connect GEV TAK gateway"
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
        limit.text = "Keep the app visible for device GPS. Direct radio connections and background TAK connections are not available."
        limit.numberOfLines = 0
        limit.font = .preferredFont(forTextStyle: .footnote)
        limit.textColor = .secondaryLabel
        let local = UIButton(type: .system)
        local.setTitle("Return to local app", for: .normal)
        local.accessibilityIdentifier = "openLocalApp"
        local.addTarget(self, action: #selector(openStandalone), for: .touchUpInside)
        local.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        entryPanel = UIStackView(arrangedSubviews: [heading, explanation, endpointField, connect, local, limit])
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
        webView?.isHidden = true
        entryContainer.isHidden = false
        backItem.isEnabled = false
        endpointField.text = UserDefaults.standard.string(forKey: Self.endpointKey)
    }

    @objc private func saveEndpoint() {
        do {
            let origin = try EndpointOrigin(endpointField.text ?? "")
            UserDefaults.standard.set(origin.string, forKey: Self.endpointKey)
            view.endEditing(true)
            open(origin)
        } catch { showMessage("Check the server address", String(describing: error)) }
    }

    @objc private func openStandalone() {
        view.endEditing(true)
        if standalone, let webView, bundledServer != nil {
            entryContainer.isHidden = true
            webView.isHidden = false
            backItem.isEnabled = webView.canGoBack
            return
        }
        guard let root = Bundle.main.url(forResource: "WebApp", withExtension: nil) else {
            showMessage("Bundled app missing", "Rebuild the IPA with the full God’s Eye View web assets.")
            return
        }
        if bundledServer != nil { showConsole(BundledAppServer.origin); return }
        let server = BundledAppServer(root: root)
        bundledServer = server
        server.didFail = { [weak self, weak server] error in
            guard let self, self.bundledServer === server else { return }
            self.bundledServer = nil
            if self.standalone { self.showMessage("Local app unavailable", "The local service stopped. Use Reload to restart it.") }
        }
        do {
            try server.start { [weak self] error in
                guard let self else { return }
                if let error {
                    self.bundledServer = nil
                    self.showMessage("Local app unavailable", error.localizedDescription)
                } else { self.showConsole(BundledAppServer.origin) }
            }
        } catch {
            bundledServer = nil
            showMessage("Local app unavailable", error.localizedDescription)
        }
    }

    private func trusted(_ url: URL) -> Bool {
        if standalone {
            return url.scheme == "http" && url.host == "127.0.0.1" && url.port == Int(BundledAppServer.port) && url.user == nil && url.password == nil
        }
        return endpoint?.contains(url) == true
    }

    private func permitsDownload(_ url: URL) -> Bool {
        if trusted(url) { return true }
        guard url.scheme == "blob", url.absoluteString.count <= 4096,
              let embedded = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
        return trusted(embedded)
    }

    private func trusted(scheme: String, host: String, port: Int) -> Bool {
        if standalone { return scheme == "http" && host == "127.0.0.1" && port == Int(BundledAppServer.port) }
        return endpoint?.contains(protocol: scheme, host: host, port: port) == true
    }

    private func open(_ origin: EndpointOrigin) {
        endpoint = origin
        showConsole(origin.url)
    }

    private func showConsole(_ url: URL) {
        cancelExport()
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView?.removeFromSuperview()
        standalone = url == BundledAppServer.origin
        entryContainer.isHidden = true
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = standalone ? .default() : gatewayStore
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
        console.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    @objc private func goBack() { if webView?.canGoBack == true { webView?.goBack() } }
    @objc private func reloadConsole() {
        if standalone && bundledServer == nil { openStandalone() }
        else { webView?.reloadFromOrigin() }
    }

    @objc private func changeServer() {
        guard !clearingWebsite else { return }
        if standalone {
            let choice = UIAlertController(title: "TAK connection", message: "The full globe runs locally without login. Connect to your private GEV TAK gateway for network services; its server session is separate from local mode.", preferredStyle: .alert)
            choice.addAction(UIAlertAction(title: "Keep working locally", style: .cancel))
            choice.addAction(UIAlertAction(title: "Configure server", style: .default) { [weak self] _ in self?.showEntry() })
            present(choice, animated: true)
            return
        }
        let alert = UIAlertController(title: "Change private server?", message: "First use TAK → NETWORK → Sign out to revoke your server session. Continue clears gateway cookies and gateway website data on this device. Local maps and preferences are kept. It does not confirm server-side sign-out.", preferredStyle: .alert)
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
        gatewayStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { [weak self] in
            Task { @MainActor in
                self?.clearingWebsite = false
                self?.openStandalone()
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
        if navigationAction.targetFrame?.isMainFrame == true,
           trusted(url), url.path == "/login" {
            // Web logout and session expiry return here without a JS/native
            // bridge. Retire any native export before showing the login page.
            if presentedViewController is UIDocumentPickerViewController { dismiss(animated: false) }
            cancelExport()
        }
        if navigationAction.shouldPerformDownload || url.scheme?.lowercased() == "blob" {
            guard mayPresent(for: webView, frame: navigationAction.sourceFrame),
                  permitsDownload(url), canBeginExport
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
        guard trusted(url) else {
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
           !trusted(url) {
            decisionHandler(.cancel)
        } else if navigationResponse.isForMainFrame && !navigationResponse.canShowMIMEType {
            guard mainNavigationMayDownload, canBeginExport else { decisionHandler(.cancel); return }
            downloadPending = true
            decisionHandler(.download)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        backItem.isEnabled = webView.canGoBack
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--gev-smoke"), standalone {
            checkBundledStartup(webView)
        }
#endif
    }
#if DEBUG
    // Opt-in simulator evidence only. This is not present in release IPAs.
    private func checkBundledStartup(_ candidate: WKWebView) {
        guard candidate === webView, standalone, smokeChecksRemaining > 0 else { return }
        smokeChecksRemaining -= 1
        let script = """
        (() => {
          const app = window.__godsEyeView;
          const viewer = app?.viewer;
          const layers = app?.dataManager?.layers?.size || 0;
          const initialized = !!viewer && !viewer.isDestroyed() && !!app.takClient && layers >= 34;
          if (initialized && !window.__gevSmokeRenderRequested) {
            window.__gevSmokeRenderRequested = true;
            const remove = viewer.scene.postRender.addEventListener(() => {
              window.__gevSmokeRendered = true;
              remove();
            });
            viewer.scene.requestRender();
          }
          return {ready: initialized && !!window.__gevSmokeRendered,
            layers, origin: location.origin, title: document.title};
        })()
        """
        candidate.evaluateJavaScript(script) { [weak self, weak candidate] value, error in
            guard let self, let candidate, candidate === self.webView, self.standalone else { return }
            var record = value as? [String: Any] ?? ["ready": false]
            if let error { record["error"] = error.localizedDescription }
            let passed = record["ready"] as? Bool == true && record["origin"] as? String == BundledAppServer.origin.absoluteString
            if passed || self.smokeChecksRemaining == 0 {
                record["ready"] = passed
                if let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
                   let bytes = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) {
                    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try? bytes.write(to: directory.appendingPathComponent("gev-startup-smoke.json"), options: .atomic)
                }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak candidate] in
                    if let candidate { self?.checkBundledStartup(candidate) }
                }
            }
        }
    }
#endif
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if standalone {
            showMessage("Local app unavailable", "The bundled app could not load. Use Reload to retry the local service.")
        } else {
            showMessage("Secure connection unavailable", "Check your approved server address, private network and the phone's trusted certificate chain. Certificate errors are not bypassed. Use Reload after correcting the connection.")
        }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showMessage("Console stopped", "WebKit stopped the page. Reload the console and reconnect if needed. Tactical data from the old page is not restored.")
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let allowed = webView === self.webView && !clearingWebsite && UIApplication.shared.applicationState == .active && frame.isMainFrame &&
            trusted(scheme: origin.protocol, host: origin.host, port: origin.port)
        decisionHandler(allowed ? .prompt : .deny)
    }

    private func mayPresent(for candidate: WKWebView, frame: WKFrameInfo) -> Bool {
        candidate === webView && !clearingWebsite && presentedViewController == nil &&
        UIApplication.shared.applicationState == .active && frame.isMainFrame &&
        trusted(scheme: frame.securityOrigin.protocol, host: frame.securityOrigin.host, port: frame.securityOrigin.port)
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
        UIAlertController(title: standalone ? "GEV TAK" : (endpoint?.string ?? "Private console"), message: String(message.prefix(4096)), preferredStyle: .alert)
    }

    private var canBeginExport: Bool {
        !downloadPending && activeDownload == nil && exportFile == nil &&
        presentedViewController == nil && UIApplication.shared.applicationState == .active && !clearingWebsite
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { receive(download, from: webView) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { receive(download, from: webView) }

    private func receive(_ download: WKDownload, from candidate: WKWebView) {
        guard candidate === webView, downloadPending, activeDownload == nil,
              let url = download.originalRequest?.url, permitsDownload(url)
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
              let url = response.url, permitsDownload(url),
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
        exportPrompt = alert
        declineExport = { completionHandler(nil) }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            guard let self else { completionHandler(nil); return }
            self.cancelExport()
        })
        alert.addAction(UIAlertAction(title: "Choose save location", style: .default) { [weak self, weak alert] _ in
            guard let self else { completionHandler(nil); return }
            guard self.declineExport != nil else { return }
            guard let alert else { self.cancelExport(); return }
            guard self.activeDownload === download, !self.clearingWebsite,
                  UIApplication.shared.applicationState == .active
            else { self.cancelExport(); return }
            self.declineExport = nil
            self.exportPrompt = nil
            do {
                let directory = self.exportRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                var root = self.exportRoot
                try root.setResourceValues(values)
                let destination = directory.appendingPathComponent(filename, isDirectory: false)
                self.exportFile = destination
                // A small blob can finish before an alert's dismiss animation.
                // Start writing after dismissal so Files can always be shown.
                alert.dismiss(animated: true) { [weak self] in
                    guard let self, self.activeDownload === download, !self.clearingWebsite,
                          UIApplication.shared.applicationState == .active
                    else { completionHandler(nil); return }
                    self.downloadTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                        Task { @MainActor in self?.checkDownloadSize() }
                    }
                    completionHandler(destination)
                }
            } catch {
                completionHandler(nil)
                self.cancelExport()
                alert.dismiss(animated: true) { [weak self] in
                    self?.showMessage("Export unavailable", "The temporary protected file could not be created.")
                }
            }
        })
        present(alert, animated: true)
    }

    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping @MainActor @Sendable (WKDownload.RedirectPolicy) -> Void) {
        let allowed = download === activeDownload && request.url.map { trusted($0) } == true
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
        let decline = declineExport
        declineExport = nil
        exportPrompt?.dismiss(animated: false)
        exportPrompt = nil
        decline?()
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
    // scripts or remote native HTTP transport are installed.
}
