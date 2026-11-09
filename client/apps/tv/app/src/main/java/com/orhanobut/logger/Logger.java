package com.orhanobut.logger;

import android.util.Log;

/**
 * `com.orhanobut.logger.Logger` 的最小替身。
 *
 * <p>为什么要有它：TV 端复用的 catvod-api 里，`Path`/`Shell` 等工具类调用
 * `Logger.t(TAG).d(...)`。原库（orhanobut/logger）只是个格式化日志外包装，
 * 为几条调试日志引一整个依赖不值当，写个转发到 android.util.Log 的桩即可。
 *
 * <p>只实现实际用到的 `t()` + `d()`：多实现没人调的方法等于死代码。
 */
public final class Logger {

    private static final int MAX_CHUNK = 3500;

    private final String tag;

    private Logger(String tag) {
        this.tag = tag == null ? "catvod" : tag;
    }

    public static Logger t(String tag) {
        return new Logger(tag);
    }

    public void d(String msg) {
        log(Log.DEBUG, msg, null);
    }

    public void e(String msg) {
        log(Log.ERROR, msg, null);
    }

    public void e(Throwable t, String msg) {
        log(Log.ERROR, msg, t);
    }

    /**
     * Logcat 单条上限约 4KB，超长会整条丢失。
     * 分段打印，保证长 JSON 不会因为截断而看不到。
     */
    private void log(int level, String msg, Throwable t) {
        String s = msg == null ? "" : msg;
        if (s.length() <= MAX_CHUNK) {
            Log.println(level, tag, s);
        } else {
            for (int i = 0; i < s.length(); i += MAX_CHUNK) {
                Log.println(level, tag, s.substring(i, Math.min(s.length(), i + MAX_CHUNK)));
            }
        }
        if (t != null) Log.println(Log.ERROR, tag, Log.getStackTraceString(t));
    }
}
