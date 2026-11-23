import AppKit
import Network
import WebKit

let names = ["微信", "QQ"]

let appTitle = "NAS 聊天"

// MARK: - Home-network entry
//
// A server that offers a home-network entry publishes it at /mobile/lan-config.json and its private root
// certificate at /mobile/lan-root.cer. The app learns both from the public address you entered (over normal,
// publicly trusted HTTPS) and then trusts that certificate only for that one private address and port.

struct HomeEntry {
    let origin: URL          // https://192.168.1.2:8443
    let anchor: SecCertificate

    var host: String { origin.host ?? "" }
    var port: Int { origin.port ?? 443 }

    static func isPrivate(_ host: String) -> Bool {
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        return parts[0] == 10 || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && (16...31).contains(parts[1]))
    }

    /// Accepts only an HTTPS address on a private IPv4 host, without credentials.
    static func origin(from text: String) -> URL? {
        guard var parts = URLComponents(string: text), parts.scheme?.lowercased() == "https", let host = parts.host,
              isPrivate(host), parts.user == nil, parts.password == nil else { return nil }
        parts.path = ""; parts.query = nil; parts.fragment = nil
        return parts.url
    }

    static func certificate(_ data: Data) -> SecCertificate? {
        if let text = String(data: data, encoding: .ascii), text.contains("-----BEGIN CERTIFICATE-----") {
            let body = text.components(separatedBy: "\n").filter { !$0.hasPrefix("-----") }.joined()
            return Data(base64Encoded: body, options: .ignoreUnknownCharacters).flatMap { SecCertificateCreateWithData(nil, $0 as CFData) }
        }
        return SecCertificateCreateWithData(nil, data as CFData)
    }

    func credential(for challenge: URLAuthenticationChallenge) -> URLCredential? {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, space.host == host, space.port == port,
              let trust = space.serverTrust else { return nil }
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
        SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        return SecTrustEvaluateWithError(trust, nil) ? URLCredential(trust: trust) : nil
    }
}

