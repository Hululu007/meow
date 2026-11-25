package android.app;

/**
 * JVM 宿主的 ActivityThread 桩。
 *
 * <p>很多 jar 源（Bili、PanSearch 等）在 init 里直接
 * `ActivityThread.currentApplication()` 取 Context —— 例如
 * `[spider] init getActivity() err: android.app.ActivityThread`
 * （2026-11-25 iOS 日志 16 次）。缺这个类时它们直接
 * `NoClassDefFoundError`，初始化半途而废，表现为某些站详情/播放不可用。
 *
 * <p>返回一个进程级单例 {@link Application}（Context 桩提供 files/cache
 * 目录）。**只存在于 JVM stub 源集**：Android/TV 走系统真实现，不受影响。
 */
public class ActivityThread {

    private static final Application APP = new Application();

    public static ActivityThread currentActivityThread() {
        return new ActivityThread();
    }

    public static Application currentApplication() {
        return APP;
    }

    public Application getApplication() {
        return APP;
    }
}
