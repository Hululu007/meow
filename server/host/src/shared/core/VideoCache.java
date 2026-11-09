package core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 离线缓存：把线上看过的片子落到本地，**断网后仍能完整看完一集**。
 *
 * <p><b>目标不是省流量</b>。判据是拔掉网线后：画面能播、弹幕能显示、
 * 进度条能拖、退出再进能续播。凡是只在"第二次加载更快"上有效果的做法
 * （HTTP 缓存、服务端代理缓存）都不算完成。
 *
 * <p><b>断网可播的四个硬前提</b>：
 * <ol>
 *   <li>播放地址本地可达 —— 缓存命中时返回 {@code /api/cache/{id}/playlist.m3u8}；</li>
 *   <li>清单内所有引用本地化 —— 分片、{@code EXT-X-KEY} 的 URI、字幕都改成
 *       <b>相对 playlist.m3u8 的同目录文件名</b>（与在线改写方向相反：
 *       在线必须是绝对地址，否则播放器把相对路径拼到源站域名上会 404）；</li>
 *   <li>前端不被后端离线挡住 —— 见 {@code stores/app.ts} 的 boot；</li>
 *   <li>弹幕本地读 —— 见 {@code ApiServer} 的 danmakuDiskGet。</li>
 * </ol>
 *
 * <p><b>为什么不能存成一个 mp4</b>：仓库里没有任何转封装/复用能力
 * （无 ffmpeg、无 mp4box/mux.js），把 TS 分片拼成 mp4 需要重写容器，
 * 而且会丢掉"边下边播"。存分片 + 本地清单不需要任何转码。
 */
public final class VideoCache {

    private VideoCache() {
    }

    private static final String ROOT = "cache/video";

    /**
     * 缓存根目录。
     *
     * <p>默认在数据目录下（`cache/video`）。policy.json 里配 {@code cacheDir}
     * 可以指到别的盘——PC 端 C 盘小的时候这是唯一出路。**相对路径按数据目录解析**，
     * 这样容器里写 {@code cacheDir: "mnt/cache"} 也能落在数据目录下而不是进程 cwd
     * （cwd 在容器/服务里不可控，写进去的东西重启就找不到了）。
     *
     * <p><b>进程内只解析一次</b>：{@link #dirOf} 每次下载分片都会调本方法，
     * 如果每次都重读 policy，用户在任务跑到一半时改了 cacheDir，前一半分片留在
     * 旧目录、后一半写进新目录，任务看起来"永远差几个分片"且删不掉。
     * 代价是改 cacheDir 需要重启后端，用 {@link #cacheDirReloadRequired()}
     * 让接口把这件事告诉前端。
     *
     * <p>配了但路径不可用（父目录不存在且建不出来）就退回默认值，
     * 不要因为一个配置错误让整个缓存功能失效。
     */
    public static java.nio.file.Path cacheRoot() {
        java.nio.file.Path cached = rootCache;
        if (cached != null) return cached;
        synchronized (VideoCache.class) {
            if (rootCache != null) return rootCache;
            String custom = policy().optString("cacheDir", "").trim();
            rootPolicyValue = custom;
            java.nio.file.Path resolved = null;
            if (!custom.isEmpty()) {
                try {
                    java.nio.file.Path p = java.nio.file.Paths.get(custom);
                    if (!p.isAbsolute()) p = DataPaths.root().resolve(p);
                    p = p.toAbsolutePath().normalize();
                    java.nio.file.Files.createDirectories(p);
                    if (java.nio.file.Files.isWritable(p)) resolved = p;
                } catch (Exception e) {
                    System.out.println("[cache] cacheDir 不可用，退回默认: " + e.getMessage());
                }
            }
            rootCache = resolved != null ? resolved : DataPaths.of(ROOT);
            System.out.println("[cache] root = " + rootCache);
            return rootCache;
        }
    }

    private static volatile java.nio.file.Path rootCache;
    /** 解析 cacheRoot 时看到的 policy 值，用来判断"改了但还没重启"。 */
    private static volatile String rootPolicyValue;

    /** policy 里的 cacheDir 与当前生效值不同 → 需要重启后端。 */
    public static boolean cacheDirReloadRequired() {
        // 先确保 rootPolicyValue 已拍过（否则第一次请求会误报"需要重启"）
        cacheRoot();
        String cur = policy().optString("cacheDir", "").trim();
        return !cur.equals(rootPolicyValue == null ? "" : rootPolicyValue);
    }
    /** 单任务并发下载的分片数。NAS 局域网实测 4 路足够跑满千兆。 */
    private static final int PARALLEL = 4;

    /**
     * 一个批次里同时在跑的任务数。
     *
     * <p>刻意比单任务的分片并发（{@link #PARALLEL}）更小：整季 20 集各开 4 路
     * 就是 80 条连接，源站会直接 429/断流。2 是"能连续吞下整季"与
     * "不把源站打成拒绝服务"之间实测能稳住的折中值。
     */
    private static final int BATCH_PARALLEL = 2;

    /** 任务表：id → 进度。内存态，重启后按目录重建（见 restore）。 */
    private static final Map<String, Task> TASKS = new ConcurrentHashMap<>();

    public static final class Task {
        public String id = "";
        public String site = "";
        public String vodId = "";
        public String ep = "";
        public String name = "";
        public String sourceUrl = "";
        /** 0-100 */
        public int percent;
        public int total;
        public int done;
        public String state = "idle"; // idle|running|done|failed|canceled|paused
        public String error = "";
        public long bytes;
        public long createdAt = System.currentTimeMillis();
        /** 整季批量下载的批次 id；单集下载为空串。 */
        public String batchId = "";
        /** 最近一次状态变化的时间，任务清单按它排序。 */
        public long updatedAt = System.currentTimeMillis();
        /** 失败但可以续传（目录里已有分片 / 或只是被重启打断）。 */
        public boolean resumable;

        /*
         * 以下字段是「我的缓存」按剧聚合展示所需，2026-10-30 新增。
         *
         * 为什么必须存进任务、而不是每次去问源站：离线时源站根本连不上，
         * 而缓存页恰恰是离线场景下唯一要打开的页面 —— 海报和片名必须本地有。
         * 这些值在**发起缓存时**由前端从详情页带过来（那一刻一定联网）。
         */
        /** 海报远端地址（某些源不给图，允许空）。 */
        public String poster = "";
        /** 本地海报文件名（如 poster.webp）；空 = 还没下或下失败。 */
        public String posterFile = "";
        /** 纯剧名。name 是"剧名 第N集"，聚合分组要用纯剧名。 */
        public String vodName = "";
        public String vodYear = "";
        public String vodArea = "";
        public String vodRemarks = "";
    }

    /** 一集的缓存目录：cache/video/<id>/ */
    private static Path dirOf(String id) {
        java.nio.file.Path r = cacheRoot().resolve(safeId(id));
        try {
            java.nio.file.Files.createDirectories(r);
        } catch (Exception ignored) {
        }
        return r;
    }

    /**
     * 导出用：这一集的分片文件（按序号排序）。
     *
     * <p>给「缓存导出到本机/U盘」用：有 ffmpeg 时作为 concat 的输入清单，
     * 没有时直接按序拼成单个 .ts 流。只返回存在的分片，缺片不报错——
     * 缺片说明这一集其实没下完，调用方自己看返回数量判断。
     */
    public static java.util.List<java.nio.file.Path> segments(String id) {
        java.util.List<java.nio.file.Path> out = new java.util.ArrayList<>();
        java.nio.file.Path dir = dirOf(id);
        if (!java.nio.file.Files.isDirectory(dir)) return out;
        try (java.util.stream.Stream<java.nio.file.Path> st = java.nio.file.Files.list(dir)) {
            st.filter(p -> {
                String n = p.getFileName().toString();
                return n.startsWith("seg-") && n.endsWith(".ts");
            }).sorted().forEach(out::add);
        } catch (Exception ignored) {
        }
        return out;
    }

    /** 导出用：合并后的单文件路径（ffmpeg 产物）。已存在且比所有分片新则直接复用。 */
    public static java.nio.file.Path mergedFile(String id) {
        return dirOf(id).resolve("merged.mp4");
    }

    /** 导出用：这一集的元信息（文件名、站点等）。 */
    public static JSONObject meta(String id) {
        return readMeta(id);
    }

