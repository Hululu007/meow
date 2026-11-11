package com.meow.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 手机扫码改设置，推给电视。
 *
 * <p><b>为什么做这个</b>：电视遥控器打字是所有 TV 应用最痛的一步。
 * 尤其「搜不到某部剧」这种问题要在设置页翻好几个分区才定位得到，
 * 每次都拿遥控器一个个移焦点是折磨。让用户在手机上打开一个网页、
 * 勾选/填完后点发送，电视立刻生效——这是唯一不痛苦的办法。
 *
 * <p><b>为什么不用 WebView 加载真设置页</b>：设置页是 Vue SPA，只由
 * MainActivity 的 shouldInterceptRequest 从 assets 供给（拦 meow.local），
 * 这里要复刻一整套静态文件服务 + 反向代理。代价远大于收益：
 * 手机端需要的是"改几个常用项"，不是"完整设置页"。
 *
 * <p><b>为什么推送后不用重载页面</b>：写 localStorage 只是改数据，
 * 页面不会知道。前端 `savePrefs()` 会派发 `meow:prefs` 事件，
 * 主题/列数/播放器都监听它——所以推送时走同一条路（写 + 派发），
 * 无需 reloadApp。这一点在 MuMu 上实测过。
 *
 * <p><b>端口固定 9333 而非协商</b>：二维码里的地址必须提前知道，
 * 协商会让"先生成码再起服务"变成循环依赖。被占就顺延，并把最终端口
 * 写进二维码。
 */
final class PushServer {

    private static final String TAG = "MeowPush";

    /** 前端 prefs 的 localStorage 键（与 stores/prefs.ts 的 KEY 一致）。 */
    static final String PREF_LS_KEY = "meow.prefs";

    /**
     * 手机提交后回调（主线程）。
     *
     * <p>{@code url}/{@code config} 是老的两项（后端地址），
     * {@code prefsJson} 是这次新增的完整设置（JSON 对象文本，可为空）。
     */
    interface OnPush {
        /**
         * @param importMode 配置导入方式：{@code merge} / {@code replace}，
         *                   手机页没选时为空串（调用方按默认处理）
         */
        void onPush(String url, String config, String prefsJson, String importMode);
    }

    /**
     * 问前端要"当前设置"和"应用新设置"的口子。
     *
     * <p>为什么不让 PushServer 直接摸 localStorage：`savePrefs()` 有模块级
     * cache，绕过它写 localStorage 会让页面继续读到旧值。设置页的读写
     * 必须回到前端做，壳只负责递 JSON。接口与 {@code DebugServer.Host}
     * 分开是因为这两个能力只有主界面（有 WebView）才有。
     */
    interface PrefsHost {
        /** 返回当前 prefs 的 JSON 文本；WebView 不可用返回 null。 */
        String readPrefsJson();

        /** 应用一份 prefs patch，返回实际写入的字段数；失败返回 0。 */
        int applyPrefsJson(String json);

        /** WebDAV 配置（`meow.webdav`，独立于 prefs，含密码）。 */
        String readWebdavJson();

        int applyWebdavJson(String json);

        /** 更新源与访问令牌（`meow.updateSource` / `meow.updateToken`）。 */
        String readUpdateJson();

        int applyUpdateJson(String json);

        /**
         * 后端 policy（搜索缓存时长 / JS 运行时 / 广告过滤 / SafeDNS /
         * 弹幕 API / 缓存配额与目录）。
         *
         * <p>这一组不在浏览器里 —— TV 本机执行时写端内网关的 policy.json，
         * 连外部后端时写那台机器的。所以是**异步**的（要发 HTTP）。
         */
        String readPolicyJson();

        int applyPolicyJson(String json);

        /** 命令类动作（clearSearchCache / resetHealth），返回影响条数。 */
        int runAction(String name);
    }

    private static volatile PrefsHost prefsHost;

    /** 由 MainActivity 在 WebView 就绪后注入；壳退出时置 null。 */
    static void setPrefsHost(PrefsHost host) {
        prefsHost = host;
    }

    private static ServerSocket socket;
    private static Thread thread;
    private static int port;
    private static String lanIp = "";
    private static volatile boolean running;

    /**
     * 一次性访问令牌：没有它就没有任何数据可读、任何设置可写。
     *
     * <p><b>为什么必须有</b>：这个端口绑在 0.0.0.0 上，同一 WiFi 下任何设备
     * 都能访问。没有令牌时，别人的手机只要打开 http://电视IP:9333/ 就能
     * 读到全部设置（含 WebDAV 密码、AI Key 的字段回显）、并把任意配置推上来
     * —— 等于把电视交给整个局域网。
     *
     * <p><b>为什么每次开启都换新的</b>：关掉再开是"怀疑令牌泄漏了"最省事的
     * 补救动作；沿用旧令牌会让这个动作毫无作用。与 {@code DebugServer} 同策。
     */
    private static volatile String token = "";

    /** 令牌字符集去掉易混淆的 0/O/1/I/l，便于用户在手机上手输。 */
    private static final String TOKEN_CHARS = "23456789abcdefghjkmnpqrstuvwxyz";

    private static String newToken() {
        java.security.SecureRandom rnd = new java.security.SecureRandom();
        StringBuilder sb = new StringBuilder(8);
        for (int i = 0; i < 8; i++) {
            sb.append(TOKEN_CHARS.charAt(rnd.nextInt(TOKEN_CHARS.length())));
        }
        return sb.toString();
    }

    /** 当前令牌（TV 弹层要显示它，供用户手输）。 */
    static String token() {
        return token;
    }

    static boolean isRunning() {
        return running;
    }

    static String lanIp() {
        return lanIp;
    }

    static int port() {
        return port;
    }

    /**
     * 手机要访问的地址（配置页展示 + 生成二维码用）。
     *
     * <p>带上 {@code ?k=<token>}：扫码即自动携带令牌，用户不用手输。
     * 手输 URL 时若漏了这段，手机页会弹出令牌输入框（见 PHONE_HTML 的
     * needToken 分支），而不是给一个空白页。
     */
    static String pushUrl() {
        if (lanIp.isEmpty()) return "";
        String base = "http://" + lanIp + ":" + port + "/";
        return token.isEmpty() ? base : base + "?k=" + token;
    }

    static boolean start(Context ctx, OnPush cb) {
        if (running) return true;
        token = newToken();
        lanIp = findLanIp();
        if (lanIp.isEmpty()) return false;
        try {
            ServerSocket ss = null;
            int p = 9333;
            for (int i = 0; i < 20; i++) {
                try {
                    ss = new ServerSocket(9333 + i);
                    p = 9333 + i;
                    break;
                } catch (Exception ignored) {
                }
            }
            if (ss == null) return false;
            socket = ss;
            port = p;
            running = true;
            final Handler ui = new Handler(Looper.getMainLooper());
            final ServerSocket server = ss;
            thread = new Thread(() -> {
                while (running) {
                    try {
                        Socket s = server.accept();
                        new Thread(() -> handle(s, ui, cb, ctx)).start();
                    } catch (Exception e) {
                        if (!running) break;
                    }
                }
            }, "meow-push");
            thread.setDaemon(true);
            thread.start();
            return true;
        } catch (Exception e) {
            running = false;
            return false;
        }
    }

    static void stop() {
        running = false;
        try {
            if (socket != null) socket.close();
        } catch (Exception ignored) {
        }
        socket = null;
        thread = null;
        token = "";
    }

