package routes;

import platform.HttpExchange;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 各路由模块共用的 HTTP 小工具。
 *
 * <p><b>为什么单独一份而不是继续挂在 ApiServer 上</b>：路由按域拆到本包后，
 * 每个模块都需要「读 body / 解析 query / 发 JSON / 补 CORS」。留在 ApiServer
 * 里会让每个模块都反向依赖那个 8000 行的主类，拆了等于没拆。
 *
 * <p>这些方法都是无状态的纯工具，搬出来不会碰到任何业务状态
 * （SITES / API / EXT 那些仍留在 ApiServer，属于「站点注册表」域）。
 *
 * <p><b>与 ApiServer 里同名方法的关系</b>：ApiServer 保留自己的一份（还有人调），
 * 后续逐域迁移完成后可以删掉主类里那份，避免两套实现漂移。
 * 迁移期间两边必须保持行为一致——改动这里时记得同步。
 */
public final class Api {

    private Api() {
    }

    // ---------------------------------------------------------------- 响应

    public static void sendJson(HttpExchange ex, int code, String body) throws IOException {
        sendText(ex, code, body, "application/json; charset=utf-8");
    }

    public static void sendText(HttpExchange ex, int code, String body, String type) throws IOException {
        byte[] data = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", type);
        ex.sendResponseHeaders(code, data.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    /** 失败响应：统一 {@code {code:-1,msg:...}} 形状，前端只认这个。 */
    public static void sendError(HttpExchange ex, int httpCode, String msg) throws IOException {
        // android-json 的 put 抛受检 JSONException，这里手工拼——错误响应绝不能
        // 因为序列化再抛一次而变成 500 空 body（排查时最没用的形态）。
        String safe = String.valueOf(msg)
                .replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", " ");
        sendJson(ex, httpCode, "{\"code\":-1,\"msg\":\"" + safe + "\"}");
    }

    /** 二进制响应（分片、图片）。调用方自己保证 data 完整。 */
    public static void sendBytes(HttpExchange ex, int code, byte[] data, String contentType) throws IOException {
        ex.getResponseHeaders().set("Content-Type", contentType);
        ex.sendResponseHeaders(code, data.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    // ---------------------------------------------------------------- 请求

    /** 读整个请求体为 UTF-8 字符串。 */
    public static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    /** 读 body 并解析成 JSON 对象；空 body 返回空对象（不抛）。 */
    public static JSONObject readJson(HttpExchange ex) {
        try {
            String s = read(ex.getRequestBody());
            if (s == null || s.trim().isEmpty()) return new JSONObject();
            return new JSONObject(s);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /**
     * 解析 query string。
     *
     * <p>同名参数后者覆盖前者（与大多数框架一致）；值做 URL 解码，
     * 解码失败保留原样而不是丢参数——排查时"看到原文"比"参数消失"有用。
     */
    public static Map<String, String> query(HttpExchange ex) {
        Map<String, String> out = new LinkedHashMap<>();
        String raw = ex.getRequestURI().getRawQuery();
        if (raw == null || raw.isEmpty()) return out;
        for (String pair : raw.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String k = eq < 0 ? pair : pair.substring(0, eq);
            String v = eq < 0 ? "" : pair.substring(eq + 1);
            try {
                k = URLDecoder.decode(k, "UTF-8");
                v = URLDecoder.decode(v, "UTF-8");
            } catch (Exception ignored) {
            }
            out.put(k, v);
        }
        return out;
    }

    public static String trimToEmpty(String s) {
        return s == null ? "" : s.trim();
    }

    public static String q(HttpExchange ex, String key) {
        return trimToEmpty(query(ex).get(key));
    }

    public static int qInt(HttpExchange ex, String key, int def) {
        try {
            String v = q(ex, key);
            return v.isEmpty() ? def : Integer.parseInt(v);
        } catch (Exception e) {
            return def;
        }
    }

    public static long qLong(HttpExchange ex, String key, long def) {
        try {
            String v = q(ex, key);
            return v.isEmpty() ? def : Long.parseLong(v);
        } catch (Exception e) {
            return def;
        }
    }

    // ---------------------------------------------------------------- CORS

    /**
     * 补 CORS 头。
     *
     * <p>与 ApiServer.applyCors 同规则：localhost 任意端口 + tauri 放行，
     * 其余下发 policy 里的白名单。这里只做「有 Origin 才回」的最小实现，
     * 白名单判断仍由主类负责（它持有 policy 缓存）。
     */
    public static void cors(HttpExchange ex) {
        String origin = ex.getRequestHeaders().getFirst("Origin");
        if (origin == null || origin.isEmpty()) return;
        boolean ok = origin.startsWith("http://localhost:")
                || origin.startsWith("http://127.0.0.1:")
                || origin.startsWith("tauri://")
                || origin.startsWith("http://tauri.localhost")
                || origin.startsWith("https://tauri.localhost");
        if (ok) {
            ex.getResponseHeaders().set("Access-Control-Allow-Origin", origin);
            ex.getResponseHeaders().set("Vary", "Origin");
        }
    }
}
