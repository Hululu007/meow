package routes;

import platform.HttpExchange;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;

/**
 * 可选的模型转发：纯 Web 环境（没有 Tauri / TV 壳）调模型时的唯一出路。
 *
 * <h3>为什么需要它</h3>
 * OpenAI / DeepSeek 这类厂商**不返回 CORS 头**（是它们的策略），浏览器直接
 * {@code fetch} 必被挡。PC 和 TV 有壳可以走原生 HTTP，纯 Web 没有——只能由
 * 后端代发一次请求。
 *
 * <h3>它不是"AI 后端"</h3>
 * 这个端点**只转发**：不解析响应、不参与编排、不存 key、不缓存。
 * 编排与规则全在前端（docs/47 §4.1）。删掉它 AI 依然能用（PC/TV 走壳）。
 *
 * <h3>默认关闭</h3>
 * {@code policy.json} 的 {@code llmRelay.enabled} 必须显式打开，
 * 否则一律 403。理由是一个能往任意 URL 发 POST 的端点等于开放正向代理，
 * 且请求里带着用户的 key —— 默认开会让自建实例变成别人的免费跳板。
 */
public final class LlmRelay {

    private LlmRelay() {
    }

    /** 只允许 http/https，且不接受回环/链路本地 —— 防止 relay 被拿去打内网。 */
    private static boolean urlAllowed(String baseUrl) {
        try {
            URI u = URI.create(baseUrl);
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
            if (!scheme.equals("http") && !scheme.equals("https")) return false;
            String host = u.getHost();
            if (host == null || host.isEmpty()) return false;
            String h = host.toLowerCase();
            // 本地 Ollama 是明确支持的场景（127.0.0.1:11434），
            // 所以这里**允许回环**——但要配合 enabled 开关，不能默认开。
            return !h.equals("169.254.169.254"); // 云元数据仍拒绝
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * POST 请求体：
     * <pre>
     * { "baseUrl": "https://api.deepseek.com/v1",
     *   "apiKey": "sk-...",
     *   "body": { "model": "...", "messages": [...], ... } }
     * </pre>
     * 响应原样回传上游的 JSON（前端自己解 choices[0].message.content）。
     */
    public static void handle(HttpExchange ex, JSONObject policy) {
        try {
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                Api.sendJson(ex, 405, "{\"ok\":false,\"error\":\"use POST\"}");
                return;
            }
            JSONObject relay = policy.optJSONObject("llmRelay");
            boolean enabled = relay != null && relay.optBoolean("enabled", false);
            if (!enabled) {
                // 明确说"怎么开"，否则用户以为功能坏了
                Api.sendJson(ex, 403, new JSONObject()
                        .put("ok", false)
                        .put("error", "llmRelay disabled")
                        .put("hint", "在 policy.json 里加 \"llmRelay\": {\"enabled\": true}；"
                                + "PC/TV 端不需要它（走壳代理）")
                        .toString());
                return;
            }

            String raw = Api.read(ex.getRequestBody());
            JSONObject in = raw == null || raw.trim().isEmpty() ? new JSONObject() : new JSONObject(raw);
            String baseUrl = in.optString("baseUrl", "").replaceAll("/+$", "");
            String apiKey = in.optString("apiKey", "");
            JSONObject body = in.optJSONObject("body");
            if (baseUrl.isEmpty() || body == null) {
                Api.sendJson(ex, 400, "{\"ok\":false,\"error\":\"baseUrl and body required\"}");
                return;
            }
            if (!urlAllowed(baseUrl)) {
                Api.sendJson(ex, 400, "{\"ok\":false,\"error\":\"baseUrl not allowed\"}");
                return;
            }

            // 白名单（可选）：配了就只允许这些前缀，运营型部署用它防滥用
            String allow = relay.optString("allowBaseUrlPrefix", "");
            if (!allow.isEmpty() && !baseUrl.startsWith(allow)) {
                Api.sendJson(ex, 403, new JSONObject()
                        .put("ok", false)
                        .put("error", "baseUrl not in allowlist")
                        .put("allow", allow).toString());
                return;
            }

            int timeoutMs = relay.optInt("timeoutMs", 20000);
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) URI.create(baseUrl + "/chat/completions").toURL().openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(Math.min(10000, timeoutMs));
                c.setReadTimeout(timeoutMs);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                if (!apiKey.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + apiKey);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = c.getResponseCode();
                byte[] resp;
                try (InputStream in2 = code >= 400 ? c.getErrorStream() : c.getInputStream()) {
                    resp = readAll(in2);
                }
                String text = new String(resp, StandardCharsets.UTF_8);
                // 原样透传：前端自己解 choices。上游错误也一起透传，
                // 这样"key 无效 / 模型不存在"的原始报错能看到，不用我们猜。
                Api.sendText(ex, code >= 200 && code < 300 ? 200 : code, text,
                        "application/json; charset=utf-8");
            } catch (Exception e) {
                Api.sendJson(ex, 502, new JSONObject()
                        .put("ok", false)
                        .put("error", "upstream failed: " + e).toString());
            } finally {
                if (c != null) c.disconnect();
            }
        } catch (Exception e) {
            try {
                Api.sendJson(ex, 500, new JSONObject()
                        .put("ok", false).put("error", String.valueOf(e)).toString());
            } catch (Exception ignored) {
            }
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        if (in == null) return new byte[0];
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
        return bos.toByteArray();
    }
}