    private static String safeId(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length() && sb.length() < 64; i++) {
            char c = s.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '_' || c == '-') {
                sb.append(c);
            }
        }
        return sb.length() == 0 ? "x" : sb.toString();
    }

    /** 缓存 id：site|vodId|ep 的稳定哈希。同一集重复点下载会复用同一目录。 */
    public static String idFor(String site, String vodId, String ep) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
            byte[] d = md.digest((site + "|" + vodId + "|" + ep).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.substring(0, 16);
        } catch (Exception e) {
            return safeId(site + "_" + vodId + "_" + ep);
        }
    }

    // ------------------------------------------------------------ 配额

    private static final String POLICY_KEY_QUOTA = "cacheQuotaGb";
    private static final String POLICY_KEY_MODE = "cacheEvictMode";
    /** 默认配额。8GB 约 20 集 1080p，再多用户该自己清了。 */
    private static final long DEFAULT_QUOTA_GB = 8;

    private static JSONObject policy() {
        try {
            String raw = DataPaths.read("policy.json");
            return raw == null || raw.trim().isEmpty() ? new JSONObject() : new JSONObject(raw);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /** 配额（字节）。<=0 表示不限制。 */
    public static long quotaBytes() {
        long gb = policy().optLong(POLICY_KEY_QUOTA, DEFAULT_QUOTA_GB);
        return gb <= 0 ? 0 : gb * 1024L * 1024L * 1024L;
    }

    /** 淘汰模式：lru（默认）或 off（只告警不删）。 */
    public static String evictMode() {
        return "off".equalsIgnoreCase(policy().optString(POLICY_KEY_MODE, "lru")) ? "off" : "lru";
    }

    /**
     * 超配额时按最久未访问淘汰。
     *
     * <p><b>为什么按访问时间而不是创建时间</b>：用户可能反复看一部老片，
     * 按创建时间会把正在看的那部删掉。{@code at} 在每次播放本地清单时刷新。
     *
     * <p><b>为什么不删正在下载的</b>：那些任务还持有目录句柄，删了会让下载报错；
     * 而且用户刚点下载就被系统清掉很突兀。
     */
    public static synchronized void enforceQuota() {
        long quota = quotaBytes();
        if (quota <= 0) return;
        long total = totalBytes();
        if (total <= quota) return;
        if ("off".equals(evictMode())) {
            System.out.println("[cache] 超配额 " + total + " > " + quota + "，evictMode=off 不删除");
            return;
        }
        List<JSONObject> items = new ArrayList<>();
        JSONArray arr = list();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null || !"done".equals(o.optString("state"))) continue;
            items.add(o);
        }
        items.sort((a, b) -> Long.compare(a.optLong("at", 0), b.optLong("at", 0)));
        for (JSONObject o : items) {
            if (total <= quota) break;
            long sz = o.optLong("size", 0);
            String id = o.optString("id", "");
            if (id.isEmpty()) continue;
            if (delete(id)) {
                total -= sz;
                System.out.println("[cache] 配额淘汰 " + id + "（释放 " + sz + " 字节）");
            }
        }
    }

    /** 播放时刷新访问时间，让 LRU 知道这集还在用。 */
    public static void touch(String id) {
        try {
            JSONObject m = readMeta(id);
            if (m == null) return;
            m.put("at", System.currentTimeMillis());
            writeMeta(id, m);
        } catch (Exception ignored) {
        }
    }

    // ------------------------------------------------------------ 元信息

    private static Path metaOf(String id) {
        return dirOf(id).resolve("meta.json");
    }

    public static JSONObject readMeta(String id) {
        try {
            Path p = metaOf(id);
            if (!Files.isRegularFile(p)) return null;
            return new JSONObject(new String(Files.readAllBytes(p), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    private static void writeMeta(String id, JSONObject meta) {
        try {
            Path p = metaOf(id);
            Files.write(p, meta.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            System.out.println("[cache] meta 写入失败: " + e);
        }
    }

    /**
     * 把海报下载到这一集的缓存目录里。
     *
     * <p>为什么必须本地存一份：离线时远端海报地址（多半在源站的图床）
     * 根本连不上，"我的缓存"就会变成一排灰底占位图 —— 那正是这个页面
     * 在火车/飞机上最不该出现的样子。
     *
     * <p>失败不重试也不报错：海报缺失只影响观感，不该让整集缓存失败。
     * 扩展名按响应内容嗅探（有的源给 .webp 实际是 jpeg）。
     */
    private static void downloadPoster(Task t) {
        if (t.poster == null || t.poster.isEmpty()) return;
        try {
            byte[] b = fetchBytes(t.poster);
            if (b == null || b.length < 100) return;
            String ext = sniffImageExt(b);
            if (ext == null) return;
            String fname = "poster." + ext;
            Files.write(dirOf(t.id).resolve(fname), b);
            t.posterFile = fname;
            touchManifest(t);
        } catch (Throwable e) {
            System.out.println("[cache] 海报下载失败 " + t.id + ": " + e.getClass().getSimpleName());
        }
    }

    /** 按魔数判断图片扩展名；不是已知图片返回 null。 */
    private static String sniffImageExt(byte[] b) {
        if (b.length < 12) return null;
        // JPEG: FF D8 FF
        if ((b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8) return "jpg";
        // PNG: 89 50 4E 47
        if ((b[0] & 0xFF) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "png";
        // GIF: "GIF8"
        if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return "gif";
        // WEBP: "RIFF"...."WEBP"
        if (b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "webp";
        return null;
    }

    // ------------------------------------------------------------ 下载

    /**
     * 开始下载一集的 m3u8。
     *
     * <p>调用方给的是**已经过 SSRF 校验的源地址**（通常来自 /api/proxy/stream
     * 拿到的那条 play 地址）。这里不重复校验，但也不接受本地路径——
     * 缓存的是网络流，不是本地文件。
     */
    public static Task start(String site, String vodId, String ep, String name, String url) {
        return start(site, vodId, ep, name, url, "");
    }

    /**
     * 开始下载一集，并记到某个批次下（单集传空串）。
     *
     * <p>同一集重复点下载会复用同一个任务（id 由 site|vodId|ep 决定）：
     * 正在跑就直接返回进度，跑完就直接返回已完成的任务，失败过才原地重开。
     * "已完成就直接返回"是必要的：用户再点一次下载时，重下会把 state
     * 短暂翻回 running，正在看批次进度的界面会从 100% 跳回中间值，
     * 看起来像"已经下好的又坏了"。
     */
    public static Task start(String site, String vodId, String ep, String name, String url, String batchId) {
        return start(site, vodId, ep, name, url, batchId, null);
    }

    /**
     * 带展示元数据的启动（「我的缓存」按剧聚合要用）。
     *
     * <p>`meta` 里的键与 Task 的展示字段同名：poster / vodName / vodYear /
     * vodArea / vodRemarks。传 null 等价于旧行为（缓存能下但卡片没海报）。
     * 已经存在的任务会**补齐**这些字段：用户先缓存了第 1 集（旧版没有元数据），
     * 之后带元数据再缓存第 2 集时，第 1 集也应该能显示在海报卡片下。
     */
    public static Task start(String site, String vodId, String ep, String name, String url,
                             String batchId, JSONObject meta) {
        String id = idFor(site, vodId, ep);
        Task existing = TASKS.get(id);
        if (existing != null && "running".equals(existing.state)) {
            // 已有任务但这次是批量里的另一集：把批次号补上，否则整季进度里看不见它
            if (batchId != null && !batchId.isEmpty() && existing.batchId.isEmpty()) {
                existing.batchId = batchId;
                touchManifest(existing);
            }
            applyMeta(existing, meta);
            return existing;
        }
        if (existing != null && "done".equals(existing.state)
                && Files.isRegularFile(dirOf(id).resolve("playlist.m3u8"))) {
            if (batchId != null && !batchId.isEmpty() && existing.batchId.isEmpty()) {
                existing.batchId = batchId;
                touchManifest(existing);
            }
            applyMeta(existing, meta);
            return existing;
        }

        // 配额检查放在建任务之前：腾不出空间就不要开始，否则下到一半失败，
        // 用户看到"下载失败"却不知道是磁盘配额满了。
        enforceQuota();

        Task t = new Task();
        t.id = id;
        t.site = site;
        t.vodId = vodId;
        t.ep = ep;
        t.name = name;
        t.sourceUrl = url;
        t.batchId = batchId == null ? "" : batchId;
        t.state = "running";
        t.updatedAt = System.currentTimeMillis();
        applyMeta(t, meta);
        TASKS.put(id, t);
        saveManifest();

        Thread th = new Thread(() -> run(t), "cache-" + id);
        th.setDaemon(true);
        th.start();
        return t;
    }

    /**
     * 把前端带来的展示元数据写进任务（缺失的键保持原值，不覆盖成空）。
     *
     * <p>为什么"不覆盖成空"很重要：同一部剧的第 2 集可能从不同入口发起
     * （详情页 / 批量下载），有的入口拿不到海报。若照抄空值，
     * 第 1 集已经存好的海报会被抹掉，卡片突然变成占位图。
     */
    private static void applyMeta(Task t, JSONObject meta) {
        if (meta == null || t == null) return;
        String p = meta.optString("poster", "");
        if (!p.isEmpty()) t.poster = p;
        String vn = meta.optString("vodName", "");
        if (!vn.isEmpty()) t.vodName = vn;
        String y = meta.optString("vodYear", "");
        if (!y.isEmpty()) t.vodYear = y;
        String a = meta.optString("vodArea", "");
        if (!a.isEmpty()) t.vodArea = a;
        String r = meta.optString("vodRemarks", "");
        if (!r.isEmpty()) t.vodRemarks = r;
        touchManifest(t);
    }

    /**
     * 弹幕预取钩子：缓存一集时顺带把这一集的弹幕抓下来落盘。
     *
     * <p><b>为什么必须预取</b>：弹幕只在**播放时**被拉取（见 ApiServer 的
     * {@code fetchDanmakuAuto}），缓存的片子如果从没在线播放过，磁盘上就没有
     * 这份 XML。断网后进播放页 → 上游全连不上 → 弹幕空白，
     * 而「离线也能看完一集」这个目标里的"看完"包含弹幕。
     *
     * <p><b>为什么用回调而不是直接调 ApiServer</b>：core 包不依赖 ApiServer
     * （那会让 core 反向依赖入口类，TV 网关的减配版后端也会被拖进来）。
     * 装配点在 ApiServer.boot()，与 {@code CacheRoutes.bindPolicy} 同一套。
     *
     * @param vodName 纯剧名（不含"第N集"）
     * @param ep      集数文本（如 "第3集" / "3"），解成数字才能对上播放时的 key
     */
    public interface DanmakuPrefetcher {
        void prefetch(String vodName, String ep);
    }

    private static volatile DanmakuPrefetcher danmakuPrefetcher;

    public static void bindDanmakuPrefetcher(DanmakuPrefetcher p) {
        danmakuPrefetcher = p;
    }

    /**
     * 抓这一集的弹幕并落盘。失败不影响下载（弹幕没有也能看），
     * 但要在日志里说清楚，否则"离线没弹幕"会变成无从查起的问题。
     */
    private static void prefetchDanmaku(Task t) {
        DanmakuPrefetcher p = danmakuPrefetcher;
        if (p == null) return;
        String name = t.vodName == null ? "" : t.vodName.trim();
        if (name.isEmpty()) {
            // 老任务/直连入口可能没有 vodName，name 里通常带剧名
            name = stripEpSuffix(t.name == null ? "" : t.name);
        }
        if (name.isEmpty()) return;
        try {
            p.prefetch(name, t.ep == null ? "" : t.ep);
        } catch (Throwable ex) {
            System.out.println("[cache] 弹幕预取失败 " + t.id + ": " + ex);
        }
    }

    private static void run(Task t) {
        try {
            Path dir = dirOf(t.id);
            /*
             * 先抓海报再抓视频流。
             *
             * 顺序有意义：海报是几 KB、视频是几百 MB，万一这一集因为源站问题
             * 下不下来（实测 m3u8 常被防盗链拦），至少卡片上还有图有片名，
             * 用户能看出"我点过这部剧"而不是一片空白。
             */
            downloadPoster(t);
            String text = fetch(t.sourceUrl);
            if (text == null || !text.trim().startsWith("#EXTM3U")) {
                fail(t, "这不是 m3u8 清单（源可能返回了网页或空内容）");
                return;
            }

            // 主清单（有 EXT-X-STREAM-INF）先落到子清单：只取第一档，
            // 多档并存会让"缓存一集"变成缓存整部片的所有码率。
            String[] master = firstVariant(text);
            String playlist;
            String baseUrl;
            if (master != null) {
                String subUrl = resolve(t.sourceUrl, master[0]);
                baseUrl = baseUrlOf(subUrl);
                playlist = fetch(subUrl);
                if (playlist == null || !playlist.trim().startsWith("#EXTM3U")) {
                    fail(t, "子清单拉取失败");
                    return;
                }
            } else {
                baseUrl = baseUrlOf(t.sourceUrl);
                playlist = text;
            }

            // 收集要下载的资源：分片 + KEY + MAP。字幕（EXT-X-MEDIA）也一起，
            // 否则断网时字幕消失。
            List<String> lines = new ArrayList<>();
            for (String ln : playlist.split("\n")) lines.add(ln);

            Map<String, String> local = new LinkedHashMap<>(); // 绝对URL → 本地文件名
            int segIndex = 0;
            for (int i = 0; i < lines.size(); i++) {
                String ln = lines.get(i);
                String tr = ln.trim();
                if (tr.isEmpty()) continue;
                if (tr.startsWith("#")) {
                    // URI="..." 出现在 EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA
                    int a = tr.indexOf("URI=\"");
                    if (a >= 0) {
                        int b = tr.indexOf('"', a + 5);
                        if (b > a) {
                            String inner = tr.substring(a + 5, b);
                            String abs = resolve(baseUrl, inner);
                            if (!local.containsKey(abs)) {
                                local.put(abs, "res-" + (local.size()) + extOf(abs));
                            }
                        }
                    }
                    continue;
                }
                // 分片行
                String abs = resolve(baseUrl, tr);
                // BYTERANGE 的分片不能按整文件存：同一个 URL 会出现在多行，
                // 每行只是不同的字节区间。这里按行号区分文件名，各存整份
                // （浪费空间但不会播错——存字节区间需要额外解析 Range 语义）。
                String fname = String.format("seg-%05d.ts", segIndex++);
                local.put(abs + (hasByterange(lines, i) ? "#" + fname : ""), fname);
            }

            t.total = 0;
            for (String k : local.keySet()) if (!k.contains("#res-")) t.total++;
            t.total = local.size();

            // 并发下载
            List<Map.Entry<String, String>> entries = new ArrayList<>(local.entrySet());
            java.util.concurrent.ExecutorService pool =
                    java.util.concurrent.Executors.newFixedThreadPool(PARALLEL);
            java.util.concurrent.atomic.AtomicInteger ok = new java.util.concurrent.atomic.AtomicInteger();
            java.util.concurrent.atomic.AtomicLong bytes = new java.util.concurrent.atomic.AtomicLong();
            List<java.util.concurrent.Future<?>> fs = new ArrayList<>();
            try {
                for (Map.Entry<String, String> e : entries) {
                    fs.add(pool.submit(() -> {
                        if ("canceled".equals(t.state)) return null;
                        Path out = dir.resolve(e.getValue());
                        // 断点续传：已下好的分片直接跳过。判据是"存在且非空"，
                        // 不比对字节数——上游分片会随广告插入变化，比长度会永远续不上。
                        try {
                            if (Files.isRegularFile(out) && Files.size(out) > 0) {
                                bytes.addAndGet(Files.size(out));
                                int d0 = ok.incrementAndGet();
                                t.done = d0;
                                t.percent = t.total == 0 ? 0 : (int) (d0 * 100L / t.total);
                                t.bytes = bytes.get();
                                return null;
                            }
                        } catch (Exception ignored) {
                        }
                        String abs = e.getKey();
                        int hash = abs.indexOf('#');
                        String real = hash >= 0 ? abs.substring(0, hash) : abs;
                        byte[] data = fetchBytes(real);
                        if (data == null) return null;
                        // 先写 .part 再原子改名。直接写目标文件时进程被 kill
                        // 会留下"非空但截断"的分片，而续传的判据正是"非空"——
                        // 那一片会被当成下好的一直留着，表现为"播到某集必卡"。
                        Path part = out.resolveSibling(out.getFileName() + ".part");
                        try {
                            Files.write(part, data);
                            Files.move(part, out, StandardCopyOption.REPLACE_EXISTING);
                            bytes.addAndGet(data.length);
                        } catch (Exception ex) {
                            try {
                                Files.deleteIfExists(part);
                            } catch (Exception ignored) {
                            }
                            return null;
                        }
                        int d = ok.incrementAndGet();
                        t.done = d;
                        t.percent = t.total == 0 ? 0 : (int) (d * 100L / t.total);
                        t.bytes = bytes.get();
                        // 每片都写清单会把磁盘打满，touchManifest 内部按 2 秒节流
                        touchManifest(t);
                        return null;
                    }));
                }
                for (java.util.concurrent.Future<?> f : fs) {
                    try {
                        f.get();
                    } catch (Exception ignored) {
                    }
                }
            } finally {
                pool.shutdownNow();
            }

            if ("canceled".equals(t.state)) return;

            // 写本地清单：**所有引用改成同目录文件名**。
            // 这是与在线改写最关键的区别：在线必须是绝对地址（否则播放器
            // 按源站域名解析相对路径 → 404，实测踩过），离线必须相反，
            // 因为断网时没有任何服务端可拼前缀。
            StringBuilder out = new StringBuilder();
            segIndex = 0;
            for (int i = 0; i < lines.size(); i++) {
                String ln = lines.get(i);
                String tr = ln.trim();
                if (tr.isEmpty()) continue;
                if (tr.startsWith("#EXTM3U")) {
                    out.append("#EXTM3U").append('\n');
                    continue;
                }
                if (tr.startsWith("#")) {
                    int a = tr.indexOf("URI=\"");
                    if (a >= 0) {
                        int b = tr.indexOf('"', a + 5);
                        if (b > a) {
                            String inner = tr.substring(a + 5, b);
                            String abs = resolve(baseUrl, inner);
                            String fname = local.get(abs);
                            if (fname != null) {
                                out.append(tr, 0, a + 5).append(fname).append(tr.substring(b)).append('\n');
                                continue;
                            }
                        }
                    }
                    out.append(tr).append('\n');
                    continue;
                }
                String abs = resolve(baseUrl, tr);
                String byterangeName = String.format("seg-%05d.ts", segIndex);
                String fname = local.get(abs + "#" + byterangeName);
                if (fname == null) fname = local.get(abs);
                if (fname != null) {
                    out.append(fname).append('\n');
                    segIndex++;
                } else {
                    // 没下到的分片保留原地址：断网时这一段会失败，但整集不会全废
                    out.append(tr).append('\n');
                }
            }
            // VOD 清单补 ENDLIST：缺它部分播放器会当成直播一直等
            if (!out.toString().contains("#EXT-X-ENDLIST")) {
                out.append("#EXT-X-ENDLIST").append('\n');
            }
            Files.write(dir.resolve("playlist.m3u8"), out.toString().getBytes(StandardCharsets.UTF_8));

            JSONObject meta = new JSONObject();
            meta.put("id", t.id);
            meta.put("site", t.site);
            meta.put("vodId", t.vodId);
            meta.put("ep", t.ep);
            meta.put("name", t.name);
            meta.put("sourceUrl", t.sourceUrl);
            meta.put("bytes", t.bytes);
            meta.put("segments", t.total);
            meta.put("createdAt", t.createdAt);
            // at = 最近一次访问（播放/下载完成）。配额淘汰按它排序，
            // 与 createdAt 分开：老片重看时 createdAt 不变，at 会刷新。
            meta.put("at", System.currentTimeMillis());
            meta.put("percent", t.percent);
            /*
             * 展示元数据一起落盘：离线打开缓存页时，源站和列表接口都够不着，
             * 海报地址/剧名/年份只能从这里读（见 Task 里新增字段的注释）。
             */
            meta.put("poster", t.poster);
            meta.put("posterFile", t.posterFile);
            meta.put("vodName", t.vodName);
            meta.put("vodYear", t.vodYear);
            meta.put("vodArea", t.vodArea);
            meta.put("vodRemarks", t.vodRemarks);
            writeMeta(t.id, meta);

            if (t.done == 0) {
                fail(t, "一个分片都没下到");
                return;
            }
            /*
             * 分片齐了再抓弹幕：弹幕请求要打平台接口（iqiyi/tencent/聚合站），
             * 放在最前面会和分片抢带宽，也可能在 m3u8 都拉不到时白花时间。
             * 这里失败不算缓存失败——没有弹幕的集照样能播。
             */
            prefetchDanmaku(t);
            t.state = "done";
            t.percent = 100;
            t.resumable = false;
            t.updatedAt = System.currentTimeMillis();
            saveManifest();
        } catch (Throwable ex) {
            fail(t, ex.getClass().getSimpleName() + ": " + ex.getMessage());
        }
    }

    private static boolean hasByterange(List<String> lines, int idx) {
        // 分片行前一行的 EXT-X-BYTERANGE 说明这一行只取一段字节
        for (int i = idx - 1; i >= 0 && i >= idx - 2; i--) {
            if (lines.get(i).trim().startsWith("#EXT-X-BYTERANGE")) return true;
        }
        return false;
    }

    private static void fail(Task t, String msg) {
        t.state = "failed";
        t.error = msg == null ? "" : msg;
        t.updatedAt = System.currentTimeMillis();
        // 只要目录里已经落过分片，这一集就值得续传：整集重下等于把
        // 已经拿到的几十 MB 再要一遍，源站和用户都不划算。
        t.resumable = hasAnySegment(t.id);
        saveManifest();
        System.out.println("[cache] " + t.id + " 失败: " + t.error);
    }

    /** 缓存目录里有没有任何分片文件（判断能不能续传的最小证据）。 */
    private static boolean hasAnySegment(String id) {
        try {
            Path d = dirOf(id);
            if (!Files.isDirectory(d)) return false;
            return Files.list(d).anyMatch(p -> {
                String n = p.getFileName().toString();
                return n.startsWith("seg-") || n.startsWith("res-");
            });
        } catch (Exception e) {
            return false;
        }
    }

    /** 主清单只取第一档：多码率并存会让"缓存一集"变成缓存整部片。 */
    private static String[] firstVariant(String text) {
        String[] lines = text.split("\n");
        for (int i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith("#EXT-X-STREAM-INF")) {
                for (int j = i + 1; j < lines.length; j++) {
                    String t = lines[j].trim();
                    if (!t.isEmpty() && !t.startsWith("#")) return new String[]{t};
                }
            }
        }
        return null;
    }

    private static String extOf(String url) {
        String path = url;
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        int dot = path.lastIndexOf('.');
        if (dot < 0) return ".bin";
        String e = path.substring(dot);
        return e.length() > 6 ? ".bin" : e;
    }

    private static String baseUrlOf(String url) {
        int q = url.indexOf('?');
        String s = q >= 0 ? url.substring(0, q) : url;
        int slash = s.lastIndexOf('/');
        return slash > 8 ? s.substring(0, slash + 1) : s;
    }

    /** 相对地址解析。带 query 的相对路径保留 query（签名分片常见）。 */
    private static String resolve(String base, String uri) {
        if (uri == null || uri.isEmpty()) return base;
        if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
        try {
            return URI.create(base).resolve(uri).toString();
        } catch (Exception e) {
            return base + uri;
        }
    }

    private static String fetch(String url) {
        byte[] b = fetchBytes(url);
        return b == null ? null : new String(b, StandardCharsets.UTF_8);
    }

    private static byte[] fetchBytes(String url) {
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) java.net.URI.create(url).toURL().openConnection();
            c.setConnectTimeout(10_000);
            c.setReadTimeout(30_000);
            c.setRequestProperty("User-Agent", "Mozilla/5.0");
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) {
                c.disconnect();
                return null;
            }
            try (InputStream in = c.getInputStream()) {
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
                return bos.toByteArray();
            } finally {
                c.disconnect();
            }
        } catch (Exception e) {
            return null;
        }
    }

    // ------------------------------------------------------------ 批次与任务清单

    /**
     * 一个整季批次。
     *
     * <p>只存 id 列表不存 Task 引用：任务会在重试/重启时被换掉实例，
     * 持有旧引用会让批次进度停在上一次的百分比。
     */
    public static final class Batch {
        public String id = "";
        public String site = "";
        public String vodId = "";
        public long createdAt = System.currentTimeMillis();
        public final List<String> ids = new ArrayList<>();
    }

    private static final Map<String, Batch> BATCHES = new ConcurrentHashMap<>();

    /**
     * 批次调度池：全局固定 2 线程，**跨批次共享**。
     *
     * <p>共享而不是每批一个：用户连点两季下载时，两个池各 2 路就是 4 集并发，
     * 每集再 4 路分片 → 16 条连接打同一个源站，这是实测最容易触发限流的形状。
     */
    private static final java.util.concurrent.ExecutorService BATCH_POOL =
            java.util.concurrent.Executors.newFixedThreadPool(BATCH_PARALLEL, r -> {
                Thread t = new Thread(r, "cache-batch");
                t.setDaemon(true);
                return t;
            });

    /** 单批集数上限。整季一两百集正常，上千集只可能是脚本误用。 */
    private static final int BATCH_MAX_ITEMS = 500;

    /**
     * 任务清单文件：{@code data/cache/tasks.json}。
     *
     * <p>刻意**不**放在 cacheRoot 下：cacheRoot 可以被 policy 的 cacheDir 指到
     * 别的盘，而清单是"后端知道有哪些任务"的索引，换了盘还得能找到它。
     * 放数据目录下，与缓存内容解耦。
     */
    private static Path manifestPath() {
        return DataPaths.of("cache").resolve("tasks.json");
    }

    /**
     * 任务清单落盘。
     *
     * <p>每次状态变化都写一次：清单只有几十条，一次写入不到 1KB，
     * 而丢掉它的代价是"重启后所有未完成任务凭空消失"。
     * 下载分片的进度更新（每片一次）**不**落盘，见 {@link #touchManifest}。
     */
    private static synchronized void saveManifest() {
        try {
            JSONArray tasks = new JSONArray();
            for (Map.Entry<String, Task> e : TASKS.entrySet()) {
                Task t = e.getValue();
                JSONObject o = new JSONObject();
                o.put("id", t.id);
                o.put("site", t.site);
                o.put("vodId", t.vodId);
                o.put("ep", t.ep);
                o.put("name", t.name);
                o.put("sourceUrl", t.sourceUrl);
                o.put("state", t.state);
                o.put("percent", t.percent);
                o.put("done", t.done);
                o.put("total", t.total);
                o.put("bytes", t.bytes);
                o.put("error", t.error);
                o.put("batchId", t.batchId);
                o.put("createdAt", t.createdAt);
                o.put("updatedAt", t.updatedAt);
                o.put("resumable", t.resumable);
                // 展示元数据（离线缓存页要用，见 Task 字段注释）
                o.put("poster", t.poster);
                o.put("posterFile", t.posterFile);
                o.put("vodName", t.vodName);
                o.put("vodYear", t.vodYear);
                o.put("vodArea", t.vodArea);
                o.put("vodRemarks", t.vodRemarks);
                tasks.put(o);
            }
            JSONArray batches = new JSONArray();
            for (Batch b : BATCHES.values()) {
                JSONObject o = new JSONObject();
                o.put("id", b.id);
                o.put("site", b.site);
                o.put("vodId", b.vodId);
                o.put("createdAt", b.createdAt);
                o.put("ids", new JSONArray(b.ids));
                batches.put(o);
            }
            JSONObject root = new JSONObject();
            root.put("tasks", tasks);
            root.put("batches", batches);
            Path p = manifestPath();
            Files.createDirectories(p.getParent());
            Path tmp = p.resolveSibling("tasks.json.tmp");
            Files.write(tmp, root.toString().getBytes(StandardCharsets.UTF_8));
            // 先写临时文件再 rename：进程被 kill 时不会留下半截 JSON，
            // 否则下次启动 loadManifest 解析失败、全部任务丢失。
            Files.move(tmp, p, StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception e) {
            System.out.println("[cache] 任务清单写入失败: " + e);
        }
    }

    /** 节流用的上次落盘时间。 */
    private static volatile long lastTouchSave;

    /**
     * 进度变化时的轻量落盘。
     *
     * <p>每下完一个分片都写清单会把磁盘打满（一集几十上百片），
     * 这里最多 2 秒写一次——重启丢的也只是最近两秒的进度，
     * 而分片文件本身在磁盘上，续传时会被重新数出来。
     */
    private static void touchManifest(Task t) {
        t.updatedAt = System.currentTimeMillis();
        long now = System.currentTimeMillis();
        if (now - lastTouchSave < 2_000L) return;
        lastTouchSave = now;
        saveManifest();
    }

    /**
     * 启动时读回任务清单。
     *
     * <p>上次退出时还在 {@code running} 的任务一律改判为 {@code failed} +
     * {@code resumable=true}：进程已经没了，说它还在下载是撒谎；
     * 而目录里的分片还在，所以它可以被 {@link #resume} 接着下。
     * 这里刻意不新增 {@code interrupted} 状态——前端的状态联合里没有它，
     * 多一个值会让"下载中"的筛选逻辑静默漏掉这些任务。
     */
    public static synchronized void loadManifest() {
        try {
            Path p = manifestPath();
            if (!Files.isRegularFile(p)) return;
            JSONObject root = new JSONObject(new String(Files.readAllBytes(p), StandardCharsets.UTF_8));
            JSONArray batches = root.optJSONArray("batches");
            if (batches != null) {
                for (int i = 0; i < batches.length(); i++) {
                    JSONObject o = batches.optJSONObject(i);
                    if (o == null) continue;
                    Batch b = new Batch();
                    b.id = o.optString("id", "");
                    if (b.id.isEmpty()) continue;
                    b.site = o.optString("site", "");
                    b.vodId = o.optString("vodId", "");
                    b.createdAt = o.optLong("createdAt", 0);
                    JSONArray ids = o.optJSONArray("ids");
                    if (ids != null) {
                        for (int j = 0; j < ids.length(); j++) b.ids.add(ids.optString(j, ""));
                    }
                    BATCHES.put(b.id, b);
                }
            }
            JSONArray tasks = root.optJSONArray("tasks");
            if (tasks != null) {
                for (int i = 0; i < tasks.length(); i++) {
                    JSONObject o = tasks.optJSONObject(i);
                    if (o == null) continue;
                    Task t = new Task();
                    t.id = o.optString("id", "");
                    if (t.id.isEmpty()) continue;
                    t.site = o.optString("site", "");
                    t.vodId = o.optString("vodId", "");
                    t.ep = o.optString("ep", "");
                    t.name = o.optString("name", "");
                    t.sourceUrl = o.optString("sourceUrl", "");
                    t.state = o.optString("state", "idle");
                    t.percent = o.optInt("percent", 0);
                    t.done = o.optInt("done", 0);
                    t.total = o.optInt("total", 0);
                    t.bytes = o.optLong("bytes", 0);
                    t.error = o.optString("error", "");
                    t.batchId = o.optString("batchId", "");
                    t.createdAt = o.optLong("createdAt", 0);
                    t.updatedAt = o.optLong("updatedAt", 0);
                    t.resumable = o.optBoolean("resumable", false);
                    t.poster = o.optString("poster", "");
                    t.posterFile = o.optString("posterFile", "");
                    t.vodName = o.optString("vodName", "");
                    t.vodYear = o.optString("vodYear", "");
                    t.vodArea = o.optString("vodArea", "");
                    t.vodRemarks = o.optString("vodRemarks", "");
                    if ("running".equals(t.state) || "idle".equals(t.state)) {
                        // 进程重启打断的；有分片或至少有源地址就能续
                        t.state = "failed";
                        t.error = t.error.isEmpty() ? "backend restarted" : t.error;
                        t.resumable = !t.sourceUrl.isEmpty();
                    }
                    TASKS.put(t.id, t);
                }
            }
            pruneOldEntries();
            System.out.println("[cache] 任务清单已恢复: " + TASKS.size() + " 条, "
                    + BATCHES.size() + " 个批次");
        } catch (Exception e) {
            System.out.println("[cache] 任务清单读取失败: " + e);
        }
    }

    /**
     * 已完成且很久没被碰过的任务从清单里剔掉。
     *
     * <p>不清 {@code failed} 的：失败任务可能还要续传，删了用户就找不到它了。
     * 也不删磁盘上的分片——那是 {@link #delete} 与配额淘汰的事，
     * 清单只负责"后端认识哪些任务"，不该顺手删用户的片子。
     */
    private static void pruneOldEntries() {
        final long keepMs = 7L * 24 * 3600 * 1000;
        long now = System.currentTimeMillis();
        List<String> drop = new ArrayList<>();
        for (Map.Entry<String, Task> e : TASKS.entrySet()) {
            Task t = e.getValue();
            if (!"done".equals(t.state)) continue;
            if (now - t.updatedAt < keepMs) continue;
            drop.add(e.getKey());
        }
        for (String id : drop) TASKS.remove(id);
        // 批次记录只留最近 7 天，否则每下一次整季就多一条永久垃圾
        List<String> dropBatches = new ArrayList<>();
        for (Map.Entry<String, Batch> e : BATCHES.entrySet()) {
            if (now - e.getValue().createdAt >= keepMs) dropBatches.add(e.getKey());
        }
        for (String id : dropBatches) BATCHES.remove(id);
        if (!drop.isEmpty() || !dropBatches.isEmpty()) {
            System.out.println("[cache] 清单剪枝: " + drop.size() + " 任务, "
                    + dropBatches.size() + " 批次");
        }
    }

    /**
     * 起一个整季批次。
     *
     * <p>返回的 {@code ids} 是**全部**集的 id（含还没轮到的），
     * 没轮到的任务在 TASKS 里是 {@code idle} 状态——这样前端一拿到批次号
     * 就能渲染完整的集列表，而不是眼睁睁看着条目一个个冒出来。
     */
    public static Batch startBatch(String site, String vodId, List<JSONObject> items) {
        Batch b = new Batch();
        b.id = "b" + Long.toString(System.currentTimeMillis(), 36)
                + Integer.toString((int) (Math.random() * 1296), 36);
        b.site = site;
        b.vodId = vodId;

        List<JSONObject> accepted = new ArrayList<>();
        for (JSONObject it : items) {
            if (accepted.size() >= BATCH_MAX_ITEMS) break;
            String ep = it.optString("ep", "");
            String url = it.optString("url", "");
            if (url.isEmpty()) continue;
            String id = idFor(site, vodId, ep);
            b.ids.add(id);
            // 已经下完的集不再入队：用户在离线页再点一次"下载整季"时，
            // 期望的是"补齐缺的"，而不是把已经能播的集重下一遍
            // （重下还会把 state 短暂翻回 running，批次进度从 100% 跳回中间值）。
            Task prev = TASKS.get(id);
            boolean alreadyDone = prev != null && "done".equals(prev.state);
            boolean alreadyRunning = prev != null && "running".equals(prev.state);
            if (!alreadyDone && !alreadyRunning) {
                accepted.add(it);
                // 占位任务：让批次进度在第一个分片下载前就能显示"排队中"
                Task t = new Task();
                t.id = id;
                t.site = site;
                t.vodId = vodId;
                t.ep = ep;
                t.name = it.optString("name", "");
                t.sourceUrl = url;
                t.batchId = b.id;
                t.state = "idle";
                // 已经有任务（失败过的）就复用实例，见 start() 的注释
                if (prev == null) TASKS.put(id, t);
            } else if (prev != null && prev.batchId.isEmpty()) {
                // 别处（单集下载）下完的，挂到本批次下，进度里也能看到它
                prev.batchId = b.id;
            }
        }
        BATCHES.put(b.id, b);
        saveManifest();

        for (JSONObject it : accepted) {
            String ep = it.optString("ep", "");
            String name = it.optString("name", "");
            String url = it.optString("url", "");
            BATCH_POOL.submit(() -> {
                try {
                    Task t = start(site, vodId, ep, name, url, b.id);
                    awaitTask(t);
                } catch (Throwable th) {
                    System.out.println("[cache] 批次 " + b.id + " 的 " + ep + " 起不来: " + th);
                }
            });
        }
        return b;
    }

    /** 等一个任务离开 running/idle。轮询而不是 join：任务线程没有暴露句柄契约。 */
    private static void awaitTask(Task t) {
        while (true) {
            String s = t.state;
            if ("done".equals(s) || "failed".equals(s) || "canceled".equals(s)) return;
            try {
                Thread.sleep(500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    public static Batch batch(String id) {
        return BATCHES.get(id);
    }

    /**
     * 批次聚合进度。
     *
     * <p>{@code state} 取值：{@code running}（还有没跑完的）/ {@code done}
     * （全部成功）/ {@code partial}（有失败但也有成功的）/ {@code failed}
     * （全失败）。{@code partial} 是这一层能提供的最有用信息——
     * 整季里挂两三集是常态，直接报 failed 会让用户以为整批白下。
     */
    public static JSONObject batchStatus(String batchId) {
        Batch b = BATCHES.get(batchId);
        if (b == null) return null;
        JSONArray items = new JSONArray();
        int doneCount = 0;
        int failCount = 0;
        int runningCount = 0;
        int percentSum = 0;
        long bytes = 0;
        for (String id : b.ids) {
            Task t = TASKS.get(id);
            JSONObject o = new JSONObject();
            String state = t == null ? "idle" : t.state;
            try {
                o.put("id", id);
                o.put("ep", t == null ? "" : t.ep);
                o.put("name", t == null ? "" : t.name);
                o.put("state", state);
                o.put("percent", t == null ? 0 : t.percent);
                o.put("done", t == null ? 0 : t.done);
                o.put("total", t == null ? 0 : t.total);
                o.put("bytes", t == null ? 0 : t.bytes);
                o.put("error", t == null ? "" : t.error);
                o.put("resumable", t != null && t.resumable);
            } catch (Exception ignored) {
            }
            items.put(o);
            if ("done".equals(state)) doneCount++;
            else if ("failed".equals(state) || "canceled".equals(state)) failCount++;
            else runningCount++;
            if (t != null) {
                percentSum += t.percent;
                bytes += t.bytes;
            }
        }
        int n = b.ids.size();
        String state;
        if (runningCount > 0) state = "running";
        else if (failCount == 0) state = "done";
        else if (doneCount == 0) state = "failed";
        else state = "partial";
        JSONObject out = new JSONObject();
        try {
            out.put("ok", true);
            out.put("batch", b.id);
            out.put("site", b.site);
            out.put("vodId", b.vodId);
            out.put("state", state);
            out.put("total", n);
            out.put("done", doneCount);
            out.put("failed", failCount);
            out.put("pending", runningCount);
            out.put("percent", n == 0 ? 0 : percentSum / n);
            out.put("bytes", bytes);
            out.put("items", items);
        } catch (Exception ignored) {
        }
        return out;
    }

    /** 所有批次（设置页/离线页做分组展示用）。 */
    public static JSONArray batches() {
        JSONArray out = new JSONArray();
        for (Batch b : BATCHES.values()) {
            JSONObject s = batchStatus(b.id);
            if (s != null) out.put(s);
        }
        return out;
    }

    /**
     * 未完成的任务（重启后仍可续）。
     *
     * <p>含 {@code failed} 且 {@code resumable} 的，含还在 {@code running} 的，
     * 也含排队中（{@code idle}）的——这三类都是"用户点了下载但还没拿到片子"。
     */
    public static JSONArray unfinished() {
        JSONArray out = new JSONArray();
        List<Task> all = new ArrayList<>(TASKS.values());
        all.sort((a, b) -> Long.compare(b.updatedAt, a.updatedAt));
        for (Task t : all) {
            boolean unfinishedState = "running".equals(t.state)
                    || "idle".equals(t.state)
                    || ("failed".equals(t.state) && t.resumable);
            if (!unfinishedState) continue;
            JSONObject o = new JSONObject();
            try {
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
                o.put("batchId", t.batchId);
                o.put("resumable", t.resumable);
                o.put("hasSegments", hasAnySegment(t.id));
                o.put("updatedAt", t.updatedAt);
            } catch (Exception ignored) {
            }
            out.put(o);
        }
        return out;
    }

    /**
     * 续传一个任务。
     *
     * <p>不需要单独维护"已下到第几片"的游标：{@link #run} 里每个分片下载前
     * 都会检查目标文件是否已存在且非空（见分片循环里的跳过分支），
     * 存在的直接计入完成数、不存在的才发请求。所以"从第一个缺失分片继续"
     * 是天然成立的——并发写同一文件也不会冲突，因为文件名叫
     * {@code seg-00042.ts}，由清单里的行号决定，同一个分片只会由一个线程写。
     *
     * @return 任务；id 不存在 / 没有源地址时返回 null
     */
    public static Task resume(String id) {
        Task t = TASKS.get(id);
        if (t == null) return null;
        // 已经下完的不要再跑一遍：分片跳过逻辑会让它"成功得很快"，
        // 但清单/meta 会被重写一遍、还会白打一次源站。
        if ("done".equals(t.state)) return t;
        if ("running".equals(t.state)) return t;
        if (t.sourceUrl == null || t.sourceUrl.isEmpty()) return null;
        return start(t.site, t.vodId, t.ep, t.name, t.sourceUrl, t.batchId);
    }

    // ------------------------------------------------------------ 查询与管理

    /** 全部缓存条目（设置页「离线缓存」列表用）。 */
    public static JSONArray list() {
        JSONArray out = new JSONArray();
        try {
            Path root = cacheRoot();
            if (!Files.isDirectory(root)) return out;
            List<Path> dirs = new ArrayList<>();
            Files.list(root).filter(Files::isDirectory).forEach(dirs::add);
            for (Path d : dirs) {
                String id = d.getFileName().toString();
                JSONObject meta = readMeta(id);
                if (meta != null) {
                    // 实时算占用，不信 meta 里的（下载中断时那个数不准）
                    meta.put("size", dirSize(d));
                    out.put(meta);
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    public static long dirSize(Path p) {
        long[] n = new long[]{0};
        try {
            Files.walk(p).filter(Files::isRegularFile).forEach(f -> {
                try {
                    n[0] += Files.size(f);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
        return n[0];
    }

    // ---------------------------------------------------------------- 弹幕缓存

    /** 弹幕缓存目录（与视频缓存同级，但不进 cacheRoot：cacheRoot 可能被指到外接盘）。 */
    public static Path danmakuRoot() {
        return DataPaths.dir("cache/danmaku");
    }

    /** 弹幕缓存占用字节。设置页「存储」用它，与视频缓存并列显示。 */
    public static long danmakuBytes() {
        return dirSize(danmakuRoot());
    }

    /** 弹幕缓存文件数。 */
    public static int danmakuCount() {
        try {
            Path root = danmakuRoot();
            if (!Files.isDirectory(root)) return 0;
            int[] n = new int[]{0};
            Files.list(root).filter(Files::isRegularFile).forEach(p -> n[0]++);
            return n[0];
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * 清弹幕缓存。
     *
     * <p><b>为什么需要这个方法</b>：弹幕缓存原来只有"读过期不命中"，
     * 文件本身永不删除——一个 22MB 的目录在 OECT 上实测就是这么攒起来的
     * （23 个文件，最早的是 10 月 24 日）。用户看不到、也清不掉。
     *
     * @param onlyExpired true 时只删超过 TTL 的；false 全清
     * @return 删掉的文件数
     */
    public static int clearDanmaku(boolean onlyExpired) {
        int n = 0;
        try {
            Path root = danmakuRoot();
            if (!Files.isDirectory(root)) return 0;
            long now = System.currentTimeMillis();
            List<Path> files = new ArrayList<>();
            Files.list(root).filter(Files::isRegularFile).forEach(files::add);
            for (Path f : files) {
                try {
                    if (onlyExpired && now - Files.getLastModifiedTime(f).toMillis() < DANMAKU_TTL_MS) {
                        continue;
                    }
                    Files.deleteIfExists(f);
                    n++;
                } catch (Exception ignored) {
                }
            }
        } catch (Exception ignored) {
        }
        return n;
    }

    /** 弹幕缓存保留期：与 ApiServer 的 DANMAKU_DISK_TTL_MS 保持一致（30 天）。 */
    public static final long DANMAKU_TTL_MS = 30L * 24 * 3600 * 1000;

    /*
     * ────────────────────────────────────────────────────────────────
     * 弹幕缓存配额与淘汰（2026-11-02，照搬视频缓存那套）
     * ────────────────────────────────────────────────────────────────
     *
     * 之前只有手动清理（设置页两个按钮）+ 30 天 TTL，而 TTL 只在**读**的时候
     * 判断、文件本身永不删除 —— 一季 30 集约 42MB（每集完整 XML ~1.4MB），
     * 重度用户一个月能攒几百 MB，且没有任何上限。
     *
     * 视频缓存那边已有「配额 + LRU + 保护正在用」的成熟实现（见 enforceQuota），
     * 这里照搬同一套语义，只是判据换成文件的 lastModified：
     * 弹幕缓存是"一个 key 一个 .xml"，没有 meta.json 可以记 at。
     */

    private static final String POLICY_KEY_DM_QUOTA = "danmakuCacheQuotaMb";
    private static final String POLICY_KEY_DM_MODE = "danmakuCacheEvictMode";
    /** 默认 200MB：约 140 集完整弹幕。够看几部剧，又不至于吃掉盒子的存储。 */
    private static final long DEFAULT_DM_QUOTA_MB = 200;

    /** 弹幕缓存配额（字节）。<=0 表示不限制。 */
    public static long danmakuQuotaBytes() {
        long mb = policy().optLong(POLICY_KEY_DM_QUOTA, DEFAULT_DM_QUOTA_MB);
        return mb <= 0 ? 0 : mb * 1024L * 1024L;
    }

    /** 弹幕淘汰模式：lru（默认）或 off（只告警不删）。与视频缓存同一个取值语义。 */
    public static String danmakuEvictMode() {
        return "off".equalsIgnoreCase(policy().optString(POLICY_KEY_DM_MODE, "lru")) ? "off" : "lru";
    }

    /**
     * 当前正在播放的弹幕 key —— **淘汰时必须跳过它**。
     *
     * <p><b>为什么必须有</b>：用户拖进度条 / 短暂卡顿时，后端会重新读这一集的
     * 弹幕。如果 LRU 恰好把它删了，表现就是"看到一半弹幕突然全没了"，
     * 而且要重新联网抓（断网时直接空）。视频缓存那边靠"正在下载的任务不删"
     * 规避同类问题，这里用"正在播的 key 不删"。
     *
     * <p>由 {@code ApiServer} 在每次读/写弹幕缓存时设置；只保留最近一次，
     * 单用户场景够用（多个客户端同时看不同剧时，后设置的那个受保护）。
     */
    private static volatile String danmakuActiveKey = "";

    /** 标记当前正在使用的弹幕缓存 key（由 ApiServer 调用）。 */
    public static void touchDanmaku(String key) {
        if (key != null && !key.isEmpty()) danmakuActiveKey = key;
    }

    /** 供诊断/测试读取当前受保护的 key。 */
    public static String danmakuActiveKey() {
        return danmakuActiveKey;
    }

    /**
     * 超配额时按 lastModified 最旧淘汰。
     *
     * <p>判据用 lastModified 而不是文件名/创建时间：每次命中缓存都会
     * {@link #touchDanmakuFile} 刷新它，所以"最久没动过"就是 LRU 语义
     * ——与视频缓存 `at` 字段同一个思路。
     *
     * <p><b>永不动 {@link #danmakuActiveKey} 对应的那个文件</b>，
     * 即使它是全目录最旧的（用户刚拖到片尾重看、或从历史页点进一集老剧，
     * 文件时间很旧但此刻正在用）。
     */
    public static synchronized void enforceDanmakuQuota() {
        enforceDanmakuQuotaLocked(null);
    }

    /**
     * 同 {@link #enforceDanmakuQuota()}，但额外保护一个 key。
     *
     * <p><b>为什么需要</b>：{@code danmakuDiskPut} 写完立刻查配额，那一份此刻刚落地、
     * 理应排最新——但如果配额小到装不下它自己（用户设成 0.5MB 而一集 1.4MB），
     * 淘汰循环会把唯一的文件也删掉，于是"刚抓完就没了"。
     *
     * <p>★ 这里<b>不能</b>复用 {@link #touchDanmaku}：设置 activeKey 等于宣称
     * "这一集正在播"。而下集预取恰恰是<b>别的</b>集——那样会顶掉真正在播那集的保护，
     * 淘汰起来正好删掉用户正在看的弹幕（实测踩过：预取 ep12 把 ep11 的保护顶掉）。
     */
    public static void enforceDanmakuQuota(String extraProtectKey) {
        synchronized (VideoCache.class) {
            enforceDanmakuQuotaLocked(extraProtectKey);
        }
    }

    private static void enforceDanmakuQuotaLocked(String extraProtectKey) {
        long quota = danmakuQuotaBytes();
        if (quota <= 0) return;
        Path root = danmakuRoot();
        if (!Files.isDirectory(root)) return;

        List<Path> files = new ArrayList<>();
        try {
            Files.list(root).filter(Files::isRegularFile).forEach(files::add);
        } catch (Exception e) {
            return;
        }
        long total = 0;
        for (Path f : files) {
            try {
                total += Files.size(f);
            } catch (Exception ignored) {
            }
        }
        if (total <= quota) return;
        if ("off".equals(danmakuEvictMode())) {
            System.out.println("[cache] 弹幕超配额 " + total + " > " + quota
                    + "，danmakuCacheEvictMode=off 不删除");
            return;
        }

        // 最久没动过的排前面
        files.sort((a, b) -> {
            try {
                return Long.compare(Files.getLastModifiedTime(a).toMillis(),
                        Files.getLastModifiedTime(b).toMillis());
            } catch (Exception e) {
                return 0;
            }
        });

        String protect = md5Of(danmakuActiveKey) + ".xml";
        String protect2 = (extraProtectKey == null || extraProtectKey.isEmpty())
                ? ".xml" : md5Of(extraProtectKey) + ".xml";
        int n = 0;
        for (Path f : files) {
            if (total <= quota) break;
            // 正在播的那集 / 刚写完的那集：文件名就是 md5(key) + ".xml"
            String fn = f.getFileName().toString();
            if (!protect.equals(".xml") && fn.equals(protect)) continue;
            if (!protect2.equals(".xml") && fn.equals(protect2)) continue;
            long sz;
            try {
                sz = Files.size(f);
            } catch (Exception e) {
                continue;
            }
            try {
                if (Files.deleteIfExists(f)) {
                    total -= sz;
                    n++;
                }
            } catch (Exception ignored) {
            }
        }
        if (n > 0) {
            System.out.println("[cache] 弹幕配额淘汰 " + n + " 个文件，剩 " + total + " 字节");
        }
    }

    /**
     * 刷新某个弹幕缓存文件的访问时间（LRU 的"最近用过"信号）。
     *
     * <p>命中缓存时调用。失败无所谓（有些文件系统不支持改时间戳），
     * 只是那一集的淘汰优先级会偏旧。
     */
    public static void touchDanmakuFile(Path f) {
        try {
            if (f != null && Files.isRegularFile(f)) {
                Files.setLastModifiedTime(f, java.nio.file.attribute.FileTime.fromMillis(
                        System.currentTimeMillis()));
            }
        } catch (Exception ignored) {
        }
    }

    /** 与 ApiServer 的 md5Hex 同一算法（缓存文件名就是它生成的）。 */
    private static String md5Of(String s) {
        if (s == null || s.isEmpty()) return "";
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
            byte[] d = md.digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 缓存是否可用（清单与 meta 都在）。 */
    public static boolean has(String id) {
        return Files.isRegularFile(dirOf(id).resolve("playlist.m3u8")) && readMeta(id) != null;
    }

    /**
     * 按「剧」聚合的缓存列表 —— 「我的缓存」一剧一卡片的直接数据源。
     *
     * <p>聚合键是 {@code site + vodId}：同一部剧从不同源缓存时**分开**，
     * 因为不同源的清晰度/线路不同，混在一张卡里用户点开会有两套集数。
     *
     * <p>为什么不在前端聚合：前端拿到的是平铺 list（一集一条），
     * 270 条要自己 groupBy，还要处理"哪些集下完了、哪些还在跑"。
     * 这层语义（state/percent）在后端本来就是权威的，放前端做会漂移。
     *
     * <p>每张卡片返回：
     * <ul>
     *   <li>剧级：vodName / poster（有本地图的走本地端点）/ year / area / remarks</li>
     *   <li>统计：episodes（集数）/ doneEpisodes / totalBytes / downloading</li>
     *   <li>eps：按集号排序的 [{id, ep, state, percent, bytes, playable}]</li>
     * </ul>
     */
    public static JSONArray grouped() {
        JSONArray out = new JSONArray();
        try {
            Path root = cacheRoot();
            if (!Files.isDirectory(root)) return out;

            // 剧键 → 聚合体
            Map<String, JSONObject> groups = new java.util.LinkedHashMap<>();
            Map<String, JSONArray> groupEps = new java.util.HashMap<>();
            Map<String, Long> groupBytes = new java.util.HashMap<>();
            List<Path> dirs = new ArrayList<>();
            Files.list(root).filter(Files::isDirectory).forEach(dirs::add);
            // 按目录名（= id，含 site|vodId|ep 的哈希）排序不保证集数顺序，
            // 下面 ep 排序交给 sortEpisodes 统一处理。
            for (Path d : dirs) {
                String id = d.getFileName().toString();
                JSONObject meta = readMeta(id);
                if (meta == null) continue;

                String site = meta.optString("site", "");
                String vodId = meta.optString("vodId", "");
                String key = site + "|" + vodId;

                JSONObject g = groups.get(key);
                if (g == null) {
                    g = new JSONObject();
                    g.put("site", site);
                    g.put("vodId", vodId);
                    // 剧名优先用 vodName（纯剧名），老数据没有就用 name 去掉"第N集"
                    String vn = meta.optString("vodName", "");
                    if (vn.isEmpty()) vn = stripEpSuffix(meta.optString("name", ""));
                    g.put("name", vn);
                    g.put("poster", meta.optString("poster", ""));
                    g.put("posterFile", meta.optString("posterFile", ""));
                    g.put("year", meta.optString("vodYear", ""));
                    g.put("area", meta.optString("vodArea", ""));
                    g.put("remarks", meta.optString("vodRemarks", ""));
                    g.put("lastAt", 0L);
                    groups.put(key, g);
                    groupEps.put(key, new JSONArray());
                    groupBytes.put(key, 0L);
                }
                // 老数据可能只有 name 没有海报：后来某一集带了元数据就补上
                if (g.optString("posterFile").isEmpty() && !meta.optString("posterFile", "").isEmpty()) {
                    g.put("posterFile", meta.optString("posterFile", ""));
                }
                if (g.optString("poster").isEmpty() && !meta.optString("poster", "").isEmpty()) {
                    g.put("poster", meta.optString("poster", ""));
                }
                long at = meta.optLong("at", meta.optLong("createdAt", 0));
                if (at > g.optLong("lastAt", 0)) {
                    g.put("lastAt", at);
                    // 顺手用最新那一集的剧名/海报填补空字段
                    String vn2 = meta.optString("vodName", "");
                    if (!vn2.isEmpty() && g.optString("name", "").isEmpty()) g.put("name", vn2);
                }

                long size = dirSize(d);
                groupBytes.put(key, groupBytes.get(key) + size);

                JSONObject ep = new JSONObject();
                ep.put("id", id);
                ep.put("ep", meta.optString("ep", ""));
                ep.put("name", meta.optString("name", ""));
                ep.put("bytes", size);
                boolean hasPlaylist = Files.isRegularFile(d.resolve("playlist.m3u8"));
                ep.put("playable", hasPlaylist);
                // 内存任务表里的实时状态优先；没有任务（重启后重建）就按文件判
                Task t = TASKS.get(id);
                if (t != null) {
                    ep.put("state", t.state);
                    ep.put("percent", t.percent);
                } else {
                    ep.put("state", hasPlaylist ? "done" : "failed");
                    ep.put("percent", hasPlaylist ? 100 : 0);
                }
                groupEps.get(key).put(ep);
            }

            /*
             * ★ 补上"还在下载、meta.json 尚未落盘"的集。
             *
             * 踩过（2026-10-30 实测）：上面是遍历**磁盘目录**读 meta 组装的，
             * 而 meta 要到该集下载完成才写。于是正在下的第 2 集（实测 76%）
             * 在 grouped 里完全不存在 —— 前端看不到「下载中」角标，
             * 进度弹框也是空的，用户只能干等。
             *
             * 判据用 TASKS：它从任务创建那一刻就有记录（含 running/paused）。
             * id 已在磁盘目录里出现过就跳过，避免重复。
             */
            for (Task t : TASKS.values()) {
                String key = t.site + "|" + t.vodId;
                JSONObject g = groups.get(key);
                // 目录可能已经建了但 meta 还没写：字节数照实算（下面建组要用）
                long size = 0;
                try {
                    Path d = dirOf(t.id);
                    if (Files.isDirectory(d)) size = dirSize(d);
                } catch (Exception ignored) {
                }
                if (g == null) {
                    /*
                     * ★ 不给「失败/取消且一点没下下来」的任务单独建卡。
                     *
                     * 实测（2026-10-30）：用户先把《我不是大师》从 AppDrama2 缓存成功，
                     * 又对同一个剧点了 Jpys 源的缓存；Jpys 给不出 m3u8 → 任务 failed、
                     * 磁盘零字节、meta.json 从未落盘。可任务仍在 TASKS 里，于是这里
                     * 又建了一组，海报墙出现第二张「0/1 集 · 无海报」的空卡，
                     * 看起来像缓存了两部不同的剧。
                     *
                     * 这类任务该出现的地方是下面的「未下完」列表（能续传/能删），
                     * 不是海报墙。running/paused 例外：它们正在产生内容，
                     * 首集刚开始下、目录还是空的时候也要让用户看到「下载中」。
                     */
                    boolean live = "running".equals(t.state) || "paused".equals(t.state);
                    if (!live && size <= 0) continue;
                    // 这部剧一个 meta 都还没有（首集刚开始下）：整组都靠任务表建
                    g = new JSONObject();
                    g.put("site", t.site);
                    g.put("vodId", t.vodId);
                    String vn = t.vodName == null || t.vodName.isEmpty()
                            ? stripEpSuffix(t.name) : t.vodName;
                    g.put("name", vn);
                    g.put("poster", t.poster == null ? "" : t.poster);
                    g.put("posterFile", t.posterFile == null ? "" : t.posterFile);
                    g.put("year", t.vodYear == null ? "" : t.vodYear);
                    g.put("area", t.vodArea == null ? "" : t.vodArea);
                    g.put("remarks", t.vodRemarks == null ? "" : t.vodRemarks);
                    g.put("lastAt", t.updatedAt);
                    groups.put(key, g);
                    groupEps.put(key, new JSONArray());
                    groupBytes.put(key, 0L);
                }
                JSONArray eps = groupEps.get(key);
                boolean exists = false;
                for (int i = 0; i < eps.length(); i++) {
                    if (t.id.equals(eps.optJSONObject(i).optString("id", ""))) {
                        exists = true;
                        break;
                    }
                }
                if (exists) continue;
                groupBytes.put(key, groupBytes.get(key) + size);
                JSONObject ep = new JSONObject();
                ep.put("id", t.id);
                ep.put("ep", t.ep == null ? "" : t.ep);
                ep.put("name", t.name == null ? "" : t.name);
                ep.put("bytes", size);
                ep.put("playable", Files.isRegularFile(dirOf(t.id).resolve("playlist.m3u8")));
                ep.put("state", t.state);
                ep.put("percent", t.percent);
                eps.put(ep);
            }

            for (Map.Entry<String, JSONObject> e : groups.entrySet()) {
                String key = e.getKey();
                JSONObject g = e.getValue();
                JSONArray eps = sortEpisodes(groupEps.get(key));
                int done = 0, downloading = 0;
                for (int i = 0; i < eps.length(); i++) {
                    String st = eps.optJSONObject(i).optString("state", "");
                    if ("done".equals(st)) done++;
                    else if ("running".equals(st) || "paused".equals(st)) downloading++;
                }
                g.put("episodes", eps.length());
                g.put("doneEpisodes", done);
                g.put("downloading", downloading);
                g.put("totalBytes", groupBytes.get(key));
                g.put("eps", eps);
                out.put(g);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    /** 去除"第N集"后缀，得到纯剧名（老数据没有 vodName 时的兜底）。 */
    private static String stripEpSuffix(String name) {
        if (name == null) return "";
        return name.replaceAll("[\\s　]*第?\\s*\\d+\\s*[集话話期]$", "").trim();
    }

    /** 按集号数值排序；非数字的排在最后（VIP/预告这类）。 */
    private static JSONArray sortEpisodes(JSONArray eps) {
        List<JSONObject> list = new ArrayList<>();
        for (int i = 0; i < eps.length(); i++) {
            JSONObject o = eps.optJSONObject(i);
            if (o != null) list.add(o);
        }
        list.sort((a, b) -> {
            int ea = epNum(a.optString("ep", ""));
            int eb = epNum(b.optString("ep", ""));
            if (ea != eb) return Integer.compare(ea, eb);
            return a.optString("ep", "").compareTo(b.optString("ep", ""));
        });
        JSONArray out = new JSONArray();
        for (JSONObject o : list) out.put(o);
        return out;
    }

    /** 从 "12" / "第12集" / "12.5" 里取整数集号；取不到返回 Integer.MAX_VALUE。 */
    private static int epNum(String s) {
        if (s == null || s.isEmpty()) return Integer.MAX_VALUE;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\d+)").matcher(s);
        if (!m.find()) return Integer.MAX_VALUE;
        try {
            return Integer.parseInt(m.group(1));
        } catch (Exception e) {
            return Integer.MAX_VALUE;
        }
    }

    /**
     * 读某一集目录下的本地海报文件；没有返回 null。
     *
     * <p>给 {@code /api/cache/poster?id=...} 用。离线时这是唯一能出图的来源。
     */
    public static Path posterOf(String id) {
        try {
            Path dir = dirOf(id);
            if (!Files.isDirectory(dir)) return null;
            for (String ext : new String[]{"webp", "jpg", "png", "gif"}) {
                Path p = dir.resolve("poster." + ext);
                if (Files.isRegularFile(p)) return p;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /**
     * 找这部剧任意一集已有的本地海报（按剧聚合时共用一张图）。
     *
     * <p>为什么不是每集各存一份：一季 24 集就有 24 份一模一样的图，
     * 纯浪费。展示时用「该剧第一张能读到的那份」即可。
     */
    public static Path posterOfVod(String site, String vodId) {
        try {
            Path root = cacheRoot();
            if (!Files.isDirectory(root)) return null;
            List<Path> dirs = new ArrayList<>();
            Files.list(root).filter(Files::isDirectory).forEach(dirs::add);
            for (Path d : dirs) {
                JSONObject meta = readMeta(d.getFileName().toString());
                if (meta == null) continue;
                if (!site.equals(meta.optString("site", ""))) continue;
                if (!vodId.equals(meta.optString("vodId", ""))) continue;
                Path p = posterOf(d.getFileName().toString());
                if (p != null) return p;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 本地清单文件。 */
    public static Path playlistOf(String id) {
        return dirOf(id).resolve("playlist.m3u8");
    }

    /**
     * 缓存目录下的某个文件（分片/密钥）。只允许单段文件名，防穿越。
     *
     * <p><b>为什么还要查盘符</b>（2026-10-30 安全审计 C4 实测）：
     * Windows 上 `dir.resolve("P:policy.json")` 是**盘符相对路径**，
     * 会落到 P: 盘的"当前目录"，直接越出缓存目录 —— 原判据只挡了
     * `/` `\` `..`，于是 `GET /api/transcode/<id>/P:policy.json`
     * 能读到后端的 policy.json（里面有 authToken 与所有配置）。
     *
     * <p>补两道：显式拒 `:`，再用 `normalize().startsWith()` 兜底
     * （后者能挡住未来任何新的路径语法）。
     */
    public static Path fileOf(String id, String name) {
        if (name == null || name.isEmpty()) return null;
        if (name.contains("/") || name.contains("\\") || name.contains("..")) return null;
        // 盘符（C: / P:）与 NTFS 数据流（file.txt:stream）都靠它挡
        if (name.indexOf(':') >= 0) return null;
        Path dir = dirOf(id);
        Path out = dir.resolve(name).normalize();
        // 归一化后必须仍在缓存目录内，否则一律拒绝
        if (!out.startsWith(dir.normalize())) return null;
        return out;
    }

    public static boolean delete(String id) {
        TASKS.remove(id);
        saveManifest();
        try {
            Path d = dirOf(id);
            if (!Files.isDirectory(d)) return false;
            List<Path> all = new ArrayList<>();
            Files.walk(d).forEach(all::add);
            // 先删文件再删目录，Windows 上顺序反了会失败
            for (int i = all.size() - 1; i >= 0; i--) Files.deleteIfExists(all.get(i));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    public static Task status(String id) {
        Task t = TASKS.get(id);
        if (t != null) return t;
        JSONObject m = readMeta(id);
        if (m == null) return null;
        Task s = new Task();
        s.id = id;
        s.site = m.optString("site", "");
        s.vodId = m.optString("vodId", "");
        s.ep = m.optString("ep", "");
        s.name = m.optString("name", "");
        s.state = "done";
        s.percent = 100;
        s.total = m.optInt("segments", 0);
        s.done = s.total;
        s.bytes = m.optLong("bytes", 0);
        return s;
    }

    public static Task cancel(String id) {
        Task t = TASKS.get(id);
        if (t != null) t.state = "canceled";
        return t;
    }

    /**
     * 暂停：把状态置 paused，下载循环下一片就会停。
     *
     * <p>与 cancel 的区别只在**用户意图**，实现相同 —— 二者都可以靠
     * {@link #resume(String)} 从已下分片继续（断点续传按"文件存在且非空"判断）。
     * 不把 paused 做成"真的挂起线程再唤醒"：那要维护一组挂起中的 Future，
     * 进程重启后这些 Future 全丢，反而比"停了再续"更脆。
     *
     * <p>已完成的任务不允许暂停（没有意义，还会把 100% 翻成 50%）。
     */
    public static Task pause(String id) {
        Task t = TASKS.get(id);
        if (t == null) return null;
        if ("done".equals(t.state)) return t;
        t.state = "paused";
        t.resumable = hasAnySegment(id);
        touchManifest(t);
        return t;
    }

    /**
     * 删除：停掉任务 + 删除整个缓存目录。
     *
     * <p>先置 canceled 再删目录：下载线程还在写分片时直接删目录，
     * 它会因为 `NoSuchFileException` 走进 fail 分支，日志里出现
     * "下载失败"的假报错。置状态后线程会在下一个分片检查点退出。
     */
    public static boolean remove(String id) {
        Task t = TASKS.get(id);
        if (t != null) {
            t.state = "canceled";
            TASKS.remove(id);
        }
        try {
            Path dir = dirOf(id);
            if (Files.isDirectory(dir)) {
                List<Path> files = new ArrayList<>();
                Files.walk(dir).sorted(java.util.Comparator.reverseOrder()).forEach(files::add);
                for (Path p : files) {
                    try { Files.deleteIfExists(p); } catch (Exception ignored) {}
                }
            }
        } catch (Exception ignored) {
            return false;
        }
        saveManifest();
        return true;
    }

    /** 总占用，设置页显示用。 */
    public static long totalBytes() {
        try {
            return dirSize(cacheRoot());
        } catch (Exception e) {
            return 0;
        }
    }

    /** 供播放页判断：这一集有没有缓存过。 */
    public static Map<String, String> describe(String id) {
        HashMap<String, String> m = new HashMap<>();
        JSONObject meta = readMeta(id);
        if (meta != null) {
            m.put("name", meta.optString("name", ""));
            m.put("bytes", String.valueOf(meta.optLong("bytes", 0)));
        }
        return m;
    }
}
