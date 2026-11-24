import SwiftUI

struct RootView: View {
    @ObservedObject var boot: Bootstrap

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let url = boot.webURL {
                /*
                 * 全屏铺满（和浏览器一样进刘海区），安全区交给页面自己算。
                 *
                 * ★ 为什么不是把 WebView 缩进安全区（上一版做法，用户否了）：
                 *   那样刘海/Home 条两块永远是黑边，应用的背景和顶栏、底栏
                 *   都变成"贴在里面的一张小画"，和主流 App 不一样。主流做法是
                 *   页面画满全屏，再由 CSS 用 env(safe-area-inset-*) 把**内容**
                 *   （顶栏、底栏、卡片）推开 —— tokens.css 里 `.app-header`
                 *   / `.has-tabbar` 的算式已经按这个写好了，只要求页面
                 *   viewport 带 `viewport-fit=cover`（index.html 的 iOS 分支已加）。
                 */
                WebView(url: url,
                        script: boot.bootScript,
                        onReady: { _ = Task { @MainActor in boot.webReady = true } },
                        onError: { message in _ = Task { @MainActor in boot.message = message } })
                    .ignoresSafeArea()
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