    private static void handle(Socket s, Handler ui, OnPush cb, Context ctx) {
        try {
            s.setSoTimeout(15000);
            InputStream in = s.getInputStream();
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            int prev3 = 0, b;
            // 读到 \r\n\r\n 为止（只看请求头，body 单独按 Content-Length 读）
            while ((b = in.read()) != -1) {
                head.write(b);
                if (prev3 == '\r' && head.size() >= 4) {
                    byte[] h = head.toByteArray();
                    int n = h.length;
                    if (h[n - 4] == '\r' && h[n - 3] == '\n' && h[n - 2] == '\r' && h[n - 1] == '\n') break;
                }
                prev3 = b;
            }
            String header = new String(head.toByteArray(), "UTF-8");
            String first = header.split("\r\n")[0];
            String method = first.split(" ")[0];
            String path = first.split(" ").length > 1 ? first.split(" ")[1] : "/";

            int len = 0;
            for (String line : header.split("\r\n")) {
                if (line.toLowerCase().startsWith("content-length:")) {
                    try {
                        len = Integer.parseInt(line.substring(15).trim());
                    } catch (Exception ignored) {
                    }
                }
            }
            // 设置表单比两个字段大得多（20+ 项），原来 8KB 的上限不够。
            // 64KB 仍然远小于一次误传大文件会造成的压力，且手机侧表单
            // 实际只有几 KB。
            byte[] bodyBuf = new byte[Math.max(0, Math.min(len, 65536))];
            int read = 0;
            while (read < bodyBuf.length) {
                int n = in.read(bodyBuf, read, bodyBuf.length - read);
                if (n <= 0) break;
                read += n;
            }
            String body = new String(bodyBuf, 0, read, "UTF-8");

            String pathOnly = path;
            int q = pathOnly.indexOf('?');
            if (q >= 0) pathOnly = pathOnly.substring(0, q);

            /*
             * 令牌门禁：除了根路径（返回页面骨架，不含任何数据）之外，
             * 任何读配置 / 写配置的请求都必须带对令牌。
             *
             * 为什么根路径放行：页面本身要先能加载，否则用户没地方输令牌 ——
             * 变成一个死锁。页面里不含任何配置数据（数据全靠后续 fetch），
             * 所以放行根路径不泄露信息。
             */
            boolean isRootPage = pathOnly.isEmpty() || "/".equals(pathOnly);
            boolean guarded = pathOnly.startsWith("/push")
                    || pathOnly.startsWith("/lives")
                    || "/prefs".equals(pathOnly) || "/extra".equals(pathOnly)
                    || "/act".equals(pathOnly);
            if (!isRootPage && guarded) {
                Map<String, String> preForm = "POST".equals(method) ? parseForm(body) : null;
                if (!tokenOk(path, header, preForm)) {
                    write(s, 403, "application/json",
                            "{\"ok\":false,\"error\":\"invalid token\"}");
                    s.close();
                    return;
                }
            }

            if ("POST".equals(method) && pathOnly.startsWith("/push")) {
                Map<String, String> form = parseForm(body);
                final String fu = form.get("url");
                final String fc = form.get("config");
                final String fp = form.get("prefs");
                final String fw = form.get("webdav");
                final String fup = form.get("update");
                final String fpo = form.get("policy");
                // 配置导入方式（replace / merge）。空 = 老版本手机页，按默认处理。
                final String fm = form.get("mode");
                // 三条通道分别落盘，各自返回写入项数。为什么不能合成一个：
                // prefs / webdav / update 都在浏览器 localStorage，
                // policy 在后端文件；混在一起时任何一条失败都会让整次推送
                // 报 0，用户分不清"哪一项没生效"。
                PrefsHost ph = prefsHost;
                int nPrefs = 0, nWebdav = 0, nUpdate = 0, nPolicy = 0;
                if (ph != null) {
                    if (fp != null && !fp.isEmpty()) nPrefs = ph.applyPrefsJson(fp);
                    if (fw != null && !fw.isEmpty()) nWebdav = ph.applyWebdavJson(fw);
                    if (fup != null && !fup.isEmpty()) nUpdate = ph.applyUpdateJson(fup);
                    if (fpo != null && !fpo.isEmpty()) nPolicy = ph.applyPolicyJson(fpo);
                }
                final int applied = nPrefs + nWebdav + nUpdate + nPolicy;
                ui.post(() -> cb.onPush(fu == null ? "" : fu, fc == null ? "" : fc,
                        fp == null ? "" : fp, fm == null ? "" : fm));
                write(s, 200, "application/json",
                        "{\"ok\":true,\"applied\":" + applied
                                + ",\"prefs\":" + nPrefs
                                + ",\"webdav\":" + nWebdav
                                + ",\"update\":" + nUpdate
                                + ",\"policy\":" + nPolicy + "}");
            } else if (pathOnly.startsWith("/lives")) {
                /*
                 * 直播源增删查的转发口。
                 *
                 * 手机页和后端不同源（手机连的是 PushServer 的端口，后端在
                 * 30011 或电视自带的 9978），手机直接 fetch 会被 CORS 挡。
                 * 在电视上用原生 HTTP 转一次，手机就只跟 PushServer 同源通信。
                 *
                 * 为什么不干脆让手机页调 /push：增删是**列表操作**，不是
                 * "存一个值"，失败要单独重试；混进 /push 会连累 prefs 整批失败。
                 */
                String base = backendBase(ctx);
                String forward = "DELETE".equals(method) ? "DELETE"
                        : ("POST".equals(method) ? "POST" : "GET");
                String payload = ("POST".equals(forward) || "DELETE".equals(forward)) ? body : null;
                write(s, 200, "application/json; charset=utf-8",
                        proxyJson(base + "/api/lives", forward, payload));
            } else if ("GET".equals(method) && "/prefs".equals(pathOnly)) {
                // 手机页需要用"电视当前的值"预填表单，否则用户会以为
                // 空白就是默认值，一提交就把已有的设置冲掉。
                write(s, 200, "application/json; charset=utf-8", currentPrefsJson(ctx));
            } else if ("GET".equals(method) && "/extra".equals(pathOnly)) {
                // WebDAV / 更新源 / policy 三组，手机页一次性取回预填。
                // 合并成一个端点而不是三个：手机页在 3G/弱网下多发两个请求
                // 只会让首屏更慢，而这三份数据都不大。
                write(s, 200, "application/json; charset=utf-8", currentExtraJson());
            } else if ("POST".equals(method) && "/act".equals(pathOnly)) {
                // 命令类动作（清空搜索缓存 / 重置源健康）。
                // 为什么不并在 /push 里：这两个是"现在做一件事"而不是"存一个值"，
                // 语义不同；而且它们失败不该影响已经写进去的设置。
                String name = queryOf(path, "name");
                PrefsHost ph = prefsHost;
                int n = 0;
                if (ph != null && !name.isEmpty()) n = ph.runAction(name);
                write(s, 200, "application/json", "{\"ok\":true,\"n\":" + n + "}");
            } else {
                write(s, 200, "text/html; charset=utf-8", PHONE_HTML);
            }
            s.close();
        } catch (Exception e) {
            Log.w(TAG, "handle failed", e);
            try {
                s.close();
            } catch (Exception ignored2) {
            }
        }
    }

    /**
     * 读出 WebView 里当前的 prefs（供手机页预填）。
     *
     * <p>为什么不从 SharedPreferences 读：prefs 存在 WebView 的 localStorage，
     * 不在原生 prefs 里。这里必须问前端要——这也是 {@code OnPush} 回调
     * 要能执行 JS 的原因。
     *
     * <p>拿不到就返回空对象而不是报错：手机页会以「默认值」渲染，
     * 用户至少还能改；报错会让整页白掉，比空表单更糟。
     */
    /**
     * 后端基地址：用户填的那个优先，留空就用电视自带的执行环境（本机网关）。
     *
     * <p>手机页上的 `/lives` 要转发到这里；两种形态（连自建后端 / 用内置网关）
     * 的手机页长得一样，不该让用户为此改填另一份地址。
     */
    private static String backendBase(Context ctx) {
        try {
            String v = ctx.getSharedPreferences(MainActivity.PREF, Context.MODE_PRIVATE)
                    .getString(MainActivity.K_API, "");
            if (v != null && !v.trim().isEmpty()) {
                return v.trim().replaceAll("/+$", "");
            }
        } catch (Throwable ignored) {
        }
        return GatewayServer.baseUrl();
    }

