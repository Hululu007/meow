package routes;

import platform.HttpExchange;

import org.json.JSONObject;

import core.LogBuffer;

import java.io.IOException;
import java.util.Map;

/**
 * 运行日志路由：{@code GET/DELETE /api/logs}。
 *
 * <p>从 ApiServer 拆出来的第一个域——它零业务耦合（只读 core.LogBuffer 的内存环形缓冲），
 * 是验证「拆分方式可行」的最小样本。
 *
 * <p><b>为什么还要 isNoisyPath</b>：请求进日志缓冲前要先过滤高频路径，
 * 这个判定属于日志域自身语义（"什么值得记"），跟着路由一起搬走，
 * 主类只在写入缓冲时调一次。
 */
public final class LogRoutes {

    private LogRoutes() {
    }

    /**
     * 这些路径不写进日志缓冲。
     *
     * <p>判据是「高频 + 无诊断价值」：健康检查 3 秒一次、日志页自己轮询，
     * 都记下来会在几分钟内把 2000 条缓冲冲干净，真正要看的错误就没了。
     * 它们仍然在 stdout 里（不变），只是不进网页面板。
     */
    public static boolean isNoisyPath(String path) {
        if (path == null) return true;
        return "/api/health".equals(path)
                || "/api/logs".equals(path)
                // 分片与清单：一集几百个请求，必然淹没日志
                || path.startsWith("/api/cache/")
                || path.startsWith("/api/library/stream")
                || path.startsWith("/api/transcode/")
                // ★ 必须是完整前缀 /api/proxy/，不能只写 /proxy：
                //   "/api/proxy/stream".startsWith("/proxy") 恒为 false，原来那条
                //   从来没生效过。播一集几百个分片就把 2000 条缓冲冲干净，
                //   日志面板在播放时等于不可用（docs/47 §2.4 记录的现存 bug）。
                || path.startsWith("/api/proxy/")
                || "/proxy".equals(path);
    }

    /**
     * GET 取日志 / DELETE 清空。
     *
     * <p>参数：{@code level}(info|warn|error) · {@code tag}(模块) ·
     * {@code since}(只要 id 更大的，增量轮询用) · {@code limit}(默认 500，上限 2000)。
     * 不带参数就返回「最新 500 条 + 统计」，前端首屏一次拿全；
     * 之后用 {@code since=lastId} 只拉增量。
     */
    public static void handle(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();
        if ("DELETE".equalsIgnoreCase(method)) {
            LogBuffer.clear();
            // 手工拼字符串：android-json 的 put 抛受检异常，而这里在 try 之外，
            // 用它是编译不过的（而且这个响应体是固定形状，本来也不需要序列化器）
            Api.sendJson(ex, 200, "{\"ok\":true}");
            return;
        }
        if ("OPTIONS".equalsIgnoreCase(method)) {
            Api.cors(ex);
            ex.sendResponseHeaders(204, -1);
            ex.close();
            return;
        }

        Map<String, String> q = Api.query(ex);
        String level = Api.trimToEmpty(q.get("level"));
        String tag = Api.trimToEmpty(q.get("tag"));
        long since = 0;
        try {
            since = Long.parseLong(Api.trimToEmpty(q.get("since")));
        } catch (Exception ignored) {
        }
        int limit = 500;
        try {
            String l = Api.trimToEmpty(q.get("limit"));
            if (!l.isEmpty()) limit = Integer.parseInt(l);
        } catch (Exception ignored) {
        }

        try {
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("stats", LogBuffer.stats());
            out.put("items", LogBuffer.query(level, tag, since, limit));
            Api.sendJson(ex, 200, out.toString());
        } catch (Throwable t) {
            // android-json 的受检异常 + 可能的 OOM：日志端点绝不能把后端搞挂，
            // 它本身就是用来排查故障的。
            Api.sendError(ex, 500, "读取日志失败：" + t.getMessage());
        }
    }
}
