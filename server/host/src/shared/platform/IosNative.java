package platform;

/**
 * iOS 壳提供的原生能力（JNI）。
 *
 * <p>这些 native 方法由 {@code JvmBridge.m} 在 JVM 起来之后用
 * {@code RegisterNatives} 注册；桌面 / Android 上永远不会被调用（下载钩子
 * 只在 iOS 安装，见 {@link Bridge#installDownloader}）。
 *
 * <p><b>为什么要原生</b>：iOS 上 JVM 是 Zero 解释执行，TLS 与大文件 IO 都是
 * 纯解释，1~5MB 的源 jar 要十几秒；交给 NSURLSession 是秒级。下载是纯搬运，
 * 没有平台语义。
 */
public final class IosNative {

    private IosNative() {
    }

    /**
     * 把 {@code url} 下载到 {@code destPath}（存在则覆盖）。
     *
     * @return true = 成功且文件非空；失败返回 false，调用方回退 JVM 下载
     */
    public static native boolean download(String url, String destPath);
}
