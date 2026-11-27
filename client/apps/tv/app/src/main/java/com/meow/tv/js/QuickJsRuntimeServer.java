package com.meow.tv.js;

import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * TV 内置的 drpy 兼容运行时：让 `.js` 源在端上直接跑，不用连外部 drpy。
 *
 * <p><b>为什么做成 HTTP 服务而不是直接改 apiserver</b>：
 * {@code ApiServer.callScriptRuntime()} 是 shared 源码（JVM / Android 都编），
 * 它只会往 `jsRuntime` 配的地址发 {@code POST /{site}/{action}}。与其在 shared 里
 * 加一层"本地引擎"分支（JVM 端没有 QuickJS，抽象成本高），不如在端上起一个
 * 同协议的小服务，把 {@code jsRuntime} 指向 127.0.0.1。这样：
 * <ul>
 *   <li>shared / drpy / Docker 一行都不用改</li>
 *   <li>端上没装 QuickJS 时服务起不来，行为自动退回"连外部运行时"</li>
 *   <li>协议只有一份定义（drpy 的 dispatch），两边不会漂</li>
 * </ul>
 *
 * <p><b>只在 jsRuntime 为空时接管</b>：用户/配置显式填了外部 drpy 地址时，
 * 说明他要连那台（可能是 NAS 上算力更强的），不能悄悄改成本地。
 * 这个判断在 {@link #publishIfAbsent} 的调用方（GatewayServer）做。
 *
 * <p><b>单实例串行</b>：QuickJS 的 owner 线程本来就是串行的，多线程提交会在
 * 内部排队。搜索并发 12 个请求时这里不会打爆，只是排队——与外部 drpy 的
 * worker 池行为一致（drpy 也是单 worker 队列）。
 */
public final class QuickJsRuntimeServer {

    private static final String TAG = "MeowJsRt";

    /** 脚本实例池：key = 脚本 URL（含 query，因为不同 query 可能是不同脚本） */
    private static final Map<String, QuickJsSpider> INSTANCES = new ConcurrentHashMap<>();

    private static volatile ServerSocket server;
    private static volatile int port;
    private static ExecutorService pool;

    /*
     * 端内脚本运行时段位（19xxx，四端统一）：
     *   19341         tv-node 模块（弹幕聚合）
     *   19351..19370  tv-python 模块（pyrt，宿主从 19351 起探 20 个）
     *   19381..19389  内置 QuickJS（本类）
     *
     * ★ 以前这里是 `new ServerSocket(0)` → 系统随机高位端口（Android 32768+），
     *   每台设备都不同：日志对不上、排障要现查、policy 里也没法用固定地址描述。
     *   改成"固定首选 + 顺延"，与 PC/fpk 的插件端口协商同一套路。
     */
    private static final int PORT_MIN = 19381;
    private static final int PORT_TRIES = 9;

    private QuickJsRuntimeServer() {
    }

    /** 幂等启动。返回实际端口；已在跑就直接返回旧端口。失败返回 0。 */
    public static synchronized int start() {
        if (server != null && !server.isClosed()) return port;
        for (int i = 0; i < PORT_TRIES; i++) {
            int p = PORT_MIN + i;
            ServerSocket ss;
            try {
                ss = new ServerSocket(p, 50, InetAddress.getByName("127.0.0.1"));
            } catch (Throwable busy) {
                continue;
            }
            port = p;
            server = ss;
            pool = Executors.newFixedThreadPool(4, r -> {
                Thread t = new Thread(r, "meow-jsrt");
                t.setDaemon(true);
                return t;
            });
            Thread accept = new Thread(() -> acceptLoop(ss), "meow-jsrt-accept");
            accept.setDaemon(true);
            accept.start();
            Log.i(TAG, "quickjs runtime listening 127.0.0.1:" + port);
            return port;
        }
        Log.w(TAG, "start failed: " + PORT_MIN + ".." + (PORT_MIN + PORT_TRIES - 1) + " 全被占用");
        port = 0;
        return 0;
    }

    public static int port() {
        return port;
    }

    /** 形如 `http://127.0.0.1:12345`（未启动时返回空串） */
    public static String baseUrl() {
        int p = port;
        return p <= 0 ? "" : "http://127.0.0.1:" + p;
    }

    public static synchronized void stop() {
        try {
            if (server != null) server.close();
        } catch (Throwable ignored) {
        }
        server = null;
        port = 0;
        if (pool != null) {
            pool.shutdownNow();
            pool = null;
        }
        for (QuickJsSpider s : INSTANCES.values()) {
            try {
                s.destroy();
            } catch (Throwable ignored) {
            }
        }
        INSTANCES.clear();
    }

    // ── HTTP 层 ─────────────────────────────────────────────────────────

    private static void acceptLoop(ServerSocket ss) {
        while (!ss.isClosed()) {
            try {
                Socket sock = ss.accept();
                ExecutorService p = pool;
                if (p == null) {
                    sock.close();
                    continue;
                }
                p.execute(() -> handle(sock));
            } catch (Throwable t) {
                if (!ss.isClosed()) Log.w(TAG, "accept: " + t);
            }
        }
    }

    private static void handle(Socket sock) {
        try (Socket s = sock) {
            s.setSoTimeout(45_000);
            InputStream in = s.getInputStream();
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String requestLine = lines.length > 0 ? lines[0] : "";
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                write(s, 400, "{\"code\":-1,\"msg\":\"bad request\"}");
                return;
            }
            String method = parts[0];
            String path = parts[1];
            int contentLength = 0;
            String apiHeader = null;
            String extHeader = null;
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c <= 0) continue;
                String k = lines[i].substring(0, c).trim();
                String v = lines[i].substring(c + 1).trim();
                if (k.equalsIgnoreCase("Content-Length")) {
                    try {
                        contentLength = Integer.parseInt(v);
                    } catch (NumberFormatException ignored) {
                    }
                } else if (k.equalsIgnoreCase("X-DRPY-Api")) {
                    apiHeader = URLDecoder.decode(v, "UTF-8");
                } else if (k.equalsIgnoreCase("X-DRPY-Ext")) {
                    extHeader = URLDecoder.decode(v, "UTF-8");
                }
            }
            byte[] bodyBytes = new byte[Math.max(0, contentLength)];
            int read = 0;
            while (read < bodyBytes.length) {
                int n = in.read(bodyBytes, read, bodyBytes.length - read);
                if (n <= 0) break;
                read += n;
            }
            String bodyText = new String(bodyBytes, 0, read, StandardCharsets.UTF_8);

            /*
             * GET /health：宿主 scriptRuntimeUsable() 的探活点。
             *
             * ★ 以前这里只有 POST，GET 一律 405。而宿主探活要求 **200**，
             *   于是内置 QuickJS 永远被判定 "runtime=down" —— probe 显示
             *   "124 站需要脚本运行时（未配置）"，但实际 js 站能搜出 40+ 条。
             *   （2026-11-26 在 .76 上实测：js_袋鼠影视 45 条，probe 同时报 down。）
             *
             * caps 与 pyrt/drpy 对齐：js=true、py=false。宿主据此判定
             * ".py 交给这个运行时没意义"，而不是把 .py 当 JS 去解析。
             */
            if ("GET".equalsIgnoreCase(method) && (path.equals("/health") || path.equals("/"))) {
                /*
                 * 顶层 `py` 是宿主 runtimeSupportsPy() 的判据（它读 o.optBoolean("py")），
                 * caps 只是给人看的；两处都给，避免嵌套结构读不到 → 默认 true
                 * → 110 个 .py 站被误报"可用"。
                 */
                write(s, 200, "{\"ok\":true,\"service\":\"quickjs\",\"py\":false,"
                        + "\"caps\":{\"js\":true,\"py\":false}}");
                return;
            }
            if (!"POST".equalsIgnoreCase(method)) {
                write(s, 405, "{\"code\":-1,\"msg\":\"use POST /{site}/{action}\"}");
                return;
            }
            String[] seg = path.split("/");
            if (seg.length < 3) {
                write(s, 404, "{\"code\":-1,\"msg\":\"use POST /{site}/{action}\"}");
                return;
            }
            String site = URLDecoder.decode(seg[1], "UTF-8");
            String action = URLDecoder.decode(seg[2], "UTF-8");
            if (apiHeader == null || apiHeader.isEmpty()) {
                write(s, 400, "{\"code\":-1,\"msg\":\"missing X-DRPY-Api header\"}");
                return;
            }

            JSONObject body;
            try {
                body = bodyText.trim().isEmpty() ? new JSONObject() : new JSONObject(bodyText);
            } catch (Exception e) {
                write(s, 200, "{\"code\":-1,\"msg\":\"bad json body\"}");
                return;
            }

            String out;
            long t0 = System.currentTimeMillis();
            try {
                QuickJsSpider spider = instance(site, apiHeader, extHeader);
                out = spider.dispatch(action, body);
                if (out == null) out = "{}";
            } catch (Throwable t) {
                Log.w(TAG, site + "/" + action + " failed", t);
                out = "{\"code\":-1,\"msg\":" + JSONObject.quote(String.valueOf(t.getMessage())) + "}";
            }
            Log.i(TAG, site + "/" + action + " " + (System.currentTimeMillis() - t0) + "ms -> " + out.length() + "B");
            write(s, 200, out);
        } catch (Throwable t) {
            Log.w(TAG, "handle: " + t);
        }
    }

    /** 只读到空行为止（不消费 body，body 由调用方按 Content-Length 读） */
    private static String readHead(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int prev3 = -1, prev2 = -1, prev1 = -1;
        while (true) {
            int b = in.read();
            if (b < 0) break;
            buf.write(b);
            if (prev3 == '\r' && prev2 == '\n' && prev1 == '\r' && b == '\n') break;
            prev3 = prev2;
            prev2 = prev1;
            prev1 = b;
            if (buf.size() > 16 * 1024) break;
        }
        return buf.size() == 0 ? null : buf.toString(StandardCharsets.ISO_8859_1.name());
    }

    private static void write(Socket s, int code, String body) {
        try {
            byte[] data = body.getBytes(StandardCharsets.UTF_8);
            String head = "HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "ERR") + "\r\n"
                    + "Content-Type: application/json; charset=utf-8\r\n"
                    + "Content-Length: " + data.length + "\r\n"
                    + "Connection: close\r\n\r\n";
            OutputStream out = s.getOutputStream();
            out.write(head.getBytes(StandardCharsets.ISO_8859_1));
            out.write(data);
            out.flush();
        } catch (Throwable t) {
            Log.w(TAG, "write: " + t);
        }
    }

    // ── 实例池 ─────────────────────────────────────────────────────────

    /**
     * 取/建一个脚本实例。
     *
     * <p>key 用 api URL 而不是 site 名：同一个脚本可能被多个 site 引用
     * （配置里换 key 但 api 不变），按 URL 复用省一份 QuickJS 上下文；
     * 反过来同 site 换脚本也会因为 URL 变了而重建。
     */
    private static QuickJsSpider instance(String site, String api, String ext) throws Exception {
        QuickJsSpider cached = INSTANCES.get(api);
        if (cached != null) return cached;
        synchronized (QuickJsRuntimeServer.class) {
            cached = INSTANCES.get(api);
            if (cached != null) return cached;
            QuickJsSpider s = new QuickJsSpider(site, api);
            s.init(ext == null ? "" : ext);
            INSTANCES.put(api, s);
            return s;
        }
    }

    /** 配置重新导入时调用：脚本内容可能变了，全部重建 */
    public static synchronized void invalidate() {
        for (QuickJsSpider s : INSTANCES.values()) {
            try {
                s.destroy();
            } catch (Throwable ignored) {
            }
        }
        INSTANCES.clear();
    }
}
