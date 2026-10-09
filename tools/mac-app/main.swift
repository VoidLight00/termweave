// TermWeave.app: native window for the local TermWeave web UI.
// The Aside/Chrome PWA shortcut falls back to a browser tab when the browser decides so;
// a WKWebView window does not depend on any browser.
// Build: tools/mac-app/build.sh
import Cocoa
import WebKit

// `open -a TermWeave --args <url>` opens a specific panel (used by TermWeave Phone).
let argURL = CommandLine.arguments.dropFirst().first { $0.hasPrefix("http://127.0.0.1:") }
let home = URL(string: argURL ?? ProcessInfo.processInfo.environment["TERMWEAVE_URL"] ?? "http://127.0.0.1:7317/")!

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var authTried = false

    // Token is read at runtime from the plugin .env, never compiled into the app.
    func localToken() -> String? {
        let env = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/herdr/plugins/config/devswha.herdr-web-ui/.env")
        guard let text = try? String(contentsOf: env, encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n") where line.hasPrefix("HERDR_WEB_TOKEN=") {
            let v = line.dropFirst("HERDR_WEB_TOKEN=".count).trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
            return v.isEmpty ? nil : v
        }
        return nil
    }

    // First page load: sign in with the local token so the window never shows the pairing screen.
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
        guard !authTried, let token = localToken(),
              let body = try? JSONSerialization.data(withJSONObject: ["token": token]),
              let json = String(data: body, encoding: .utf8) else { return }
        authTried = true
        let js = """
        fetch('/api/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(\(json))})
          .then(r=>{ if(r.status===204) location.reload(); })
        """
        w.evaluateJavaScript(js)
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // persistent: keeps login, layout, preferences
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "TermWeave"
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("TermWeaveMain")
        window.makeKeyAndOrderFront(nil)
        buildMenu()
        web.load(URLRequest(url: home))
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // Server not up yet (e.g. right after login): retry instead of a blank window.
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { w.load(URLRequest(url: home)) }
    }

    // Links to other sites and target=_blank go to the default browser.
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = a.request.url, url.host != home.host, a.navigationType == .linkActivated {
            NSWorkspace.shared.open(url); return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration,
                 for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let url = a.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String,
                 initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = m; alert.runModal(); completionHandler()
    }

    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String,
                 initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = m
        alert.addButton(withTitle: "확인"); alert.addButton(withTitle: "취소")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    @objc func reload() { web.load(URLRequest(url: home)) }

    // Without an Edit menu, Cmd+C / Cmd+V do nothing inside a WKWebView.
    func buildMenu() {
        let main = NSMenu()
        func sub(_ title: String, _ items: [(String, Selector?, String)]) {
            let item = NSMenuItem(); let menu = NSMenu(title: title)
            for (t, s, k) in items {
                menu.addItem(s == nil ? .separator() : NSMenuItem(title: t, action: s, keyEquivalent: k))
            }
            item.submenu = menu; main.addItem(item)
        }
        sub("TermWeave", [("TermWeave 숨기기", #selector(NSApplication.hide(_:)), "h"),
                          ("", nil, ""),
                          ("TermWeave 종료", #selector(NSApplication.terminate(_:)), "q")])
        sub("편집", [("실행 취소", Selector(("undo:")), "z"), ("다시 실행", Selector(("redo:")), "Z"),
                    ("", nil, ""),
                    ("잘라내기", #selector(NSText.cut(_:)), "x"), ("복사", #selector(NSText.copy(_:)), "c"),
                    ("붙여넣기", #selector(NSText.paste(_:)), "v"), ("모두 선택", #selector(NSText.selectAll(_:)), "a")])
        sub("보기", [("새로고침", #selector(reload), "r")])
        sub("윈도우", [("최소화", #selector(NSWindow.miniaturize(_:)), "m"),
                     ("닫기", #selector(NSWindow.performClose(_:)), "w")])
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
