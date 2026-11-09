import platform.Headers;
import platform.HttpExchange;
import platform.HttpServer;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

/**
 * Minimal CatVod spider host.
 *
 * Loads the Android spider dex (converted with dex2jar) on a plain JVM and
 * exposes the HTTP protocol expected by zyfun's T4_CATVOD adapter:
 *
 *   GET  /config
 *   POST /{Spider}/init|home|category|detail|search|play|action
 *
 * Usage: java -cp "classes;libs/*" SpiderHost [port]
 */
public class SpiderHost {

    private static int port = 9979;

    // Spiders that were verified to work on a plain JVM.
    private static final Map<String, String> SITES = new LinkedHashMap<>();
    /** 多实例站点的 ext（key 形如 AppDrama2#2） */
    private static final Map<String, String> EXT_MULTI = new HashMap<>();
    static {
        SITES.put("Douban", "豆瓣");
        SITES.put("AppYQK", "优奇客");
        SITES.put("AppYsV2", "AppYsV2");
        SITES.put("AppFQ", "AppFQ");
        SITES.put("DuoDuoTv", "多多TV");
        SITES.put("Gulu", "咕噜");
        SITES.put("Hxq", "Hxq");
        SITES.put("SP360", "360影视");
        SITES.put("SaoHuo", "骚火");
        SITES.put("Gz360", "360资源");
        SITES.put("Jpys", "金牌");
        SITES.put("Wwys", "农民");
        SITES.put("Dm84", "动漫巴士");
        SITES.put("AppRJ", "潮流");
        SITES.put("AppQi", "肥猫");
        SITES.put("AppGet", "蔬菜");
        SITES.put("Jianpian", "荐片");
        SITES.put("Czsapp", "厂长");
        // 按 spider.jar 内实际可用的类补齐：此前只注册了 18 个，
        // 导致「干饭」「哔哩」等大量可用源在首页和聚合搜索里完全不出现。
        SITES.put("AppDrama2", "干饭");
        SITES.put("Bili", "哔哩");
        SITES.put("Config", "配置中心");
        SITES.put("Duopan", "闪电优汐");
        SITES.put("FirstAid", "急救");
        SITES.put("GuaziTY", "瓜子体育");
        SITES.put("Kanqiu", "看球");
        SITES.put("Kugou", "酷狗");
        SITES.put("MiSou", "米搜");
        SITES.put("PanSearch", "盘搜");
        SITES.put("Push", "推送");
        loadSitesFromConfig();
    }

