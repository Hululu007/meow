import SwiftUI

struct RootView: View {
    @ObservedObject var boot: Bootstrap

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let url = boot.webURL {
                /*
                 * ★ 不要 ignoresSafeArea：WKWebView 自己是 contentInsetAdjustmentBehavior
                 *   = .never，页面又会画到刘海底下（顶栏被遮住、设置页第一个输入框
                 *   点不到）。这里让 SwiftUI 把 WebView 约束在安全区内，刘海/Home
                 *   指示条那块只露底层黑底——等价于「浏览器窗口不进刘海」。
                 */
                WebView(url: url,
                        script: boot.bootScript,
                        onReady: { _ = Task { @MainActor in boot.webReady = true } },
                        onError: { message in _ = Task { @MainActor in boot.message = message } })
            }

            if !boot.webReady {
                VStack(spacing: 14) {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(.white)
                    Text(boot.message)
                        .font(.footnote)
                        .foregroundColor(.white.opacity(0.78))
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                        .padding(.horizontal, 10)
                }
                .padding(.horizontal, 26)
                .padding(.vertical, 20)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color.black.opacity(0.62)))
            }
        }
    }
}
