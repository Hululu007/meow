package core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * 海报图片落盘。
 *
 * <p><b>为什么必须落盘</b>：片库的使用场景就是「局域网脱网也能看」。
 * 原来海报只会写浏览器缓存（{@code Cache-Control: max-age=86400}），
 * 于是断网超过一天、或者 TV 的 WebView 缓存被系统清理之后，整面海报墙全裂。
 * 落盘后 {@code /api/proxy/image} 命中本地文件时**一次网络请求都不发**。
 *
 * <p><b>存哪</b>：{@code data/posters/<sha1(url)>.<ext>}，与 scrape-cache.json
 * 同级。片库目录是只读的（不该往用户的 NAS 里写东西），所以只能存我们自己的
 * 数据目录。
 *
 * <p><b>为什么按 URL 哈希而不是片名</b>：同一张海报可能被多个片名共用
 * （合集、别名），按 URL 存天然去重；而且 URL 是唯一的、可复算的，
 * 不需要维护映射表。
 *
 * <p><b>配额</b>：默认 500MB，超限按最后访问时间淘汰。按每张 30KB 算，
 * 500MB ≈ 1.6 万张海报，远超普通人的片库规模；真到了这个量级，
 * 说明用户该考虑加盘而不是我们该改成数据库。
 *
 * <p>目录布局：
 * <pre>
 *   data/posters/
 *     a1b2c3d4....jpg
 *     .index.json         {url: {f: 文件名, at: 最后访问时间}}
 * </pre>
 * 索引只是为了淘汰时知道"哪个 URL 对应哪个文件、多久没访问"；
 * 丢了也能重建（最多变成一个 orphan 目录，下次写入时清）。
 */
public final class PosterStore {

    private PosterStore() {
    }

    private static final String DIR = "posters";
    private static final String INDEX = "posters/.index.json";

    /**
     * 配额上限。超过就按最后访问时间淘汰最旧的。
     *
     * <p>1 GB 而不是 500 MB：海报改取豆瓣 {@code l_ratio_poster} 之后单张约
     * 170 KB（原 s_ 只有 17 KB），500 MB 只够约 3000 张；一部剧按季各一张、
     * 上千部片子很容易顶到。1 GB ≈ 6000 张，仍是有界值。
     */
    private static final long MAX_BYTES = 1000L * 1024 * 1024;
    /** 单张超过这个大小就不存（防止把视频/畸形响应当图片存进来）。 */
    private static final int MAX_ONE = 8 * 1024 * 1024;

    /** 索引：url → {f: 文件名, at: 毫秒}。惰性加载。
     *
     * volatile：`index()` 用双重检查读它，非 volatile 时其他线程可能
     * 看到「引用已赋值但内容未构造完」的中间状态。
     */
    private static volatile JSONObject INDEX_CACHE;

    private static JSONObject index() {
        /*
         * ★ 双重检查：热路径不进锁。
         *
         * `get()` 每张海报都调这里，而首页一次 24+ 张、后端请求池 12 线程。
         * 原来整个方法 `synchronized`，12 个线程在这里排队 ——
         * 实测 6 张并发每张 4.1 秒，单张只要 49ms，就是这把锁的代价。
         * INDEX_CACHE 一旦装载就不会再变（只在 persistIndex 前被修改，
         * 而那些修改本身也在类锁内），所以 volatile 读足够。
         */
        JSONObject c = INDEX_CACHE;
        if (c != null) return c;
        synchronized (PosterStore.class) {
            if (INDEX_CACHE != null) return INDEX_CACHE;
            String raw = DataPaths.read(INDEX);
            if (raw == null || raw.trim().isEmpty()) {
                INDEX_CACHE = new JSONObject();
            } else {
                try {
                    INDEX_CACHE = new JSONObject(raw);
                } catch (Exception e) {
                    INDEX_CACHE = new JSONObject();
                }
            }
            return INDEX_CACHE;
        }
    }

    private static synchronized void persistIndex() {
        try {
            DataPaths.write(INDEX, index().toString());
        } catch (Exception ignored) {
        }
    }

    private static Path dir() {
        return DataPaths.root().resolve(DIR);
    }