/// Short requests outside the pages: reaching the home entry, and fetching its certificate.
final class HomeNetwork: NSObject, URLSessionDelegate {
    static let shared = HomeNetwork()
    var entries: () -> [HomeEntry] = { [] }
    lazy var quick: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1.5
        config.timeoutIntervalForResource = 2
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    /// Only a quick, trusted answer from the home entry counts as being at home.
    func reachable(_ entry: HomeEntry, _ done: @escaping (Bool) -> Void) {
        var request = URLRequest(url: entry.origin.appendingPathComponent("mobile/manifest.json"))
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        quick.dataTask(with: request) { _, response, error in
            let ok = error == nil && (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        if let entry = entries().first(where: { $0.host == space.host && $0.port == space.port }) {
            if let credential = entry.credential(for: challenge) { completionHandler(.useCredential, credential) }
            else { completionHandler(.cancelAuthenticationChallenge, nil) }
        } else { completionHandler(.performDefaultHandling, nil) }
    }
}

final class ChatApp: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 730),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    let pages = NSView()
    lazy var picker = NSSegmentedControl(labels: names, trackingMode: .selectOne, target: self, action: #selector(selectTab))
    var browsers: [WKWebView?] = [nil, nil]
    var failures: [String?] = [nil, nil]
    var onLan = [false, false]
    var checking = [false, false]
    var lastCheck = Date.distantPast
    let pathMonitor = NWPathMonitor()
    var active = 0
    let errorLabel = NSTextField(wrappingLabelWithString: "")
    lazy var retry = NSButton(title: "重新连接", target: self, action: #selector(reloadPage))
    lazy var errorBox = NSStackView(views: [errorLabel, retry])
    lazy var lanItem = NSMenuItem(title: "优先家里直连", action: #selector(toggleLan), keyEquivalent: "")
    let defaults = UserDefaults.standard

    func applicationDidFinishLaunching(_ notification: Notification) {
        defaults.register(defaults: ["preferLan": true])
        HomeNetwork.shared.entries = { [weak self] in self.map { s in names.indices.compactMap { s.home($0) } } ?? [] }
        buildMenu()
        let root = NSView()
        let bar = NSView()
        let divider = NSBox()
        divider.boxType = .separator
        window.contentView = root
        window.title = appTitle
        window.minSize = NSSize(width: 620, height: 440)
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("MainWindow")
        for child in [bar, divider, pages] {
            child.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(child)
        }
        bar.addSubview(picker)
        picker.translatesAutoresizingMaskIntoConstraints = false
        picker.segmentStyle = .rounded
        for i in names.indices { picker.setWidth(80, forSegment: i) }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: root.topAnchor), bar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: root.trailingAnchor), bar.heightAnchor.constraint(equalToConstant: 43),
            picker.centerXAnchor.constraint(equalTo: bar.centerXAnchor), picker.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            divider.topAnchor.constraint(equalTo: bar.bottomAnchor), divider.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            pages.topAnchor.constraint(equalTo: divider.bottomAnchor), pages.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            pages.trailingAnchor.constraint(equalTo: root.trailingAnchor), pages.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])
        errorBox.orientation = .vertical
        errorBox.spacing = 12
        errorLabel.alignment = .center
        show(defaults.integer(forKey: "lastChat") == 1 ? 1 : 0)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // Arriving home, leaving, waking from sleep or coming back to the app re-checks the route.
        var firstPath = true
        pathMonitor.pathUpdateHandler = { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                if firstPath { firstPath = false; return }
                self?.recheckRoutes(force: true)
            }
        }
        pathMonitor.start(queue: .main)
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self?.recheckRoutes(force: true) }
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) { recheckRoutes(force: false) }

    func buildMenu() {
        let main = NSMenu()
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem()
            main.addItem(item)
            let menu = NSMenu(title: title)
            item.submenu = menu
            return menu
        }
        let app = submenu(appTitle)
        app.addItem(withTitle: "设置当前服务地址…", action: #selector(configure), keyEquivalent: ",").target = self
        lanItem.target = self
        lanItem.state = defaults.bool(forKey: "preferLan") ? .on : .off
        app.addItem(lanItem)
        app.addItem(.separator())
        app.addItem(withTitle: "隐藏" + appTitle, action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "退出" + appTitle, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = submenu("编辑")
        for (title, command, key) in [("撤销","undo:","z"),("剪切","cut:","x"),("复制","copy:","c"),("粘贴","paste:","v"),("全选","selectAll:","a")] {
            edit.addItem(withTitle: title, action: Selector(command), keyEquivalent: key)
        }
        let view = submenu("显示")
        for i in names.indices {
            let item = view.addItem(withTitle: names[i], action: #selector(menuTab(_:)), keyEquivalent: String(i+1))
            item.target = self
            item.tag = i
        }
        view.addItem(.separator())
        view.addItem(withTitle: "重新载入", action: #selector(reloadPage), keyEquivalent: "r").target = self
        view.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.mainMenu = main
    }

    // MARK: Addresses

    func origin(_ i: Int) -> URL? {
        guard let value = defaults.string(forKey: "origin" + String(i)) else { return nil }
        return URL(string: value)
    }
    /// The home entry learned from this chat's public address, if any.
    func home(_ i: Int) -> HomeEntry? {
        guard let public_ = origin(i), defaults.string(forKey: "lanFor" + String(i)) == public_.absoluteString,
              let text = defaults.string(forKey: "lanOrigin" + String(i)), let lan = HomeEntry.origin(from: text),
              let data = defaults.data(forKey: "lanCA" + String(i)), let anchor = HomeEntry.certificate(data) else { return nil }
        return HomeEntry(origin: lan, anchor: anchor)
    }
    func entry(_ i: Int) -> URL? {
        let base = onLan[i] ? home(i)?.origin : origin(i)
        return base?.appendingPathComponent("mobile/desktop.html")
    }
    func allowed(_ url: URL, _ i: Int) -> Bool {
        guard url.scheme == "https", let host = url.host else { return false }
        let port = url.port ?? 443
        if let o = origin(i), host == o.host, port == (o.port ?? 443) { return true }
        if let h = home(i), host == h.host, port == h.port { return true }
        return false
    }
    func updateTitle() {
        window.title = names[active] + (onLan[active] ? " · 家里直连" : "") + " · " + appTitle
    }

    // MARK: Route choice

    /// Picks the home entry when it answers quickly, otherwise the public address.
    func route(_ i: Int, _ done: @escaping (Bool) -> Void) {
        guard defaults.bool(forKey: "preferLan"), let h = home(i) else { done(false); return }
        HomeNetwork.shared.reachable(h, done)
    }
    func recheckRoutes(force: Bool) {
        guard force || Date().timeIntervalSince(lastCheck) > 30 else { return }
        lastCheck = Date()
        for i in names.indices where browsers[i] != nil && !checking[i] {
            checking[i] = true
            route(i) { [weak self] lan in
                guard let self = self else { return }
                self.checking[i] = false
                if lan != self.onLan[i] || self.failures[i] != nil {
                    self.onLan[i] = lan
                    if let url = self.entry(i) { self.browsers[i]?.load(URLRequest(url: url)) }
                    if i == self.active { self.updateTitle() }
                }
            }
        }
    }
    @objc func toggleLan() {
        defaults.set(!defaults.bool(forKey: "preferLan"), forKey: "preferLan")
        lanItem.state = defaults.bool(forKey: "preferLan") ? .on : .off
        recheckRoutes(force: true)
    }

    /// After the public page loads (signed in), learn the home entry from it.
    func discover(_ i: Int, _ web: WKWebView) {
        guard let public_ = origin(i), defaults.bool(forKey: "preferLan") else { return }
        let script = "const r = await fetch('/mobile/lan-config.json', {cache: 'no-store'}); return r.ok ? (await r.json()).url : null;"
        web.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self, case .success(let value) = result, let text = value as? String,
                  let lan = HomeEntry.origin(from: text), self.origin(i) == public_ else { return }
            var request = URLRequest(url: public_.appendingPathComponent("mobile/lan-root.cer"))
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            URLSession.shared.dataTask(with: request) { data, response, _ in
                guard let data = data, (response as? HTTPURLResponse)?.statusCode == 200, HomeEntry.certificate(data) != nil else { return }
                DispatchQueue.main.async {
                    guard self.origin(i) == public_ else { return }
                    let known = self.home(i)
                    self.defaults.set(public_.absoluteString, forKey: "lanFor" + String(i))
                    self.defaults.set(lan.absoluteString, forKey: "lanOrigin" + String(i))
                    self.defaults.set(data, forKey: "lanCA" + String(i))
                    if known?.origin != lan { self.lastCheck = .distantPast; self.recheckRoutes(force: true) }
                }
            }.resume()
        }
    }

    // MARK: Pages

    @objc func selectTab() { show(picker.selectedSegment) }
    @objc func menuTab(_ sender: NSMenuItem) { show(sender.tag) }
    func show(_ index: Int) {
        if active != index { browsers[active]?.removeFromSuperview() }
        active = index
        picker.selectedSegment = index
        updateTitle()
        defaults.set(index, forKey: "lastChat")
        guard origin(index) != nil else {
            failures[index] = "请先设置服务的 HTTPS 地址"
            displayError()
            return
        }
        if browsers[index] == nil {
            let config = WKWebViewConfiguration()
            config.websiteDataStore = .default()
            let web = WKWebView(frame: pages.bounds, configuration: config)
            web.navigationDelegate = self
            web.uiDelegate = self
            web.autoresizingMask = [.width, .height]
            browsers[index] = web
            checking[index] = true
            route(index) { [weak self] lan in
                guard let self = self else { return }
                self.checking[index] = false
                self.onLan[index] = lan
                if let url = self.entry(index) { web.load(URLRequest(url: url)) }
                if index == self.active { self.updateTitle() }
            }
        }
        if let web = browsers[index], web.superview == nil {
            web.frame = pages.bounds
            pages.addSubview(web)
            window.makeFirstResponder(web)
        }
        displayError()
    }
    @objc func configure() {
        let alert = NSAlert()
        alert.messageText = names[active] + " 服务地址"
        alert.informativeText = "输入 NAS 服务的 HTTPS 域名，可包含端口。"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 330, height: 24))
        field.placeholderString = "https://chat.example.com"
        field.stringValue = defaults.string(forKey: "origin" + String(active)) ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "保存")
        alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = field
        while alert.runModal() == .alertFirstButtonReturn {
            let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard var parts = URLComponents(string: value), parts.scheme?.lowercased() == "https",
                  let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
                  parts.query == nil, parts.fragment == nil,
                  ["", "/", "/mobile/", "/mobile/desktop.html"].contains(parts.path) else {
                alert.informativeText = "请输入有效的 HTTPS 服务地址，例如 https://chat.example.com"
                continue
            }
            parts.path = ""
            guard let origin = parts.url?.absoluteString else { continue }
            if defaults.string(forKey: "origin" + String(active)) == origin { return }
            defaults.set(origin, forKey: "origin" + String(active))
            for key in ["lanFor", "lanOrigin", "lanCA"] { defaults.removeObject(forKey: key + String(active)) }
            browsers[active]?.removeFromSuperview()
            browsers[active] = nil
            failures[active] = nil
            onLan[active] = false
            show(active)
            return
        }
    }
    func displayError() {
        errorBox.removeFromSuperview()
        guard let message = failures[active] else { return }
        retry.title = origin(active) == nil ? "设置地址…" : "重新连接"
        errorLabel.stringValue = names[active] + " 连接中断\n" + message
        errorBox.translatesAutoresizingMaskIntoConstraints = false
        pages.addSubview(errorBox)
        NSLayoutConstraint.activate([errorBox.centerXAnchor.constraint(equalTo: pages.centerXAnchor), errorBox.centerYAnchor.constraint(equalTo: pages.centerYAnchor),
                                     errorBox.widthAnchor.constraint(lessThanOrEqualTo: pages.widthAnchor, multiplier: 0.85)])
    }
    @objc func reloadPage() {
        guard origin(active) != nil, let web = browsers[active] else { configure(); return }
        let i = active
        // Reloading also re-checks whether the chat can come straight from home.
        route(i) { [weak self] lan in
            guard let self = self else { return }
            if lan != self.onLan[i] || self.failures[i] != nil || web.url == nil {
                self.onLan[i] = lan
                if let url = self.entry(i) { web.load(URLRequest(url: url)) }
                if i == self.active { self.updateTitle() }
            } else { web.reload() }
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let i = browsers.firstIndex(where: { $0 === webView }) else { return }
        failures[i] = nil
        if i == active { displayError() }
        if !onLan[i], webView.url?.path.hasSuffix("/desktop.html") == true { discover(i, webView) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    func failed(_ web: WKWebView, _ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled, let i = browsers.firstIndex(where: { $0 === web }) else { return }
        if onLan[i] {
            // The home entry stopped answering (for example the Mac just left home): use the public address.
            onLan[i] = false
            if let url = entry(i) { web.load(URLRequest(url: url)) }
            if i == active { updateTitle() }
            return
        }
        failures[i] = error.localizedDescription
        if i == active { displayError() }
    }
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        if let i = browsers.firstIndex(where: { $0 === webView }), let h = home(i), space.host == h.host, space.port == h.port {
            if let credential = h.credential(for: challenge) { completionHandler(.useCredential, credential) }
            else { completionHandler(.cancelAuthenticationChallenge, nil) }
        } else { completionHandler(.performDefaultHandling, nil) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard action.targetFrame?.isMainFrame != false, let url = action.request.url else { decisionHandler(.allow); return }
        if let i = browsers.firstIndex(where: { $0 === webView }), allowed(url, i) {
            if action.targetFrame == nil { decisionHandler(.cancel); webView.load(action.request) }
            else { decisionHandler(.allow) }
        } else {
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated && url.scheme == "https" { NSWorkspace.shared.open(url) }
        }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }
}
let application = NSApplication.shared
let delegate = ChatApp()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
