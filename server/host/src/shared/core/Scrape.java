package core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;

/**
 * 刮削：把「文件名」变成「海报 + 年份 + 简介」。
 *
 * <p><b>为什么必然要刮</b>：实测用户的片库是**纯裸视频库**（314 个文件、
 * 362GB、0 张图、0 个字幕、0 个 .nfo），所以「复用本地 .nfo 与同目录图片」
 * 这条路在这台机器上没有基线，只能靠在线刮。
 *
 * <p><b>为什么失败必须能退化</b>：内网/离线环境下刮不到是常态，
 * 刮削结果只是"更好看"，不能变成"打不开"。任何异常都退回文件名。
 *
 * <p><b>为什么结果要落盘</b>：片库目录是只读的（且我们不该往里写东西），
 * 元数据存到我们自己的数据目录，按「片名+年份」做 key；
 * 断网重开也能立刻显示上次刮到的海报。
 *
 * <p><b>用哪个源</b>：豆瓣的 {@code subject_suggest} 实测可用（无需 key），
 * 返回片名/年份/条目 URL。海报 URL 由条目 URL 推不出来，所以另走
 * {@code /api/proxy/image} 转发豆瓣图床（那些图有 Referer 防盗链）。
 */
public final class Scrape {

    private Scrape() {
    }

    private static final String CACHE_FILE = "scrape-cache.json";
    /**
     * 命中记录的保留时长：**永久**。
     *
     * <p>原来这里是 30 天。改成永久的判据是使用场景：片库的意义就是
     * 「局域网脱网也能看」——NAS 上有没有公网、豆瓣今天通不通，都不该
     * 影响已经刮到的东西。片名→海报是稳定映射，反复重查只会白打外网。
     *
     * <p>要更新某一条，用户手动点「重新搜刮」（{@code force=true} 跳过缓存）。
     */
    private static final long KEEP_FOREVER = Long.MAX_VALUE;
    /**
     * 未命中的缓存时长。**必须远短于永久**。
     *
     * <p>踩过：豆瓣 {@code subject_suggest} 偶尔整体返回空数组（限流/抖动），
     * 而旧逻辑把"没查到"也按 30 天缓存，于是那段时间列过的片名全部被钉死，
     * 之后接口恢复了这些片仍然永远没有海报（实测本机 101 条缓存里只有 3 条成功，
     * 其余全是某次抖动留下的空结果）。失败只记 10 分钟：既挡住连点刷新，
     * 又不会把一次抖动变成一个月。
     */
    private static final long TTL_MISS_MS = 10L * 60 * 1000;

    /** 内存缓存 + 落盘。key = 归一化片名。 */
    private static JSONObject CACHE;

    private static synchronized JSONObject cache() {
        if (CACHE != null) return CACHE;
        String raw = DataPaths.read(CACHE_FILE);
        if (raw == null || raw.trim().isEmpty()) {
            CACHE = new JSONObject();
        } else {
            try {
                CACHE = new JSONObject(raw);
            } catch (Exception e) {
                CACHE = new JSONObject();
            }
        }
        return CACHE;
    }

    private static synchronized void persist() {
        try {
            DataPaths.write(CACHE_FILE, CACHE.toString());
        } catch (Exception ignored) {
        }
    }

    /** 片名归一化：去空格/全半角差异，让"庆余年"和"庆余年 "命中同一条。 */
    private static String normalize(String title) {
        if (title == null) return "";
        String s = title.trim().toLowerCase();
        s = s.replace("　", "").replace(" ", "");
        s = s.replace(":", "").replace("：", "");
        s = s.replace("·", "");
        return s;
    }

