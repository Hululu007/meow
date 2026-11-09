package routes;

import platform.HttpExchange;
import platform.Headers;

import core.Transcode;
import core.VideoCache;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * 缓存域路由：下载、批量、状态、任务、续传、导出。
 *
 * <p><b>为什么能干净搬出</b>：这些方法只依赖 VideoCache（已是独立类）、
 * Transcode（找 ffmpeg）和几个无状态 HTTP 工具，**不碰**站点注册表
 * （SITES/API/EXT）也不碰鉴权——鉴权在 handle() 入口统一做过了。
 *
 * <p><b>合并期状态在这里</b>：MERGING 记录"哪一集正在跑 ffmpeg"，
 * 用于挡住并发导出与对未下完的集导出。它天然属于缓存域，
 * 留在主类里只会让主类继续持有与路由无关的运行时状态。
 */
public final class CacheRoutes {

    private CacheRoutes() {
    }

    /**
     * 正在合并的集（id → 开始时间）。
     *
     * <p>作用有二：① 同一集被两个请求同时导出时，第二个不要重复跑 ffmpeg
     * （媒体文件动辄几百 MB，两个进程同时写同一目录会互相拖慢甚至写坏）；
     * ② 已经合了很久还没完成，说明卡住了，告诉调用方稍后再试而不是一直等。
     *
     * <p>用 ConcurrentHashMap + 时间戳而不是锁：导出是长任务（可能几十秒），
     * 持锁会让其它集的导出全部排队。
     */
    private static final ConcurrentHashMap<String, Long> MERGING = new ConcurrentHashMap<>();

    /** 超过这个时长还占着，视为上一次合并异常退出（进程被杀/断电），允许重新开始。 */
    private static final long MERGE_STALE_MS = 10 * 60 * 1000L;

    /**
     * ffmpeg 合并的超时（秒）。
     *
     * <p>只做 {@code -c copy} 不转码，速度是磁盘带宽级别：1 小时 1080p 约
     * 5–15 秒。给 3 分钟足够任何正常情况；超过说明卡住了，必须杀掉——
     * 否则请求永久挂起、后端线程被占死。
     */
    private static final int FFMPEG_TIMEOUT_SEC = 180;

    /**
     * 离线缓存。
     *
     * <p>GET    {@code /api/cache}                     列表 + 总占用
     * <br>GET    {@code /api/cache?id=xxx}              单个任务状态
     * <br>POST   {@code /api/cache}                     开始下载（单集，或旧的 items 一次性批量）
     * <br>DELETE {@code /api/cache?id=xxx}              删除缓存
     * <br>GET    {@code /api/cache/{id}/playlist.m3u8}  本地清单（断网时播它）
     * <br>GET    {@code /api/cache/{id}/{file}}         本地分片
     * <br>POST   {@code /api/cache/batch}               整季批量（全局 2 路队列）
     * <br>GET    {@code /api/cache/status?batch=id}     批次聚合进度
     * <br>GET    {@code /api/cache/tasks}               未完成任务（含重启前被打断的）
     * <br>POST   {@code /api/cache/resume}              续传：{"id":...} 或 {"ids":[...]}
     *
     * <p><b>为什么本地清单要单独一个端点</b>：断网时前端不能再去
     * {@code /api/proxy/stream}（它要回源），必须直接拿本地文件。
     * 清单里的引用是同目录相对文件名，播放器按清单 URL 解析后正好落到
     * {@code /api/cache/{id}/seg-00001.ts}。
     */
    public static void handleCache(HttpExchange ex) throws Exception {
        String method = ex.getRequestMethod();
        Map<String, String> q = Api.query(ex);
        String id = Api.trimToEmpty(q.get("id"));

        if ("GET".equalsIgnoreCase(method) || "HEAD".equalsIgnoreCase(method)) {
            if (!id.isEmpty()) {
                core.VideoCache.Task t = core.VideoCache.status(id);
                if (t == null) {
                    Api.sendJson(ex, 404, "{\"code\":-1,\"msg\":\"no such cache\"}");
                    return;
                }
                Api.sendJson(ex, 200, cacheJson(t).toString());
                return;
            }
            JSONArray arr = core.VideoCache.list();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                core.VideoCache.Task live = core.VideoCache.status(o.optString("id", ""));
                if (live != null) o.put("state", live.state);
            }
            Api.sendJson(ex, 200, new JSONObject().put("ok", true).put("items", arr)
                    .put("totalBytes", core.VideoCache.totalBytes())
                    // 配额与淘汰模式一起回给前端：离线页要显示"已用 5.2 / 8 GB"，
                    // 否则用户不知道为什么老片被删了。
                    .put("quotaBytes", core.VideoCache.quotaBytes())
                    .put("evictMode", core.VideoCache.evictMode())
                    /*
                     * 弹幕缓存另算：不占视频配额（不同目录、不同淘汰规则），
                     * 但用户看「存储」时要能看到它吃了多少 —— OECT 上实测
                     * 攒了 22MB，设置页此前完全看不到这笔开销。
                     */
                    .put("danmakuBytes", core.VideoCache.danmakuBytes())
                    .put("danmakuCount", core.VideoCache.danmakuCount())
                    .put("cacheDir", core.VideoCache.cacheRoot().toString())
                    // cacheDir 只在后端启动时解析一次（见 VideoCache.cacheRoot 的注释），
                    // 改了 policy 必须重启才生效——直接告诉前端，别让人对着"改了没变"猜。
                    .put("cacheDirReloadRequired", core.VideoCache.cacheDirReloadRequired())
                    .put("cacheDirPolicy", policyCacheDir())
                    .toString());
            return;
        }