    /** 把一次请求转发给后端，返回响应体原文（连不上也回可读 JSON，不抛）。 */
    private static String proxyJson(String url, String method, String body) {
        java.net.HttpURLConnection c = null;
        try {
            c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            c.setConnectTimeout(5000);
            // 加源时后端会真拉一遍 m3u 再解析，十几秒很正常
            c.setReadTimeout(45000);
            c.setRequestMethod(method);
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                c.getOutputStream().write(body.getBytes("UTF-8"));
            }
            int code = c.getResponseCode();
            java.io.InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (in != null) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) != -1) sb.append(new String(buf, 0, n, "UTF-8"));
                in.close();
            }
            String out = sb.toString();
            return out.isEmpty()
                    ? "{\"ok\":false,\"msg\":\"后端返回 HTTP " + code + "\"}"
                    : out;
        } catch (Exception e) {
            return "{\"ok\":false,\"msg\":" + jsonEscape("连不上后端：" + e.getClass().getSimpleName()) + "}";
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String jsonEscape(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static String currentPrefsJson(Context ctx) {
        PrefsHost h = prefsHost;
        if (h == null) return "{}";
        String raw = h.readPrefsJson();
        if (raw == null || raw.isEmpty() || "null".equals(raw)) return "{}";
        // evaluateJavascript 对字符串结果会返回带引号的 JSON 文本（"..."），
        // 先剥一层引号，手机端才能直接 JSON.parse。
        return unwrapJsString(raw);
    }

    /**
     * 剥掉 evaluateJavascript 给字符串加的引号并反转义。
     *
     * <p>`evaluateJavascript("JSON.stringify(x)")` 返回的是 `"{\"a\":1}"`——
     * 一个 JSON 字符串字面量，而不是对象。手机端 `JSON.parse` 它只会得到
     * 另一个字符串，字段全都拿不到（表单全空）。必须在这里解一次。
     */
    static String unwrapJsStringPublic(String s) {
        return unwrapJsString(s);
    }

    private static String unwrapJsString(String s) {
        if (s == null) return "{}";
        String t = s.trim();
        if (t.length() < 2 || t.charAt(0) != '"') return t;
        StringBuilder sb = new StringBuilder(t.length());
        for (int i = 1; i < t.length() - 1; i++) {
            char c = t.charAt(i);
            if (c == '\\' && i + 1 < t.length() - 1) {
                char n = t.charAt(++i);
                switch (n) {
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'u':
                        if (i + 4 < t.length()) {
                            try {
                                sb.append((char) Integer.parseInt(t.substring(i + 1, i + 5), 16));
                                i += 4;
                            } catch (Exception ignored) {
                                sb.append("\\u");
                            }
                        }
                        break;
                    default: sb.append(n);
                }
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /**
     * WebDAV / 更新源 / policy 三组的当前值，合成一个 JSON 交给手机页预填。
     *
     * <p>为什么合成一个：手机页在弱网下多发两个请求只会让首屏更慢，
     * 而这三份数据都不大（各几十字段以内）。合并后手机页一次 `GET /extra`
     * 就能把全部表单填好。
     *
     * <p>任一组拿不到就用空对象兜底：表单会显示空值（用户可以填），
     * 而不是整页报错。
     */
    private static String currentExtraJson() {
        PrefsHost h = prefsHost;
        String webdav = "{}", update = "{}", policy = "{}";
        if (h != null) {
            webdav = unwrapJsString(h.readWebdavJson());
            update = unwrapJsString(h.readUpdateJson());
            policy = unwrapJsString(h.readPolicyJson());
        }
        if (webdav == null || webdav.isEmpty()) webdav = "{}";
        if (update == null || update.isEmpty()) update = "{}";
        if (policy == null || policy.isEmpty()) policy = "{}";
        return "{\"webdav\":" + webdav + ",\"update\":" + update + ",\"policy\":" + policy + "}";
    }

    /**
     * 校验请求携带的令牌。
     *
     * <p>三个来源都接受，按"最不容易丢"排序：
     * <ol>
     *   <li>query {@code ?k=} —— 手机页所有 fetch 都拼这个（扫码进入时自动带）</li>
     *   <li>POST 表单字段 {@code k} —— 某些老浏览器/表单提交路径</li>
     *   <li>请求头 {@code X-Meow-Token} —— 给 curl / 脚本用</li>
     * </ol>
     *
     * <p>用普通 equals 而不是定时安全比较：这是本地局域网的 8 位随机串，
     * 计时攻击的前提（能反复探测精确到微秒）在这里不成立，而
     * {@code MessageDigest.isEqual} 会让整段代码更难读。
     */
    private static boolean tokenOk(String path, String header, Map<String, String> form) {
        if (token.isEmpty()) return false;
        String want = token;
        String q = queryOf(path, "k");
        if (want.equals(q)) return true;
        if (form != null && want.equals(form.get("k"))) return true;
        for (String line : header.split("\r\n")) {
            int c = line.indexOf(':');
            if (c < 0) continue;
            if (!"x-meow-token".equalsIgnoreCase(line.substring(0, c).trim())) continue;
            if (want.equals(line.substring(c + 1).trim())) return true;
        }
        return false;
    }

    /**
     * 页面里嵌的令牌。
     *
     * <p>为什么不把 token 直接拼进 HTML：那样任何人 GET 一次根路径就拿到了
     * 令牌，等于没有鉴权。这里只嵌"是否要求令牌"，令牌本身仍由 URL 的
     * {@code ?k=} 携带（扫码自动带入），或在页面上手输。
     */
    private static String tokenRequiredFlag() {
        return token.isEmpty() ? "false" : "true";
    }

    /** 从 `/path?a=1&b=2` 里取查询参数。 */
    private static String queryOf(String path, String key) {
        int q = path == null ? -1 : path.indexOf('?');
        if (q < 0) return "";
        for (String kv : path.substring(q + 1).split("&")) {
            int eq = kv.indexOf('=');
            if (eq < 0) continue;
            if (!key.equals(kv.substring(0, eq))) continue;
            try {
                return URLDecoder.decode(kv.substring(eq + 1), "UTF-8");
            } catch (Exception e) {
                return "";
            }
        }
        return "";
    }

    private static Map<String, String> parseForm(String body) {
        Map<String, String> out = new LinkedHashMap<>();
        if (body == null || body.isEmpty()) return out;
        for (String kv : body.split("&")) {
            int eq = kv.indexOf('=');
            if (eq < 0) continue;
            String k = kv.substring(0, eq);
            try {
                out.put(k, URLDecoder.decode(kv.substring(eq + 1), "UTF-8"));
            } catch (UnsupportedEncodingException e) {
                out.put(k, kv.substring(eq + 1));
            }
        }
        return out;
    }

    private static void write(Socket s, int code, String type, String body) {
        try {
            OutputStream os = s.getOutputStream();
            byte[] data = body.getBytes("UTF-8");
            String head = "HTTP/1.1 " + code + " OK\r\n"
                    + "Content-Type: " + type + "\r\n"
                    + "Content-Length: " + data.length + "\r\n"
                    + "Cache-Control: no-store\r\n"
                    + "Access-Control-Allow-Origin: *\r\n"
                    + "Connection: close\r\n\r\n";
            os.write(head.getBytes("UTF-8"));
            os.write(data);
            os.flush();
        } catch (Exception ignored) {
        }
    }

    // ---------------------------------------------------------------- 手机页

    /**
     * 手机端设置页。
     *
     * <p><b>为什么是手写 HTML 而不是打包一份前端</b>：这份页面只需显示
     * 十几个常用项，引 Vue/React 会让它变成需要构建的第二套前端；
     * 而 PushServer 只能返回字符串，没有静态文件服务能力。
     *
     * <p><b>为什么不给「全部设置」</b>：视频画面缩放、壁纸、AI Key
     * 这些在电视上改更自然（要边看边调），手机上改反而不直观。
     * 这里只放"改完想立刻看效果"和"遥控器上特别难操作"的那些项。
     */
    private static final String PHONE_HTML = ""
            + "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
            + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            + "<meta name=\"color-scheme\" content=\"dark light\"><title>设置电视</title>"
            + "<style>/* ★ 必须显式给 color-scheme。 "
            + "<meta name=\"color-scheme\" content=\"dark light\"> 只是\"声明支持两种\"， 实际用哪套由**系统偏好**决定 —— 手机是浅色系统时，原生 "
            + "<select> 的 弹层会渲染成白底灰条（实测截图：深色页面上弹出一块浅色菜单）， 而 select 元素本身是被我们样式化的，于是\"框是深的、弹层是白的\"。 CSS 的 color-scheme 优先级高于 meta，按 data-mode 钉死才跟主题一致。 这与 PC 端 tokens.css 里的同名规则是同一个坑。 */ :root{ color-scheme:dark; --accent:#03dac5;--accent-dim:#02b3a2;--on-accent:#0a0b11; --base:#12141d;--ink:#ffffff;--ink-2:#b8bdcc;--ink-3:#7a8095; --card:rgba(255,255,255,.055);--card-hover:rgba(255,255,255,.085); --line:rgba(255,255,255,.06);--field:rgba(0,0,0,.3); --sunken:rgba(255,255,255,.03); --hot:#ff0057;--ok:#6cc354;--warn:#ff5f00; --r-md:10px;--r-lg:14px;--r-xl:20px; } /* 跟电视当前主题走：推完设置后这页也会立刻变成对应配色 */ :root[data-mode=light]{ color-scheme:light; --base:#f4f6fa;--ink:#141828;--ink-2:#4b5263;--ink-3:#7c8496; --card:rgba(20,26,40,.05);--card-hover:rgba(20,26,40,.08); --line:rgba(20,26,40,.12);--field:rgba(20,26,40,.05); --sunken:#ffffff;--on-accent:#04211d; } *{box-sizing:border-box;-webkit-tap-highlight-color:transparent} body{margin:0;padding:16px 14px 96px;background:var(--base);color:var(--ink); font:15px/1.55 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif; -webkit-font-smoothing:antialiased} /* 页头：与设置页分区卡的标题层级一致 */ header{margin:0 2px 14px} h1{font-size:19px;font-weight:600;margin:0 0 3px;letter-spacing:.01em} header p{color:var(--ink-3);font-size:12.5px;margin:0} /* 分区卡：.set-card 的移动端对应物 */ section{background:var(--sunken);border:1px solid var(--line);border-radius:var(--r-xl); padding:12px 14px;margin-bottom:10px} h2{font-size:12px;font-weight:500;color:var(--ink-2);margin:0 0 8px;letter-spacing:.01em} /* 行：标签左、控件右 */ .row{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)} .row:first-of-type{border-top:0;padding-top:2px} .row:last-child{padding-bottom:2px} .k{flex:1 1 auto;min-width:0;font-size:14.5px;color:var(--ink)} .k small{display:block;color:var(--ink-3);font-size:11.5px;margin-top:1px;line-height:1.4} /* 输入：令牌与 web 的 --color-field 一致 */ input[type=text],select{flex:0 1 auto;min-width:0;width:100%;max-width:62%; background:var(--field);color:var(--ink);border:1px solid var(--line); border-radius:var(--r-md);padding:8px 10px;font-size:14px;outline:none; font-family:inherit;transition:border-color .15s} input[type=number]{flex:0 0 auto;width:80px;text-align:right; background:var(--field);color:var(--ink);border:1px solid var(--line); border-radius:var(--r-md);padding:8px 10px;font-size:14px;outline:none; font-family:inherit;transition:border-color .15s} input:focus,select:focus{border-color:var(--accent)}/* 弹层每一项也上色：老 WebView（实测 Chrome 110 的 TV）只给 color-scheme 时 option 仍是系统默认白底 */select option{background:var(--base);color:var(--ink)} /* 开关：尺寸与磁贴行高对齐 */ .sw{position:relative;width:46px;height:28px;flex:0 0 auto} .sw input{position:absolute;opacity:0;width:100%;height:100%;margin:0;z-index:2} .sw i{position:absolute;left:0;top:0;right:0;bottom:0;background:var(--line); border-radius:14px;transition:background-color .18s} .sw i:after{content:'';position:absolute;width:22px;height:22px;border-radius:11px; background:#fff;top:3px;left:3px;transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.3)} .sw input:checked+i{background:var(--accent)} .sw input:checked+i:after{transform:translateX(18px)} button{width:100%;margin-top:0;padding:14px;border:0;border-radius:var(--r-lg); background:var(--accent);color:var(--on-accent);font-size:16px;font-weight:600; font-family:inherit;cursor:pointer;transition:opacity .15s} button:active{opacity:.85} button:disabled{opacity:.45} /* 底部按钮组：推送占满，刷新窄一档。 刷新是次级动作，但必须一直可见 —— 电视被别人用遥控器改过之后， 不刷新就看不到新值，用户会基于过期数据做判断。 */ .actions{display:flex;gap:10px;align-items:stretch} .actions #b{flex:1 1 auto;min-width:0} #rf{flex:0 0 auto;width:auto;padding:14px 20px;background:var(--card); color:var(--ink-2);border:1px solid var(--line);font-size:15px;font-weight:500} #rf:active{opacity:.7} .msg .stamp{color:var(--ink-3)} /* 令牌门禁：没有正确令牌时用遮罩挡住表单，而不是让用户填完才被 403 拒绝 */ #gate{position:fixed;left:0;top:0;right:0;bottom:0;z-index:50;background:var(--base); display:flex;flex-direction:column;align-items:center;justify-content:center; padding:24px 22px;text-align:center} #gate.hide{display:none} #gate h2{font-size:16px;color:var(--ink);margin:0 0 6px;font-weight:600;letter-spacing:0} #gate p{color:var(--ink-3);font-size:13px;margin:0 0 18px;line-height:1.6;max-width:22rem} #gate input{width:100%;max-width:16rem;text-align:center;letter-spacing:.22em; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px; background:var(--field);color:var(--ink);border:1px solid var(--line); border-radius:var(--r-md);padding:12px 14px;outline:none} #gate input:focus{border-color:var(--accent)} #gate button{max-width:16rem;margin-top:14px} #gateMsg{color:var(--hot);font-size:13px;min-height:20px;margin-top:10px} .footer{position:fixed;left:0;right:0;bottom:0;z-index:10;padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));background:var(--base);border-top:1px solid var(--line)}.footer:before{content:'';position:absolute;left:0;right:0;top:-24px;height:24px;background:linear-gradient(to bottom,transparent,var(--base));pointer-events:none}.msg{text-align:center;margin:0 0 6px;font-size:13px;min-height:18px;color:var(--ink-3)}.msg:empty{display:none} .msg.ok{color:var(--ok)}.msg.err{color:var(--hot)} /* 直播源列表：手机屏窄，名字一行、地址一行、删除按钮靠右 */ .live-item{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--line)} .live-item:first-child{border-top:0;padding-top:2px} .live-name{flex:0 1 auto;max-width:38%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;color:var(--ink)} .live-url{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--ink-3)} .live-del{flex:0 0 auto;width:auto;margin:0;padding:4px 10px;background:var(--card);color:var(--ink-3);border:1px solid var(--line);border-radius:8px;font-size:12px;font-weight:500;box-shadow:none} .live-add{width:100%;margin-top:8px;padding:12px;background:var(--card);color:var(--ink-2);border:1px solid var(--line);border-radius:var(--r-lg);font-size:15px;font-weight:500} .live-empty{color:var(--ink-3);font-size:12.5px;padding:4px 0} .live-msg{margin:8px 0 0;font-size:12.5px;color:var(--ink-3);text-align:center} .live-msg:empty{display:none} .live-msg.ok{color:var(--ok)} .live-msg.err{color:var(--hot)}"
            + "</style></head><body><div id=\"gate\"> <h2>需要访问令牌</h2> "
            + "<p>令牌显示在电视的「设置 → 连接 → 扫码填写」弹框里（地址末尾的 k 参数）。 扫描二维码进入会自动带入；手动打开地址时请在此输入。</p> "
            + "<input id=\"gateInput\" type=\"text\" maxlength=\"8\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\" placeholder=\"8 位令牌\"> "
            + "<button id=\"gateBtn\">进入</button> <div id=\"gateMsg\"></div> </div> <header> "
            + "<h1>设置电视</h1> <p>勾选或填写后点底部按钮，电视上立即生效，不用重启。</p> </header> <section> <h2>连接</h2></h2> <div "
            + "class=\"row\"><span class=\"k\">后端地址<small>留空 = 用电视自带的执行环境</small></span> <input type=\"text\" "
            + "id=\"p_api\" placeholder=\"http://ip:30011\"></div> </section> <section> <h2>搜索与源</h2><small>"
            + "改完这些要重启后端才彻底生效的部分不在此列</small></h2> <div class=\"row\"><span class=\"k\">配置地址<small>CatVod 形状的 "
            + "JSON，可留空</small></span> <input type=\"text\" id=\"p_config\" "
            + "placeholder=\"http://ip:30011/config.json\"></div> <div class=\"row\"><span class=\"k\">导入方式<small>"
            + "追加保留现有站点；替换会整表换掉</small></span><select id=\"p_importMode\"><option value=\"merge\">追加（推荐）</option><"
            + "option value=\"replace\">替换</option></select></div><div class=\"row\"><span class=\"k\">清空搜索缓存<"
            + "small>修完源后立刻看全量结果</small></span> <span class=\"sw\"><input type=\"checkbox\" "
            + "id=\"p_clearSearchCache\"><i></i></span></div> <div class=\"row\"><span class=\"k\">重置源健康<small>"
            + "清掉跳过/降档标记，全部源重新参与</small></span> <span class=\"sw\"><input type=\"checkbox\" id=\"p_resetHealth\"><"
            + "i></i></span></div> <div class=\"row\"><span class=\"k\">结果缓存-命中<small>秒</small></span> <input "
            + "type=\"number\" id=\"g_searchCacheHitSec\" min=\"60\" max=\"86400\" step=\"60\"></div> <div "
            + "class=\"row\"><span class=\"k\">结果缓存-空结果<small>秒</small></span> <input type=\"number\" "
            + "id=\"g_searchCacheMissSec\" min=\"30\" max=\"86400\" step=\"30\"></div> <div class=\"row\"><span "
            + "class=\"k\">结果缓存-失败<small>秒，别调大</small></span> <input type=\"number\" id=\"g_searchCacheFailSec\" "
            + "min=\"30\" max=\"86400\" step=\"30\"></div> <div class=\"row\"><span class=\"k\">噪音过滤词<small>"
            + "命中片名/备注即处理，留空=关闭</small></span> <input type=\"text\" id=\"g_searchNoise\" placeholder=\"解说, 混剪, 预告, "
            + "花絮\"></div> <div class=\"row\"><span class=\"k\">命中后<small>过滤=不显示；降级=排到最后</small></span> <select "
            + "id=\"g_searchNoiseMode\"><option value=\"filter\">过滤隐藏</option> <option value=\"rank\">仅排序降级<"
            + "/option></select></div> <div class=\"row\"><span class=\"k\">JS 运行时<small>drpy 地址，留空=未装</small><"
            + "/span> <input type=\"text\" id=\"g_jsRuntime\" placeholder=\"http://ip:9330\"></div> <div "
            + "class=\"row\"><span class=\"k\">广告分片过滤<small>按 ads 表丢 m3u8 分片</small></span> <span class=\"sw\"><"
            + "input type=\"checkbox\" id=\"g_filterAds\"><i></i></span></div> </h2> <div class=\"row\"><span "
            + "class=\"k\">搜索线程<small>同时向多少个源发请求</small></span> <input type=\"number\" id=\"p_searchThreads\" "
            + "min=\"1\" max=\"64\" step=\"1\"></div> <div class=\"row\"><span class=\"k\">结果展示</span> <select "
            + "id=\"p_searchLayout\"><option value=\"grid\">缩略图</option> <option value=\"list\">列表</option><"
            + "/select></div> </section> <section> <h2>直播源</h2></h2><div id=\"liveList\"><div class=\"live-empty\">"
            + "读取中…</div></div><div class=\"row\"><span class=\"k\">名称<small>可留空</small></span><input "
            + "type=\"text\" id=\"p_liveName\" placeholder=\"例：每日更新\"></div><div class=\"row\"><span class=\"k\">"
            + "播放列表<small>m3u / txt，添加前会先拉一遍校验</small></span><input type=\"text\" id=\"p_liveUrl\" "
            + "placeholder=\"https://example.com/live.m3u\"></div><button id=\"liveAdd\" class=\"live-add\">添加直播源<"
            + "/button><p id=\"liveMsg\" class=\"live-msg\"></p></section> <section> <h2>播放</h2></h2> <div "
            + "class=\"row\"><span class=\"k\">画面缩放<small>适应 / 铺满 / 拉伸</small></span> <select id=\"p_videoFit\"><"
            + "option value=\"contain\">适应</option> <option value=\"cover\">铺满</option><option value=\"fill\">拉伸<"
            + "/option></select></div> <div class=\"row\"><span class=\"k\">自动连播</span> <select "
            + "id=\"p_autoNextMode\"><option value=\"countdown\">倒计时</option> <option value=\"immediate\">立即<"
            + "/option><option value=\"off\">不连播</option></select></div> <div class=\"row\"><span class=\"k\">"
            + "连播倒计时<small>秒</small></span> <input type=\"number\" id=\"p_autoNextDelay\" min=\"3\" max=\"30\" "
            + "step=\"1\"></div> <div class=\"row\"><span class=\"k\">跳过片头<small>秒，0 = 不跳</small></span> <input "
            + "type=\"number\" id=\"p_skipIntro\" min=\"0\" max=\"600\" step=\"5\"></div> <div class=\"row\"><span "
            + "class=\"k\">跳过片尾<small>秒，0 = 不跳</small></span> <input type=\"number\" id=\"p_skipOutro\" min=\"0\" "
            + "max=\"600\" step=\"5\"></div> <div class=\"row\"><span class=\"k\">跳过前倒计时<small>0 = 立即跳</small><"
            + "/span> <input type=\"number\" id=\"p_skipCountdown\" min=\"0\" max=\"15\" step=\"1\"></div> <div "
            + "class=\"row\"><span class=\"k\">跳过中插广告<small>区间标错会吞剧情</small></span> <span class=\"sw\"><input "
            + "type=\"checkbox\" id=\"p_skipMiddle\"><i></i></span></div> <div class=\"row\"><span class=\"k\">"
            + "右上角进度<small>控制栏隐藏时也能看到</small></span> <span class=\"sw\"><input type=\"checkbox\" "
            + "id=\"p_showTimeBadge\"><i></i></span></div> <div class=\"row\"><span class=\"k\">底部迷你进度条</span> <"
            + "span class=\"sw\"><input type=\"checkbox\" id=\"p_showMiniProgress\"><i></i></span></div> </section>"
            + " <section> <h2>弹幕</h2></h2> <div class=\"row\"><span class=\"k\">显示弹幕</span> <span class=\"sw\"><"
            + "input type=\"checkbox\" id=\"p_danmaku\"><i></i></span></div> <div class=\"row\"><span class=\"k\">"
            + "密度<small>同时决定滚动时长与显示区域</small></span> <select id=\"p_danmakuDensity\"><option value=\"sparse\">稀疏<"
            + "/option> <option value=\"standard\">标准</option><option value=\"dense\">密集</option> <option "
            + "value=\"custom\">自定义（保留电视设置）</option></select></div> <div class=\"row\"><span class=\"k\">字号</span> "
            + "<select id=\"p_danmakuScale\"><option value=\"0.8\">80%</option> <option value=\"1\">标准</option><"
            + "option value=\"1.2\">120%</option> <option value=\"1.4\">140%</option></select></div> <div "
            + "class=\"row\"><span class=\"k\">透明度<small>0.2 ~ 1</small></span> <input type=\"number\" "
            + "id=\"p_danmakuOpacity\" min=\"0.2\" max=\"1\" step=\"0.1\"></div> <div class=\"row\"><span "
            + "class=\"k\">滚动时长<small>秒，越大越慢</small></span> <input type=\"number\" id=\"p_danmakuDuration\" "
            + "min=\"6\" max=\"30\" step=\"1\"></div> <div class=\"row\"><span class=\"k\">显示区域<small>占屏高比例 0.4~1<"
            + "/small></span> <input type=\"number\" id=\"p_danmakuArea\" min=\"0.4\" max=\"1\" step=\"0.05\"><"
            + "/div> <div class=\"row\"><span class=\"k\">屏蔽词<small>逗号分隔，命中即不显示</small></span> <input "
            + "type=\"text\" id=\"p_danmakuBlock\" placeholder=\"引战,剧透\"></div> </h2> <div class=\"row\"><span "
            + "class=\"k\">弹幕 API<small>留空=内置源；装插件会自动填</small></span> <input type=\"text\" id=\"g_danmakuApi\" "
            + "placeholder=\"http://ip:9321\"></div> <div class=\"row\"><span class=\"k\">腾讯自动抓取<small>时间轴不准，默认关<"
            + "/small></span> <span class=\"sw\"><input type=\"checkbox\" id=\"g_danmakuTencent\"><i></i></span><"
            + "/div> </section> <section> <h2>外观</h2></h2> <div class=\"row\"><span class=\"k\">主题</span> <select "
            + "id=\"p_themeStyle\"><option value=\"meow\">猫窝青</option> <option value=\"claude\">暖沙</option><option "
            + "value=\"material\">水泥</option> <option value=\"miuix\">米柚</option></select></div> <div "
            + "class=\"row\"><span class=\"k\">明暗</span> <select id=\"p_themeMode\"><option value=\"dark\">深色<"
            + "/option> <option value=\"light\">浅色</option><option value=\"system\">跟随系统</option></select></div> <"
            + "div class=\"row\"><span class=\"k\">首页列数<small>上限，窄屏会自动减少</small></span> <input type=\"number\" "
            + "id=\"p_homeCols\" min=\"3\" max=\"10\" step=\"1\"></div> <div class=\"row\"><span class=\"k\">壁纸<"
            + "/span> <select id=\"p_wallpaper\"><option value=\"\">无背景</option> <option value=\"cinema\">影院光斑<"
            + "/option><option value=\"aura\">青色光带</option> <option value=\"cat\">窗边猫</option><option "
            + "value=\"nightcity\">夜雨灯影</option> <option value=\"ember\">余烬微光</option><option value=\"mistlake\">"
            + "雾湖晨霭</option> <option value=\"dusksea\">暮海沉照</option><option value=\"nebula\">深空星云</option> <option "
            + "value=\"shanshui\">淡彩山水</option><option value=\"cloudsea\">云海晨光</option> <option value=\"sakura\">"
            + "樱花窗前</option><option value=\"catnap\">窗边小憩</option> <option value=\"rabbit\">青草小兔</option><option "
            + "value=\"meadow\">山野薄雾</option> <option value=\"custom\">自定义（自己上传的）</option></select></div> <div "
            + "class=\"row\"><span class=\"k\">背景模糊<small>0–20 px</small></span> <input type=\"number\" "
            + "id=\"p_wallpaperBlur\" min=\"0\" max=\"20\" step=\"1\"></div> <div class=\"row\"><span class=\"k\">"
            + "壁纸可见度<small>0–1，越高字越淡</small></span> <input type=\"number\" id=\"p_wallpaperOpacity\" min=\"0\" "
            + "max=\"1\" step=\"0.05\"></div> </section> <section> <h2>存储</h2></h2> <div class=\"row\"><span "
            + "class=\"k\">缓存配额<small>GB，0 = 不限制</small></span> <input type=\"number\" id=\"g_cacheQuotaGb\" "
            + "min=\"0\" max=\"2000\" step=\"1\"></div> <div class=\"row\"><span class=\"k\">超限时</span> <select "
            + "id=\"g_cacheEvictMode\"><option value=\"lru\">自动删最久没看的</option> <option value=\"off\">只提示，不删<"
            + "/option></select></div> <div class=\"row\"><span class=\"k\">缓存位置<small>留空=数据目录下 cache/video</small>"
            + "</span> <input type=\"text\" id=\"g_cacheDir\" placeholder=\"D:\\meow-cache\"></div> <div "
            + "class=\"row\"><span class=\"k\">历史记录条数<small>超出后最旧的被丢弃</small></span> <input type=\"number\" "
            + "id=\"p_historyLimit\" min=\"0\" max=\"500\" step=\"10\"></div> </section> <section> <h2>WebDAV 同步<"
            + "/h2></h2> <div class=\"row\"><span class=\"k\">启用</span> <span class=\"sw\"><input "
            + "type=\"checkbox\" id=\"w_enabled\"><i></i></span></div> <div class=\"row\"><span class=\"k\">地址<"
            + "small>根地址，如 http://ip:5005/meow</small></span> <input type=\"text\" id=\"w_url\" "
            + "placeholder=\"http://ip:5005/meow\"></div> <div class=\"row\"><span class=\"k\">用户名</span> <input "
            + "type=\"text\" id=\"w_user\" placeholder=\"留空 = 匿名\"></div> <div class=\"row\"><span class=\"k\">密码<"
            + "small>留空 = 不修改电视上已存的</small></span> <input type=\"text\" id=\"w_pass\" placeholder=\"留空 = 不修改\"><"
            + "/div> <div class=\"row\"><span class=\"k\">子目录<small>默认 meow</small></span> <input type=\"text\" "
            + "id=\"w_dir\" placeholder=\"meow\"></div> <div class=\"row\"><span class=\"k\">同步观看历史</span> <span "
            + "class=\"sw\"><input type=\"checkbox\" id=\"w_syncHistory\"><i></i></span></div> <div class=\"row\"><"
            + "span class=\"k\">同步设置备份</span> <span class=\"sw\"><input type=\"checkbox\" id=\"w_syncPrefs\"><i><"
            + "/i></span></div> <div class=\"row\"><span class=\"k\">同步搜索词</span> <span class=\"sw\"><input "
            + "type=\"checkbox\" id=\"w_syncSearchHistory\"><i></i></span></div> <div class=\"row\"><span "
            + "class=\"k\">备份片库配置<small>不含密码</small></span> <span class=\"sw\"><input type=\"checkbox\" "
            + "id=\"w_syncLibrary\"><i></i></span></div> </section> <section> <h2>AI</h2></h2> <div class=\"row\"><"
            + "span class=\"k\">启用</span> <span class=\"sw\"><input type=\"checkbox\" id=\"p_llmEnabled\"><i></i><"
            + "/span></div> <div class=\"row\"><span class=\"k\">接口地址<small>OpenAI 兼容端点</small></span> <input "
            + "type=\"text\" id=\"p_llmBaseUrl\" placeholder=\"http://ip:8788/v1\"></div> <div class=\"row\"><span "
            + "class=\"k\">模型</span> <input type=\"text\" id=\"p_llmModel\" placeholder=\"deepseek-chat\"></div> <"
            + "div class=\"row\"><span class=\"k\">API Key<small>只存本机，不进备份</small></span> <input type=\"text\" "
            + "id=\"p_llmApiKey\" placeholder=\"sk-...\"></div> <div class=\"row\"><span class=\"k\">上下文轮数<small>"
            + "0–10</small></span> <input type=\"number\" id=\"p_llmHistoryRounds\" min=\"0\" max=\"10\" "
            + "step=\"1\"></div> <div class=\"row\"><span class=\"k\">超时<small>毫秒，推理模型可调大</small></span> <input "
            + "type=\"number\" id=\"p_llmTimeoutMs\" min=\"3000\" max=\"120000\" step=\"1000\"></div> <div "
            + "class=\"row\"><span class=\"k\">最大输出<small>token；推理模型会自动加大</small></span> <input type=\"number\" "
            + "id=\"p_llmMaxTokens\" min=\"100\" max=\"8000\" step=\"100\"></div> </section> <section> <h2>维护</h2><"
            + "/h2> <div class=\"row\"><span class=\"k\">安全 DNS<small>DoH 解析，绕过 TUN fake-ip</small></span> <span "
            + "class=\"sw\"><input type=\"checkbox\" id=\"g_safeDns\"><i></i></span></div> <div class=\"row\"><"
            + "span class=\"k\">DNS 服务商<small>安全 DNS 关闭时无效</small></span> <select id=\"g_dnsProvider\"><option "
            + "value=\"dnspub\">腾讯 DoH</option> <option value=\"ali\">阿里 DoH</option><option value=\"360\">360 DoH<"
            + "/option> <option value=\"google\">Google DoH</option> <option value=\"cloudflare\">Cloudflare<"
            + "/option></select></div> </section> <section> <h2>应用更新</h2></h2> <div class=\"row\"><span "
            + "class=\"k\">更新源<small>留空=内置 GitHub Release</small></span> <input type=\"text\" id=\"u_source\" "
            + "placeholder=\"留空 = 内置默认源\"></div> <div class=\"row\"><span class=\"k\">备用源<small>主源失败才试</small><"
            + "/span> <input type=\"text\" id=\"u_backup\" placeholder=\"可留空，不会回落官方源\"></div> <div class=\"row\"><"
            + "span class=\"k\">访问令牌<small>私有仓才需要</small></span> <input type=\"text\" id=\"u_token\" "
            + "placeholder=\"公开源留空\"></div> <div class=\"row\"><span class=\"k\">自动检查壳</span><span class=\"sw\"><"
            + "input type=\"checkbox\" id=\"u_autoApp\"><i></i></span></div> <div class=\"row\"><span class=\"k\">"
            + "自动检查模块<small>仅已安装</small></span><span class=\"sw\"><input type=\"checkbox\" id=\"u_autoModule\"><i><"
            + "/i></span></div> <div class=\"row\"><span class=\"k\">自动检查插件<small>仅 PC</small></span><span "
            + "class=\"sw\"><input type=\"checkbox\" id=\"u_autoPlugins\"><i></i></span></div> <div class=\"row\"><"
            + "span class=\"k\">自动检查 fnOS<small>24h 一次</small></span><span class=\"sw\"><input type=\"checkbox\" "
            + "id=\"u_autoFpk\"><i></i></span></div> <p class=\"note\">自动检查只更新状态，不弹框、不自动下载；模块/插件/fpk 最多 24h 一次。</p>"
            + " </section> "
            + "<div class=\"footer\"> <div class=\"msg\" id=\"r\"></div> <div class=\"actions\"> "
            + "<button id=\"b\">推送到电视</button> <button id=\"rf\" title=\"重新读取电视上的当前设置\">刷新"
            + "</button> </div> </div>"
            + "<script>/* ── 字段表 ────────────────────────────────────────────────────────── [元素 id, 存储键, 类型]。类型只影响取值方式： bool 复选框 int 整数（空 = 不推） float 小数（空 = 不推） text 文本/下拉（空串 = 不推） 刻意不含 volume/muted/rate（播放态，设置页没有 UI）、cacheDays、 closeToTray（PC 专属）。 */ var F=[ ['p_searchThreads','searchThreads','int'],['p_searchLayout','searchLayout','text'], ['p_historyLimit','historyLimit','int'], ['p_danmaku','danmaku','bool'],['p_danmakuDensity','danmakuDensity','text'], ['p_danmakuScale','danmakuScale','float'],['p_danmakuOpacity','danmakuOpacity','float'], ['p_danmakuDuration','danmakuDuration','int'],['p_danmakuArea','danmakuArea','float'], ['p_danmakuBlock','danmakuBlock','text'], ['p_videoFit','videoFit','text'],['p_autoNextMode','autoNextMode','text'], ['p_autoNextDelay','autoNextDelay','int'], ['p_skipIntro','skipIntro','int'],['p_skipOutro','skipOutro','int'], ['p_skipCountdown','skipCountdown','int'],['p_skipMiddle','skipMiddle','bool'], ['p_showTimeBadge','showTimeBadge','bool'],['p_showMiniProgress','showMiniProgress','bool'], ['p_themeStyle','themeStyle','text'],['p_themeMode','themeMode','text'], ['p_homeCols','homeCols','int'], ['p_wallpaper','wallpaper','text'],['p_wallpaperBlur','wallpaperBlur','int'], ['p_wallpaperOpacity','wallpaperOpacity','float'], ['p_llmEnabled','llmEnabled','bool'],['p_llmBaseUrl','llmBaseUrl','text'], ['p_llmModel','llmModel','text'],['p_llmApiKey','llmApiKey','text'], ['p_llmHistoryRounds','llmHistoryRounds','int'], ['p_llmTimeoutMs','llmTimeoutMs','int'],['p_llmMaxTokens','llmMaxTokens','int']]; /* policy 组（写后端 policy.json） */ var G=[ ['g_searchCacheHitSec','searchCacheHitSec','int'], ['g_searchCacheMissSec','searchCacheMissSec','int'], ['g_searchCacheFailSec','searchCacheFailSec','int'], ['g_jsRuntime','jsRuntime','text'],['g_filterAds','filterAds','bool'], ['g_danmakuApi','danmakuApi','text'],['g_danmakuTencent','danmakuTencent','bool'], ['g_cacheQuotaGb','cacheQuotaGb','int'],['g_cacheEvictMode','cacheEvictMode','text'], ['g_cacheDir','cacheDir','text'],['g_searchNoise','searchNoise','text'], ['g_searchNoiseMode','searchNoiseMode','text'], ['g_safeDns','safeDns','bool'], ['g_dnsProvider','dnsProvider','text']]; /* WebDAV 组（localStorage meow.webdav） */ var W=[ ['w_enabled','enabled','bool'],['w_url','url','text'],['w_user','user','text'], ['w_pass','pass','text'],['w_dir','dir','text'], ['w_syncHistory','syncHistory','bool'],['w_syncPrefs','syncPrefs','bool'], ['w_syncSearchHistory','syncSearchHistory','bool'],['w_syncLibrary','syncLibrary','bool']]; /* 更新组 */ var U=[['u_source','source','text'],['u_backup','backupSource','text'],['u_token','token','text'],['u_autoApp','autoCheckApp','bool'],['u_autoModule','autoCheckModule','bool'],['u_autoPlugins','autoCheckPlugins','bool'],['u_autoFpk','autoCheckFpk','bool']]; /* 密度档位 → 滚动时长/显示区域。与 stores/prefs.ts 的 DENSITY_PRESETS 一致。 选档时必须三键一起写：只写 danmakuDensity 会留下\"档位写着密集、 实际还是 12s/70%\"的不一致（getPrefs 只在值非法时才反推，不救这个）。 */ var DENSITY={sparse:{duration:18,area:0.55},standard:{duration:12,area:0.7},dense:{duration:9,area:0.85}}; /* ── 访问令牌 ────────────────────────────────────────────────────── 来源优先级：URL 的 ?k= （扫码自动带入）> localStorage（上次手输过的）。 为什么存 localStorage：手输一次之后刷新页面不该再输一遍；但它只存在 这台手机上，换设备要重新扫。 ★ 只在**验证通过之后**才写 localStorage。踩过：原来在 loadToken 里 无条件写，于是扫码扫到过期令牌（电视重启换新了）会被记住，用户下次 直接打开就带着错的撞 403，而且看不出为什么。 */ var K_KEY='meow.push.k'; function kFromUrl(){ var m=location.search.match(/[?&]k=([^&]+)/); return m?decodeURIComponent(m[1]):''} function loadToken(){ var u=kFromUrl(); if(u)return u; try{return localStorage.getItem(K_KEY)||''}catch(e){return ''}} var TOKEN=loadToken(); /* 令牌被后端拒绝（403）时为 true，用来区分\"令牌错\"和\"电视没起来\"。 只有前者才该清掉本地记住的令牌。 */ var authFailed=false; /* 给所有后端请求拼令牌。用 URL 参数而不是请求头：GET 也能带， 而且和后端 tokenOk() 的第一个判据一致。 */ function withK(url){ if(!TOKEN)return url; return url+(url.indexOf('?')>=0?'&':'?')+'k='+encodeURIComponent(TOKEN)} var cur={},curG={},curW={},curU={}; var okPrefs=false,okExtra=false; var r=document.getElementById('r'),b=document.getElementById('b'), rf=document.getElementById('rf'); function el(id){return document.getElementById(id)} function readOf(id,kind){var e=el(id);if(!e)return undefined; if(kind==='bool')return !!e.checked; if(kind==='int'){var n=parseInt(e.value,10);return isNaN(n)?undefined:n} if(kind==='float'){var f=parseFloat(e.value);return isNaN(f)?undefined:f} var s=e.value.trim();return s===''?undefined:s} function fill(list,base){list.forEach(function(f){var e=el(f[0]);if(!e)return; var v=base[f[1]]; if(v===undefined||v===null)return; if(f[2]==='bool')e.checked=!!v;else e.value=v})} /* ★ 预填完成后的 DOM 快照。与 base 一起决定\"这项到底算不算用户改的\"。 见 diff() 里的两种判据。 */ var init={}; function snapshot(){ F.concat(G).concat(W).concat(U).forEach(function(f){ var e=el(f[0]);if(!e)return; init[f[0]]=f[2]==='bool'?!!e.checked:e.value})} /* 判定\"这一项要不要推\"，分两种情形： ① 基线有值（正常预填）：与电视不同才推 —— 用户改了。 ② 基线缺失（该键在电视侧不存在，如干净的 policy.json）：只有 **用户主动改过**才推（与预填快照 init 不同）。 为什么不能用\"基线缺失就一律不推\"：实测 .77 干净设备上 policy 只有 2 个键，用户在手机上勾了「安全 DNS」这个开关， 结果被门禁吞掉、推不上去 —— 用户会以为功能坏了。 也不能用\"基线缺失就推\"：预填失败（GET /prefs 超时）时表单全是 HTML 默认值，会整批覆盖电视配置（实测能推 9 项 prefs + 3 policy + 4 webdav）。所以必须靠 init 区分\"默认值\"和\"用户改过\"。 */ function diff(list,base,out){list.forEach(function(f){ var v=readOf(f[0],f[2]);if(v===undefined)return; if(base[f[1]]!==undefined){ if(base[f[1]]===v)return; out[f[1]]=v;return} if(init[f[0]]===undefined)return; if(init[f[0]]===v)return; out[f[1]]=v})} function setMsg(t,cls){r.textContent=t||'';r.className='msg'+(cls?' '+cls:'')} function updateReady(){ if(okPrefs&&okExtra){b.disabled=false;if(!r.textContent)setMsg('');} else{b.disabled=true; setMsg(!okPrefs?'读取电视设置失败，无法安全推送（避免覆盖你的配置）' :'读取后端配置失败，无法安全推送','err');} } /* ★ 必须判 HTTP 状态码。踩过：只写 .then(x=>x.json())，403 的响应体 {\"ok\":false,\"error\":\"invalid token\"} 是个合法 JSON 对象，有 2 个键， okPrefs 判\"键数>0\"就成立 → boot() 走 hideGate()，遮罩永远不弹。 用户看到的是一个空表单 + 灰掉的按钮，完全不知道是令牌问题。 */ function loadPrefs(){ return fetch(withK('/prefs')).then(function(x){ if(x.status===403){authFailed=true;throw new Error('forbidden')} if(!x.ok)throw new Error('http '+x.status); return x.json()}).then(function(p){ cur=(p&&typeof p==='object')?p:{}; /* 200 就算读到（哪怕是空对象：干净的电视本来就没配过任何东西）。 这里不能再用\"键数>0\"当判据，那既会把 403 当成功，也会把空配置当失败。 */ okPrefs=true; if(cur.themeMode)document.documentElement.setAttribute('data-mode', cur.themeMode==='light'?'light':'dark'); fill(F,cur)}).catch(function(){okPrefs=false;cur={}}) } function loadExtra(){ return fetch(withK('/extra')).then(function(x){ if(x.status===403){authFailed=true;throw new Error('forbidden')} if(!x.ok)throw new Error('http '+x.status); return x.json()}).then(function(e){ e=e||{};curW=e.webdav||{};curU=e.update||{};curG=e.policy||{}; okExtra=true; fill(W,curW);fill(U,curU);fill(G,curG); }).catch(function(){okExtra=false}) } /* ── 启动：先用令牌探一次 /prefs ────────────────────────────────── 为什么要探：光\"URL 里有 k\"不代表令牌对（电视重启过就换新令牌了）。 探测失败 → 弹遮罩让用户输，而不是让他在一个永远 403 的表单上填半天。 */ var gate=document.getElementById('gate'),gateInput=document.getElementById('gateInput'), gateBtn=document.getElementById('gateBtn'),gateMsg=document.getElementById('gateMsg'); function showGate(msg){ gate.classList.remove('hide'); b.disabled=true; gateMsg.textContent=msg||''; /* 聚焦到输入框：手机上少点一次 */ try{gateInput.focus()}catch(e){} } function hideGate(){gate.classList.add('hide')} function boot(){ b.disabled=true; Promise.all([loadPrefs(),loadExtra()]).then(function(){ if(!okPrefs&&!okExtra){ /* 两种失败分开说、处置也不同： · 403 → 令牌不对（电视重启会换新令牌），清掉本地记住的， 否则下次打开还带着错的撞，而且看不出为什么 · 其他 → 连不上电视（WebView 没就绪 / 不同 WiFi），令牌留着 */ if(authFailed){ /* 没带令牌就来（第一次打开）不算\"失效\"——红字「已过期」会让 用户以为自己做错了什么。只有真的带了令牌被拒才这么说。 */ var hadToken=!!TOKEN; TOKEN='';try{localStorage.removeItem(K_KEY)}catch(e){} showGate(hadToken?'令牌无效或已过期，请看电视上最新的 8 位令牌':''); }else{ showGate('连不上电视，确认手机和电视在同一 WiFi、电视停在主界面'); } return; } /* 验证通过才记住令牌：扫码带入的正确令牌下次不用再手输 */ try{localStorage.setItem(K_KEY,TOKEN)}catch(e){} hideGate(); snapshot();updateReady(); loadLives(); }).catch(function(){ snapshot();updateReady(); }); } gateBtn.onclick=function(){ var v=(gateInput.value||'').trim().toLowerCase(); if(v.length<4){gateMsg.textContent='请输入完整的令牌';return} /* 必须在 loadPrefs() 之前算：它会把表单覆盖成电视值。 令牌失效通常发生在\"电视重启过\"，用户这时往往已经改了几项还没推； 重新验证会把那几项冲掉，静默丢失是最不该做的。 */ var hadPending=hasPending(); TOKEN=v;authFailed=false; gateBtn.disabled=true;gateMsg.textContent='验证中…'; loadPrefs().then(function(){ loadExtra().then(function(){ gateBtn.disabled=false; if(okPrefs||okExtra){ /* 验证通过才落盘，见 loadToken 的注释 */ try{localStorage.setItem(K_KEY,v)}catch(e){} hideGate();gateMsg.textContent=''; snapshot();updateReady(); loadLives(); if(hadPending)setMsg('令牌已更新，表单已按电视最新值重读（之前没推的改动已丢弃）'); }else{ gateMsg.textContent='令牌不对，请核对电视上显示的那 8 位'; TOKEN='';try{localStorage.removeItem(K_KEY)}catch(e){} } }); }).catch(function(){ gateBtn.disabled=false;gateMsg.textContent='无法连接电视，确认在同一 WiFi'; }); }; gateInput.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.keyCode===13)gateBtn.click(); }); boot(); /* ── 直播源 ────────────────────────────────────────────────────── 增删查都走 /lives，由电视转发到后端（手机与后端不同源，直接 fetch 会被 CORS 挡）。 令牌复用 withK()，和 /prefs、/push 同一套。 校验失败就不保存：存一个打不开的地址，只会让下次打开还是空列表。 */ function liveMsg(t,cls){var e=el('liveMsg');if(!e)return;e.textContent=t||'';e.className='live-msg'+(cls?' '+cls:'')} function renderLives(list){var box=el('liveList');if(!box)return;box.innerHTML='';if(!list||!list.length){var d=document.createElement('div');d.className='live-empty';d.textContent='还没有直播源';box.appendChild(d);return}list.forEach(function(l){var row=document.createElement('div');row.className='live-item';var n=document.createElement('span');n.className='live-name';n.textContent=l.name||l.url;var u=document.createElement('span');u.className='live-url';u.textContent=l.url;var b=document.createElement('button');b.className='live-del';b.textContent='删除';b.onclick=function(){removeLive(l.url)};row.appendChild(n);row.appendChild(u);row.appendChild(b);box.appendChild(row)})} function loadLives(){return fetch(withK('/lives')).then(function(x){if(x.status===403){authFailed=true;throw new Error('forbidden')}return x.json()}).then(function(r){if(r&&r.ok)renderLives(r.lives||[]);else renderLives([])}).catch(function(){renderLives([])})} function addLive(){var u=(el('p_liveUrl').value||'').trim();if(!/^https?:\\/\\//i.test(u)){liveMsg('请填 http(s) 开头的 m3u / txt 地址','err');return}var b=el('liveAdd');b.disabled=true;liveMsg('正在校验，源站慢的话要十几秒…');fetch(withK('/lives'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:(el('p_liveName').value||'').trim(),url:u,verify:true})}).then(function(x){return x.json()}).then(function(r){b.disabled=false;if(!r||!r.ok){liveMsg((r&&r.msg)||'这个地址解析不出频道','err');return}renderLives(r.lives||[]);el('p_liveUrl').value='';el('p_liveName').value='';liveMsg('已添加'+(r.channels?'，'+r.channels+' 个频道':''),'ok')}).catch(function(){b.disabled=false;liveMsg('添加失败，确认和电视在同一 WiFi','err')})} function removeLive(url){if(!confirm('删除这个直播源？\\n'+url))return;fetch(withK('/lives'),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url})}).then(function(x){return x.json()}).then(function(r){if(r&&r.ok){renderLives(r.lives||[]);liveMsg('已删除','ok')}else liveMsg('删除失败','err')}).catch(function(){liveMsg('删除失败','err')})} el('liveAdd').onclick=addLive; /* ── 刷新 ────────────────────────────────────────────────────────── 为什么需要：页面上的值只在**打开那一刻**抓过一次。之后如果电视 被遥控器改过（或另一台手机推过），这里显示的仍是旧值 —— 用户会 基于过期数据判断\"电视上是什么样\"，再改一项就把别的项按旧基线写回去。 有未推送的改动时先确认：刷新会用电视的新值覆盖表单，本地未推的 改动会丢，静默丢掉是最不该做的。 */ function hasPending(){ var a={},b2={},c={},d={}; diff(F,cur,a);diff(G,curG,b2);diff(W,curW,c);diff(U,curU,d); var url=((el('p_api')||{}).value||'').trim(); var cfg=((el('p_config')||{}).value||'').trim(); return Object.keys(a).length+Object.keys(b2).length +Object.keys(c).length+Object.keys(d).length>0||!!url||!!cfg; } function stamp(){var d=new Date();function p(n){return n<10?'0'+n:''+n} return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())} function refreshAll(ask){ if(ask&&hasPending()&&!confirm('刷新会用电视上的当前值覆盖表单，' +'你有改动还没推送，会丢失。继续刷新？')){ /* 用户放弃刷新：必须把提示改掉。 否则上一条「已刷新 · 11:51:52」会留在屏幕上，用户以为刷新成功了， 而表单里其实还是自己的改动 —— 这是最容易误判的一种反馈。 */ setMsg('已取消刷新，你的改动还在'); return;} rf.disabled=true;b.disabled=true; setMsg('正在读取电视设置…'); okPrefs=false;okExtra=false; Promise.all([loadPrefs(),loadExtra()]).then(function(){ /* 电视重启会换新令牌：刷新时拿到 403 说明本地令牌已过期， 不能只说\"读取失败\"把表单留在那儿 —— 用户对着一个永远失败的 按钮点，唯一的出路是重新输令牌，而遮罩才是输令牌的地方。 */ if(authFailed){ TOKEN='';try{localStorage.removeItem(K_KEY)}catch(e){} showGate('令牌已失效（电视重启会换新令牌），请重新输入'); return; } snapshot();updateReady(); /* updateReady 在失败时会写错误提示，别覆盖它 */ if(okPrefs&&okExtra){ if(el('p_clearSearchCache'))el('p_clearSearchCache').checked=false; if(el('p_resetHealth'))el('p_resetHealth').checked=false; setMsg('已刷新 · '+stamp(),'ok'); } }).catch(function(){ okPrefs=false;okExtra=false;snapshot();updateReady(); }).then(function(){rf.disabled=false}); } rf.onclick=function(){refreshAll(true)}; b.onclick=function(){ var url=((el('p_api')||{}).value||'').trim(); var cfg=((el('p_config')||{}).value||'').trim(); var prefs={},policy={},webdav={},update={}; diff(F,cur,prefs);diff(G,curG,policy);diff(W,curW,webdav);diff(U,curU,update); /* 密度联写：选了具体档位就补上 duration/area。 选 custom 表示\"保留电视原值\"，不动这三个键。 */ var d=prefs.danmakuDensity; if(d&&DENSITY[d]){ prefs.danmakuDuration=DENSITY[d].duration; prefs.danmakuArea=DENSITY[d].area; } /* 密码留空 = 不修改：saveWebdav 是浅合并，传空串会把电视上的密码清掉。 */ if(webdav.pass==='')delete webdav.pass; var clearCache=!!(el('p_clearSearchCache')||{}).checked; var resetHealth=!!(el('p_resetHealth')||{}).checked; var n=Object.keys(prefs).length+Object.keys(policy).length +Object.keys(webdav).length+Object.keys(update).length; if(!n&&!url&&!cfg&&!clearCache&&!resetHealth){setMsg('没有改动');return} b.disabled=true;setMsg('发送中…'); var body='url='+encodeURIComponent(url)+'&config='+encodeURIComponent(cfg) +'&mode='+encodeURIComponent(((el('p_importMode')||{}).value||'merge')) +'&prefs='+encodeURIComponent(JSON.stringify(prefs)) +'&policy='+encodeURIComponent(JSON.stringify(policy)) +'&webdav='+encodeURIComponent(JSON.stringify(webdav)) +'&update='+encodeURIComponent(JSON.stringify(update)); fetch(withK('/push'),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body}) .then(function(x){ /* 令牌过期时 /push 会 403。必须弹回遮罩重输，而不是只说 \"发送失败\"——用户会去查 WiFi，而真正的问题在令牌。 */ if(x.status===403){ authFailed=true; TOKEN='';try{localStorage.removeItem(K_KEY)}catch(e){} b.disabled=false; showGate('令牌已失效（电视重启会换新令牌），请重新输入'); throw new Error('forbidden'); } return x.json()}).then(function(res){ var extra=''; if(clearCache||resetHealth){ var jobs=[]; if(clearCache)jobs.push(fetch(withK('/act?name=clearSearchCache'),{method:'POST'})); if(resetHealth)jobs.push(fetch(withK('/act?name=resetHealth'),{method:'POST'})); Promise.all(jobs).catch(function(){}); extra='，缓存/源健康操作已发出'; } setMsg('已发送（'+(res&&res.applied?res.applied:0)+' 项）'+extra+'，看电视吧','ok'); b.disabled=false; /* 推成功后把这些值并入基线，重复点不会重复写 */ [['F',prefs],['G',policy],['W',webdav],['U',update]].forEach(function(pair){ var base=pair[0]==='F'?cur:pair[0]==='G'?curG:pair[0]==='W'?curW:curU; for(var k in pair[1])base[k]=pair[1][k]; }); if(clearCache)el('p_clearSearchCache').checked=false; if(resetHealth)el('p_resetHealth').checked=false; }).catch(function(){setMsg('发送失败，确认和电视在同一 WiFi','err');b.disabled=false})};"
            + "</script></body></html>";

    private static String findLanIp() {
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getNetworkInterfaces() == null
                        ? ni.getInetAddresses() : ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    String ip = a.getHostAddress();
                    if (ip == null) continue;
                    if (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*")) {
                        return ip;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return "";
    }
}
