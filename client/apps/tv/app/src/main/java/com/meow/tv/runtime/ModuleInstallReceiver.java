package com.meow.tv.runtime;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

/**
 * 运行时模块装好/更新后，自动把 `:node` 重启一次。
 *
 * <p><b>为什么必须有它</b>（2026-11-06 实测）：装完模块后什么都不发生 ——
 * 安装的是**另一个包**，我们的进程不会因此重启，`MainActivity.onCreate`
 * 里的 `startService` 也不会再跑一次。表现是"更新成功，但弹幕还是旧版本
 * 甚至没有弹幕"，用户必须手动重进应用或点「重启」。
 *
 * <p><b>为什么先 stop 再 start</b>：老 `:node` 进程里映射的是旧 APK 的
 * `libnode.so`（Android 已加载的 so 不会因为重装而替换）。不先停掉，
 * 新版本永远不会生效；而 `NodeService.onDestroy` 会自杀进程，所以
 * stop 之后必须等一小会再 start，否则 start 会落到正在销毁的进程上。
 */
public class ModuleInstallReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            String pkg = intent.getData() == null
                    ? "" : intent.getData().getSchemeSpecificPart();
            if (!RuntimeModuleHost.NODE_PACKAGE.equals(pkg)) return;
            android.util.Log.i("MeowNode", "module " + intent.getAction() + ", restarting :node");

            final Context app = ctx.getApplicationContext();
            /*
             * 必须先解绑：主进程持有 :node 的绑定（保活用），而「有客户端绑定」的
             * Service 对 stopService 免疫 —— 不解绑就停不掉，下面的 startService
             * 只会打到那个还在跑的旧实例上，模块更新等于没生效。
             */
            com.meow.tv.GatewayServer.unbindNodeRuntime(app);
            app.stopService(new Intent(app, NodeService.class));
            // onDestroy 里 killProcess 是异步的，等一拍再起
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    if (!RuntimeModuleState.enabled(app)) return;
                    com.meow.tv.GatewayServer.bindNodeRuntime(app);
                } catch (Throwable t) {
                    android.util.Log.w("MeowNode", "restart after install failed: " + t);
                }
            }, 1500);
        } catch (Throwable t) {
            android.util.Log.w("MeowNode", "ModuleInstallReceiver failed: " + t);
        }
    }
}