        if ("DELETE".equalsIgnoreCase(method)) {
            if (id.isEmpty()) {
                Api.sendJson(ex, 400, "{\"code\":-1,\"msg\":\"id required\"}");
                return;
            }
            boolean ok = core.VideoCache.delete(id);
            Api.sendJson(ex, ok ? 200 : 500, new JSONObject().put("ok", ok).toString());
            return;
        }

        if (!"POST".equalsIgnoreCase(method)) {
            Api.sendJson(ex, 405, "{\"code\":-1,\"msg\":\"method not allowed\"}");
            return;
        }

        String body = Api.read(ex.getRequestBody());
        JSONObject in = body == null || body.trim().isEmpty() ? new JSONObject() : new JSONObject(body);

        // 批量下载：{"items":[{site,vodId,ep,name,url}, ...]}
        // 一次请求起整季，避免前端循环发 N 次（每集一个 HTTP 往返，还要自己排队）。
        JSONArray batch = in.optJSONArray("items");
        if (batch != null) {
            JSONArray started = new JSONArray();
            JSONArray skipped = new JSONArray();
            for (int i = 0; i < batch.length(); i++) {
                JSONObject it = batch.optJSONObject(i);
                if (it == null) continue;
                String s = Api.trimToEmpty(it.optString("site", ""));
                String v = Api.trimToEmpty(it.optString("vodId", ""));
                String e = Api.trimToEmpty(it.optString("ep", ""));
                String n = Api.trimToEmpty(it.optString("name", ""));
                String u = Api.trimToEmpty(it.optString("url", ""));
                if (s.isEmpty() || v.isEmpty() || u.isEmpty()) {
                    skipped.put(new JSONObject().put("ep", e).put("reason", "缺少 site/vodId/url"));
                    continue;
                }
                if (!core.UrlSafety.isSafeMediaUrl(u)
                        && !Boolean.getBoolean("meow.test.allowLoopbackCache")) {
                    skipped.put(new JSONObject().put("ep", e).put("reason", "地址不被允许"));
                    continue;
                }
                try {
                    core.VideoCache.Task t = core.VideoCache.start(s, v, e, n, u);
                    started.put(cacheJson(t));
                } catch (Exception be) {
                    skipped.put(new JSONObject().put("ep", e)
                            .put("reason", String.valueOf(be.getMessage())));
                }
            }
            Api.sendJson(ex, 200, new JSONObject().put("ok", true)
                    .put("started", started)
                    .put("startedCount", started.length())
                    .put("skipped", skipped)
                    .toString());
            return;
        }