    /**
     * 缓存 key：`[lib|]归一化片名|年份`。
     *
     * <p><b>为什么要带 lib</b>：两个片库各有一部《教父》（1972）时，
     * 旧 key 只按片名+年份算，两条会共用同一条记录——后刮的覆盖先刮的，
     * 而用户根本看不出为什么这个库的封面变成了另一个库的。
     * 加上库维度后各存各的，代价是同一部片在两个库各查一次（可接受）。
     *
     * <p>lib 为空时仍是旧格式，这样老缓存**不需要迁移**也能命中
     * （列目录时前端一定带 lib，只是"全局条目"退化成没带）。
     */
    private static String keyOf(String lib, String title, int year) {
        String base = normalize(title) + "|" + (year > 0 ? year : "");
        String l = lib == null ? "" : lib.trim();
        return l.isEmpty() ? base : l + "|" + base;
    }

    /**
     * 打开到豆瓣的连接，**系统 DNS 失败时退到 DoH**。
     *
     * <p>为什么不能直接 `url.openConnection()`：这台机器踩过一次真实故障——
     * NAS 的 `/etc/resolv.conf` 只有一个已失效的 nameserver，容器内任何域名都
     * 解析不了。后果是刮削"每一部都搜不到"，和豆瓣限流的表现完全一样，
     * 排查时极易误判。DoH 在同一时刻是通的，所以这里必须能绕过系统 DNS。
     *
     * <p>做法与 {@code ApiServer.openStream} 一致：safeDns 开启时先 DoH 拿 IP，
     * 再让 HttpURLConnection 直连该 IP（Host 头仍用域名，SNI 不变，
     * 并补一次主机名校验防止中间人）。
     */
    private static HttpURLConnection httpConnection(URL url, int connectMs, int readMs)
            throws java.io.IOException {
        JSONObject policy = null;
        try {
            String raw = DataPaths.read("policy.json");
            if (raw != null && !raw.trim().isEmpty()) policy = new JSONObject(raw);
        } catch (Exception ignored) {
        }
        boolean safeDns = policy != null && policy.optBoolean("safeDns", false);
        String provider = policy == null ? "" : policy.optString("dnsProvider", "");
        if (provider.isEmpty()) provider = "dnspub";

        if (!safeDns || !"https".equalsIgnoreCase(url.getProtocol())) {
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(connectMs);
            c.setReadTimeout(readMs);
            return c;
        }
        String ip = Doh.resolve(url.getHost(), provider);
        if (ip == null || ip.isEmpty()) {
            // DoH 也拿不到：退回直连，让失败以连接异常的形式暴露（而不是静默）
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(connectMs);
            c.setReadTimeout(readMs);
            return c;
        }
        String mapped = url.getProtocol() + "://" + ip
                + (url.getPort() > 0 ? ":" + url.getPort() : "") + url.getFile();
        HttpURLConnection c = (HttpURLConnection) new URL(mapped).openConnection();
        c.setConnectTimeout(connectMs);
        c.setReadTimeout(readMs);
        c.setRequestProperty("Host", url.getHost());
        /*
         * 连的是 IP，URL 里没有域名，JSSE 的主机名校验会拿 IP 去比证书、必然失败。
         * 原实现在这里装了个"永远返回 true"的 HostnameVerifier 来绕过，
         * 副作用是**彻底关掉主机名校验**（2026-10-30 安全审计 H12）。
         *
         * 这里改用 endpointIdentificationAlgorithm=HTTPS 无法解决（它比的还是
         * URL 里的 host=IP）。所以做**显式校验**：拿域名去比服务器证书的 SAN，
         * 不通过就抛异常。判据与 JSSE 一致：dNSName 通配只允许最左一段。
         */
        if (c instanceof javax.net.ssl.HttpsURLConnection) {
            javax.net.ssl.HttpsURLConnection hc = (javax.net.ssl.HttpsURLConnection) c;
            String want = url.getHost();
            hc.setHostnameVerifier((h, session) -> verifyCertHost(want, session));
        }
        return c;
    }

