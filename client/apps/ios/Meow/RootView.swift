import SwiftUI

struct RootView: View {
    @ObservedObject var boot: Bootstrap

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let url = boot.webURL {
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
