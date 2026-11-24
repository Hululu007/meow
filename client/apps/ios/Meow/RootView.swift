import SwiftUI

struct RootView: View {
    @ObservedObject var boot: Bootstrap

    /// TV 端开屏同款底色（brand_splash_bg #0B2220）：
    /// 品牌屏 → 网页首帧之间不留「白/黑一闪」。
    private let splashBG = Color(red: 0x0B / 255.0, green: 0x22 / 255.0, blue: 0x20 / 255.0)

    var body: some View {
        ZStack {
            splashBG.ignoresSafeArea()

            if let url = boot.webURL {
                /*
                 * 全屏铺满（和浏览器一样进刘海区），安全区交给页面自己算。
                 * 页面用 viewport-fit=cover + CSS env(safe-area-inset-*)
                 * 把顶栏/底栏推开（tokens.css 的 html[data-shell='ios'] 段）。
                 */
                WebView(url: url,
                        script: boot.bootScript,
                        onReady: { _ = Task { @MainActor in boot.webReady = true } },
                        onError: { message in _ = Task { @MainActor in
                            // 网页加载失败也算失败：开屏页留着并给出原因，可重试
                            boot.failText = message
                            boot.failed = true
                        } })
                    .ignoresSafeArea()
            }

            if !boot.webReady {
                /*
                 * 开屏页盖住整个启动过程（2026-11-24 用户要求）。
                 *
                 * 之前这里是一圈转圈 + 「正在启动 Java 宿主…」这类工程化文案：
                 * 用户看到的是"程序在装什么东西"，而不是"App 在开机"。
                 * 现在只留品牌图标（TV 开屏同款：深绿底 + 居中图标），
                 * 后台照常起 JVM / 静态服务，就绪后整块让位给网页。
                 * 只有**真的起不来**（缺 web 资源 / 静态服务失败 / 网页加载失败）
                 * 才显示一行原因 + 重试。
                 */
                VStack(spacing: 22) {
                    SplashLogo()

                    if boot.failed {
                        VStack(spacing: 12) {
                            Text(boot.failText)
                                .font(.footnote)
                                .foregroundColor(.white.opacity(0.72))
                                .multilineTextAlignment(.center)
                                .textSelection(.enabled)
                                .padding(.horizontal, 28)
                            Button {
                                boot.retry()
                            } label: {
                                Text("重试")
                                    .font(.footnote.weight(.semibold))
                                    .padding(.horizontal, 22)
                                    .padding(.vertical, 9)
                                    .background(Color.white.opacity(0.12))
                                    .clipShape(Capsule())
                                    .foregroundColor(.white)
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 开屏图标：轻微呼吸（不改尺寸/位置，避免"跳一下"）。
private struct SplashLogo: View {
    @State private var pulse = false

    var body: some View {
        Image("BrandLogo")
            .resizable()
            .interpolation(.high)
            .frame(width: 112, height: 112)
            .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
            .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
            .scaleEffect(pulse ? 1.03 : 1.0)
            .animation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: pulse)
            .onAppear { pulse = true }
    }
}
