package com.meow.tv;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * 端内网关的独立进程宿主（`android:process=":spider"`）。
 *
 * <p><b>为什么需要它</b>（2026-11-05 真机结论）：投影仪（32 位 ART）在
 * "聚合搜索"时会命中系统 ART 的一致性断言，`HeapTaskDaemon` 直接 SIGABRT。
 * 应用层修不了 GC，只能把触发面挪出主进程：
 *
 * <ul>
 *   <li>主进程 = UI + WebView（崩不了，因为不跑 spider）</li>
 *   <li>本服务进程 = 纯 Java + jar（与 Fongmi 的进程画像一致），崩了由系统
 *       按 {@link #START_STICKY} 重启，前端只会看到一次「正在重连」</li>
 * </ul>
 *
 * <p>进程间唯一通道就是网关自己的 HTTP（127.0.0.1:9978），所以 UI 侧代码
 * 一行不用改；探活判据用"端口能连上"，不能用 {@link GatewayServer#isRunning()}
 * （那个静态标记只在启动它的进程里有意义）。
 */
public class GatewayService extends Service {

    /** 导入配置后要求重建网关（旧 loader / 站点表作废）。 */
    static final String ACTION_RESTART = "com.meow.tv.action.GATEWAY_RESTART";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        GatewayServer.markServiceProcess();
        if (ACTION_RESTART.equals(intent == null ? null : intent.getAction())) {
            new Thread(() -> {
                android.util.Log.i("MeowTv", "GatewayService restart="
                        + GatewayServer.restartInProcess(getApplicationContext()));
            }, "meow-gateway-restart").start();
            return START_STICKY;
        }
        // ApiServer.boot + 44 个站点注册是重活，别占主线程（服务进程也有主线程）
        new Thread(() -> {
            boolean up = GatewayServer.startInProcess(getApplicationContext());
            android.util.Log.i("MeowTv", "GatewayService gateway=" + (up ? "up" : "FAILED"));
        }, "meow-gateway-svc").start();
        // 被系统回收后自动重建：网关是"随时可重启"的纯服务，粘性重建最省心
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
