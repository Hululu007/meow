package core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * DoH（DNS over HTTPS）解析，供**所有需要出网的模块**共用。
 *
 * <p><b>为什么必须抽出来</b>：这台机器踩过一次真实故障——NAS 的网络配置里
 * DNS 被写死成一个已经失效的地址（`/etc/resolv.conf` 只有那一条 nameserver），
 * 于是容器内**任何域名都解析不了**。表现是两处同时坏：
 * <ul>
 *   <li>{@code /api/proxy/image} 对豆瓣图床返回 403 {@code url not allowed}
 *       —— 那是 {@link UrlSafety} 解析不出 IP 时的拒绝，不是图床拒绝；</li>
 *   <li>刮削全部失败，且看起来像"豆瓣限流"。</li>
 * </ul>
 * 而同一时刻 {@code /api/dns/resolve?host=img3.doubanio.com} 用 DoH 能正常
 * 拿到 IP。也就是说：**能出网，只是系统 DNS 坏了**。
 *
 * <p>所以 DoH 不能只给视频代理那一条路用。{@link UrlSafety} 的安全判定、
 * {@link Scrape} 的抓取、以及 {@code /api/proxy/*} 都走这里，
 * 由 {@code policy.safeDns} 统一开关。
 *
 * <p>provider 支持内置名（ali/dnspub/360/google/cloudflare）或直接给完整 URL。
 */
public final class Doh {

    private Doh() {
    }

    private static final Map<String, String> PROVIDERS = new java.util.LinkedHashMap<>();

    static {
        PROVIDERS.put("ali", "https://223.5.5.5/resolve");
        PROVIDERS.put("dnspub", "https://doh.pub/dns-query");
        PROVIDERS.put("360", "https://doh.360.cn/resolve");
        PROVIDERS.put("google", "https://dns.google/resolve");
        PROVIDERS.put("cloudflare", "https://cloudflare-dns.com/dns-query");
    }

    /** 内置 provider 表（供 /api/dns/resolve 与诊断展示）。 */
    public static Map<String, String> providers() {
        return PROVIDERS;
    }

    /** 缓存：`provider|host` → {ip, 记录时间}。TTL 5 分钟。 */
    private static final Map<String, Object[]> CACHE = new ConcurrentHashMap<>();
    private static final long TTL_MS = 300_000L;

    /** 解析失败后短时间内不要反复打 DoH（DNS 坏时每次都要 6 秒超时）。 */
    private static final Map<String, Long> FAIL_UNTIL = new ConcurrentHashMap<>();
    private static final long FAIL_BACKOFF_MS = 15_000L;

    /** provider 级熔断：某个 provider 整体不可达时，{@link #DOWN_UNTIL} 之前跳过它。 */
    private static final Map<String, Long> DOWN_UNTIL = new ConcurrentHashMap<>();
    private static final long DOWN_BACKOFF_MS = 120_000L;

    /**
     * 降级顺序。
     *
     * <p><b>为什么必须有多 provider 降级</b>：实测这台 NAS 上 `doh.pub`
     * 整个不可达（`wget` 直接失败），而同一时刻 `223.5.5.5` / `doh.360.cn` /
     * `dns.google` 都正常。用户 policy 里配的正是 `dnspub`，于是"有 DoH"这件事
     * 只在纸面上成立——系统 DNS 坏了 + 配的那个 DoH 也不通 = 全线失败。
     * 所以配的那个只当**首选**，不通就按这个顺序换。
     */
    private static final String[] FALLBACK_ORDER = {"ali", "360", "dnspub", "google", "cloudflare"};

    /**
     * 解析 A 记录（带 provider 降级）。
     *
     * @return IP；所有 provider 都失败返回 null（调用方按"不可达"处理）
     */
    public static String resolve(String host, String provider) {
        if (host == null || host.isEmpty()) return null;
        String prov = provider == null || provider.isEmpty() ? "ali" : provider;
        String key = prov + "|" + host;
        long now = System.currentTimeMillis();
        Object[] hit = CACHE.get(key);
        if (hit != null && now - (Long) hit[1] < TTL_MS) return (String) hit[0];
        Long failAt = FAIL_UNTIL.get(key);
        if (failAt != null && now < failAt) return null;

        for (String p : chain(prov)) {
            Long down = DOWN_UNTIL.get(p);
            if (down != null && now < down) continue;
            try {
                String ip = query(host, p);
                if (ip != null && !ip.isEmpty()) {
                    CACHE.put(key, new Object[]{ip, now});
                    FAIL_UNTIL.remove(key);
                    return ip;
                }
                // 拿到空结果：可能是"真没有这条记录"，也可能是 provider 静默失败。
                // 打一下熔断，换下一个 provider 再试一次。
                DOWN_UNTIL.put(p, now + DOWN_BACKOFF_MS);
            } catch (Exception e) {
                DOWN_UNTIL.put(p, now + DOWN_BACKOFF_MS);
            }
        }
        FAIL_UNTIL.put(key, now + FAIL_BACKOFF_MS);
        return null;
    }

    /** 首选 provider 打头，其余按 FALLBACK_ORDER 补齐（去重）。 */
    private static java.util.List<String> chain(String preferred) {
        java.util.List<String> out = new java.util.ArrayList<>();
        out.add(preferred);
        for (String p : FALLBACK_ORDER) {
            if (!out.contains(p)) out.add(p);
        }
        return out;
    }

    /**
     * 解析出**全部** A 记录，按顺序返回（去重）。
     *
     * <p><b>为什么调用方需要「全部」而不是「第一个」</b>：实测踩过——
     * {@code img3.doubanio.com}（阿里 CDN）一次返回 16 个 IP，而某台 NAS 到
     * 其中一部分 IP 的连接会超时（实测 10–26 秒才失败），到另一部分 0.2 秒就通。
     * 只取第一个 IP 时，只要那一个不通，整面海报墙就是裂的——而同一时刻
     * 从别的机器直连这些 URL 全都正常，看起来像"豆瓣挂了"，极难定位。
     *
     * <p>调用方应逐个尝试，第一个连不通就换下一个。
     */
    public static java.util.List<String> candidates(String host, String provider) {
        return new java.util.ArrayList<>(resolveAll(host, provider));
    }

    /**
     * 解析多个 A 记录（安全判定要看**每一个**地址，不能只抽第一个：
     * 一个域名同时返回公网与内网 IP 时，只看第一个会漏掉内网那个）。
     */
    public static java.util.List<String> resolveAll(String host, String provider) {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (host == null || host.isEmpty()) return out;
        String prov = provider == null || provider.isEmpty() ? "ali" : provider;
        String key = "all|" + prov + "|" + host;
        long now = System.currentTimeMillis();
        Object[] hit = CACHE.get(key);
        if (hit != null && now - (Long) hit[1] < TTL_MS) {
            @SuppressWarnings("unchecked")
            java.util.List<String> cached = (java.util.List<String>) hit[0];
            return cached;
        }
        Long failAt = FAIL_UNTIL.get(key);
        if (failAt != null && now < failAt) return out;

        for (String p : chain(prov)) {
            Long down = DOWN_UNTIL.get(p);
            if (down != null && now < down) continue;
            try {
                JSONObject o = fetch(host, p);
                JSONArray ans = o == null ? null : o.optJSONArray("Answer");
                java.util.List<String> got = new java.util.ArrayList<>();
                if (ans != null) {
                    for (int i = 0; i < ans.length(); i++) {
                        JSONObject a = ans.optJSONObject(i);
                        if (a == null) continue;
                        if (a.optInt("type") == 1) {
                            String ip = a.optString("data", "");
                            if (!ip.isEmpty()) got.add(ip);
                        }
                    }
                }
                if (!got.isEmpty()) {
                    CACHE.put(key, new Object[]{got, now});
                    FAIL_UNTIL.remove(key);
                    return got;
                }
                DOWN_UNTIL.put(p, now + DOWN_BACKOFF_MS);
            } catch (Exception e) {
                DOWN_UNTIL.put(p, now + DOWN_BACKOFF_MS);
            }
        }
        FAIL_UNTIL.put(key, now + FAIL_BACKOFF_MS);
        return out;
    }

    private static String query(String host, String provider) throws Exception {
        JSONObject o = fetch(host, provider);
        JSONArray ans = o == null ? null : o.optJSONArray("Answer");
        if (ans == null) return null;
        for (int i = 0; i < ans.length(); i++) {
            JSONObject a = ans.optJSONObject(i);
            if (a == null) continue;
            if (a.optInt("type") == 1) {
                String ip = a.optString("data", "");
                if (!ip.isEmpty()) return ip;
            }
        }
        return null;
    }

    private static JSONObject fetch(String host, String provider) throws Exception {
        String base = provider.startsWith("http") ? provider : PROVIDERS.getOrDefault(provider, PROVIDERS.get("ali"));
        String url = base + (base.contains("?") ? "&" : "?") + "name="
                + URLEncoder.encode(host, "UTF-8") + "&type=A";
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(6000);
        c.setReadTimeout(6000);
        c.setRequestProperty("Accept", "application/dns-json");
        c.setRequestProperty("User-Agent", "meow-player/0.1");
        if (c.getResponseCode() >= 400) {
            c.disconnect();
            return null;
        }
        InputStream in = c.getInputStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        in.close();
        c.disconnect();
        return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
    }

    /**
     * 系统 DNS 解析失败时，退到 DoH 再试一次。
     *
     * <p>顺序刻意是「系统 DNS 优先」：正常机器上系统 DNS 更快、且走了本地缓存，
     * 只有它挂了（解析不出 / 抛异常）才值得多花一次 DoH 往返。
     * 反过来优先 DoH 会让每台好机器都多付一次 HTTPS 开销。
     *
     * @return 地址数组；两次都失败时返回空数组（**不抛**，由调用方决定怎么拒绝）
     */
    public static InetAddress[] resolveWithFallback(String host, String provider) {
        try {
            InetAddress[] got = InetAddress.getAllByName(host);
            if (got != null && got.length > 0) {
                // 系统解析到了，但可能是 fake-ip（TUN 代理）。safeDns 开着时
                // 仍用 DoH 覆盖，理由见 ApiServer.openStream 的注释。
                if (!isFakeIp(got)) return got;
            }
        } catch (Exception ignored) {
            /* 系统 DNS 挂了，落到 DoH */
        }
        java.util.List<String> ips = resolveAll(host, provider);
        if (ips.isEmpty()) return new InetAddress[0];
        java.util.List<InetAddress> out = new java.util.ArrayList<>();
        for (String ip : ips) {
            try {
                // 用 getByAddress 而不是 getByName：后者会再走一次系统 DNS
                byte[] raw = ipToBytes(ip);
                if (raw != null) out.add(InetAddress.getByAddress(host, raw));
            } catch (Exception ignored) {
            }
        }
        return out.toArray(new InetAddress[0]);
    }

    /** TUN 代理的 fake-ip 段（198.18.0.0/15）。 */
    private static boolean isFakeIp(InetAddress[] addrs) {
        for (InetAddress a : addrs) {
            byte[] b = a.getAddress();
            if (b.length == 4 && (b[0] & 0xff) == 198 && ((b[1] & 0xff) == 18 || (b[1] & 0xff) == 19)) {
                return true;
            }
        }
        return false;
    }

    private static byte[] ipToBytes(String ip) {
        String[] parts = ip.split("\\.");
        if (parts.length != 4) return null; // 只处理 IPv4；IPv6 交给系统 DNS
        byte[] b = new byte[4];
        try {
            for (int i = 0; i < 4; i++) {
                int v = Integer.parseInt(parts[i]);
                if (v < 0 || v > 255) return null;
                b[i] = (byte) v;
            }
        } catch (NumberFormatException e) {
            return null;
        }
        return b;
    }
}
