package com.meow.runtime.python;

import android.content.Context;
import android.util.Log;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import com.meow.runtime.PythonRuntimeApi;

/**
 * Python 运行时模块入口：宿主用 {@code DexClassLoader} 加载本类，再按
 * {@link PythonRuntimeApi} 调用。
 *
 * <p><b>加载链</b>（宿主侧 {@code RuntimeModuleHost.pythonEntry}）：
 * <pre>
 * DexClassLoader(module.apk, odexDir, null, hostClassLoader)
 *   → Class.forName("com.meow.runtime.python.RuntimeEntry", true, loader)
 *   → newInstance() → startServer(hostContext, …)
 * </pre>
 * native 路径**不**走 DexClassLoader 的 nativePath：Chaquopy 的
 * `AndroidPlatform` 自己从 {@code ApplicationInfo.nativeLibraryDir} 拼绝对路径，
 * 而那正是模块 APK 安装时解压出来的 `lib/<abi>/`（宿主进程能 dlopen）。
 *
 * <p><b>为什么 Python 跑在宿主进程而不是模块自己的进程</b>：
 * 一本 APK 一个进程的话，宿主就得用 startService 跨包调起（Android 11+ 还要
 * queries 声明）。而 Chaquopy 的 stdlib 只要拿到"模块的 Context"就能读到，
 * 不需要换进程 —— 少一层跨进程通信，端口协商也简单。
 * 代价是 Python 成为进程级单例（`Python.isStarted()`），宿主里只能有一份。
 */
public final class RuntimeEntry implements PythonRuntimeApi {

    private static final String TAG = "MeowPyRt";

    /** 模块包名。宿主与本模块必须一致（清单里也是这个）。 */
    public static final String PACKAGE = "com.meow.runtime.python";

    private volatile boolean ready;
    private volatile String version = "";

    @Override
    public String id() {
        return "python";
    }

    @Override
    public String versionName() {
        return "3.10.22";
    }

    @Override
    public int startServer(Object hostContext, String scriptsDir, int port, String drpyUpstream)
            throws Exception {
        if (!(hostContext instanceof Context host)) {
            throw new IllegalArgumentException("hostContext must be an android.content.Context");
        }
        /*
         * ★ 必须是"模块自己的 Context"：Chaquopy 用它的
         *   getAssets() 读 stdlib、用 getApplicationInfo().nativeLibraryDir 找 .so。
         *   传宿主的 Context 会在 import 第一个标准库模块时抛
         *   ModuleNotFoundError / FileNotFoundError，而错误信息里完全看不出
         *   是 Context 用错了。
         */
        Context mod = host.createPackageContext(PACKAGE, 0);
        if (!Python.isStarted()) {
            Python.start(new AndroidPlatform(mod));
        }
        Python py = Python.getInstance();
        try {
            version = String.valueOf(py.getModule("sys").get("version"));
        } catch (Throwable ignored) {
        }
        ready = true;
        Log.i(TAG, "python ready: " + version + ", scripts=" + scriptsDir + ", port=" + port);
        PyObject pyrt = py.getModule("pyrt");
        // 阻塞直到服务退出（与 node 的 startProcess 同一模型）
        pyrt.callAttr("serve", port, scriptsDir, drpyUpstream == null ? "" : drpyUpstream);
        return 0;
    }

    @Override
    public boolean ready() {
        return ready;
    }

    @Override
    public String pythonVersion() {
        return version;
    }
}
