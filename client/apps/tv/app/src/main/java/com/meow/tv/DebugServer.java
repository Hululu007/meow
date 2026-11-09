package com.meow.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 局域网远程调试服务：让 PC 直接验收投影仪上的应用。
 *
 * <p><b>为什么需要它</b>：这台投影仪没有 adb 开关，验收时"看得见画面、拿不到状态"
 * ——想确认页面走到了哪一页、图片有没有加载、某个按钮点下去有没有反应，都只能靠
 * 人盯着屏幕猜。这里把 WebView 的只读状态、任意 JS 执行、截图和遥控按键暴露成一个
 * 带令牌的 HTTP 接口，PC 上 curl 一条就能拿到证据。
 *
 * <p><b>为什么绑 0.0.0.0 而不是 127.0.0.1</b>：PC 与投影仪是两台机器，回环地址
 * 从 PC 根本连不上（与 {@link GatewayServer} 不同——那个是给壳内 WebView 用的）。
 * 绑定全网卡意味着整个局域网都能连，所以默认关闭、必须显式开、且必须带令牌：
 * {@code X-Meow-Token} 不匹配一律 403，没令牌时 {@link #start} 直接拒绝启动。
 *
 * <p><b>为什么端口从 9977 起、被占顺延</b>：9333 是 {@link PushServer}、9978 是
 * {@link GatewayServer}、9339-9346/9455 被 PC 端 MCP 占用。电视上这些服务不会
 * 同时都在跑，但验收时很可能 PushServer 正开着（配置页扫码），所以用一段
 * 空闲区间并从 9977 起顺延；9978 在顺延区间里，必须显式跳过。
 *
 * <p><b>为什么不引 HTTP 库</b>：只五个端点，手写 400 行就够；引 NanoHTTPD
 * 会给 APK 加依赖，而 TV 包的体积与老内核兼容性是硬约束。
 */
final class DebugServer {

    private static final String TAG = "MeowDebug";

    /** 起始端口；实际端口可能因被占而顺延，以 {@link #port()} 为准。 */
    static final int BASE_PORT = 9977;

    /** 顺延窗口：20 个端口足够，再占用说明这台设备上跑着别的东西。 */
    private static final int PORT_TRIES = 20;

    /** 端内网关固定占 9978，顺延到这里必须跳过而不是硬撞。 */
    private static final int GATEWAY_PORT = 9978;

    /** eval 的 js 可能带一大段代码，8KB（PushServer 的 body 上限）不够。 */
    private static final int MAX_BODY = 256 * 1024;

    private static final int MAX_SHOTS = 20;

    /**
     * 远程调试对 WebView 的接入点。
     *
     * <p>所有方法都从 HTTP 工作线程调用，**实现方必须自己切到 UI 线程**——
     * WebView 的任何方法在非 UI 线程上调用都是未定义行为。
     */
    interface Host {
        /** 当前 WebView 的 URL；WebView 还不存在时返回空串。 */
        String currentUrl();

        /**
         * 执行 JS 并同步等结果。
         *
         * @return evaluateJavascript 的原始 JSON 文本；超时或 WebView 不可用返回 null
         */
        String evalJs(String js);

        /** 把 WebView 当前画面画进一张新 Bitmap；不可用时返回 null。 */
        Bitmap screenshot();

        /** 模拟一次遥控按键（按下+抬起）。@return 是否被消费 */
        boolean sendKey(int keyCode);

        /** 模拟返回键。合成 KeyEvent 的 tracking 旗标不可靠，直接走 Activity 的返回逻辑。 */
        void pressBack();
    }

    private static ServerSocket socket;
    private static Thread thread;
    private static ExecutorService pool;
    private static int port;
    private static String lanIp = "";
    private static volatile boolean running;
    private static long startedAt;
    private static volatile Host host;
    private static volatile String token = "";
    private static Context appCtx;

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private DebugServer() {
    }

    static boolean isRunning() {
        return running;
    }

    static int port() {
        return port;
    }

    static String lanIp() {
        return lanIp;
    }

    /** 当前生效的令牌；未运行时为空串。MainActivity 据此判断要不要重启服务。 */
    static String token() {
        return token;
    }

    /** 给人看的地址；没有局域网地址时退回回环（至少本机能验收）。 */
    static String url() {
        String ip = lanIp.isEmpty() ? "127.0.0.1" : lanIp;
        return "http://" + ip + ":" + port;
    }

    /** 16 个十六进制字符，够抗局域网内盲猜；每次开启开关都换一个新的。 */
    static String newToken() {
        byte[] b = new byte[8];
        new SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder(16);
        for (byte x : b) {
            sb.append(HEX[(x >> 4) & 0xf]).append(HEX[x & 0xf]);
        }
        return sb.toString();
    }

    static synchronized boolean start(Context ctx, Host h, String tok) {
        if (running) return true;
        if (tok == null || tok.isEmpty()) {
            // 没有令牌还监听全网卡，等于把「任意 JS 执行」交给整个局域网。宁可不启动。
            Log.w(TAG, "refuse to start without token");
            return false;
        }
        appCtx = ctx.getApplicationContext();
        host = h;
        token = tok;
        try {
            ServerSocket ss = null;
            int p = BASE_PORT;
            for (int i = 0; i < PORT_TRIES; i++) {
                int candidate = BASE_PORT + i;
                if (candidate == GATEWAY_PORT) continue;
                try {
                    // 不传 InetAddress：单参构造就是绑通配地址（0.0.0.0），
                    // 顺带避免在 UI 线程上做一次不必要的地址解析
                    ss = new ServerSocket(candidate, 16);
                    p = candidate;
                    break;
                } catch (Exception ignored) {
                }
            }
            if (ss == null) {
                Log.w(TAG, "all ports busy from " + BASE_PORT);
                host = null;
                token = "";
                return false;
            }
            final ServerSocket server = ss;
            socket = ss;
            port = p;
            // 枚举网卡放在绑定之后：它是纯展示信息，不该拖慢"端口已经通了"这件事
            lanIp = findLanIp();
            startedAt = System.currentTimeMillis();
            running = true;
            pool = Executors.newFixedThreadPool(4);
            thread = new Thread(() -> {
                while (running) {
                    try {
                        Socket s = server.accept();
                        ExecutorService ex = pool;
                        if (ex == null) {
                            s.close();
                            break;
                        }
                        ex.submit(() -> handle(s));
                    } catch (Exception e) {
                        if (!running) break;
                    }
                }
            }, "meow-debug");
            thread.setDaemon(true);
            thread.start();
            Log.i(TAG, "debug server on " + url());
            return true;
        } catch (Exception e) {
            running = false;
            socket = null;
            thread = null;
            host = null;
            token = "";
            Log.w(TAG, "start failed", e);
            return false;
        }
    }

    static synchronized void stop() {
        running = false;
        try {
            if (socket != null) socket.close();
        } catch (Exception ignored) {
        }
        socket = null;
        thread = null;
        // 正在处理的请求持有 Host 的局部引用，shutdownNow 只打断排队中的任务；
        // 不 awaitTermination 是因为调用点在 UI 线程（onDestroy），不能阻塞。
        if (pool != null) {
            pool.shutdownNow();
            pool = null;
        }
        host = null;
        appCtx = null;
        token = "";
    }

    // ---------------------------------------------------------------- 请求处理

    private static void handle(Socket s) {
        // 抓局部引用：stop() 可能在本请求处理中途把静态字段清空
        final Host h = host;
        final String tok = token;
        final Context ctx = appCtx;
        try (Socket sock = s) {
            sock.setSoTimeout(20000);
            InputStream in = sock.getInputStream();
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            int m1 = 0, m2 = 0, m3 = 0, m4 = 0, b;
            // 逐字节读到 \r\n\r\n：请求头都很小，且这样不必猜缓冲区大小
            while ((b = in.read()) != -1) {
                head.write(b);
                m1 = m2;
                m2 = m3;
                m3 = m4;
                m4 = b;
                if (m1 == '\r' && m2 == '\n' && m3 == '\r' && m4 == '\n') break;
                if (head.size() > 64 * 1024) break;
            }
            String header = new String(head.toByteArray(), StandardCharsets.UTF_8);
            String[] lines = header.split("\r\n");
            if (lines.length < 1) return;
            String[] req = lines[0].split(" ");
            if (req.length < 2) {
                sendJson(sock, 400, "{\"ok\":false,\"error\":\"bad request line\"}");
                return;
            }
            String method = req[0].toUpperCase();
            String full = req[1];
            int q = full.indexOf('?');
            String path = q < 0 ? full : full.substring(0, q);
            Map<String, String> query = q < 0
                    ? Collections.<String, String>emptyMap() : parseQuery(full.substring(q + 1));

            int contentLength = 0;
            String gotToken = "";
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c <= 0) continue;
                String k = lines[i].substring(0, c).trim().toLowerCase();
                String v = lines[i].substring(c + 1).trim();
                if ("content-length".equals(k)) {
                    try {
                        contentLength = Integer.parseInt(v);
                    } catch (NumberFormatException ignored) {
                    }
                } else if ("x-meow-token".equals(k)) {
                    gotToken = v;
                }
            }
            byte[] body = readBody(in, contentLength);

            // 鉴权在最前面：所有方法（含 OPTIONS）都必须带令牌，与"任何请求都要 token"一致。
            // 代价是浏览器跨域预检拿不到响应（预检按规范不能带自定义头），
            // 而本服务的目标调用方是 PC 上的 curl / 脚本，不受影响。
            if (!tokenOk(gotToken, tok)) {
                // 用 403 而不是 401 + WWW-Authenticate：这里要的是"带对头"，
                // 不是让浏览器弹一个用户根本不知道密码的登录框
                sendJson(sock, 403,
                        "{\"ok\":false,\"error\":\"forbidden\",\"hint\":\"missing or wrong X-Meow-Token\"}");
                return;
            }
            if ("OPTIONS".equals(method)) {
                send(sock, 204, "text/plain", new byte[0]);
                return;
            }
            if (h == null) {
                sendJson(sock, 503, "{\"ok\":false,\"error\":\"service stopping\"}");
                return;
            }

            if ("/health".equals(path)) {
                if (!"GET".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use GET\"}");
                    return;
                }
                sendJson(sock, 200, healthJson(ctx, h));
                return;
            }
            if ("/state".equals(path)) {
                if (!"GET".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use GET\"}");
                    return;
                }
                String value = safeEval(h, STATE_JS);
                if (value == null) {
                    sendJson(sock, 503, "{\"ok\":false,\"error\":\"webview not ready or eval timeout\"}");
                    return;
                }
                send(sock, 200, "application/json; charset=utf-8", value.getBytes(StandardCharsets.UTF_8));
                return;
            }
            if ("/eval".equals(path)) {
                if (!"POST".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use POST\"}");
                    return;
                }
                String js;
                try {
                    js = new JSONObject(new String(body, StandardCharsets.UTF_8)).optString("js", "");
                } catch (Exception e) {
                    sendJson(sock, 400, "{\"ok\":false,\"error\":\"body must be {\\\"js\\\":\\\"...\\\"}\"}");
                    return;
                }
                if (js.isEmpty()) {
                    sendJson(sock, 400, "{\"ok\":false,\"error\":\"js required\"}");
                    return;
                }
                String value = safeEval(h, js);
                if (value == null) {
                    sendJson(sock, 500, "{\"ok\":false,\"error\":\"eval timeout or webview not ready\"}");
                    return;
                }
                // 原样返回 evaluateJavascript 的 JSON 文本：字符串带引号、对象就是 JSON。
                // 不包一层是刻意的——验收时要能直接对比页面返回的原始值。
                send(sock, 200, "text/plain; charset=utf-8", value.getBytes(StandardCharsets.UTF_8));
                return;
            }
            if ("/screenshot".equals(path)) {
                if (!"GET".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use GET\"}");
                    return;
                }
                Bitmap bmp = h.screenshot();
                if (bmp == null) {
                    sendJson(sock, 503, "{\"ok\":false,\"error\":\"webview not ready\"}");
                    return;
                }
                int w = bmp.getWidth();
                int hgt = bmp.getHeight();
                ByteArrayOutputStream png = new ByteArrayOutputStream();
                boolean ok = bmp.compress(Bitmap.CompressFormat.PNG, 100, png);
                boolean blank = probablyBlank(bmp);
                bmp.recycle();
                if (!ok) {
                    sendJson(sock, 500, "{\"ok\":false,\"error\":\"png encode failed\"}");
                    return;
                }
                byte[] bytes = png.toByteArray();
                String saved = null;
                if ("1".equals(query.get("save")) && ctx != null) saved = savePng(ctx, bytes);
                StringBuilder out = new StringBuilder(1024);
                out.append("{\"ok\":true,\"width\":").append(w)
                        .append(",\"height\":").append(hgt)
                        .append(",\"bytes\":").append(bytes.length)
                        // 硬件加速下 WebView.draw 可能只画出一张纯色图。与其让调用方
                        // 拿到一张"看起来对"的黑图去猜，不如直接标出来。
                        .append(",\"possiblyBlank\":").append(blank)
                        .append(",\"png\":\"").append(Base64.encodeToString(bytes, Base64.NO_WRAP)).append('"');
                if (saved != null) out.append(",\"savedTo\":").append(jsonStr(saved));
                out.append('}');
                sendJson(sock, 200, out.toString());
                return;
            }
            if ("/key".equals(path) || "/keys".equals(path)) {
                /*
                 * 遥控器按键。
                 *
                 * <pre>
                 * POST /key   {"key":"up","n":3}      （原接口，保留）
                 * GET  /key?k=up&amp;n=3                  （简写：curl 一行即可，不用拼 JSON）
                 * GET  /keys?seq=down,down,right,ok   （连按序列：调试走多级菜单最常用）
                 * </pre>
                 *
                 * k 与 key、n 与 count 都认：调试脚本里两种写法都有人写，
                 * 不统一容易"传了没反应"。
                 */
                String key = "";
                int times = 1;
                String seq = "";
                if ("GET".equals(method)) {
                    key = firstNonEmpty(query.get("k"), query.get("key"));
                    times = parseIntSafe(firstNonEmpty(query.get("n"), query.get("count")), 1);
                    seq = query.getOrDefault("seq", "");
                } else if ("POST".equals(method)) {
                    try {
                        // 变量名不能叫 in：handle() 里已有一个 InputStream in（踩过）
                        JSONObject kbody = new JSONObject(new String(body, StandardCharsets.UTF_8));
                        key = kbody.optString("key", kbody.optString("k", ""));
                        times = kbody.optInt("n", kbody.optInt("count", 1));
                    } catch (Exception e) {
                        sendJson(sock, 400, "{\"ok\":false,\"error\":\"body must be {\\\"key\\\":\\\"up|down|left|right|ok|back|menu\\\",\\\"n\\\":1}\"}");
                        return;
                    }
                } else {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use GET or POST\"}");
                    return;
                }

                // 连按序列：seq=down,down,right,ok
                if (!seq.isEmpty()) {
                    StringBuilder done = new StringBuilder();
                    boolean allOk = true;
                    for (String raw : seq.split(",")) {
                        String one = raw.trim().toLowerCase();
                        if (one.isEmpty()) continue;
                        if (!pressOne(h, one)) {
                            allOk = false;
                            sendJson(sock, 400, "{\"ok\":false,\"error\":\"unknown key in seq\","
                                    + "\"key\":" + jsonStr(one) + ",\"done\":" + jsonStr(done.toString()) + "}");
                            return;
                        }
                        done.append(done.length() > 0 ? "," : "").append(one);
                        // 每次之间留一点间隔：页面要跑一遍几何选焦 + Vue 重渲染，
                        // 连着发会在同一帧里互相覆盖，看起来像"只动了一步"。
                        try {
                            Thread.sleep(120);
                        } catch (InterruptedException ignored) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    String seqFocus = safeEval(h, FOCUS_JS);
                    sendJson(sock, 200, "{\"ok\":" + allOk + ",\"seq\":" + jsonStr(done.toString())
                            + ",\"count\":" + done.toString().split(",").length
                            + ",\"focus\":" + (seqFocus == null ? "null" : seqFocus) + "}");
                    return;
                }

                key = key.trim().toLowerCase();
                if (key.isEmpty()) {
                    sendJson(sock, 400, "{\"ok\":false,\"error\":\"key required\","
                            + "\"keys\":[\"up\",\"down\",\"left\",\"right\",\"ok\",\"back\",\"menu\"]}");
                    return;
                }
                if (times < 1) times = 1;
                if (times > 30) times = 30; // 防手滑写 1000 把页面卡死
                if ("back".equals(key)) {
                    // 返回键没有"连按"语义（再按就退出应用了），一律只按一次
                    h.pressBack();
                    sendJson(sock, 200, "{\"ok\":true,\"key\":\"back\",\"n\":1}");
                    return;
                }
                int code = keyCode(key);
                if (code == 0) {
                    sendJson(sock, 400,
                            "{\"ok\":false,\"error\":\"unknown key\",\"keys\":[\"up\",\"down\",\"left\",\"right\",\"ok\",\"back\",\"menu\"]}");
                    return;
                }
                boolean handled = false;
                for (int i = 0; i < times; i++) {
                    handled = h.sendKey(code);
                    if (i + 1 < times) {
                        try {
                            Thread.sleep(120);
                        } catch (InterruptedException ignored) {
                            Thread.currentThread().interrupt();
                            break;
                        }
                    }
                }
                // handled 只说明"壳消费了这个按键"，不代表焦点真的移动了：
                // 已经在网格最后一行时按 down，壳照样吞掉按键，但焦点纹丝不动。
                // 调试时这个区别很重要（"为什么按了没反应"），所以额外读一次焦点，
                // 把焦点文本/坐标一起带回去。读不到就省略，不影响主流程。
                String where = safeEval(h, FOCUS_JS);
                String extra = where == null ? "" : ",\"focus\":" + where;
                sendJson(sock, 200, "{\"ok\":true,\"key\":" + jsonStr(key)
                        + ",\"n\":" + times + ",\"handled\":" + handled + extra + "}");
                return;
            }
            // 焦点现状：当前哪个元素带 meow-tv-focus + 它是不是还在视口里。
            // 电视上"不知道选到哪里"只能靠这个断言，截图看不出来。
            if ("/focus".equals(path)) {
                if (!"GET".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use GET\"}");
                    return;
                }
                send(sock, 200, "application/json; charset=utf-8",
                        utf8(safeEval(h, FOCUS_JS)));
                return;
            }
            // ────────────────────────────────────────────────────────────
            // 以下端点与 PC 的 pc_* 工具对齐，补齐 TV 端验收真正需要的几项。
            // 共同点：都建立在 /eval 之上——把前端已有的调试接口暴露出来，
            // 不在原生侧重复实现一遍业务逻辑。
            // ────────────────────────────────────────────────────────────

            // /console ≈ pc_console：页面的 JS 错误。
            // 前端 diagnostics.ts 已在采集（window.__meowDiag），这里只转发。
            // 这是 TV 黑屏/白屏排查的第一手材料：语法错误不触发 onReceivedError。
            if ("/console".equals(path) || "/network".equals(path)) {
                if (!"GET".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use GET\"}");
                    return;
                }
                String v = safeEval(h, diagJs("/console".equals(path) ? "errors" : "net"));
                send(sock, 200, "application/json; charset=utf-8",
                        unwrap(v).getBytes(StandardCharsets.UTF_8));
                return;
            }

            // /danmaku ≈ pc_danmaku：弹幕渲染器状态。
            // 弹幕画在 canvas 上，DOM 读不到，只能问实例本身。
            // mounted=false 表示播放器未挂载（不在播放页，或组件已销毁）。
            if ("/danmaku".equals(path)) {
                if (!"GET".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use GET\"}");
                    return;
                }
                send(sock, 200, "application/json; charset=utf-8",
                        unwrap(safeEval(h, DANMAKU_JS)).getBytes(StandardCharsets.UTF_8));
                return;
            }

            // /dom ≈ pc_dom：可点元素与可见文本摘要，供脚本定位焦点/按钮。
            if ("/dom".equals(path)) {
                if (!"GET".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use GET\"}");
                    return;
                }
                send(sock, 200, "application/json; charset=utf-8",
                        unwrap(safeEval(h, DOM_JS)).getBytes(StandardCharsets.UTF_8));
                return;
            }

            // /perf ≈ pc_perf：导航各阶段耗时与资源概况。
            if ("/perf".equals(path)) {
                if (!"GET".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use GET\"}");
                    return;
                }
                send(sock, 200, "application/json; charset=utf-8",
                        unwrap(safeEval(h, PERF_JS)).getBytes(StandardCharsets.UTF_8));
                return;
            }

            // /navigate ≈ pc_navigate：切路由。TV 没有地址栏，这是直达某页的唯一办法。
            // body: {"hash":"#/settings"}
            if ("/navigate".equals(path)) {
                if (!"POST".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use POST\"}");
                    return;
                }
                String hash;
                try {
                    hash = new JSONObject(new String(body, StandardCharsets.UTF_8)).optString("hash", "");
                } catch (Exception e) {
                    sendJson(sock, 400, "{\"ok\":false,\"error\":\"body must be {\\\"hash\\\":\\\"#/...\\\"}\"}");
                    return;
                }
                if (hash.isEmpty()) {
                    sendJson(sock, 400, "{\"ok\":false,\"error\":\"hash required\"}");
                    return;
                }
                String v = safeEval(h, "(function(){try{location.hash=" + jsonStr(hash)
                        + ";return JSON.stringify({ok:true,hash:location.hash})}"
                        + "catch(e){return JSON.stringify({ok:false,error:e.message})}})()");
                send(sock, 200, "application/json; charset=utf-8",
                        unwrap(v).getBytes(StandardCharsets.UTF_8));
                return;
            }

            // /wait ≈ pc_wait：轮询一个 JS 表达式直到为真。
            // 验收脚本里等「数据加载完 / 面板打开」全靠它，比固定 sleep 稳得多。
            // body: {"js":"...","timeout_ms":15000,"interval_ms":300}
            if ("/wait".equals(path)) {
                if (!"POST".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use POST\"}");
                    return;
                }
                String js;
                long timeoutMs;
                long intervalMs;
                try {
                    // 变量名不能叫 b：handle() 开头已用 int b 逐字节读请求头
                    JSONObject wq = new JSONObject(new String(body, StandardCharsets.UTF_8));
                    js = wq.optString("js", "");
                    timeoutMs = wq.optLong("timeout_ms", 15000);
                    intervalMs = wq.optLong("interval_ms", 300);
                } catch (Exception e) {
                    sendJson(sock, 400, "{\"ok\":false,\"error\":\"body must be {\\\"js\\\":\\\"...\\\"}\"}");
                    return;
                }
                if (js.isEmpty()) {
                    sendJson(sock, 400, "{\"ok\":false,\"error\":\"js required\"}");
                    return;
                }
                // 上限卡住：调用方给一个巨大 timeout 会把这条连接占死
                if (timeoutMs <= 0 || timeoutMs > 60000) timeoutMs = 60000;
                if (intervalMs < 100) intervalMs = 100;
                long deadline = System.currentTimeMillis() + timeoutMs;
                String last = "";
                boolean ok = false;
                int tries = 0;
                while (System.currentTimeMillis() < deadline) {
                    tries++;
                    String v = safeEval(h, "(function(){try{return (" + js + ")?'1':'0'}"
                            + "catch(e){return 'err:'+e.message}})()");
                    last = v == null ? "" : v.replace("\"", "").trim();
                    if ("1".equals(last)) {
                        ok = true;
                        break;
                    }
                    try {
                        Thread.sleep(intervalMs);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                sendJson(sock, 200, "{\"ok\":" + ok + ",\"tries\":" + tries
                        + ",\"last\":" + jsonStr(last) + "}");
                return;
            }

            // /gateway：TV 本地网关（9978）状态。PC 那边对应 pc_plugins。
            // TV 没有插件概念，能执行的是本地 jar 站点，所以报网关与站点数。
            if ("/gateway".equals(path)) {
                if (!"GET".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use GET\"}");
                    return;
                }
                boolean gw = false;
                int gwPort = 0;
                int locals = 0;
                try {
                    gw = GatewayServer.isRunning();
                    gwPort = GatewayServer.port();
                } catch (Throwable ignored) {
                }
                try {
                    if (ctx != null) {
                        LocalSites.load(ctx);
                        locals = LocalSites.size();
                    }
                } catch (Throwable ignored) {
                }
                sendJson(sock, 200, "{\"ok\":true,\"gatewayRunning\":" + gw
                        + ",\"gatewayPort\":" + gwPort + ",\"localSites\":" + locals
                        + ",\"lastError\":" + jsonStr(LocalSpiderHost.lastError()) + "}");
                return;
            }

            // /mcp：MCP 的 JSON-RPC 端点，与 PC 端 mcp.rs 同一套报文格式。
            //
            // 为什么在 REST 之上再包一层而不是改成纯 MCP：
            //   REST 端点已被那些在投影仪旁敲 curl 的人用着，改了就是破坏；
            //   而统一协议的价值是"一套客户端能同时驱动 PC 和 TV"。
            //   两者并存，MCP 只是 REST 的另一个入口，底层仍是同一批函数。
            if ("/mcp".equals(path)) {
                if (!"POST".equals(method)) {
                    sendJson(sock, 405, "{\"ok\":false,\"error\":\"use POST\"}");
                    return;
                }
                send(sock, 200, "application/json; charset=utf-8",
                        handleMcp(new String(body, StandardCharsets.UTF_8), h)
                                .getBytes(StandardCharsets.UTF_8));
                return;
            }

            sendJson(sock, 404,
                    "{\"ok\":false,\"error\":\"not found\",\"endpoints\":[\"GET /health\",\"GET /state\","
                            + "\"POST /eval\",\"GET /screenshot\",\"POST /key\","
                            + "\"GET /console\",\"GET /network\",\"GET /danmaku\",\"GET /dom\","
                            + "\"GET /perf\",\"POST /navigate\",\"POST /wait\",\"GET /gateway\"]}");
        } catch (Throwable t) {
            Log.w(TAG, "handle failed", t);
        }
    }

    /** 对当前页面执行只读 JS 取状态。返回对象时 evaluateJavascript 直接给出 JSON。 */
    /**
     * 把 {@code evaluateJavascript} 的原始返回解成纯 JSON 文本。
     *
     * <p>页面的 JS 若返回字符串，WebView 给的是一层带引号的 JSON 字符串
     * （{@code "{\"ok\":true}"}）；若返回对象则是裸 JSON。两种都要能发给调用方，
     * 否则脚本得为每个端点写一套解析。
     */
    private static String unwrap(String evalResult) {
        if (evalResult == null) return "{\"ok\":false,\"error\":\"webview not ready or eval timeout\"}";
        String s = evalResult.trim();
        if (s.isEmpty() || "null".equals(s)) return "{\"ok\":false,\"error\":\"eval returned null\"}";
        if (s.startsWith("\"")) {
            try {
                return new JSONObject("{\"v\":" + s + "}").optString("v", "{}");
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":\"bad eval result\"}";
            }
        }
        return s;
    }

    // ------------------------------------------------------------ MCP

    /**
     * MCP（JSON-RPC 2.0）入口，报文格式与 PC 端 {@code mcp.rs} 完全一致。
     *
     * <p><b>为什么 TV 也做 MCP</b>：REST 端点够用，但 PC 和 TV 两套协议意味着
     * 每个验收脚本都得写两份。统一之后一个客户端（{@code smoke/meow_mcp.py}）
     * 能同时驱动两端，工具名只差 {@code pc_}/{@code tv_} 前缀。
     *
     * <p><b>为什么工具是 REST 的封装而不是重写</b>：两端行为必须一致，
     * 重写一份等于制造第二个真相来源。这里每个工具都转调同一批底层函数。
     *
     * <p><b>鉴权仍走外层</b>：MCP 请求和其它端点一样要带 {@code X-Meow-Token}，
     * 在 handle() 开头统一校验。补 MCP 不能成为绕过令牌的入口。
     */
    private static String handleMcp(String bodyText, Host h) throws Exception {
        Object parsed;
        try {
            parsed = new org.json.JSONTokener(bodyText).nextValue();
        } catch (Exception e) {
            // 解析失败只影响这一条请求，用 JSON-RPC 的 parse error 回，
            // 而不是让整个连接 500——客户端会据此判断是报文问题而非服务挂了
            org.json.JSONObject out = new org.json.JSONObject();
            out.put("jsonrpc", "2.0");
            out.put("id", org.json.JSONObject.NULL);
            org.json.JSONObject err = new org.json.JSONObject();
            err.put("code", -32700);
            err.put("message", "parse error: " + e.getMessage());
            out.put("error", err);
            return out.toString();
        }

        // MCP 允许批量请求。批量时逐个处理，结果按数组返回。
        if (parsed instanceof org.json.JSONArray) {
            org.json.JSONArray arr = (org.json.JSONArray) parsed;
            org.json.JSONArray res = new org.json.JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                String one = rpcOne(arr.optJSONObject(i), h);
                if (one != null) res.put(new org.json.JSONTokener(one).nextValue());
            }
            return res.toString();
        }
        return rpcOne((org.json.JSONObject) parsed, h);
    }

    /**
     * 处理单条 JSON-RPC 请求。
     *
     * @return 响应 JSON；通知（无 id）返回 null
     */
    private static String rpcOne(org.json.JSONObject req, Host h) throws Exception {
        if (req == null) return null;
        boolean hasId = req.has("id") && !req.isNull("id");
        String id = hasId ? req.opt("id").toString() : null;
        String method = req.optString("method", "");
        org.json.JSONObject params = req.optJSONObject("params");
        if (params == null) params = new org.json.JSONObject();

        // 通知不需要响应：客户端发 initialized 时不回，否则它会把响应当成
        // 一条没有对应请求的孤儿消息。
        if (!hasId) return null;

        org.json.JSONObject out = new org.json.JSONObject();
        out.put("jsonrpc", "2.0");
        try {
            out.put("id", new org.json.JSONTokener(id).nextValue());
        } catch (Exception e) {
            out.put("id", id);
        }
        try {
            switch (method) {
                case "initialize": {
                    org.json.JSONObject caps = new org.json.JSONObject();
                    org.json.JSONObject toolsCap = new org.json.JSONObject();
                    toolsCap.put("listChanged", false);
                    caps.put("tools", toolsCap);
                    org.json.JSONObject info = new org.json.JSONObject();
                    info.put("name", "meow-tv");
                    info.put("version", BuildConfig.VERSION_NAME);
                    org.json.JSONObject res = new org.json.JSONObject();
                    res.put("protocolVersion", "2024-11-05");
                    res.put("capabilities", caps);
                    res.put("serverInfo", info);
                    out.put("result", res);
                    return out.toString();
                }
                case "ping": {
                    out.put("result", new org.json.JSONObject());
                    return out.toString();
                }
                case "tools/list": {
                    org.json.JSONObject res = new org.json.JSONObject();
                    res.put("tools", mcpTools());
                    out.put("result", res);
                    return out.toString();
                }
                case "tools/call": {
                    String name = params.optString("name", "");
                    org.json.JSONObject args = params.optJSONObject("arguments");
                    if (args == null) args = new org.json.JSONObject();
                    String text = callMcpTool(name, args, h);
                    org.json.JSONArray content = new org.json.JSONArray();
                    org.json.JSONObject item = new org.json.JSONObject();
                    item.put("type", "text");
                    item.put("text", text);
                    content.put(item);
                    org.json.JSONObject res = new org.json.JSONObject();
                    res.put("content", content);
                    // 工具返回 {"ok":false,...} 时仍算"调用成功"，isError 只标
                    // 传输/执行层失败。这样调用方能拿到结构化的失败原因而不是异常。
                    res.put("isError", text.startsWith("{\"ok\":false"));
                    out.put("result", res);
                    return out.toString();
                }
                default: {
                    org.json.JSONObject err = new org.json.JSONObject();
                    err.put("code", -32601);
                    err.put("message", "method not found: " + method);
                    out.put("error", err);
                    return out.toString();
                }
            }
        } catch (Exception e) {
            org.json.JSONObject err = new org.json.JSONObject();
            err.put("code", -32603);
            err.put("message", "internal error: " + e.getMessage());
            out.put("error", err);
            return out.toString();
        }
    }

    /** MCP 工具表。名字与 PC 的 pc_* 一一对应，只是前缀不同。 */
    private static org.json.JSONArray mcpTools() {
        org.json.JSONArray tools = new org.json.JSONArray();
        tools.put(tool("tv_health",
                "服务与应用状态：应用版本、当前页面 URL、后端地址、局域网 IP、运行时长。"
                        + "排查「连不上/黑屏」的第一站。", obj()));
        tools.put(tool("tv_state",
                "当前页面状态：路由 hash、标题、已加载/总数图片、可见文本前 200 字。",
                obj()));
        tools.put(tool("tv_eval",
                "在页面上下文执行任意 JS 并返回结果（evaluateJavascript 原样返回）。"
                        + "等价于 PC 的 pc_eval。",
                obj(new String[]{"js"}, new String[]{"string"},
                        new String[]{"要执行的 JS 源码"}, null)));
        tools.put(tool("tv_screenshot",
                "截当前 WebView 画面（PNG，base64 放在 png 字段）。"
                        + "possiblyBlank=true 表示硬件加速下只画出了纯色图。",
                obj(new String[]{"save"}, new String[]{"boolean"},
                        new String[]{"true 时把 PNG 存进应用私有目录，并回传路径"}, null)));
        tools.put(tool("tv_key",
                "派发遥控器按键。支持连按序列（seq=\"down,down,ok\"）走多级菜单。"
                        + "按键：up/down/left/right/ok/back/menu。",
                objOf(
                        prop("key", "string", "单键名，如 down"),
                        prop("seq", "string", "连按序列，逗号分隔；给了它则忽略 key"),
                        prop("n", "integer", "连按次数（1-30）"))));
        tools.put(tool("tv_dom",
                "可点元素与可见文本摘要，用于定位焦点/按钮（TV 没有地址栏，只能靠这个找路）。",
                obj()));
        tools.put(tool("tv_console",
                "页面 JS 错误（来自前端 window.__meowDiag）。语法错误不触发 onReceivedError，"
                        + "黑屏常要从这里看。", obj()));
        tools.put(tool("tv_network",
                "页面全部 fetch/XHR 记录：状态码、耗时、字节数、失败原因。"
                        + "判断「后端通了没」最直接。", obj()));
        tools.put(tool("tv_danmaku",
                "弹幕渲染器状态：canvas 尺寸、在场弹幕、队列长度。canvas 内容 DOM 读不到。",
                obj()));
        tools.put(tool("tv_perf",
                "导航耗时与最慢资源。", obj()));
        tools.put(tool("tv_navigate",
                "切路由（TV 没有地址栏，这是直达某页的唯一办法）。",
                obj(new String[]{"hash"}, new String[]{"string"},
                        new String[]{"目标路由，如 #/settings"}, null)));
        tools.put(tool("tv_wait",
                "轮询一个 JS 表达式直到为真，比固定 sleep 稳。",
                obj(new String[]{"js", "timeout_ms", "interval_ms"},
                        new String[]{"string", "integer", "integer"},
                        new String[]{"要轮询的表达式", "超时毫秒，上限 60000", "轮询间隔毫秒，最小 100"},
                        new String[]{"js"})));
        tools.put(tool("tv_gateway",
                "TV 本地网关（端上执行层）状态与本地站点数。对应 PC 的 pc_plugins。",
                obj()));

        // ---- 语义工具（docs/47 §1.8 方案 A）----
        //
        // 与 PC 的 meow_* 一一对应，实现同样不在 Java 里，而是转发到页面里的
        // window.__meowTool（src/ai/bridge.ts）。业务逻辑唯一真源留前端。
        //
        // 与 PC 的唯一差别：TV 的 evaluateJavascript 是**同步回调**，
        // 拿不到 Promise 的结果。所以走 bridge 的"投任务 + 轮询"通道：
        // 先 __meowToolStart 投出去，再在 Java 侧循环 __meowToolPoll。
        tools.put(meowTool("meow_state",
                "建立上下文：后端版本、站点数、哪些源降级、日志概况与可用日志模块。任何任务开始前先调它。要看具体日志再调 meow_logs。",
                obj()));
        tools.put(meowTool("meow_logs",
                "查后端日志（2000 条环形缓冲）。用户问“刚才报什么错/为什么失败/后端怎么了”，"
                        + "或 meow_diagnose 的结论不够、需要按级别/模块/时间窗确认时用它。"
                        + "条件由你决定：拿不准就先不带条件取 50 条看全局，再按需收窄。",
                objOf(
                        prop("minLevel", "string", "最低级别：info / warn / error，只看该级别及以上"),
                        prop("tag", "string", "模块标签，精确匹配；可用值见 meow_state 的 logTags"),
                        prop("keyword", "string", "关键词，匹配正文或标签，不区分大小写"),
                        prop("minutes", "integer", "只看最近多少分钟"),
                        prop("limit", "integer", "最多返回多少条（默认 50，上限 500），取最新的"))));
        tools.put(meowTool("meow_diagnose",
                "解释播放失败的原因。用户问“为什么播不了/卡/黑屏”时用它。", obj()));
        tools.put(meowTool("meow_search",
                "按片名搜索影片，跨多源合并，返回影片与可播来源。仅在用户这句话里出现了新的片名时使用。",
                objOf(prop("keyword", "string", "片名关键词，只填片名（如“庆余年”）"),
                        prop("limit", "integer", "最多返回几部，默认 20"))));
        tools.put(meowTool("meow_play",
                "取播放地址（内部自动换线路）。需要 site 与 vod_id，二者从 meow_search 的结果里拿。",
                objOf(prop("site", "string", "来源标识（来自 meow_search）"),
                        prop("vod_id", "string", "影片在该源的 id（来自 meow_search）"),
                        prop("line", "string", "指定线路名，不填自动挑"),
                        prop("episode", "string", "集数，如 “1”；不填取第一集"))));
        tools.put(meowTool("meow_sources", "源健康清单（哪些降级/停用及失败原因）。", obj()));
        tools.put(meowTool("meow_library", "本地 / NAS 片库概览。", obj()));
        tools.put(meowTool("meow_live", "直播频道概览。failed 等于 tried 说明上游当天全挂。", obj()));
        tools.put(meowTool("meow_danmaku", "查某部片的弹幕源。",
                objOf(prop("name", "string", "片名"), prop("episode", "string", "集数"))));
        tools.put(meowTool("meow_cache", "本地缓存/下载概览。只支持查询。", obj()));
        return tools;
    }

    /** 生成一个 meow_* 语义工具的定义（与 PC 的 meow_tool_def 对应）。 */
    private static org.json.JSONObject meowTool(String name, String desc, org.json.JSONObject schema) {
        return tool(name, desc, schema);
    }

    /** 组装一个工具定义。 */
    private static org.json.JSONObject tool(String name, String desc, org.json.JSONObject schema) {
        org.json.JSONObject t = new org.json.JSONObject();
        try {
            t.put("name", name);
            t.put("description", desc);
            t.put("inputSchema", schema);
        } catch (Exception ignored) {
        }
        return t;
    }

    private static org.json.JSONObject obj() {
        org.json.JSONObject s = new org.json.JSONObject();
        try {
            s.put("type", "object");
            s.put("properties", new org.json.JSONObject());
        } catch (Exception ignored) {
        }
        return s;
    }

    private static org.json.JSONObject obj(String[] keys, String[] types, String[] descs,
                                           String[] required) {
        org.json.JSONObject props = new org.json.JSONObject();
        for (int i = 0; i < keys.length; i++) {
            try {
                props.put(keys[i], propDef(types[i], descs[i]));
            } catch (Exception ignored) {
                // 键/值是常量字符串，put 抛不出去；兜一下是为了满足受检异常
            }
        }
        return schemaOf(props, required);
    }

    /** 两个参数的版本（避免调用点构造三个平行数组时下标错位）。 */
    private static org.json.JSONObject objOf(org.json.JSONObject... props) {
        org.json.JSONObject p = new org.json.JSONObject();
        for (org.json.JSONObject one : props) {
            try {
                p.put(one.getString("__name"), one.getJSONObject("__def"));
            } catch (Exception ignored) {
            }
        }
        return schemaOf(p, null);
    }

    private static org.json.JSONObject prop(String name, String type, String desc) {
        org.json.JSONObject w = new org.json.JSONObject();
        try {
            w.put("__name", name);
            w.put("__def", propDef(type, desc));
        } catch (Exception ignored) {
        }
        return w;
    }

    private static org.json.JSONObject propDef(String type, String desc) {
        org.json.JSONObject d = new org.json.JSONObject();
        try {
            d.put("type", type);
            d.put("description", desc);
        } catch (Exception ignored) {
        }
        return d;
    }

    private static org.json.JSONObject schemaOf(org.json.JSONObject props, String[] required) {
        org.json.JSONObject s = new org.json.JSONObject();
        try {
            s.put("type", "object");
            s.put("properties", props);
            if (required != null && required.length > 0) {
                org.json.JSONArray req = new org.json.JSONArray();
                for (String r : required) req.put(r);
                s.put("required", req);
            }
        } catch (Exception ignored) {
        }
        return s;
    }

    /** 执行一个工具，返回给调用方的文本（通常是 JSON）。 */
    private static String callMcpTool(String name, org.json.JSONObject a, Host h) {
        switch (name) {
            case "tv_health":
                return healthJson(appCtx, h);
            case "tv_state":
                return unwrap(safeEval(h, STATE_JS));
            case "tv_eval": {
                String js = a.optString("js", "");
                if (js.isEmpty()) return "{\"ok\":false,\"error\":\"js required\"}";
                String v = safeEval(h, js);
                if (v == null) return "{\"ok\":false,\"error\":\"eval timeout or webview not ready\"}";
                return v;
            }
            case "tv_screenshot": {
                Bitmap bmp = h.screenshot();
                if (bmp == null) return "{\"ok\":false,\"error\":\"webview not ready\"}";
                ByteArrayOutputStream png = new ByteArrayOutputStream();
                boolean encoded = bmp.compress(Bitmap.CompressFormat.PNG, 100, png);
                boolean blank = probablyBlank(bmp);
                int w = bmp.getWidth();
                int hgt = bmp.getHeight();
                bmp.recycle();
                if (!encoded) return "{\"ok\":false,\"error\":\"png encode failed\"}";
                byte[] bytes = png.toByteArray();
                StringBuilder out = new StringBuilder(bytes.length);
                out.append("{\"ok\":true,\"width\":").append(w)
                        .append(",\"height\":").append(hgt)
                        .append(",\"bytes\":").append(bytes.length)
                        .append(",\"possiblyBlank\":").append(blank)
                        .append(",\"png\":\"")
                        .append(Base64.encodeToString(bytes, Base64.NO_WRAP)).append('"');
                if (a.optBoolean("save", false) && appCtx != null) {
                    String saved = savePng(appCtx, bytes);
                    if (saved != null) out.append(",\"savedTo\":").append(jsonStr(saved));
                }
                out.append('}');
                return out.toString();
            }
            case "tv_key": {
                String seq = a.optString("seq", "").trim();
                if (!seq.isEmpty()) {
                    StringBuilder done = new StringBuilder();
                    for (String raw : seq.split(",")) {
                        String one = raw.trim().toLowerCase();
                        if (one.isEmpty()) continue;
                        if (!pressOne(h, one)) {
                            return "{\"ok\":false,\"error\":\"unknown key in seq\",\"key\":"
                                    + jsonStr(one) + ",\"done\":" + jsonStr(done.toString()) + "}";
                        }
                        done.append(done.length() > 0 ? "," : "").append(one);
                        try {
                            Thread.sleep(120);
                        } catch (InterruptedException ignored) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    String focus = safeEval(h, FOCUS_JS);
                    return "{\"ok\":true,\"seq\":" + jsonStr(done.toString())
                            + ",\"count\":" + done.toString().split(",").length
                            + ",\"focus\":" + (focus == null ? "null" : focus) + "}";
                }
                String key = a.optString("key", "").trim().toLowerCase();
                if (key.isEmpty()) {
                    return "{\"ok\":false,\"error\":\"key required\","
                            + "\"keys\":[\"up\",\"down\",\"left\",\"right\",\"ok\",\"back\",\"menu\"]}";
                }
                int times = a.optInt("n", 1);
                if (times < 1) times = 1;
                if (times > 30) times = 30;
                if ("back".equals(key)) {
                    h.pressBack();
                    return "{\"ok\":true,\"key\":\"back\",\"n\":1}";
                }
                int code = keyCode(key);
                if (code == 0) {
                    return "{\"ok\":false,\"error\":\"unknown key\","
                            + "\"keys\":[\"up\",\"down\",\"left\",\"right\",\"ok\",\"back\",\"menu\"]}";
                }
                boolean handled = false;
                for (int i = 0; i < times; i++) {
                    handled = h.sendKey(code);
                    if (i + 1 < times) {
                        try {
                            Thread.sleep(120);
                        } catch (InterruptedException ignored) {
                            Thread.currentThread().interrupt();
                            break;
                        }
                    }
                }
                String where = safeEval(h, FOCUS_JS);
                return "{\"ok\":true,\"key\":" + jsonStr(key) + ",\"n\":" + times
                        + ",\"handled\":" + handled
                        + (where == null ? "" : ",\"focus\":" + where) + "}";
            }
            case "tv_dom":
                return unwrap(safeEval(h, DOM_JS));
            case "tv_console":
                return unwrap(safeEval(h, diagJs("errors")));
            case "tv_network":
                return unwrap(safeEval(h, diagJs("net")));
            case "tv_danmaku":
                return unwrap(safeEval(h, DANMAKU_JS));
            case "tv_perf":
                return unwrap(safeEval(h, PERF_JS));
            case "tv_navigate": {
                String hash = a.optString("hash", "");
                if (hash.isEmpty()) return "{\"ok\":false,\"error\":\"hash required\"}";
                return unwrap(safeEval(h, "(function(){try{location.hash=" + jsonStr(hash)
                        + ";return JSON.stringify({ok:true,hash:location.hash})}"
                        + "catch(e){return JSON.stringify({ok:false,error:e.message})}})()"));
            }
            case "tv_wait": {
                String js = a.optString("js", "");
                if (js.isEmpty()) return "{\"ok\":false,\"error\":\"js required\"}";
                long timeoutMs = a.optLong("timeout_ms", 15000);
                long intervalMs = a.optLong("interval_ms", 300);
                if (timeoutMs <= 0 || timeoutMs > 60000) timeoutMs = 60000;
                if (intervalMs < 100) intervalMs = 100;
                long deadline = System.currentTimeMillis() + timeoutMs;
                String last = "";
                boolean met = false;
                int tries = 0;
                while (System.currentTimeMillis() < deadline) {
                    tries++;
                    String v = safeEval(h, "(function(){try{return (" + js + ")?'1':'0'}"
                            + "catch(e){return 'err:'+e.message}})()");
                    last = v == null ? "" : v.replace("\"", "").trim();
                    if ("1".equals(last)) {
                        met = true;
                        break;
                    }
                    try {
                        Thread.sleep(intervalMs);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                return "{\"ok\":" + met + ",\"tries\":" + tries + ",\"last\":" + jsonStr(last) + "}";
            }
            case "tv_gateway": {
                boolean gw = false;
                int gwPort = 0;
                int locals = 0;
                try {
                    gw = GatewayServer.isRunning();
                    gwPort = GatewayServer.port();
                } catch (Throwable ignored) {
                }
                try {
                    if (appCtx != null) {
                        LocalSites.load(appCtx);
                        locals = LocalSites.size();
                    }
                } catch (Throwable ignored) {
                }
                return "{\"ok\":true,\"gatewayRunning\":" + gw + ",\"gatewayPort\":" + gwPort
                        + ",\"localSites\":" + locals
                        + ",\"lastError\":" + jsonStr(LocalSpiderHost.lastError()) + "}";
            }
            default:
                // meow_* 语义工具：转发到页面里的 window.__meowTool（src/ai/bridge.ts）
                if (name.startsWith("meow_")) return callMeowTool(name, a, h);
                return "{\"ok\":false,\"error\":\"unknown tool\",\"tool\":" + jsonStr(name) + "}";
        }
    }

    /**
     * 把一次 meow_* 调用转发到页面内的 {@code window.__meowTool}。
     *
     * <p><b>为什么用"投任务 + 轮询"而不是直接 await</b>：TV 的
     * {@code evaluateJavascript} 是同步回调，拿不到 Promise 的结果——
     * 直接写 {@code await window.__meowTool(...)} 只会拿到一个 pending Promise。
     * 所以先 {@code __meowToolStart} 投出去，再在 Java 侧循环
     * {@code __meowToolPoll} 直到 done 或超时。
     *
     * <p>PC 没有这个问题（CDP 的 Runtime.evaluate 支持 awaitPromise），
     * 但两边共用同一个 bridge 实现，行为必然一致。
     */
    private static String callMeowTool(String name, org.json.JSONObject a, Host h) {
        final String id = "mcp-" + System.nanoTime();
        String startJs = "(function(){try{return String(window.__meowToolStart("
                + jsonStr(id) + "," + jsonStr(name) + "," + a.toString() + "));}"
                + "catch(e){return 'ERR:'+e;}})()";
        String started = safeEval(h, startJs);
        if (started == null) {
            return "{\"ok\":false,\"error\":\"webview not ready or eval timeout\"}";
        }
        // 前端版本过旧时会抛错（没有 bridge），这是最容易踩的一条
        if (started.contains("ERR:")) {
            return "{\"ok\":false,\"error\":\"页面里没有 __meowToolStart，前端版本可能过旧（需要 0.9.22+）\"}";
        }

        String pollJs = "(function(){try{return JSON.stringify(window.__meowToolPoll("
                + jsonStr(id) + "));}catch(e){return 'ERR:'+e;}})()";
        long deadline = System.currentTimeMillis() + MEOW_TOOL_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(MEOW_TOOL_POLL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            String raw = safeEval(h, pollJs);
            if (raw == null) continue;
            // evaluateJavascript 对字符串结果会多包一层引号，这里自己剥，
            // **不能用 unwrap()**：它在结果为 "null" 时返回的是一个错误 JSON，
            // 会被下面的 catch 当成正常结果解析掉。
            String json = raw.trim();
            if (json.startsWith("\"")) {
                try {
                    json = new org.json.JSONObject("{\"v\":" + json + "}").optString("v", "");
                } catch (Exception e) {
                    continue;
                }
            }
            if (json.isEmpty() || "null".equals(json)) continue;
            if (json.contains("ERR:")) continue;
            if (json.contains("\"pending\":true")) continue;
            // 完成：把 result 字段原样返回（外部 MCP 只需要工具的结果）
            try {
                org.json.JSONObject o = new org.json.JSONObject(json);
                if (o.optBoolean("missing", false)) {
                    return "{\"ok\":false,\"error\":\"任务已过期或不存在\"}";
                }
                Object r = o.opt("result");
                return r == null ? "{\"ok\":false,\"error\":\"工具没有返回结果\"}" : String.valueOf(r);
            } catch (Exception e) {
                return json;
            }
        }
        return "{\"ok\":false,\"error\":\"工具执行超时（" + MEOW_TOOL_TIMEOUT_MS + "ms）\"}";
    }

    /** meow_* 工具的总超时：搜索跨多源，留足余量 */
    private static final long MEOW_TOOL_TIMEOUT_MS = 35_000L;
    /** 轮询间隔：太密会一直占用主线程的 eval 通道 */
    private static final long MEOW_TOOL_POLL_MS = 300L;

    /**
     * 诊断采集器的读取表达式。
     *
     * <p>前端 diagnostics.ts 已经在采集 JS 错误与全部 fetch/XHR（含状态码、耗时、
     * 失败原因），且挂在 {@code window.__meowDiag} 上供外部工具读。
     * 这里直接复用，不在原生侧重做一遍——两套采集迟早会不一致。
     */
    private static String diagJs(String fn) {
        return "(function(){try{var d=window.__meowDiag;"                + "if(!d) return '[]';"
                + "return JSON.stringify(d." + fn + "()||[])}"
                + "catch(e){return '[]'}})()";
    }

    /** 弹幕渲染器状态（对应 PC 的 pc_danmaku）。canvas 内容 DOM 读不到，只能问实例。 */
    private static final String DANMAKU_JS = "(function(){try{var d=window.__meowDm;"
            + "if(!d) return JSON.stringify({ok:true,mounted:false});"
            + "var cs=d.debugCanvasSize?d.debugCanvasSize():{};"
            + "var st=d.debugState?d.debugState():{};"
            + "return JSON.stringify({ok:true,mounted:true,canvas:cs,state:st});"
            + "}catch(e){return JSON.stringify({ok:false,error:e.message})}})()";

    /** 可点元素与可见文本摘要（对应 PC 的 pc_dom）。 */
    private static final String DOM_JS = "(function(){try{"
            + "var els=[].slice.call(document.querySelectorAll('button,a,input,[role=button]'));"
            + "var items=els.slice(0,60).map(function(e){"
            + "var t=(e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'');"
            + "return {tag:e.tagName.toLowerCase(),text:String(t).replace(/\\s+/g,' ').trim().slice(0,40)};});"
            + "return JSON.stringify({ok:true,hash:location.hash,title:document.title,"
            + "count:els.length,items:items,images:document.images.length,"
            + "bodyText:(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,300)});"
            + "}catch(e){return JSON.stringify({ok:false,error:e.message})}})()";

    /** 导航耗时与最慢资源（对应 PC 的 pc_perf）。 */
    private static final String PERF_JS = "(function(){try{"
            + "var t=performance.timing||{};"
            + "var res=performance.getEntriesByType?performance.getEntriesByType('resource'):[];"
            + "var slow=res.slice().sort(function(a,b){return b.duration-a.duration}).slice(0,5)"
            + ".map(function(r){return {name:String(r.name).slice(-60),ms:Math.round(r.duration)}});"
            + "return JSON.stringify({ok:true,nowMs:Math.round(performance.now()),"
            + "domContentLoaded:(t.domContentLoadedEventEnd&&t.navigationStart)?"
            + "(t.domContentLoadedEventEnd-t.navigationStart):null,"
            + "load:(t.loadEventEnd&&t.navigationStart)?(t.loadEventEnd-t.navigationStart):null,"
            + "resources:res.length,slowest:slow});"
            + "}catch(e){return JSON.stringify({ok:false,error:e.message})}})()";

    private static final String STATE_JS = "(function(){try{"
            + "var imgs=document.images||[];"
            + "var loaded=0;"
            + "for(var i=0;i<imgs.length;i++){if(imgs[i].complete&&imgs[i].naturalWidth>0)loaded++;}"
            + "var text=document.body?(document.body.innerText||''):'';"
            + "return {hash:location.hash,title:document.title,"
            + "url:location.href,imgTotal:imgs.length,imgLoaded:loaded,"
            + "text:String(text).slice(0,200)};"
            + "}catch(e){return {error:String(e&&e.message||e)}}})()";

    private static String safeEval(Host h, String js) {
        try {
            return h.evalJs(js);
        } catch (Throwable t) {
            Log.w(TAG, "eval failed", t);
            return null;
        }
    }

    private static String healthJson(Context ctx, Host h) {
        String url = "";
        try {
            url = h.currentUrl();
        } catch (Throwable ignored) {
        }
        try {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("app", BuildConfig.VERSION_NAME);
            o.put("appCode", BuildConfig.VERSION_CODE);
            o.put("webview", webViewVersion(ctx));
            o.put("url", url == null ? "" : url);
            o.put("apiBase", apiBase(ctx));
            o.put("uptimeSec", (System.currentTimeMillis() - startedAt) / 1000);
            o.put("port", port);
            o.put("lanIp", lanIp);
            return o.toString();
        } catch (Exception e) {
            // JSONObject.put 在老版本上会抛，但字段全是字符串/数字，正常走不到这里
            return "{\"ok\":true,\"app\":" + jsonStr(BuildConfig.VERSION_NAME)
                    + ",\"webview\":\"unknown\",\"url\":" + jsonStr(url == null ? "" : url) + "}";
        }
    }

    /**
     * 只查 {@code com.google.android.webview}。
     *
     * <p>有的机型内核由 Chrome（Trichrome）或厂商包提供，查不到就写 unknown——
     * 猜一个版本号比 unknown 更误导人，而"内核版本"正是黑屏类问题要的证据。
     */
    private static String webViewVersion(Context ctx) {
        if (ctx == null) return "unknown";
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo("com.google.android.webview", 0);
            return pi.versionName == null ? "unknown" : pi.versionName;
        } catch (Exception e) {
            return "unknown";
        }
    }

    private static String apiBase(Context ctx) {
        if (ctx == null) return "";
        try {
            SharedPreferences sp = ctx.getSharedPreferences(MainActivity.PREF, Context.MODE_PRIVATE);
            String v = sp.getString(MainActivity.K_API, "");
            return v == null ? "" : v;
        } catch (Exception e) {
            return "";
        }
    }

    private static byte[] readBody(InputStream in, int len) throws IOException {
        int n = Math.max(0, Math.min(len, MAX_BODY));
        byte[] buf = new byte[n];
        int read = 0;
        while (read < n) {
            int r = in.read(buf, read, n - read);
            if (r <= 0) break;
            read += r;
        }
        return read == n ? buf : Arrays.copyOf(buf, read);
    }

    private static Map<String, String> parseQuery(String q) {
        Map<String, String> out = new HashMap<>();
        for (String kv : q.split("&")) {
            if (kv.isEmpty()) continue;
            int eq = kv.indexOf('=');
            if (eq <= 0) continue;
            try {
                out.put(java.net.URLDecoder.decode(kv.substring(0, eq), "UTF-8"),
                        java.net.URLDecoder.decode(kv.substring(eq + 1), "UTF-8"));
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    private static boolean tokenOk(String got, String expected) {
        if (expected == null || expected.isEmpty()) return false;
        if (got == null) return false;
        // 定长比较，避免按字节提前返回泄漏前缀
        return MessageDigest.isEqual(got.trim().getBytes(StandardCharsets.UTF_8),
                expected.getBytes(StandardCharsets.UTF_8));
    }

    /** 遥控按键名 → KeyEvent。0 表示不认识的键名。 */
    private static int keyCode(String key) {
        switch (key) {
            case "up": return android.view.KeyEvent.KEYCODE_DPAD_UP;
            case "down": return android.view.KeyEvent.KEYCODE_DPAD_DOWN;
            case "left": return android.view.KeyEvent.KEYCODE_DPAD_LEFT;
            case "right": return android.view.KeyEvent.KEYCODE_DPAD_RIGHT;
            case "ok": return android.view.KeyEvent.KEYCODE_DPAD_CENTER;
            case "menu": return android.view.KeyEvent.KEYCODE_MENU;
            default: return 0;
        }
    }

    /** 按一个键名（含 back）。认不出返回 false。 */
    private static boolean pressOne(Host h, String key) {
        if ("back".equals(key)) {
            h.pressBack();
            return true;
        }
        int code = keyCode(key);
        if (code == 0) return false;
        h.sendKey(code);
        return true;
    }

    private static String firstNonEmpty(String a, String b) {
        if (a != null && !a.trim().isEmpty()) return a.trim();
        if (b != null && !b.trim().isEmpty()) return b.trim();
        return "";
    }

    private static int parseIntSafe(String s, int def) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Exception e) {
            return def;
        }
    }

    private static byte[] utf8(String s) {
        return (s == null ? "{}" : s).getBytes(StandardCharsets.UTF_8);
    }

    /**
     * 读当前遥控焦点。
     *
     * <p>为什么单独做一个端点：电视上「不知道选到哪里」纯靠截图看不出来
     * （焦点框可能被裁切、也可能根本没生效），必须能直接读到
     * 哪个元素带 {@code meow-tv-focus} 以及它在不在视口内。
     */
    private static final String FOCUS_JS =
            "(function(){try{"
            + "var el=document.querySelector('.meow-tv-focus');"
            + "var all=document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex=\"-1\"])');"
            + "if(!el)return JSON.stringify({focused:false,ring:0,focusables:all.length});"
            + "var r=el.getBoundingClientRect();var cs=getComputedStyle(el);"
            + "return JSON.stringify({focused:true,"
            + "text:(el.textContent||'').trim().slice(0,60),"
            + "tag:el.tagName,"
            + "x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),"
            + "inView:(r.top>=-1&&r.bottom<=window.innerHeight+1&&r.left>=-1&&r.right<=window.innerWidth+1),"
            + "outline:cs.outline,"
            + "focusables:all.length});"
            + "}catch(e){return JSON.stringify({focused:false,error:String(e)});}})()";

    /**
     * 截图落盘（{@code ?save=1} 时才做）。
     *
     * <p>只保留最近 {@link #MAX_SHOTS} 张：PC 侧轮询验收时很容易每秒一张，
     * 电视的 /data 分区通常只有几百 MB，无上限会把它写满。
     */
    private static String savePng(Context ctx, byte[] png) {
        try {
            File dir = new File(ctx.getFilesDir(), "debug-shots");
            if (!dir.exists() && !dir.mkdirs()) return null;
            String name = "shot-" + new SimpleDateFormat("yyyyMMdd-HHmmss").format(new Date()) + ".png";
            File f = new File(dir, name);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(png);
            }
            File[] all = dir.listFiles();
            if (all != null && all.length > MAX_SHOTS) {
                Arrays.sort(all);
                for (int i = 0; i < all.length - MAX_SHOTS; i++) {
                    //noinspection ResultOfMethodCallIgnored
                    all[i].delete();
                }
            }
            return f.getAbsolutePath();
        } catch (Exception e) {
            Log.w(TAG, "save screenshot failed", e);
            return null;
        }
    }

    /**
     * 截图是不是整张同一个颜色。
     *
     * <p>硬件加速下 {@code WebView.draw} 在新一点的 WebView 内核上会画出一张
     * 纯黑/纯白的图（WebView 自身没有软件层），而 HTTP 仍然 200、PNG 也正常。
     * 与其让 PC 端拿到一张"看起来对"的黑图去猜，不如直接标出来。
     *
     * <p>抽样而不是全量：一张 1080p 图 200 万像素，逐点比在电视 CPU 上要几秒。
     */
    private static boolean probablyBlank(Bitmap bmp) {
        try {
            int w = bmp.getWidth();
            int hgt = bmp.getHeight();
            if (w <= 0 || hgt <= 0) return true;
            int first = bmp.getPixel(0, 0);
            // 32 个采样点：足够区分"整张纯色"和"真的画了内容"
            for (int i = 1; i <= 32; i++) {
                int x = (int) ((long) w * i / 33);
                int y = (int) ((long) hgt * i / 33);
                if (x >= w) x = w - 1;
                if (y >= hgt) y = hgt - 1;
                if (bmp.getPixel(x, y) != first) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static void sendJson(Socket sock, int code, String json) {
        send(sock, code, "application/json; charset=utf-8", json.getBytes(StandardCharsets.UTF_8));
    }

    private static void send(Socket sock, int code, String type, byte[] body) {
        try {
            OutputStream os = sock.getOutputStream();
            String head = "HTTP/1.1 " + code + " " + reason(code) + "\r\n"
                    + "Content-Type: " + type + "\r\n"
                    + "Content-Length: " + body.length + "\r\n"
                    + "Cache-Control: no-store\r\n"
                    + "Access-Control-Allow-Origin: *\r\n"
                    + "Access-Control-Allow-Headers: Content-Type,X-Meow-Token\r\n"
                    + "Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n"
                    + "Connection: close\r\n\r\n";
            os.write(head.getBytes(StandardCharsets.UTF_8));
            os.write(body);
            os.flush();
        } catch (Exception ignored) {
        }
    }

    private static String reason(int code) {
        switch (code) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 500: return "Internal Server Error";
            case 503: return "Service Unavailable";
            default: return "OK";
        }
    }

    private static String jsonStr(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    /** 与 PushServer 同样的私有网段过滤：只用来展示地址，不参与绑定。 */
    private static String findLanIp() {
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    String ip = a.getHostAddress();
                    if (ip == null) continue;
                    if (ip.startsWith("192.168.") || ip.startsWith("10.")
                            || ip.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*")) {
                        return ip;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return "";
    }
}
