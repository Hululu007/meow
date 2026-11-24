import SwiftUI
import WebKit

struct WebView: UIViewRepresentable {
    let url: URL
    let script: String
    var onReady: () -> Void = {}
    var onError: (String) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.websiteDataStore = .default()

        let controller = WKUserContentController()
        if !script.isEmpty {
            controller.addUserScript(WKUserScript(source: script,
                                                  injectionTime: .atDocumentStart,
                                                  forMainFrameOnly: false))
        }
        // 前端诊断通道：页面里的网络级失败（请求没到后端 / 预检失败）连不上
        // 后端日志，只有这里能落到 launch.log。见 api/index.ts 的 webLog()。
        controller.add(context.coordinator, name: "meowLog")
        // 页面 → 原生的控制通道（目前只有转屏：播放页全屏要横屏）。
        controller.add(context.coordinator, name: "meowIos")
        config.userContentController = controller

        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.allowsBackForwardNavigationGestures = false
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // webURL 变化会重建视图；这里不重复 load，避免打断播放页。
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        private let parent: WebView

        init(_ parent: WebView) {
            self.parent = parent
        }

        /// 页面通过 `window.webkit.messageHandlers.*.postMessage(...)` 调原生。
        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            switch message.name {
            case "meowLog":
                LaunchLog.write("[web] \(message.body)")
            case "meowIos":
                if let dict = message.body as? [String: Any],
                   let op = dict["op"] as? String,
                   op == "orientation" {
                    ShellOrientation.apply(dict["value"] as? String ?? "")
                }
            default:
                break
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            LaunchLog.write("web didFinish")
            parent.onReady()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            LaunchLog.write("web didFail: \(error.localizedDescription)")
            parent.onError(error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            LaunchLog.write("web didFailProvisional: \(error.localizedDescription)")
            parent.onError(error.localizedDescription)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil {
                webView.load(navigationAction.request)
            }
            return nil
        }
    }
}
