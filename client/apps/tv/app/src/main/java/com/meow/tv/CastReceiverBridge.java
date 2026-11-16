package com.meow.tv;

import android.app.Activity;
import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.File;
import java.lang.ref.WeakReference;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 把共享的 {@code core.CastReceiver} 接到 Android。
 *
 * <p><b>为什么在主进程启动</b>：会话状态与"播放器桥"必须在同一个进程里，
 * 否则投屏命令（暂停/seek）跨不到播放 Activity。网关虽然是独立进程，但
 * 网页上报进度走 HTTP（{@code /api/cast/progress}），只认会话状态所在进程。
 *
 * <p><b>MulticastLock 必须拿</b>：Android 的 WiFi 驱动默认过滤多播，
 * 不拿锁收不到任何 SSDP M-SEARCH（表现为"设备永远发现不了我们"）。
 */
final class CastReceiverBridge {

    private static final String TAG = "MeowCast";
    private static boolean installed;
    private static WifiManager.MulticastLock lock;
    /** 没有播放页时用它弹"是否允许投屏"（MainActivity）。 */
    private static WeakReference<Activity> host;
    /** 首投确认走页面里的 confirmDialog（不再用原生 AlertDialog）。 */
    private static WeakReference<WebView> web;

    private static final class Pending {
        final CountDownLatch latch = new CountDownLatch(1);
        volatile boolean allow;
        volatile boolean done;
    }

    private static final Map<String, Pending> PENDING = new ConcurrentHashMap<>();

    private CastReceiverBridge() {
    }

    static void attach(Activity activity) {
        host = new WeakReference<>(activity);
    }

    static void attachWeb(WebView view) {
        web = new WeakReference<>(view);
    }

    /** 页面 confirmDialog 的结果回填；超时后到达的迟到结果会被忽略。 */
    static void resolveConfirm(String id, boolean allow) {
        Pending p = id == null ? null : PENDING.get(id);
        if (p == null || p.done) return;
        p.allow = allow;
        p.done = true;
        p.latch.countDown();
    }

    static synchronized void install(Context ctx) {
        if (installed) return;
        installed = true;
        /*
         * DataPaths 是进程级静态量：网关进程早已指到 filesDir/gateway，
         * 主进程必须自己再设一次，否则 UDN/设备名会落到 cwd（Android 上不可写）。
         */
        try {
            core.DataPaths.MainArgs.set(new String[]{
                    "--data-dir=" + new File(ctx.getFilesDir(), "gateway").getAbsolutePath()
            });
        } catch (Throwable t) {
            Log.w(TAG, "data dir init failed", t);
        }
        try {
            WifiManager wm = (WifiManager) ctx.getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                lock = wm.createMulticastLock("meow-cast");
                lock.setReferenceCounted(false);
                core.CastReceiver.get().setMulticastLock(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            if (!lock.isHeld()) lock.acquire();
                        } catch (Throwable ignored) {
                        }
                    }
                }, new Runnable() {
                    @Override
                    public void run() {
                        try {
                            if (lock.isHeld()) lock.release();
                        } catch (Throwable ignored) {
                        }
                    }
                });
            }
        } catch (Throwable t) {
            Log.w(TAG, "multicast lock failed", t);
        }
        core.CastReceiver.get().setPlayer(new PlayerImpl(ctx.getApplicationContext()));
        core.CastReceiver.get().start();
    }

    /** 接收页路由：带媒体、弹幕地址，以及接收端自己的 loopback 基地址与令牌。 */
    private static String castRoute(JSONObject media, int position) {
        StringBuilder sb = new StringBuilder("#/ext-play?");
        sb.append("sessionId=").append(enc(core.CastReceiver.get().sessionId()));
        sb.append("&url=").append(enc(media.optString("url", "")));
        sb.append("&title=").append(enc(media.optString("title", "")));
        String dm = media.optString("danmakuUrl", "");
        if (!dm.isEmpty()) sb.append("&danmakuUrl=").append(enc(dm));
        sb.append("&position=").append(Math.max(0, position));
        sb.append("&castApi=").append(enc("http://127.0.0.1:" + core.CastReceiver.get().port()));
        sb.append("&ct=").append(enc(core.CastLan.token()));
        return sb.toString();
    }

    /**
     * 双重编码：intent 的 fragment 会被 {@code Uri.getFragment()} **解码一次**，
     * 单层编码会让嵌套 URL 里的 `&`/`=` 变成外层 query 的分隔符（弹幕地址因此丢失）。
     * 解码一次后仍是 `%3A%2F...`，Vue 再解一次就还原。
     */
    private static String enc(String s) {
        try {
            String once = java.net.URLEncoder.encode(s == null ? "" : s, "UTF-8")
                    .replace("+", "%20");
            return java.net.URLEncoder.encode(once, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return "";
        }
    }

    /** WebView 接收页：保留弹幕/跳片头；castApi/ct 指向接收端自己的 loopback。 */
    private static final class PlayerImpl implements core.CastReceiver.Player {
        private final Context ctx;

        PlayerImpl(Context c) {
            ctx = c;
        }

        @Override
        public boolean open(JSONObject media, int position) {
            if (media == null) return false;
            String url = media.optString("url", "");
            if (url.isEmpty()) return false;
            MainActivity.castOpen(ctx, castRoute(media, position));
            return true;
        }

        /*
         * 播放/暂停/seek 由 WebView 接收页自己跟随会话状态（它每 1.2s 轮询一次），
         * 原生层不需要再动手；stop 由会话清空后页面自行退出。
         */
        @Override
        public void pause() {
        }

        @Override
        public void play() {
        }

        @Override
        public void seek(int position) {
        }

        @Override
        public void stop() {
        }

        /**
         * 首投确认：不再弹原生 AlertDialog，改为调用页面里的 confirmDialog。
         *
         * <p>原生只负责「发请求 + 等结果」：页面里的弹框跟主题一致，而且
         * 遥控方向键 / OK 键走全站同一套 focus 逻辑（ConfirmDialog 的
         * data-tv-scope + data-tv-first）。20 秒没点就调 __meowCastCancel
         * 让页面把框收掉——实测原生弹框超时后不会自己消失，会一直压着。
         */
        @Override
        public boolean confirm(String senderName) {
            Activity a = host == null ? null : host.get();
            WebView w = web == null ? null : web.get();
            // 页面还没准备好（冷启动瞬间）：保持旧行为放行，别把首投卡死
            if (a == null || w == null) return true;
            final String id = UUID.randomUUID().toString();
            final Pending p = new Pending();
            PENDING.put(id, p);
            final String who = senderName == null ? "" : senderName;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        w.evaluateJavascript(
                                "window.__meowCastConfirm&&window.__meowCastConfirm("
                                        + JSONObject.quote(who) + "," + JSONObject.quote(id) + ")",
                                null);
                    } catch (Throwable t) {
                        p.allow = true;
                        p.done = true;
                        p.latch.countDown();
                    }
                }
            });
            try {
                p.latch.await(20, TimeUnit.SECONDS);
            } catch (Throwable ignored) {
            }
            if (!p.done) {
                // 超时：先标 done（迟到结果不再生效），再让页面收起弹框
                p.done = true;
                a.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            w.evaluateJavascript(
                                    "window.__meowCastCancel&&window.__meowCastCancel("
                                            + JSONObject.quote(id) + ")",
                                    null);
                        } catch (Throwable ignored) {
                        }
                    }
                });
            }
            PENDING.remove(id);
            return p.allow;
        }
    }
}
