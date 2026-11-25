package com.meow.runtime.python;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

/**
 * 探针：证明 CPython 3.10 + requests 能在 TV（MuMu x86_64 经 libnb 转译）上跑通。
 *
 * <p>为什么做成 Activity 而不是 Service：这一轮只验证「Chaquopy 链路可用」，
 * 不验证「主 app 怎么调它」。Activity 能被 `am start` 直接拉起，
 * 日志直接进 logcat，是最短的可观测路径。
 *
 * <p>正式形态应为 Service（见 README 的遗留项）：Chaquopy 的 stdlib 在**本 APK
 * 的 assets** 里，只有本进程的 AssetManager 读得到，所以 Python 必须跑在模块
 * 自己的进程内，宿主通过 HTTP（127.0.0.1:端口）与它通信。
 */
public class ProbeActivity extends Activity {

    private static final String TAG = "MeowPy";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        new Thread(() -> {
            try {
                Log.i(TAG, "starting Chaquopy...");
                if (!Python.isStarted()) {
                    Python.start(new AndroidPlatform(this));
                }
                Python py = Python.getInstance();
                PyObject sys = py.getModule("sys");
                Log.i(TAG, "python version = " + sys.get("version"));
                Log.i(TAG, "platform = " + sys.get("platform"));
                PyObject requests = py.getModule("requests");
                Log.i(TAG, "requests = " + requests.get("__version__"));
                PyObject urllib3 = py.getModule("urllib3");
                Log.i(TAG, "urllib3 = " + urllib3.get("__version__"));
                Log.i(TAG, "PROBE OK");
            } catch (Throwable t) {
                Log.e(TAG, "PROBE FAIL: " + t, t);
            }
        }, "py-probe").start();
    }
}