    /**
     * 用域名校验服务器证书的主机名（大小写不敏感，支持最左段通配）。
     *
     * <p>没有走 {@code HttpsURLConnection.getDefaultHostnameVerifier()}：
     * 它的默认实现**恒返回 false**（JDK 用它表示"没有默认校验器"），
     * 所以任何"调它然后 return true"的写法都是在关校验（本仓库踩过三处）。
     */
    static boolean verifyCertHost(String host, javax.net.ssl.SSLSession session) {
        if (host == null || host.isEmpty()) return false;
        try {
            java.security.cert.Certificate[] chain = session.getPeerCertificates();
            if (chain == null || chain.length == 0) return false;
            if (!(chain[0] instanceof java.security.cert.X509Certificate)) return false;
            java.security.cert.X509Certificate cert =
                    (java.security.cert.X509Certificate) chain[0];
            java.util.Collection<java.util.List<?>> sans = cert.getSubjectAlternativeNames();
            if (sans == null) return false;
            String want = host.toLowerCase();
            for (java.util.List<?> san : sans) {
                if (san == null || san.size() < 2) continue;
                Object type = san.get(0);
                Object value = san.get(1);
                if (!(type instanceof Integer) || ((Integer) type) != 2) continue; // 2 = dNSName
                if (!(value instanceof String)) continue;
                String dns = ((String) value).toLowerCase();
                if (dns.equals(want)) return true;
                // *.example.com 只匹配一级
                if (dns.startsWith("*.")) {
                    String suffix = dns.substring(1);          // ".example.com"
                    if (want.endsWith(suffix)
                            && want.indexOf('.') == want.length() - suffix.length()) {
                        return true;
                    }
                }
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 带 DoH 兜底的文本 GET —— 原生源（{@code sources/*}）共用。
     *
     * <p>为什么不各源自己写：{@link #httpConnection} 里两条约束都是踩出来的
     * （系统 DNS 坏掉时要退 DoH；退 DoH 后必须显式校验证书主机名）。
     * 分散到每个源各写一遍，必然有源漏掉其中一条，症状分别是
     * "容器里全部 UnknownHost" 和 "悄悄关掉了主机名校验"。
     *
     * @param headers 额外请求头（Host/Referer/UA 等），可空
     */
    public static String fetchText(String url, java.util.Map<String, String> headers,
                                   int connectMs, int readMs) throws java.io.IOException {
        HttpURLConnection c = null;
        try {
            c = httpConnection(new URL(url), connectMs, readMs);
            if (headers != null) {
                for (java.util.Map.Entry<String, String> e : headers.entrySet()) {
                    if (e.getKey() == null || e.getValue() == null) continue;
                    c.setRequestProperty(e.getKey(), e.getValue());
                }
            }
            int code = c.getResponseCode();
            if (code != 200) throw new java.io.IOException("HTTP " + code + " " + url);
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                long total = 0;
                // 上限只是防呆：正常 JSON 几十 KB，超过 4MB 说明端点变了
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > 4L * 1024 * 1024) break;
                    bos.write(buf, 0, n);
                }
                return new String(bos.toByteArray(), StandardCharsets.UTF_8);
            }
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /**
     * 刮一条。命中缓存直接返回；否则查豆瓣并落盘。
     *
     * <p>返回值一定有 {@code title}（刮不到时就是传入的原名），
     * 其余字段尽力而为。
     */
    public static JSONObject lookup(String title, int year) throws Exception {
        return lookup(null, title, year, false);
    }

    public static JSONObject lookup(String title, int year, boolean force) throws Exception {
        return lookup(null, title, year, force);
    }

    /**
     * 刮一条。
     *
     * @param lib   片库 id。**参与 key**：两个库各有《教父》时不能共用一条记录。
     *              传 null/空串 = 全局条目（旧数据与"不知道属于哪个库"的场景）。
     * @param force 跳过缓存直接重查。用于用户手动点「重新搜刮」——
     *              缓存命中就永远返回旧海报，用户改了片名想换一张时无路可走。
     */
    public static JSONObject lookup(String lib, String title, int year, boolean force)
            throws Exception {
        JSONObject out = new JSONObject();
        String key = keyOf(lib, title, year);
        try {
            out.put("title", title == null ? "" : title);
            out.put("year", year);
            out.put("ok", false);
        } catch (Exception ignored) {
        }

        if (title == null || title.trim().isEmpty()) return out;

        JSONObject c = cache();
        JSONObject hit = c.optJSONObject(key);
        if (!force && hit != null) {
            // 命中的永久保留；未命中的 10 分钟（见 TTL_MISS_MS 的说明）
            long ttl = hit.optBoolean("ok", false) ? KEEP_FOREVER : TTL_MISS_MS;
            if (System.currentTimeMillis() - hit.optLong("at", 0) < ttl) return hit;
        }

        // 逐级降级：实名搜不到就用中文片段再试。
        // 实测「白夜追凶 Day and Night」搜不到（豆瓣对中英混排不友好），
        // 而「白夜追凶」能命中——文件名解析出来的标题常带英文副标题。
        JSONArray found = searchDouban(title);
        JSONObject best = pick(found, title, year);
        if (best == null) {
            String chinese = chinesePart(title);
            if (!chinese.isEmpty() && !chinese.equals(title)) {
                best = pick(searchDouban(chinese), chinese, year);
            }
        }
        if (best == null) {
            String first = firstToken(title);
            if (!first.isEmpty() && !first.equals(title)) {
                best = pick(searchDouban(first), first, year);
            }
        }
        if (best == null) {
            // ★ 刮不到也要记住"查过了"，否则每次列目录都重打一遍外网。
            //   **但绝不能覆盖已有的成功记录**：数据无价，一次抖动不该抹掉
            //   已经刮到的东西。踩过的时序：
            //     T0      刮到《异物志》→ {ok:true, poster:...}
            //     T0+31d  缓存过期（旧逻辑 30 天）
            //     T0+31d  豆瓣抖动返回空 → 旧代码 c.put(key, {ok:false}) 覆盖
            //     → 原海报信息永久丢失，且 ok:false 只活 10 分钟，之后反复重试、
            //       每次抖动都继续覆盖
            //   现在的做法：成功记录不可被失败覆盖；失败只更新 missAt 供退避用。
            JSONObject prev = c.optJSONObject(key);
            if (prev != null && prev.optBoolean("ok", false)) {
                try {
                    // 只记"最近一次查失败的时间"，不动原有字段
                    prev.put("missAt", System.currentTimeMillis());
                    persist();
                } catch (Exception ignored) {
                }
                return prev;
            }
            try {
                out.put("at", System.currentTimeMillis());
            } catch (Exception ignored) {
            }
            c.put(key, out);
            persist();
            return out;
        }
        // 详情页补评分与简介。subject_suggest 只给片名/年份/海报，
        // 而移动版页面的 og:description 里同时带「豆瓣评分：X」和「简介：…」，
        // 一次请求就能拿到两项，比抓桌面版（302 反爬）稳得多。
        fillDetail(best, best.optString("id", ""));
        try {
            best.put("at", System.currentTimeMillis());
            best.put("ok", true);
        } catch (Exception ignored) {
        }
        c.put(key, best);
        persist();
        return best;
    }

    /** 从候选里挑最像的：年份相同优先，其次片名完全相等，最后取第一个。 */
    private static JSONObject pick(JSONArray found, String title, int year) {
        if (found == null || found.length() == 0) return null;
        JSONObject fallback = null;
        String want = normalize(title);
        for (int i = 0; i < found.length(); i++) {
            JSONObject o = found.optJSONObject(i);
            if (o == null) continue;
            if (fallback == null) fallback = o;
            String t = normalize(o.optString("title", ""));
            int y = o.optInt("year", 0);
            if (t.equals(want) && (year <= 0 || y == year)) return o;
            if (year > 0 && y == year && t.contains(want)) return o;
        }
        return fallback;
    }

    /**
     * 豆瓣 {@code subject_suggest}：返回 [{title, year, type, id, url}]。
     *
     * <p>为什么用这个而不是 frodo 的 search API：实测 frodo 的 search
     * 不带 apikey 返回 400，而 subject_suggest 直接 200，且字段够用
     * （片名、年份、条目 id）。它没给海报，海报另按 id 取。
     */
    private static JSONArray searchDouban(String title) {
        JSONArray out = new JSONArray();
        HttpURLConnection c = null;
        try {
            String q = URLEncoder.encode(title, "UTF-8");
            URL u = new URL("https://movie.douban.com/j/subject_suggest?q=" + q);
            // ★ 走 openCached：系统 DNS 坏掉时（NAS 的 resolv.conf 只有一个失效
            //   nameserver，实测）这里会抛 UnknownHost，表现成"每一部都搜不到"，
            //   和"豆瓣限流"长得一模一样，极难分辨。因此统一用带 DoH 兜底的连接。
            c = httpConnection(u, 6_000, 8_000);
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                            + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
            c.setRequestProperty("Referer", "https://movie.douban.com/");
            if (c.getResponseCode() != 200) return out;
            String text;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
                text = new String(bos.toByteArray(), StandardCharsets.UTF_8);
            }
            JSONArray arr = new JSONArray(text);
            for (int i = 0; i < arr.length() && i < 8; i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String t = o.optString("title", "");
                if (t.isEmpty()) continue;
                JSONObject item = new JSONObject();
                item.put("title", t);
                item.put("year", parseIntSafe(o.optString("year", "")));
                item.put("type", o.optString("type", ""));
                String id = o.optString("id", "");
                item.put("id", id);
                item.put("url", o.optString("url", ""));
                // 海报直接取响应里的 img 字段。
                // **不要按 id 拼**：豆瓣图床的文件名是 p<图片id>，与条目 id 无关，
                // 拼出来的地址必然 404（实测踩过）。
                String img = o.optString("img", "");
                if (!img.isEmpty()) item.put("poster", img);
                int ep = parseIntSafe(o.optString("episode", ""));
                if (ep > 0) item.put("episodes", ep);
                out.put(item);
            }
        } catch (Throwable t) {
            // 刮削失败必须静默退化：内网/离线是常态
        } finally {
            if (c != null) c.disconnect();
        }
        return out;
    }

    /** 抽出一段连续中文（片名里最常见的那部分）。 */
    static String chinesePart(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 0x4e00 && c <= 0x9fff) sb.append(c);
            else if (sb.length() > 0) break;
        }
        return sb.toString();
    }

