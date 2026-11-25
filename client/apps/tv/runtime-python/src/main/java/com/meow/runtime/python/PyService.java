package com.meow.runtime.python;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import java.io.File;

/**
 * Python 服务：在**模块自己的进程**里跑 pyrt。
 *
 * <p><b>为什么必须在本进程</b>：Chaquopy 的 {@code AndroidPlatform} 要求
 * "assets 与 SharedPreferences 来自同一个 Application"——它构造时先
 * {@code mContext = context.getApplicationContext() as Application}，再
 * {@code mContext.getAssets().open("chaquopy/build.json")}。宿主进程里
 * {@code createPackageContext(模块包).getApplicationContext()} 返回 null，
 * 传宿主 Application 又读不到模块的 assets。两条路都死，所以 Python 只能在
 * 模块进程里跑（那里 getApplicationContext() 就是模块自己）。
 *
 * <p><b>代价</b>：宿主读不到模块的 filesDir（跨 uid），所以脚本由宿主 HTTP
 * POST 到 {@code /_put/<name>}，落到本进程可写的外部目录。
 *
 * <p><b>端口固定 19351</b>：跨进程传端口要么走广播要么走文件，都比"固定端口 +
 * 宿主探测 /health"复杂。宿主从 19351 起探 20 个，探到 {@code "service":"pyrt"}
 * 就是它。
 */
public class PyService extends Service {

    private static final String TAG = "MeowPySvc";
    public static final int PORT = 19351;

    private Thread worker;
    private volatile String drpyUpstream = "";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String d = intent.getStringExtra("drpy");
            if (d != null) drpyUpstream = d;
        }
        startWorker();
        return START_NOT_STICKY;
    }

    /**
     * 绑定入口。
     *
     * <p>宿主用 bindService 而不是 startService：Android 8+ 禁止从后台进程
     * 启动其他应用的 Service（实测 logcat：`Background start not allowed`），
     * 而绑定不受这条限制。绑定只触发 onCreate/onBind，不触发 onStartCommand，
     * 所以 boot 必须在这里也拉一次。
     *
     * <p>drpy 上游从 bind 的 Intent extra 里拿（onBind 能读到）。
     */
    @Override
    public IBinder onBind(Intent intent) {
        if (intent != null) {
            String d = intent.getStringExtra("drpy");
            if (d != null) drpyUpstream = d;
        }
        startWorker();
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        startWorker();
    }

    private synchronized void startWorker() {
        if (worker != null && worker.isAlive()) return;
        worker = new Thread(this::boot, "meow-py-svc");
        worker.start();
    }

    private void boot() {
        try {
            if (!Python.isStarted()) {
                // 本进程的 Application 就是本模块的 → assets / native 全对
                Python.start(new AndroidPlatform(getApplicationContext()));
            }
            Python py = Python.getInstance();
            File scripts = new File(getExternalFilesDir(null), "py-scripts");
            if (!scripts.isDirectory() && !scripts.mkdirs() && !scripts.isDirectory()) {
                Log.w(TAG, "cannot create " + scripts);
                return;
            }
            Log.i(TAG, "python " + py.getModule("sys").get("version")
                    + ", scripts=" + scripts + ", port=" + PORT + ", drpy=" + drpyUpstream);
            PyObject pyrt = py.getModule("pyrt");
            // 阻塞：serve_forever()
            pyrt.callAttr("serve", PORT, scripts.getAbsolutePath(), drpyUpstream);
            Log.i(TAG, "pyrt exited");
        } catch (Throwable t) {
            Log.e(TAG, "boot failed: " + t, t);
        }
    }
}
