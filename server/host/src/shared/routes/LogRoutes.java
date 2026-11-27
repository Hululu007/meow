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
     * 这些路径不写进日志缓冲（stdout 另有一道：主类只在非噪音路径打 [req]）。
     *
     * <p>判据是「高频 + 无诊断价值」：健康检查 3 秒一次、日志页自己轮询、
     * 播放进度 5 秒一次、分片一集几百个请求，都会在几分钟内把 2000 条缓冲冲干净，
     * 真正要看的错误就没了。
     *
     * <p><b>为什么用 {@link #hit} 而不是 {@code startsWith(前缀 + "/")}</b>：
     * 2026-11-27 审计实测——`/api/cache?id=…` 的 path 是 {@code /api/cache}（无斜杠），
     * 而旧写法要求 {@code /api/cache/}，于是缓存轮询、转码状态轮询全部照记，
     * 一次 5 分钟播放 + 60 秒转码等待就吃掉 148 条（其中 120 条是纯轮询）。
     * 这和当年 `/proxy` 写成 `startsWith("/proxy")` 是同一类 bug 的第三次复发，
     * 所以这里收口成"精确 / 子路径 / 带 query"三态匹配，调用方只写基路径。
     */
    public static boolean isNoisyPath(String path) {
        if (path == null) return true;
        return hit(path, "/api/health")
                || hit(path, "/api/logs")
                || hit(path, "/api/_hb")
                || hit(path, "/api/_clientlog")
                // 分片与清单：一集几百个请求，必然淹没日志
                || hit(path, "/api/cache")
                || hit(path, "/api/library/stream")
                || hit(path, "/api/transcode")
                // 搜索轮询：一次搜索 1 秒一次快照，实测 21 行/次
                || hit(path, "/api/search/task")
                // 播放进度同步：5 秒一次，一集几百行
                || hit(path, "/api/state")
                // ★ 必须是完整前缀 /api/proxy/，不能只写 /proxy：
                //   "/api/proxy/stream".startsWith("/proxy") 恒为 false，原来那条
                //   从来没生效过。播一集几百个分片就把 2000 条缓冲冲干净，
                //   日志面板在播放时等于不可用（docs/47 §2.4 记录的现存 bug）。
                || hit(path, "/api/proxy")
                || "/proxy".equals(path);
    }

    /** 基路径三态匹配：等于它 / 是它的子路径 / 带 query（`/api/cache?id=`）。 */
    private static boolean hit(String path, String base) {
        return path.equals(base) || path.startsWith(base + "/");
    }

    /**
     * GET 取日志 / DELETE 清空。
     *
     * <p>参数：{@code level}(info|warn|error) · {@code tag}(模块) ·
     * {@code since}(只要 id 更大的，增量轮询用) · {@code limit}(默认 500，上限 2000) ·
     * {@code tail}(额外返回最新 N 条，不看 since)。
     *
     * <p><b>为什么要 tail</b>：相邻重复合并只改 {@code count}、不推进 id，
     * 前端用 {@code since} 轮询就永远看不到"又是这条 ×37"。带 {@code tail=30}
     * 时把队尾 30 条一并返回，前端按 key 替换即可让计数实时跳动（成本 30 条/次）。
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
        int tail = 0;
        try {
            String t = Api.trimToEmpty(q.get("tail"));
            if (!t.isEmpty()) tail = Math.max(0, Math.min(200, Integer.parseInt(t)));
        } catch (Exception ignored) {
        }
        /*
         * file=1：读**落盘文件**的末尾若干行。
         *
         * 为什么需要：内存环形缓冲随进程重启就没了，而后端重启恰恰是最需要看
         * 日志的时候（崩了/卡死后重启，用户问"刚才怎么回事"）。网页与 AI 面板
         * 只能读内存缓冲，读不到重启前那一份 —— 这个参数把现场接回来。
         */
        int fileLines = 0;
        if ("1".equals(Api.trimToEmpty(q.get("file")))) {
            try {
                String n = Api.trimToEmpty(q.get("lines"));
                fileLines = n.isEmpty() ? 200 : Math.max(1, Math.min(2000, Integer.parseInt(n)));
            } catch (Exception ignored) {
                fileLines = 200;
            }
        }

        try {
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("stats", LogBuffer.stats());
            out.put("items", LogBuffer.query(level, tag, since, limit));
            // 队尾快照：让前端能刷新"同一文本 ×N"的计数（合并时不推进 id）
            if (tail > 0) out.put("tail", LogBuffer.query(level, tag, 0, tail));
            if (fileLines > 0) out.put("fileItems", LogBuffer.tailFile(fileLines));
            Api.sendJson(ex, 200, out.toString());
        } catch (Throwable t) {
            // android-json 的受检异常 + 可能的 OOM：日志端点绝不能把后端搞挂，
            // 它本身就是用来排查故障的。
            Api.sendError(ex, 500, "读取日志失败：" + t.getMessage());
        }
    }
}
