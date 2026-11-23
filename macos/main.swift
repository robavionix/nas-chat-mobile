import AppKit
import WebKit

let names = ["微信", "QQ"]

let appTitle = "NAS 聊天"

final class ChatApp: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 730),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    let pages = NSView()
    lazy var picker = NSSegmentedControl(labels: names, trackingMode: .selectOne, target: self, action: #selector(selectTab))
    var browsers: [WKWebView?] = [nil, nil]
    var failures: [String?] = [nil, nil]
    var active = 0
    let errorLabel = NSTextField(wrappingLabelWithString: "")
    lazy var retry = NSButton(title: "重新连接", target: self, action: #selector(reloadPage))
    lazy var errorBox = NSStackView(views: [errorLabel, retry])

    func applicationDidFinishLaunching(_ notification: Notification) {
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
        show(UserDefaults.standard.integer(forKey: "lastChat") == 1 ? 1 : 0)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

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

    @objc func selectTab() { show(picker.selectedSegment) }
    @objc func menuTab(_ sender: NSMenuItem) { show(sender.tag) }
    func show(_ index: Int) {
        if active != index { browsers[active]?.removeFromSuperview() }
        active = index
        picker.selectedSegment = index
        window.title = names[index] + " · " + appTitle
        UserDefaults.standard.set(index, forKey: "lastChat")
        guard let url = entry(index) else {
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
            web.load(URLRequest(url: url))
        }
        if let web = browsers[index], web.superview == nil {
            web.frame = pages.bounds
            pages.addSubview(web)
            window.makeFirstResponder(web)
        }
        displayError()
    }
    func entry(_ i: Int) -> URL? {
        guard let value = UserDefaults.standard.string(forKey: "origin" + String(i)),
              let url = URL(string: value) else { return nil }
        return url.appendingPathComponent("mobile/desktop.html")
    }
    @objc func configure() {
        let alert = NSAlert()
        alert.messageText = names[active] + " 服务地址"
        alert.informativeText = "输入 NAS 服务的 HTTPS 域名，可包含端口。"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 330, height: 24))
        field.placeholderString = "https://chat.example.com"
        field.stringValue = UserDefaults.standard.string(forKey: "origin" + String(active)) ?? ""
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
            if UserDefaults.standard.string(forKey: "origin" + String(active)) == origin { return }
            UserDefaults.standard.set(origin, forKey: "origin" + String(active))
            browsers[active]?.removeFromSuperview()
            browsers[active] = nil
            failures[active] = nil
            show(active)
            return
        }
    }
    func displayError() {
        errorBox.removeFromSuperview()
        guard let message = failures[active] else { return }
        retry.title = entry(active) == nil ? "设置地址…" : "重新连接"
        errorLabel.stringValue = names[active] + " 连接中断\n" + message
        errorBox.translatesAutoresizingMaskIntoConstraints = false
        pages.addSubview(errorBox)
        NSLayoutConstraint.activate([errorBox.centerXAnchor.constraint(equalTo: pages.centerXAnchor), errorBox.centerYAnchor.constraint(equalTo: pages.centerYAnchor),
                                     errorBox.widthAnchor.constraint(lessThanOrEqualTo: pages.widthAnchor, multiplier: 0.85)])
    }
    @objc func reloadPage() {
        guard let address = entry(active), let web = browsers[active] else { configure(); return }
        if failures[active] != nil || web.url == nil { web.load(URLRequest(url: address)) }
        else { web.reload() }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let i = browsers.firstIndex(where: { $0 === webView }) else { return }
        failures[i] = nil
        if i == active { displayError() }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    func failed(_ web: WKWebView, _ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled, let i = browsers.firstIndex(where: { $0 === web }) else { return }
        failures[i] = error.localizedDescription
        if i == active { displayError() }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard action.targetFrame?.isMainFrame != false, let url = action.request.url else { decisionHandler(.allow); return }
        if let i = browsers.firstIndex(where: { $0 === webView }), url.scheme == "https", let address = entry(i), url.host == address.host, (url.port ?? 443) == (address.port ?? 443) {
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