    /** SHA-1 前 32 位十六进制。够用（碰撞概率 1/2^128），且文件名短。 */
    private static String hash(String s) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-1");
            byte[] d = md.digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 16; i++) {
                String h = Integer.toHexString(d[i] & 0xFF);
                if (h.length() == 1) sb.append('0');
                sb.append(h);
            }
            return sb.toString();
        } catch (Exception e) {
            // 没有 SHA-1 是不可能的（JDK 必有），兜底用 hashCode
            return Integer.toHexString(s.hashCode());
        }
    }

    private static String extOf(String kind) {
        if ("png".equals(kind)) return "png";
        if ("gif".equals(kind)) return "gif";
        if ("webp".equals(kind)) return "webp";
        return "jpg";
    }

    /**
     * 读本地副本。
     *
     * @return 图片字节；没有或读失败返回 null（调用方回退到网络）
     */
    public static byte[] get(String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            JSONObject e = index().optJSONObject(url);
            if (e == null) return null;
            Path p = dir().resolve(e.optString("f", ""));
            if (!Files.isRegularFile(p)) {
                // 索引有、文件没了（用户手工删过）：清掉这条，回退网络
                synchronized (PosterStore.class) {
                    index().remove(url);
                    persistIndex();
                }
                return null;
            }
            byte[] data = Files.readAllBytes(p);
            if (data.length == 0) return null;
            touch(url);
            return data;
        } catch (Exception e) {
            return null;
        }
    }

    /** 更新最后访问时间（淘汰排序用）。不每次落盘——攒够一批再写。 */
    private static void touch(String url) {
        /*
         * ★ 这条路径必须尽量无锁，否则首页海报会被串行化。
         *
         * 踩过（2026-10-30 投影仪实测）：原来整个 touch 都在
         * `synchronized (PosterStore.class)` 里，而首页一次要加载 24+ 张海报、
         * 后端请求池只有 12 个线程 —— 12 个线程在这把**类级锁**上排队，
         * 每个都要 `index()` 反序列化 + 可能 `persistIndex()` 写盘。
         * 实测 6 张并发时每张耗时 4.1 秒（串行效应），而单张只要 49ms。
         *
         * 现在：先用无锁计数器判断要不要落盘，只有真的满 50 次才进锁。
         * `at` 时间戳的更新本身不是精确语义（只用于 LRU 淘汰排序），
         * 丢几次更新完全无害。
         */
        if (TOUCH_COUNTER.incrementAndGet() < 50) {
            // 绝大多数请求走这里：完全不进锁
            return;
        }
        synchronized (PosterStore.class) {
            try {
                TOUCH_COUNTER.set(0);
                JSONObject idx = index();
                JSONObject e = idx.optJSONObject(url);
                if (e != null) e.put("at", System.currentTimeMillis());
                persistIndex();
            } catch (Exception ignored) {
                // 精简版 org.json 的 put 会抛受检异常；访问时间更新失败不影响读图
            }
        }
    }

    /** 无锁计数器：攒够 50 次触摸才落盘一次。 */
    private static final java.util.concurrent.atomic.AtomicInteger TOUCH_COUNTER =
            new java.util.concurrent.atomic.AtomicInteger(0);

    /**
     * 存一份。
     *
     * @param kind {@link #sniffOrNull} 判出的真实格式（jpeg/png/gif/webp），可为 null
     * @return true = 已落盘
     */
    public static boolean put(String url, byte[] data, String kind) {
        if (url == null || url.isEmpty() || data == null) return false;
        if (data.length == 0 || data.length > MAX_ONE) return false;
        try {
            Path d = dir();
            Files.createDirectories(d);
            String name = hash(url) + "." + extOf(kind);
            Path p = d.resolve(name);
            // 已存在就不重写（同一张图重复拉时省一次 IO）
            if (!Files.isRegularFile(p)) {
                Path tmp = d.resolve(name + ".tmp");
                Files.write(tmp, data);
                Files.move(tmp, p, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            synchronized (PosterStore.class) {
                index().put(url, new JSONObject().put("f", name).put("at", System.currentTimeMillis()));
                persistIndex();
            }
            evictIfNeeded();
            return true;
        } catch (Exception e) {
            core.LogBuffer.warn("image", "poster save failed: " + e);
            return false;
        }
    }

    /** 超配额就按最后访问时间从旧到新删，直到降到 90%。 */
    private static void evictIfNeeded() {
        try {
            Path d = dir();
            if (!Files.isDirectory(d)) return;
            long total = 0;
            List<Path> files = new ArrayList<>();
            try (java.util.stream.Stream<Path> st = Files.list(d)) {
                for (Path p : (Iterable<Path>) st::iterator) {
                    if (!Files.isRegularFile(p)) continue;
                    String n = p.getFileName().toString();
                    if (n.endsWith(".json") || n.endsWith(".tmp")) continue;
                    total += Files.size(p);
                    files.add(p);
                }
            }
            if (total <= MAX_BYTES) return;
            // 按索引里的 at 升序删（索引里没有的按文件修改时间兜底）
            JSONObject idx = index();
            List<String[]> order = new ArrayList<>();
            // ★ 用 keys() 而不是 keySet()：宿主的 org.json 是精简版（android-json），
            //   没有 Java 版的新 API。
            java.util.Iterator<String> it = idx.keys();
            while (it.hasNext()) {
                String url = it.next();
                JSONObject e = idx.optJSONObject(url);
                if (e == null) continue;
                order.add(new String[]{url, String.valueOf(e.optLong("at", 0))});
            }
            order.sort(Comparator.comparingLong(a -> Long.parseLong(a[1])));
            long target = (long) (MAX_BYTES * 0.9);
            for (String[] row : order) {
                if (total <= target) break;
                JSONObject e = idx.optJSONObject(row[0]);
                if (e == null) continue;
                Path p = d.resolve(e.optString("f", ""));
                try {
                    long sz = Files.isRegularFile(p) ? Files.size(p) : 0;
                    Files.deleteIfExists(p);
                    total -= sz;
                    idx.remove(row[0]);
                } catch (Exception ignored) {
                }
            }
            persistIndex();
            core.LogBuffer.info("image", "poster cache evicted to " + (total / 1024 / 1024) + "MB");
        } catch (Exception e) {
            core.LogBuffer.warn("image", "poster evict failed: " + e);
        }
    }

    /** 缓存统计（给设置页/诊断用）。 */
    public static JSONObject stats() {
        JSONObject out = new JSONObject();
        try {
            Path d = dir();
            int n = 0;
            long bytes = 0;
            if (Files.isDirectory(d)) {
                try (java.util.stream.Stream<Path> st = Files.list(d)) {
                    for (Path p : (Iterable<Path>) st::iterator) {
                        if (!Files.isRegularFile(p)) continue;
                        String nm = p.getFileName().toString();
                        if (nm.endsWith(".json") || nm.endsWith(".tmp")) continue;
                        n++;
                        bytes += Files.size(p);
                    }
                }
            }
            out.put("ok", true);
            out.put("count", n);
            out.put("bytes", bytes);
            out.put("limitBytes", MAX_BYTES);
        } catch (Exception e) {
            try {
                out.put("ok", false).put("msg", String.valueOf(e));
            } catch (Exception ignored2) {
            }
        }
        return out;
    }

    /** 清空（设置页"清空海报缓存"用）。 */
    public static boolean clear() {
        try {
            Path d = dir();
            if (Files.isDirectory(d)) {
                try (java.util.stream.Stream<Path> st = Files.list(d)) {
                    for (Path p : (Iterable<Path>) st::iterator) {
                        try {
                            Files.deleteIfExists(p);
                        } catch (Exception ignored) {
                        }
                    }
                }
            }
            synchronized (PosterStore.class) {
                INDEX_CACHE = new JSONObject();
                persistData();
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static void persistData() {
        try {
            DataPaths.write(INDEX, "{}");
        } catch (Exception ignored) {
        }
    }

    /**
     * 按魔数判真实格式，认不出返回 null。
     *
     * <p>与 {@code ApiServer.sniffImageType} 同一套判据，但那边是 private 且
     * 依赖大量上下文，这里复制一份最小的——只用来决定落盘后缀名。
     */
    public static String sniffOrNull(byte[] d) {
        if (d == null || d.length < 12) return null;
        if ((d[0] & 0xFF) == 0xFF && (d[1] & 0xFF) == 0xD8 && (d[2] & 0xFF) == 0xFF) return "jpeg";
        if ((d[0] & 0xFF) == 0x89 && d[1] == 'P' && d[2] == 'N' && d[3] == 'G') return "png";
        if (d[0] == 'G' && d[1] == 'I' && d[2] == 'F' && d[3] == '8') return "gif";
        if (d.length > 12 && d[0] == 'R' && d[1] == 'I' && d[2] == 'F' && d[3] == 'F'
                && d[8] == 'W' && d[9] == 'E' && d[10] == 'B' && d[11] == 'P') return "webp";
        return null;
    }
}