        String site = Api.trimToEmpty(in.optString("site", ""));
        String vodId = Api.trimToEmpty(in.optString("vodId", ""));
        String ep = Api.trimToEmpty(in.optString("ep", ""));
        String name = Api.trimToEmpty(in.optString("name", ""));
        String url = Api.trimToEmpty(in.optString("url", ""));
        if (site.isEmpty() || vodId.isEmpty() || url.isEmpty()) {
            Api.sendJson(ex, 400, "{\"code\":-1,\"msg\":\"site, vodId, url required\"}");
            return;
        }
        // 缓存源可以是任意在线地址，与 /api/proxy/stream 同样必须挡内网。
        // 例外只有测试：本机假 HLS 服务在 127.0.0.1 上，用系统属性显式放开，
        // 默认关闭且不读 policy（用户配置里改不到，避免变成"一键关掉 SSRF"）。
        if (!core.UrlSafety.isSafeMediaUrl(url)
                && !Boolean.getBoolean("meow.test.allowLoopbackCache")) {
            Api.sendJson(ex, 403, "{\"code\":-1,\"msg\":\"url not allowed\"}");
            return;
        }
        /*
         * 展示元数据随缓存请求一起带过来（前端从详情页取，那时一定联网）。
         * 只挑这几个键，不要把整个详情 JSON 塞进任务表。
         */
        JSONObject meta = new JSONObject();
        for (String k : new String[]{"poster", "vodName", "vodYear", "vodArea", "vodRemarks"}) {
            String v = Api.trimToEmpty(in.optString(k, ""));
            if (!v.isEmpty()) meta.put(k, v);
        }
        core.VideoCache.Task t = core.VideoCache.start(site, vodId, ep, name, url, "", meta);
        Api.sendJson(ex, 200, cacheJson(t).toString());
    }
    /**
     * `POST /api/cache/batch` —— 整季批量下载。
     *
     * <p>body：{@code {"site":"X","vodId":"123","items":[{"ep","name","url"},...]}}
     * <br>返回：{@code {"ok":true,"batch":"b...","ids":[...],"count":n,
     * "skipped":[{ep,reason}],"items":[{id,ep,state}]}}
     *
     * <p><b>为什么用 /api/cache/batch 而不是复用 /api/cache 的 items 分支</b>：
     * 旧分支是一次性把所有集同时 start（每集再 4 路分片），整季 20 集就是
     * 80 条并发连接打同一个源站，实测会拿到 429 与断流；新端点走全局 2 路
     * 队列，一集下完再起下一集。旧分支保留是为了不破坏已发布的前端。
     *
     * <p>每个 item 的校验失败（缺 url、地址不安全）都进 {@code skipped}，
     * 不中断整批——整季里有一集地址是广告位是常态。
     */
    public static void handleCacheBatch(HttpExchange ex) throws Exception {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            Api.sendJson(ex, 405, "{\"code\":-1,\"msg\":\"POST only\"}");
            return;
        }
        String body = Api.read(ex.getRequestBody());
        JSONObject in = body == null || body.trim().isEmpty() ? new JSONObject() : new JSONObject(body);
        String site = Api.trimToEmpty(in.optString("site", ""));
        String vodId = Api.trimToEmpty(in.optString("vodId", ""));
        JSONArray items = in.optJSONArray("items");
        if (site.isEmpty() || vodId.isEmpty() || items == null || items.length() == 0) {
            Api.sendJson(ex, 400, "{\"code\":-1,\"msg\":\"site, vodId, items required\"}");
            return;
        }
        List<JSONObject> accepted = new ArrayList<>();
        JSONArray skipped = new JSONArray();
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            String ep = Api.trimToEmpty(it.optString("ep", ""));
            String url = Api.trimToEmpty(it.optString("url", ""));
            if (url.isEmpty()) {
                skipped.put(new JSONObject().put("ep", ep).put("reason", "缺少 url"));
                continue;
            }
            // 与单集下载同一道 SSRF 校验：批量不能成为绕过它的口子
            if (!core.UrlSafety.isSafeMediaUrl(url)
                    && !Boolean.getBoolean("meow.test.allowLoopbackCache")) {
                skipped.put(new JSONObject().put("ep", ep).put("reason", "地址不被允许"));
                continue;
            }
            JSONObject ok = new JSONObject();
            ok.put("ep", ep);
            ok.put("name", Api.trimToEmpty(it.optString("name", "")));
            ok.put("url", url);
            accepted.add(ok);
        }
        if (accepted.isEmpty()) {
            Api.sendJson(ex, 200, new JSONObject().put("ok", false)
                    .put("batch", "").put("ids", new JSONArray()).put("count", 0)
                    .put("skipped", skipped).put("items", new JSONArray())
                    .put("msg", "没有可下载的集").toString());
            return;
        }
        core.VideoCache.Batch b = core.VideoCache.startBatch(site, vodId, accepted);
        JSONArray ids = new JSONArray();
        JSONArray itemsOut = new JSONArray();
        for (String id : b.ids) {
            ids.put(id);
            JSONObject o = new JSONObject();
            o.put("id", id);
            core.VideoCache.Task t = core.VideoCache.status(id);
            o.put("ep", t == null ? "" : t.ep);
            o.put("state", t == null ? "idle" : t.state);
            itemsOut.put(o);
        }
        Api.sendJson(ex, 200, new JSONObject().put("ok", true)
                .put("batch", b.id)
                .put("site", b.site)
                .put("vodId", b.vodId)
                .put("ids", ids)
                .put("count", ids.length())
                .put("skipped", skipped)
                .put("items", itemsOut)
                // 进度读取：GET /api/cache/status?batch=<id>
                .put("statusUrl", "/api/cache/status?batch=" + b.id)
                .toString());
    }
    /**
     * `GET /api/cache/status?batch=id` —— 批次聚合进度。
     *
     * <p>不带 batch 时返回所有批次概览（离线页做分组用）。
     * 单集进度仍走既有的 {@code GET /api/cache?id=xxx}，两者不重复：
     * 批次端点回答"整季下到哪了"，单集端点回答"这一集能不能播"。
     */
    public static void handleCacheStatus(HttpExchange ex) throws Exception {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())
                && !"HEAD".equalsIgnoreCase(ex.getRequestMethod())) {
            Api.sendJson(ex, 405, "{\"code\":-1,\"msg\":\"GET only\"}");
            return;
        }
        Map<String, String> q = Api.query(ex);
        String batchId = Api.trimToEmpty(q.get("batch"));
        if (batchId.isEmpty()) {
            Api.sendJson(ex, 200, new JSONObject().put("ok", true)
                    .put("batches", core.VideoCache.batches()).toString());
            return;
        }
        JSONObject s = core.VideoCache.batchStatus(batchId);
        if (s == null) {
            Api.sendJson(ex, 404, "{\"code\":-1,\"msg\":\"no such batch\"}");
            return;
        }
        Api.sendJson(ex, 200, s.toString());
    }
    /**
     * `GET /api/cache/tasks` —— 未完成任务（含重启前被打断的）。
     *
     * <p>应用的典型用法：启动后拉一次，把 {@code resumable=true} 的列成
     * "未下完"并给一个"继续"按钮（POST /api/cache/resume）。
     */
    public static void handleCacheTasks(HttpExchange ex) throws Exception {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())
                && !"HEAD".equalsIgnoreCase(ex.getRequestMethod())) {
            Api.sendJson(ex, 405, "{\"code\":-1,\"msg\":\"GET only\"}");
            return;
        }
        Api.sendJson(ex, 200, new JSONObject().put("ok", true)
                .put("items", core.VideoCache.unfinished())
                .put("cacheDir", core.VideoCache.cacheRoot().toString())
                .put("cacheDirReloadRequired", core.VideoCache.cacheDirReloadRequired())
                .toString());
    }
    /**
     * `POST /api/cache/resume` —— body {@code {"id":"..."}} 或
     * {@code {"ids":["a","b"]}}，续传未完成任务。
     *
     * <p>续传的粒度是"分片"而不是"整个任务"：{@code VideoCache.run} 在下载每个
     * 分片前都会检查目标文件，存在且非空就跳过（见分片循环里的跳过分支），
     * 所以从第一个缺失分片继续是天然成立的。分片文件名带序号
     * （{@code seg-00042.ts}），同一分片只会被一个线程写，并发下不会互相覆盖。
     */
    public static void handleCacheResume(HttpExchange ex) throws Exception {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            Api.sendJson(ex, 405, "{\"code\":-1,\"msg\":\"POST only\"}");
            return;
        }
        String body = Api.read(ex.getRequestBody());
        JSONObject in = body == null || body.trim().isEmpty() ? new JSONObject() : new JSONObject(body);
        List<String> ids = new ArrayList<>();
        String one = Api.trimToEmpty(in.optString("id", ""));
        if (!one.isEmpty()) ids.add(one);
        JSONArray arr = in.optJSONArray("ids");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                String s = Api.trimToEmpty(arr.optString(i, ""));
                if (!s.isEmpty() && !ids.contains(s)) ids.add(s);
            }
        }
        if (ids.isEmpty()) {
            Api.sendJson(ex, 400, "{\"code\":-1,\"msg\":\"id or ids required\"}");
            return;
        }
        JSONArray resumed = new JSONArray();
        JSONArray failed = new JSONArray();
        for (String id : ids) {
            core.VideoCache.Task t = core.VideoCache.resume(id);
            if (t == null) {
                failed.put(new JSONObject().put("id", id)
                        .put("reason", "任务不存在或缺少源地址"));
                continue;
            }
            resumed.put(cacheJson(t));
        }
        Api.sendJson(ex, 200, new JSONObject().put("ok", true)
                .put("resumed", resumed)
                .put("failed", failed)
                .toString());
    }
    /**
     * 把一集缓存导出成**单个文件**（流式返回）。     *
     * <p>需求来源：缓存不能只留在后端——PC/TV 要能存到本机或 U 盘，Web 要能下载到本机硬盘。
     * 后端在这里只当「抓取/转封装代理」，产物交给客户端落盘。
     *
     * <p>三档降级（按用户指定的优先级）：
     * <ol>
     *   <li><b>C/B</b>：有 ffmpeg → {@code -c copy} remux 成 mp4（不转码，几乎无 CPU 开销），
     *       产物缓存为 {@code merged.mp4}，重复导出直接复用；</li>
     *   <li><b>A</b>：无 ffmpeg → 按序拼接 TS 分片，流出一个 .ts（MPEG-TS 本身可拼接，
     *       ExoPlayer/VLC 能播；比"一堆分片目录"好管理）。</li>
     * </ol>
     * 响应头 {@code X-Meow-Export-Format} 告诉客户端实际格式，前端据此决定
     * 「已合并为 mp4」还是「缺少 ffmpeg，已存为 .ts（装插件可升级）」。
     */
    public static void handleCacheExport(HttpExchange ex) throws Exception {
        Map<String, String> q = Api.query(ex);
        String id = Api.trimToEmpty(q.get("id"));
        String format = Api.trimToEmpty(q.get("format")).toLowerCase();
        if (id.isEmpty()) {
            Api.sendJson(ex, 400, "{\"code\":-1,\"msg\":\"缺少 id\"}");
            return;
        }
        java.util.List<java.nio.file.Path> segs = core.VideoCache.segments(id);
        if (segs.isEmpty()) {
            Api.sendJson(ex, 404, "{\"code\":-1,\"msg\":\"这一集还没有缓存分片；先下载完成再导出\"}");
            return;
        }
        String blocked = exportBlockReason(id);
        if (blocked != null) {
            Api.sendJson(ex, 409, new JSONObject().put("code", -1).put("msg", blocked).toString());
            return;
        }

        String ff = core.Transcode.ffmpegPath();
        boolean wantTs = "ts".equals(format);
        java.nio.file.Path merged = null;
        if (!wantTs && !ff.isEmpty()) {
            try {
                merged = ensureMerged(id, ff, segs);
            } catch (Exception e) {
                // 合并失败不致命：降级成 .ts 流出，但把原因留在日志里
                System.out.println("[cache] remux failed, fallback to ts: " + e.getMessage());
            }
        }

        String base = exportFileName(id);
        Headers h = ex.getResponseHeaders();
        Api.cors(ex);
        h.set("X-Meow-Export-Format", merged != null ? "mp4" : "ts");
        h.set("Content-Disposition", contentDisposition(base + (merged != null ? ".mp4" : ".ts")));

        if (merged != null) {
            long len = java.nio.file.Files.size(merged);
            h.set("Content-Type", "video/mp4");
            h.set("Content-Length", String.valueOf(len));
            ex.sendResponseHeaders(200, len);
            try (OutputStream os = ex.getResponseBody();
                 InputStream in = java.nio.file.Files.newInputStream(merged)) {
                in.transferTo(os);
            }
            ex.close();
            return;
        }

        // A 档：没有 ffmpeg。分片按序号顺序就是连续码流，直接依次写出。
        //
        // 必须先 stat 出总长度再给 Content-Length，不能用分块传输（sendResponseHeaders(200, 0)）：
        // 后者一旦发头就无法改状态码，中途某个分片被删（VideoCache.delete 或配额淘汰）
        // 会在 200 已提交后抛异常，客户端收到一个 HTTP 层"完整"的截断 .ts 且毫无错误信号
        // —— TV 端会把它标成 done 落盘（实测踩过这个降级路径）。
        long tsLen;
        try {
            tsLen = 0;
            for (java.nio.file.Path p : segs) tsLen += java.nio.file.Files.size(p);
        } catch (Exception e) {
            Api.sendJson(ex, 409, new JSONObject().put("code", -1)
                    .put("msg", "分片在导出过程中被删除，请重新下载：" + e.getMessage()).toString());
            return;
        }
        h.set("Content-Type", "video/mp2t");
        h.set("Content-Length", String.valueOf(tsLen));
        ex.sendResponseHeaders(200, tsLen);
        try (OutputStream os = ex.getResponseBody()) {
            byte[] buf = new byte[64 * 1024];
            for (java.nio.file.Path p : segs) {
                try (InputStream in = java.nio.file.Files.newInputStream(p)) {
                    int n;
                    while ((n = in.read(buf)) != -1) os.write(buf, 0, n);
                }
            }
            os.flush();
        }
        ex.close();
    }
    /**
     * 导出到本机路径（PC 专用：后端与客户端同机）。
     *
     * <p>相比「先下载一遍再保存」，同机直写省一次全量 IO，也不受 WebView/浏览器
     * 落盘能力限制。因为能写任意路径，<b>只接受来自回环地址的请求</b>——
     * Docker/TV 那种远端调用一律 403，避免把后端变成任意写盘的口子。
     *
     * <p>body: {@code {"id":"...","dir":"D:/影视","name":"可选文件名"}}
     * <p>返回: {@code {ok, path, format, bytes}}
     */
    public static void handleCacheExportTo(HttpExchange ex) throws Exception {
        java.net.InetAddress remote = ex.getRemoteAddress() == null
                ? null : ex.getRemoteAddress().getAddress();
        if (remote == null || !remote.isLoopbackAddress()) {
            Api.sendJson(ex, 403, "{\"code\":-1,\"msg\":\"仅允许本机调用（PC 端直存）\"}");
            return;
        }
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            Api.sendJson(ex, 405, "{\"code\":-1,\"msg\":\"POST only\"}");
            return;
        }
        JSONObject b = new JSONObject(Api.read(ex.getRequestBody()));
        String id = Api.trimToEmpty(b.optString("id", ""));
        String dir = Api.trimToEmpty(b.optString("dir", ""));
        if (id.isEmpty() || dir.isEmpty()) {
            Api.sendJson(ex, 400, "{\"code\":-1,\"msg\":\"缺少 id 或 dir\"}");
            return;
        }
        java.util.List<java.nio.file.Path> segs = core.VideoCache.segments(id);
        if (segs.isEmpty()) {
            Api.sendJson(ex, 404, "{\"code\":-1,\"msg\":\"这一集还没有缓存分片；先下载完成再导出\"}");
            return;
        }
        // 与 /api/cache/export 同一套判定：下载中/正在合并都挡掉，
        // 否则会导出一份内容不完整的文件而用户以为成功。
        String blockedTo = exportBlockReason(id);
        if (blockedTo != null) {
            Api.sendJson(ex, 409, new JSONObject().put("code", -1).put("msg", blockedTo).toString());
            return;
        }

        String ff = core.Transcode.ffmpegPath();
        java.nio.file.Path merged = null;
        if (!ff.isEmpty()) {
            try {
                merged = ensureMerged(id, ff, segs);
            } catch (Exception e) {
                System.out.println("[cache] remux failed (export-to): " + e.getMessage());
            }
        }

        java.nio.file.Path targetDir = java.nio.file.Paths.get(dir);
        try {
            java.nio.file.Files.createDirectories(targetDir);
        } catch (Exception e) {
            Api.sendJson(ex, 400, new JSONObject().put("code", -1)
                    .put("msg", "目标目录不可用：" + e.getMessage()).toString());
            return;
        }
        String raw = Api.trimToEmpty(b.optString("name", ""));
        String base = raw.isEmpty() ? exportFileName(id) : raw;
        String ext = merged != null ? ".mp4" : ".ts";
        java.nio.file.Path target = uniqueTarget(targetDir, base, ext);

        long bytes;
        if (merged != null) {
            java.nio.file.Files.copy(merged, target,
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            bytes = java.nio.file.Files.size(target);
        } else {
            // A 档：把分片拼成单个 .ts 落盘
            try (OutputStream os = java.nio.file.Files.newOutputStream(target)) {
                for (java.nio.file.Path p : segs) {
                    java.nio.file.Files.copy(p, os);
                }
            }
            bytes = java.nio.file.Files.size(target);
        }
        Api.sendJson(ex, 200, new JSONObject().put("ok", true)
                .put("path", target.toString())
                .put("format", merged != null ? "mp4" : "ts")
                .put("bytes", bytes).toString());
    }
    /**
     * 这一集现在能不能导出；能则返回 null，不能则返回给用户看的原因。
     *
     * <p>两种情况会挡住：其他请求正在合并（稍等），或该集还在下载中
     * （分片不全，合出来必然缺内容）。
     */
    public static String exportBlockReason(String id) {
        Long startedAt = MERGING.get(id);
        if (startedAt != null) {
            if (System.currentTimeMillis() - startedAt < MERGE_STALE_MS) {
                return "这一集正在合并中，稍等几秒再试（大文件约需 10–60 秒）";
            }
            // 陈旧标记：上一次合并进程被强杀，允许重来
            MERGING.remove(id, startedAt);
        }
        core.VideoCache.Task t = core.VideoCache.status(id);
        if (t != null && "running".equals(t.state)) {
            // 半集分片也能合成文件，但内容不完整——比直接报错更糟的是"看起来导出成功"
            return "这一集还在下载中（" + t.done + "/" + t.total + " 片），下完再导出";
        }
        return null;
    }
    /**
     * 确保 merged.mp4 存在且比所有分片新；返回其路径。
     * 用 concat demuxer + {@code -c copy}：只换容器不重编码。
     */
    public static java.nio.file.Path ensureMerged(String id, String ff,
                                                   java.util.List<java.nio.file.Path> segs) throws Exception {
        java.nio.file.Path out = core.VideoCache.mergedFile(id);
        long newest = 0;
        for (java.nio.file.Path p : segs) {
            try {
                newest = Math.max(newest, java.nio.file.Files.getLastModifiedTime(p).toMillis());
            } catch (Exception ignored) {
            }
        }
        if (java.nio.file.Files.isRegularFile(out)
                && java.nio.file.Files.getLastModifiedTime(out).toMillis() >= newest
                && java.nio.file.Files.size(out) > 0) {
            return out;
        }

        // 登记「正在合并」。用 putIfAbsent：万一绕过了 exportBlockReason
        // （两条路径都会调这里），也保证同一集只有一个 ffmpeg 在跑。
        Long prev = MERGING.putIfAbsent(id, System.currentTimeMillis());
        if (prev != null) {
            throw new IOException("这一集正在合并中，请稍后再试");
        }
        try {
            return doMerge(id, ff, segs, out, dir(out));
        } finally {
            MERGING.remove(id);
        }
    }
    public static java.nio.file.Path doMerge(String id, String ff,
                                              java.util.List<java.nio.file.Path> segs,
                                              java.nio.file.Path out,
                                              java.nio.file.Path dir) throws Exception {
        StringBuilder list = new StringBuilder();
        for (java.nio.file.Path p : segs) {
            // concat 清单里的单引号需要转义；分片名由后端生成（seg-00001.ts），实际不会出现
            list.append("file '").append(p.getFileName().toString().replace("'", "'\\''")).append("'\n");
        }
        // 用 write(byte[]) 而不是 writeString：android.jar 里 Files.writeString 的
        // 两个重载虽然存在，但那是 API 33+ 才补的（低版本设备运行时会 NoSuchMethod）。
        // 这里要走同一条代码路径，用 write 最稳。
        java.nio.file.Files.write(dir.resolve("concat.txt"),
                list.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));

        java.util.List<String> cmd = new java.util.ArrayList<>();
        cmd.add(ff);
        cmd.add("-hide_banner");
        cmd.add("-loglevel"); cmd.add("error");
        cmd.add("-y");
        cmd.add("-f"); cmd.add("concat");
        cmd.add("-safe"); cmd.add("0");
        cmd.add("-i"); cmd.add("concat.txt");
        cmd.add("-c"); cmd.add("copy");
        cmd.add("-movflags"); cmd.add("+faststart");
        // ★ 先写临时名再原子改名。
        //   直接写 merged.mp4 时，ffmpeg 中途失败（分片坏、磁盘满、被 kill）会留下
        //   一份**截断的文件**；而上面的复用判定只看「存在 && 非空 && 比所有分片新」，
        //   下次进来会把它当成有效产物直接返回——用户导出的是坏视频，还查不出原因。
        //   临时名带进程 id，并发导出同一集也不会互踩。
        //
        // ★ 不用 ProcessHandle.current().pid()：android.jar 里**没有 ProcessHandle**
        //   （实测 0 条），这个类走的是同一条源码，编不过就整包失败。用随机串达到
        //   同样的「并发不互踩」目的——pid 本来也只是个不重复的标记。
        String tmpName = "merged.tmp-" + Long.toHexString(
                java.util.concurrent.ThreadLocalRandom.current().nextLong() & 0xffffffffffffL) + ".mp4";
        cmd.add(tmpName);

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(dir.toFile());
        pb.redirectErrorStream(true);
        java.nio.file.Path tmp = dir.resolve(tmpName);
        try {
            Process proc = pb.start();
            // ★ 先 waitFor(超时) 再读输出，不能顺序反了：Api.read() 会阻塞到流关闭，
            //   而 ffmpeg 卡住（输入是目录/网络挂起/坏文件死循环）时流永远不关，
            //   整个导出请求就永久挂住，前端一直转圈、后端线程被占死（实测踩过：
            //   把某个分片换成目录后请求超时 240 秒都没返回）。
            boolean done = proc.waitFor(FFMPEG_TIMEOUT_SEC, java.util.concurrent.TimeUnit.SECONDS);
            if (!done) {
                proc.destroyForcibly();
                throw new IOException("ffmpeg 超时（" + FFMPEG_TIMEOUT_SEC + " 秒），已中止。"
                        + "常见原因：某个分片损坏、磁盘满、或源文件过大");
            }
            String log = Api.read(proc.getInputStream());
            int code = proc.exitValue();
            if (code != 0 || !java.nio.file.Files.isRegularFile(tmp)
                    || java.nio.file.Files.size(tmp) == 0) {
                throw new IOException("ffmpeg exit " + code + ": " + log.trim());
            }
            // 同目录内的 move 是原子的：读者要么看到旧的完整文件，要么看到新的，
            // 不会看到半截。
            java.nio.file.Files.move(tmp, out,
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            return out;
        } finally {
            // 失败时清掉半成品；成功时已被 move 走，deleteIfExists 无副作用。
            try {
                java.nio.file.Files.deleteIfExists(tmp);
            } catch (Exception ignored) {
            }
        }
    }
    public static String exportFileName(String id) {
        String name = "";
        String ep = "";
        JSONObject meta = core.VideoCache.meta(id);
        if (meta != null) {
            name = meta.optString("name", "");
            ep = meta.optString("ep", "");
        }
        String raw = (name + (ep.isEmpty() ? "" : " - " + ep)).trim();
        if (raw.isEmpty()) raw = "meow-" + id;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length() && sb.length() < 120; i++) {
            char c = raw.charAt(i);
            if (c < 32 || c == '/' || c == '\\' || c == ':' || c == '*' || c == '?'
                    || c == '"' || c == '<' || c == '>' || c == '|') continue;
            sb.append(c);
        }
        return sb.length() == 0 ? "meow-" + id : sb.toString();
    }
    public static java.nio.file.Path uniqueTarget(java.nio.file.Path dir, String base, String ext) {
        java.nio.file.Path p = dir.resolve(base + ext);
        int n = 2;
        while (java.nio.file.Files.exists(p) && n < 1000) {
            p = dir.resolve(base + " (" + n + ")" + ext);
            n++;
        }
        return p;
    }
    public static String contentDisposition(String filename) {
        try {
            String enc = java.net.URLEncoder.encode(filename, "UTF-8").replace("+", "%20");
            return "attachment; filename=\"meow-export\"; filename*=UTF-8''" + enc;
        } catch (Exception e) {
            return "attachment";
        }
    }
    /**
     * 本地缓存文件（清单与分片）。
     *
     * <p>路径形态 {@code /api/cache/{id}/{file}}：id 与文件名都只允许单段，
     * 出现 {@code ..} 或分隔符直接 404——这是唯一直接读磁盘的媒体端点，
     * 不能留穿越口子。
     */
    public static void handleCacheFile(HttpExchange ex) throws IOException {
        String path = ex.getRequestURI().getPath();
        String rest = path.substring("/api/cache/".length());
        int slash = rest.indexOf('/');
        if (slash <= 0) {
            Api.sendJson(ex, 404, "{\"code\":-1,\"msg\":\"not found\"}");
            return;
        }
        String id = URLDecoder.decode(rest.substring(0, slash), "UTF-8");
        String file = URLDecoder.decode(rest.substring(slash + 1), "UTF-8");
        if (id.isEmpty() || file.isEmpty() || id.contains("..") || file.contains("..")
                || id.contains("/") || id.contains("\\") || file.contains("/") || file.contains("\\")) {
            Api.sendJson(ex, 404, "{\"code\":-1,\"msg\":\"not found\"}");
            return;
        }
        java.nio.file.Path p = core.VideoCache.fileOf(id, file);
        if (p == null || !java.nio.file.Files.isRegularFile(p)) {
            Api.sendJson(ex, 404, "{\"code\":-1,\"msg\":\"not cached\"}");
            return;
        }
        // 只在取清单时刷新访问时间：一集有几十上百个分片，每个都写一次 meta
        // 会把磁盘打满，而"这一集在被用"这个信息取清单就够表达了。
        if (file.endsWith(".m3u8")) {
            core.VideoCache.touch(id);
        }
        byte[] data = java.nio.file.Files.readAllBytes(p);
        Headers out = ex.getResponseHeaders();
        Api.cors(ex);
        out.set("Content-Type", file.endsWith(".m3u8")
                ? "application/vnd.apple.mpegurl" : "video/mp2t");
        out.set("Accept-Ranges", "bytes");
        out.set("Cache-Control", "public, max-age=31536000, immutable");
        // 本地文件也支持 Range：断网时进度条同样要能拖
        String range = ex.getRequestHeaders().getFirst("Range");
        if (range != null && range.startsWith("bytes=")) {
            String spec = range.substring(6);
            int dash = spec.indexOf('-');
            if (dash > 0) {
                try {
                    long start = Long.parseLong(spec.substring(0, dash).trim());
                    long end = dash + 1 < spec.length()
                            ? Long.parseLong(spec.substring(dash + 1).trim())
                            : data.length - 1;
                    if (start >= 0 && start < data.length) {
                        if (end >= data.length) end = data.length - 1;
                        int len = (int) (end - start + 1);
                        out.set("Content-Range", "bytes " + start + "-" + end + "/" + data.length);
                        ex.sendResponseHeaders(206, len);
                        ex.getResponseBody().write(data, (int) start, len);
                        ex.close();
                        return;
                    }
                } catch (NumberFormatException ignored) {
                    /* 落到整份返回 */
                }
            }
        }
        ex.sendResponseHeaders(200, data.length);
        ex.getResponseBody().write(data);
        ex.close();
    }


    /** out.getParent() 的空安全包装：调用方一路上都假定目录已存在。 */
    private static Path dir(Path p) {
        return p == null ? null : p.getParent();
    }

    /**
     * 缓任务 → JSON（前端看到的单集状态）。
     *
     * <p>跟着缓存域搬过来：它只描述 Task 的字段，没有别的依赖。
     */
    public static JSONObject cacheJson(VideoCache.Task t) throws Exception {
        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("id", t.id);
        o.put("site", t.site);
        o.put("vodId", t.vodId);
        o.put("ep", t.ep);
        o.put("name", t.name);
        o.put("state", t.state);
        o.put("percent", t.percent);
        o.put("done", t.done);
        o.put("total", t.total);
        o.put("bytes", t.bytes);
        o.put("error", t.error);
        if (!t.batchId.isEmpty()) o.put("batchId", t.batchId);
        if (t.resumable) o.put("resumable", true);
        if ("done".equals(t.state)) o.put("playlist", "/api/cache/" + t.id + "/playlist.m3u8");
        // 展示元数据（「我的缓存」一剧一卡片要用；离线时是唯一的图/名来源）
        o.put("posterFile", t.posterFile == null ? "" : t.posterFile);
        o.put("vodName", t.vodName == null ? "" : t.vodName);
        o.put("vodYear", t.vodYear == null ? "" : t.vodYear);
        o.put("vodArea", t.vodArea == null ? "" : t.vodArea);
        o.put("vodRemarks", t.vodRemarks == null ? "" : t.vodRemarks);
        if (t.posterFile != null && !t.posterFile.isEmpty()) {
            o.put("posterUrl", "/api/cache/poster?id=" + t.id);
        }
        return o;
    }

    /**
     * 任务控制：暂停 / 取消 / 删除。
     *
     * <p>POST {@code /api/cache/control} body：{@code {action, id}} 或
     * {@code {action, ids:[...]}}。批量是为「整季下载中一键取消」。
     *
     * <p>三个动作不能合并成一个 delete：
     * <ul>
     *   <li><b>pause</b>：停止下载但**保留已下分片**，可 resume 续传</li>
     *   <li><b>cancel</b>：同 pause，语义上用户放弃了这次下载</li>
     *   <li><b>delete</b>：停掉并**删除磁盘目录**，不可恢复</li>
     * </ul>
     */
    public static void handleCacheControl(HttpExchange ex) throws Exception {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            Api.sendJson(ex, 405, "{\"code\":-1,\"msg\":\"POST only\"}");
            return;
        }
        String body = Api.read(ex.getRequestBody());
        JSONObject in = body == null || body.trim().isEmpty() ? new JSONObject() : new JSONObject(body);
        String action = Api.trimToEmpty(in.optString("action", ""));
        List<String> ids = new ArrayList<>();
        String one = Api.trimToEmpty(in.optString("id", ""));
        if (!one.isEmpty()) ids.add(one);
        JSONArray arr = in.optJSONArray("ids");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                String s = Api.trimToEmpty(arr.optString(i, ""));
                if (!s.isEmpty() && !ids.contains(s)) ids.add(s);
            }
        }
        /*
         * 清弹幕缓存不需要 id：它是全局的、按文件 TTL 的。
         * 必须在 id 校验**之前**处理，否则前端传 {"action":"clearDanmaku"}
         * 会被 "action and id/ids required" 挡掉。
         */
        if ("clearDanmaku".equals(action)) {
            String mode = Api.trimToEmpty(in.optString("mode", "expired"));
            boolean onlyExpired = !"all".equals(mode);
            int n = core.VideoCache.clearDanmaku(onlyExpired);
            Api.sendJson(ex, 200, new JSONObject().put("ok", true)
                    .put("action", action).put("mode", mode).put("removed", n)
                    .put("bytes", core.VideoCache.danmakuBytes()).toString());
            return;
        }
        if (ids.isEmpty() || action.isEmpty()) {
            Api.sendJson(ex, 400, "{\"code\":-1,\"msg\":\"action and id/ids required\"}");
            return;
        }
        JSONArray okIds = new JSONArray();
        JSONArray failed = new JSONArray();
        for (String id : ids) {
            boolean ok;
            switch (action) {
                case "pause":  ok = core.VideoCache.pause(id) != null; break;
                case "cancel": ok = core.VideoCache.cancel(id) != null; break;
                case "delete": ok = core.VideoCache.remove(id); break;
                default:
                    Api.sendJson(ex, 400, "{\"code\":-1,\"msg\":\"unknown action: " + action + "\"}");
                    return;
            }
            if (ok) okIds.put(id);
            else failed.put(new JSONObject().put("id", id).put("reason", "not found"));
        }
        Api.sendJson(ex, 200, new JSONObject().put("ok", true)
                .put("action", action)
                .put("done", okIds)
                .put("failed", failed)
                .toString());
    }

    /**
     * 读缓存里的本地海报 —— 离线时唯一能出图的来源。
     *
     * <p>参数二选一：{@code id}（某一集）或 {@code site+vodId}（整部剧取任意一张）。
     * 找不到返回 404，前端自己退到占位图：不能让"没海报"变成整页报错。
     */
    public static void handleCachePoster(HttpExchange ex) throws Exception {
        java.util.Map<String, String> q = Api.query(ex);
        String id = Api.trimToEmpty(q.getOrDefault("id", ""));
        String site = Api.trimToEmpty(q.getOrDefault("site", ""));
        String vodId = Api.trimToEmpty(q.getOrDefault("vodId", ""));
        java.nio.file.Path p = null;
        if (!id.isEmpty()) p = core.VideoCache.posterOf(id);
        if (p == null && !site.isEmpty() && !vodId.isEmpty()) {
            p = core.VideoCache.posterOfVod(site, vodId);
        }
        if (p == null) {
            Api.sendJson(ex, 404, "{\"code\":-1,\"msg\":\"no poster\"}");
            return;
        }
        byte[] data = java.nio.file.Files.readAllBytes(p);
        String name = p.getFileName().toString().toLowerCase();
        String mime = name.endsWith(".png") ? "image/png"
                : name.endsWith(".gif") ? "image/gif"
                : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
        ex.getResponseHeaders().set("Content-Type", mime);
        // 本地稳定副本，长缓存：避免每次进缓存页都重新读盘
        ex.getResponseHeaders().set("Cache-Control", "public, max-age=604800");
        ex.sendResponseHeaders(200, data.length);
        ex.getResponseBody().write(data);
        ex.close();
    }

    /**
     * 读 policy.json 里的字段。
     *
     * <p>主类持有一份（16 处在用），这里只读 cacheDir 这一项。
     * 用回调注入而不是自己再读一遍文件：两份解析逻辑迟早会漂移，
     * 而 policy 是"用户改了要立刻生效"的东西（虽然 cacheDir 例外，需重启）。
     */
    public interface PolicySource {
        String cacheDir();
    }

    private static volatile PolicySource policySource;

    public static void bindPolicy(PolicySource s) {
        policySource = s;
    }

    private static String policyCacheDir() {
        PolicySource s = policySource;
        return s == null ? "" : s.cacheDir();
    }
}