    /**
     * 从 config.sites.json 展开多实例站点。
     *
     * 原始配置里同一个 spider 类会注册成多个站点（AppDrama2 → 干饭/行动/再来/一碗，
     * Bili → 合集/明星MV/少儿/小学/初中/高中），区别只在 init 时的 ext。
     * 这里把它们展开成 "类名#序号" 的 key，这样 /api/sites 与聚合搜索都能看到全部源。
     *
     * 找不到配置文件时保持上面的内置列表（不影响单机启动）。
     */
    private static void loadSitesFromConfig() {
        try {
            // 与 ApiServer 一致走 DataPaths：容器工作目录是 /，相对路径会读不到
            // 数据目录里的 config.sites.json（表现为"导入成功了但站点表没变"）。
            if (!core.DataPaths.exists("config.sites.json")) return;
            String txt = core.DataPaths.read("config.sites.json");
            if (txt == null) return;
            JSONArray arr = new JSONObject(txt).optJSONArray("sites");
            if (arr == null) return;

            Map<String, Integer> seen = new HashMap<>();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject s = arr.optJSONObject(i);
                if (s == null) continue;
                String api = s.optString("api", "");
                if (!api.startsWith("csp_")) continue;
                String cls = api.substring(4);
                Object extObj = s.opt("ext");
                String ext = extObj == null || extObj == JSONObject.NULL
                        ? "" : (extObj instanceof String ? (String) extObj : String.valueOf(extObj));
                String rawName = s.optString("name", cls);
                String name = cleanSiteName(rawName, cls);

                int n = seen.merge(cls, 1, Integer::sum);
                String key = n == 1 ? cls : cls + "#" + n;
                SITES.put(key, name);
                if (n > 1) EXT_MULTI.put(key, ext);
                else if (!ext.isEmpty()) EXT_MULTI.put(key, ext);
            }
            System.out.println("[spider-host] sites loaded from config: " + SITES.size());
        } catch (Throwable t) {
            System.out.println("[spider-host] config.sites.json ignored: " + t);
        }
    }

    /** 去掉配置里用于装饰的 emoji / 方框字符，留下可读名字 */
    private static String cleanSiteName(String raw, String fallback) {
        if (raw == null || raw.trim().isEmpty()) return fallback;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == 0x2503 || c == 0xFE0F || c == 0x20E3) continue;  // ┃ 变体选择符 键帽
            if (Character.isLetterOrDigit(c) || c == ' ' || c == '-' || c == '_') sb.append(c);
        }
        String out = sb.toString().trim();
        return out.isEmpty() ? fallback : out;
    }

    // Per-spider init extension, copied from the original config's sites[].ext.
    private static final Map<String, String> EXT = new HashMap<>();
    static {
        EXT.put("SaoHuo", "https://shdy5.us");
        EXT.put("Jpys", "https://y2s52n7.com");
        EXT.put("Wwys", "https://vip.wwgz.cn:5200");
        EXT.put("Dm84", "https://dm84.net");
        EXT.put("AppRJ", "http://v.rbotv.cn");
        // ★ 第三方服务令牌不写进源码（公开库要求）。见 ApiServer 同名说明。
        putEnvExt("AppQi", "MEOW_EXT_APPQI");
        putEnvExt("AppGet", "MEOW_EXT_APPGET");
        EXT.put("Jianpian", "https://api.ztcgi.com");
        EXT.put("Czsapp", "https://www.czzy89.com");
    }

    /** 从环境变量注册一个 ext；未设置或为空则不注册（公开源码不含令牌）。 */
    private static void putEnvExt(String key, String env) {
        String v = System.getenv(env);
        if (v != null && !v.trim().isEmpty()) EXT.put(key, v.trim());
    }

    private static final Map<String, Object> CACHE = new ConcurrentHashMap<>();

    public static void main(String[] args) throws Exception {
        if (args.length > 0) port = Integer.parseInt(args[0]);
        System.setProperty("http.agent", "okhttp/3.12.0");
        // Android ships AES/CBC/PKCS7Padding; the JVM only has PKCS5 unless a provider is registered.
        try {
            java.security.Security.addProvider((java.security.Provider) Class
                    .forName("org.bouncycastle.jce.provider.BouncyCastleProvider")
                    .getDeclaredConstructor().newInstance());
        } catch (Throwable ignored) {
        }

        platform.ServerProvider.autoDetect();
        platform.HttpServer server = platform.HttpServer.create(
                new InetSocketAddress("127.0.0.1", port), 0);
        server.start(SpiderHost::handle, 8);

        System.out.println("[spider-host] listening on http://127.0.0.1:" + port);
        System.out.println("[spider-host] zyfun config: http://127.0.0.1:" + port + "/config");
        System.out.println("[spider-host] sites: " + String.join(", ", SITES.keySet()));
    }

    private static void handle(HttpExchange ex) throws IOException {
        Headers h = ex.getResponseHeaders();
        h.add("Access-Control-Allow-Origin", "*");
        h.add("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        h.add("Access-Control-Allow-Headers", "Content-Type");

        String method = ex.getRequestMethod();
        String path = ex.getRequestURI().getPath();

        if ("OPTIONS".equalsIgnoreCase(method)) {
            ex.sendResponseHeaders(204, -1);
            ex.close();
            return;
        }

        try {
            if ("/health".equals(path)) {
                send(ex, 200, "{\"ok\":true}");
                return;
            }
            if ("/config".equals(path)) {
                send(ex, 200, config(ex.getRequestURI().getQuery()));
                return;
            }
            if ("/proxy".equals(path)) {
                proxy(ex);
                return;
            }

            String[] seg = path.split("/");
            if (seg.length < 3) {
                send(ex, 404, "{\"code\":-1,\"msg\":\"bad path\"}");
                return;
            }
            String spider = seg[1];
            String action = seg[2];
            String body = read(ex.getRequestBody());
            String out = call(spider, action, body);
            send(ex, 200, out);
        } catch (Throwable t) {
            StringWriter sw = new StringWriter();
            t.printStackTrace(new PrintWriter(sw));
            System.err.println("[spider-host] " + path + " failed: " + t);
            System.err.println(sw);
            send(ex, 500, "{\"code\":-1,\"msg\":" + JSONObject.quote(String.valueOf(t)) + "}");
        }
    }

    private static void proxy(HttpExchange ex) throws IOException {
        Map<String, String> q = new HashMap<>();
        String raw = ex.getRequestURI().getQuery();
        if (raw != null) {
            for (String kv : raw.split("&")) {
                int i = kv.indexOf('=');
                if (i < 0) continue;
                q.put(URLDecoder.decode(kv.substring(0, i), "UTF-8"),
                      URLDecoder.decode(kv.substring(i + 1), "UTF-8"));
            }
        }
        String d = q.getOrDefault("do", "");
        String cls = "bili".equals(d) ? "Bili" : null;
        if (cls == null) {
            send(ex, 501, "{\"code\":-1,\"msg\":\"proxy not implemented for " + d + "\"}");
            return;
        }
        try {
            Class<?> c = Class.forName("com.github.catvod.spider." + cls);
            Method m = c.getMethod("proxy", Map.class);
            Object[] r = (Object[]) m.invoke(null, q);
            int code = r[0] instanceof Number ? ((Number) r[0]).intValue() : 200;
            String ct = r[1] == null ? "application/octet-stream" : String.valueOf(r[1]);
            InputStream in = (InputStream) r[2];
            ex.getResponseHeaders().set("Content-Type", ct);
            ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
            ex.sendResponseHeaders(code, 0);
            OutputStream os = ex.getResponseBody();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) os.write(buf, 0, n);
            os.close();
            in.close();
        } catch (NoSuchMethodException e) {
            send(ex, 501, "{\"code\":-1,\"msg\":\"proxy not implemented for " + d + "\"}");
        } catch (Throwable t) {
            send(ex, 502, "{\"code\":-1,\"msg\":" + JSONObject.quote(String.valueOf(t)) + "}");
        }
    }

    private static String config(String query) throws Exception {        Set<String> only = null;
        if (query != null) {
            for (String kv : query.split("&")) {
                if (kv.startsWith("only=")) {
                    only = new HashSet<>(Arrays.asList(kv.substring("only=".length()).split(",")));
                }
            }
        }
        JSONArray sites = new JSONArray();
        for (Map.Entry<String, String> e : SITES.entrySet()) {
            if (only != null && !only.contains(e.getKey())) continue;
            JSONObject s = new JSONObject();
            s.put("key", e.getKey());
            s.put("name", e.getValue());
            s.put("api", "http://127.0.0.1:" + port + "/" + e.getKey());
            sites.put(s);
        }
        JSONObject video = new JSONObject();
        video.put("sites", sites);
        JSONObject root = new JSONObject();
        root.put("video", video);
        return root.toString();
    }

    private static Object instance(String spider) {
        return CACHE.computeIfAbsent(spider, k -> {
            try {
                // 多实例支持：key 形如 "AppDrama2#2" 表示用 EXT_MULTI 里第 2 组 ext
                // 初始化同一个类（原始 config 里同一 spider 会注册成「干饭」「再来」
                // 「一碗」等多个站点，靠 ext 区分）。
                String cls = k;
                String ext = EXT.getOrDefault(k, "");
                int hash = k.indexOf('#');
                if (hash > 0) {
                    cls = k.substring(0, hash);
                    ext = EXT_MULTI.getOrDefault(k, ext);
                }
                Class<?> c = Class.forName("com.github.catvod.spider." + cls);
                Object o = c.getDeclaredConstructor().newInstance();
                try {
                    // Context 用反射实例化而不是 new：写成 new android.content.Context()
                    // 会让整个类依赖 android stub 参与编译，只编译 ApiServer/SpiderHost
                    // （不把 src/android 一起交给 javac）时直接报"程序包android.content不存在"。
                    Class<?> ctxCls = Class.forName("android.content.Context");
                    c.getMethod("init", ctxCls, String.class)
                            .invoke(o, ctxCls.getDeclaredConstructor().newInstance(), ext);
                } catch (NoSuchMethodException ignored) {
                }
                return o;
            } catch (Exception e) {
                throw new RuntimeException("cannot load spider " + k + ": " + e, e);
            }
        });
    }

    private static String call(String spider, String action, String body) throws Exception {
        Object o = instance(spider);
        JSONObject b = body == null || body.trim().isEmpty() ? new JSONObject() : new JSONObject(body);

        synchronized (o) {
            switch (action) {
                case "init":
                    return "{}";
                case "home":
                    return str(method(o, "homeContent", boolean.class).invoke(o, true));
                case "category": {
                    String id = b.optString("id", b.optString("tid", ""));
                    String page = b.optString("page", b.optString("pg", "1"));
                    HashMap<String, String> filters = new HashMap<>();
                    JSONObject f = b.optJSONObject("filters");
                    if (f != null) {
                        JSONArray names = f.names();
                        if (names != null) {
                            for (int i = 0; i < names.length(); i++) {
                                String key = names.getString(i);
                                filters.put(key, f.optString(key));
                            }
                        }
                    }
                    return str(method(o, "categoryContent", String.class, String.class, boolean.class, HashMap.class)
                            .invoke(o, id, page, true, filters));
                }
                case "detail": {
                    List<String> ids = new ArrayList<>();
                    Object id = b.opt("id");
                    if (id == null) id = b.opt("ids");
                    if (id instanceof JSONArray) {
                        JSONArray arr = (JSONArray) id;
                        for (int i = 0; i < arr.length(); i++) ids.add(String.valueOf(arr.get(i)));
                    } else if (id != null) {
                        ids.add(String.valueOf(id));
                    }
                    return str(method(o, "detailContent", List.class).invoke(o, ids));
                }
                case "search": {
                    String wd = b.optString("wd", b.optString("key", ""));
                    String pg = b.optString("pg", b.optString("page", "1"));
                    boolean quick = b.optBoolean("quick", true);
                    try {
                        return str(method(o, "searchContent", String.class, boolean.class, String.class)
                                .invoke(o, wd, quick, pg));
                    } catch (NoSuchMethodException e) {
                        return str(method(o, "searchContent", String.class, boolean.class)
                                .invoke(o, wd, quick));
                    }
                }
                case "play": {
                    String flag = b.optString("flag", "");
                    String id = b.optString("id", b.optString("play", ""));
                    String raw = str(method(o, "playerContent", String.class, String.class, List.class)
                            .invoke(o, flag, id, new ArrayList<String>()));
                    return normalizePlay(raw);
                }
                case "action": {
                    String value = b.optString("action", b.optString("value", ""));
                    return str(method(o, "action", String.class).invoke(o, value));
                }
                default:
                    throw new IllegalArgumentException("unknown action: " + action);
            }
        }
    }

    /**
     * zyfun's T4 adapter expects play().url to be a string and headers to be an
     * object. CatVod spiders often return {"url":["label","http..."],"header":"{...}"}.
     */
    private static String normalizePlay(String raw) {
        try {
            JSONObject o = new JSONObject(raw);

            Object u = o.opt("url");
            if (u instanceof JSONArray) {
                JSONArray a = (JSONArray) u;
                String chosen = null;
                for (int i = 0; i < a.length(); i++) {
                    String s = String.valueOf(a.get(i));
                    if (s.startsWith("http") || s.startsWith("rtmp") || s.startsWith("magnet")
                            || s.startsWith("ed2k") || s.startsWith("ftp")) {
                        chosen = s;
                        break;
                    }
                }
                if (chosen == null && a.length() > 0) chosen = String.valueOf(a.get(a.length() - 1));
                o.put("url", chosen == null ? "" : chosen);
            } else if (u == null) {
                o.put("url", "");
            }

            Object h = o.opt("header");
            if (h instanceof String && ((String) h).trim().startsWith("{")) {
                o.put("header", new JSONObject((String) h));
            }
            Object h2 = o.opt("headers");
            if (h2 instanceof String && ((String) h2).trim().startsWith("{")) {
                o.put("headers", new JSONObject((String) h2));
            }
            return o.toString();
        } catch (Exception e) {
            return raw;
        }
    }

    private static Method method(Object o, String name, Class<?>... types) throws NoSuchMethodException {
        return o.getClass().getMethod(name, types);
    }

    private static String str(Object v) {
        return v == null ? "{}" : String.valueOf(v);
    }

    private static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void send(HttpExchange ex, int code, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }
}
