package android.app;

import android.os.Bundle;

import java.util.ArrayList;
import java.util.List;

/**
 * JVM 宿主的 Application 桩。
 *
 * <p>加密 Guard 载荷的 {@code InitOrigin.init()} 会注册
 * {@link ActivityLifecycleCallbacks}；缺这个嵌套接口时，载荷在 JVM 上会直接
 * {@code NoClassDefFoundError}，详情/播放链路走不到初始化。
 */
public class Application extends android.content.Context {

    public interface ActivityLifecycleCallbacks {
        void onActivityCreated(Activity activity, Bundle savedInstanceState);

        void onActivityStarted(Activity activity);

        void onActivityResumed(Activity activity);

        void onActivityPaused(Activity activity);

        void onActivityStopped(Activity activity);

        void onActivitySaveInstanceState(Activity activity, Bundle outState);

        void onActivityDestroyed(Activity activity);
    }

    private final List<ActivityLifecycleCallbacks> callbacks = new ArrayList<>();

    public void registerActivityLifecycleCallbacks(ActivityLifecycleCallbacks callback) {
        if (callback != null) callbacks.add(callback);
    }

    public void unregisterActivityLifecycleCallbacks(ActivityLifecycleCallbacks callback) {
        callbacks.remove(callback);
    }
}