    /** 第一个词（英文片名常见的降级候选）。 */
    static String firstToken(String s) {
        if (s == null) return "";
        final String SEP = "[" + (char) 92 + "s." + (char) 92 + "-_]+";
        for (String w : s.split(SEP)) {
            if (w.length() >= 2) return w;
        }
        return "";
    }

    private static int parseIntSafe(String s) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * 给一个目录的影片组批量补元数据。
     *
     * <p>并发度为 1（串行）**且每条之间有间隔**：豆瓣对密集请求敏感。
     * 实测：本机连着打 10 个片名两轮，第一轮 5/10 命中、第二轮 0/10 全空——
     * 不是刮削逻辑坏了，是被限流了。间隔 900ms 能把"连续 7 条"从必被限流
     * 变成基本可用。
     *
     * <p>连续失败 {@link #LIMIT_STREAK} 条就**提前收工**并标记 {@code rateLimited}：
     * 再打下去只会把后面的片名也写进"未命中"缓存（10 分钟 TTL），
     * 反而让恢复之后的十分钟里这些片仍然没有海报。
     */
    public static JSONArray enrich(JSONArray groups) throws Exception {
        return enrich(null, groups, false);
    }

    public static JSONArray enrich(JSONArray groups, boolean force) throws Exception {
        return enrich(null, groups, force);
    }

    /** 连续这么多条失败，就认定是限流而不是"这些片真的搜不到"。 */
    private static final int LIMIT_STREAK = 4;
    /** 两条之间的间隔。900ms ≈ 每分钟 66 次，低于实测会触发限流的频率。 */
    private static final long GAP_MS = 900L;

    /**
     * 批量补元数据。
     *
     * @param lib   片库 id，参与缓存 key（见 {@link #keyOf}）
     * @param force 跳过缓存重查（用户手动「重新搜刮」时用）
     */
    public static JSONArray enrich(String lib, JSONArray groups, boolean force) throws Exception {
        JSONArray out = new JSONArray();
        if (groups == null) return out;
        int streak = 0;
        for (int i = 0; i < groups.length(); i++) {
            JSONObject g = groups.optJSONObject(i);
            if (g == null) continue;
            // 命中缓存的那几条不用等——只有真要打外网的才间隔。
            // 判据在 lookup 内部，这里用一个便宜的近似：非 force 且缓存里有
            // 且未过期就跳过等待（多等一次也无害，最多慢 900ms）。
            boolean hitCache = !force && cached(lib, g.optString("title", ""), g.optInt("year", 0));
            if (!hitCache && i > 0 && !sleepGap()) break;
            try {
                JSONObject meta = lookup(lib, g.optString("title", ""), g.optInt("year", 0), force);
                JSONObject merged = new JSONObject(g.toString());
                String poster = meta.optString("poster", "");
                if (!poster.isEmpty()) merged.put("poster", poster);
                if (meta.optInt("year", 0) > 0 && merged.optInt("year", 0) <= 0) {
                    merged.put("year", meta.optInt("year", 0));
                }
                if (!meta.optString("id", "").isEmpty()) merged.put("doubanId", meta.optString("id", ""));
                boolean ok = meta.optBoolean("ok", false);
                merged.put("scraped", ok);
                // 命中的豆瓣条目标题：`pick()` 匹配不上时会退回第一条建议，
                // 前端拿它复核"这条到底沾不沾亲"（季名刮削用，见 LibraryView.doScrapeDirs）。
                // 只在命中时回传，刮不到时 title 就是请求名，回传反而会误导。
                if (ok) merged.put("matchedTitle", meta.optString("title", ""));
                if (ok) streak = 0;
                else streak++;
                out.put(merged);
                // 连续失败太多次：判定限流，剩下的原样返回并打标记，
                // **不要**写进缓存（lookup 里未命中的写入发生在它自己内部，
                // 这里只能阻止继续发生）。
                if (streak >= LIMIT_STREAK) {
                    for (int j = i + 1; j < groups.length(); j++) {
                        JSONObject rest = groups.optJSONObject(j);
                        if (rest != null) out.put(new JSONObject(rest.toString()).put("scraped", false));
                    }
                    return withFlag(out, "rateLimited", true);
                }
            } catch (Exception e) {
                out.put(g);
            }
        }
        return withFlag(out, "rateLimited", false);
    }

    /** 缓存里是否有一条**未过期且命中**的记录（用于免掉两次请求间的等待）。 */
    private static boolean cached(String lib, String title, int year) {
        if (title == null || title.trim().isEmpty()) return false;
        try {
            JSONObject hit = cache().optJSONObject(keyOf(lib, title, year));
            if (hit == null) return false;
            long ttl = hit.optBoolean("ok", false) ? KEEP_FOREVER : TTL_MISS_MS;
            return System.currentTimeMillis() - hit.optLong("at", 0) < ttl;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 把标记挂在数组上。
     *
     * <p>org.json 的 JSONArray 不能带字段，所以用一个**末尾哨兵元素**：
     * {@code {"__meta":{...}}}。前端 `scrapeGroups` 过滤掉它即可。
     * 选择这种做法而不是改返回结构，是为了不破坏已有的 items 契约
     * （PC/TV 上有旧版本前端只读 items 数组）。
     */
    private static JSONArray withFlag(JSONArray items, String key, boolean value) {
        try {
            items.put(new JSONObject().put("__meta", new JSONObject().put(key, value)));
        } catch (Exception ignored) {
        }
        return items;
    }

    /** 可被打断的等待：线程被中断直接返回 false（调用方据此收工）。 */
    private static boolean sleepGap() {
        try {
            Thread.sleep(GAP_MS);
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /**
     * 从移动版详情页补评分与简介。
     *
     * <p><b>为什么用 m.douban.com</b>：桌面版 {@code /subject/{id}/} 实测直接 302
     * 到验证页（反爬），而移动版 200 且 {@code og:description} 里就写着
     * "白夜追凶豆瓣评分：8.9 简介：…"。一次请求两项都有，不需要再抓别的接口。
     *
     * <p>抓不到就算了：评分/简介是锦上添花，不能因为详情页失败让整条刮削结果作废。
     */
    private static void fillDetail(JSONObject target, String doubanId) {
        if (doubanId == null || doubanId.isEmpty()) return;
        HttpURLConnection c = null;
        try {
            URL u = new URL("https://m.douban.com/movie/subject/" + doubanId + "/");
            c = httpConnection(u, 6_000, 8_000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                            + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
            if (c.getResponseCode() != 200) return;
            String html;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
                html = new String(bos.toByteArray(), StandardCharsets.UTF_8);
            }
            // og:description 形如：
            //   白夜追凶豆瓣评分：8.9 简介：一场灭门惨案，让原本…
            String desc = between(html, "property=\"og:description\" content=\"", "\"");
            if (desc.isEmpty()) return;
            int scoreAt = desc.indexOf("豆瓣评分：");
            if (scoreAt >= 0) {
                int i = scoreAt + "豆瓣评分：".length();
                StringBuilder sb = new StringBuilder();
                while (i < desc.length() && (Character.isDigit(desc.charAt(i)) || desc.charAt(i) == '.')) {
                    sb.append(desc.charAt(i));
                    i++;
                }
                if (sb.length() > 0) {
                    try {
                        target.put("rating", Double.parseDouble(sb.toString()));
                    } catch (Exception ignored) {
                    }
                }
            }
            int introAt = desc.indexOf("简介：");
            if (introAt >= 0) {
                String intro = desc.substring(introAt + "简介：".length()).trim();
                // 去掉末尾的"…"和多余空白，控制长度避免把 meta.json 撑大
                if (intro.endsWith("…")) intro = intro.substring(0, intro.length() - 1);
                if (intro.length() > 300) intro = intro.substring(0, 300) + "…";
                if (!intro.isEmpty()) target.put("intro", intro);
            }
        } catch (Exception ignored) {
            // 详情补不上不影响主流程
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String between(String s, String start, String end) {
        int a = s.indexOf(start);
        if (a < 0) return "";
        a += start.length();
        int b = s.indexOf(end, a);
        if (b < 0) return "";
        return s.substring(a, b).replace("&quot;", "\"").replace("&amp;", "&").trim();
    }

    /** 清理缓存（设置页"清空刮削缓存"用）。 */
    public static boolean clear() {
        synchronized (Scrape.class) {
            CACHE = new JSONObject();
            return DataPaths.write(CACHE_FILE, "{}");
        }
    }

    /**
     * 解除一条绑定（删掉这部片的刮削结果）。
     *
     * <p>为什么按片名+年份删而不是按条目 id：缓存是「片名 → 豆瓣条目」的映射，
     * 键由片名归一化得到，没有独立 id。前端手里有的正是片名和年份。
     *
     * <p>删完再查会重新走一次豆瓣，所以「解除绑定」的可见效果是：这张海报消失，
     * 下次列目录时重新匹配（可能匹配到同一条，也可能匹配到别的）。
     */
    public static boolean unbind(String title, int year) {
        return unbind(null, title, year);
    }

    /**
     * 解除一条绑定（带库维度）。
     *
     * <p>除了删本库那条，**还会清掉旧的全局条目**（`片名|年份` 格式）——
     * 那是加库维度之前留下的，不删的话"解除绑定"看起来没生效：
     * 界面读的是带库的 key（删了），但旧条目还在，某些路径仍能命中它。
     */
    public static boolean unbind(String lib, String title, int year) {
        if (title == null || title.trim().isEmpty()) return false;
        String key = keyOf(lib, title, year);
        String legacy = normalize(title) + "|" + (year > 0 ? year : "");
        synchronized (Scrape.class) {
            JSONObject c = cache();
            boolean touched = c.has(key);
            if (touched) c.remove(key);
            if (!legacy.equals(key) && c.has(legacy)) {
                c.remove(legacy);
                touched = true;
            }
            if (!touched) return false;
            return DataPaths.write(CACHE_FILE, c.toString());
        }
    }
}
