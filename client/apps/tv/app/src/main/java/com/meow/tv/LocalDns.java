package com.meow.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.github.catvod.bean.Doh;
import com.github.catvod.net.OkHttp;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 把配置里的 {@code hosts} / {@code doh} 表接到 catvod 的 OkHttp 客户端。
 *
 * <p><b>为什么必须有这一步</b>：TV 的 spider 全部通过 {@code com.github.catvod.net.OkHttp}
 * 发请求，而它的 {@link com.github.catvod.net.OkDns} 是这样工作的：
 * <pre>
 * lookup(host) {
 *   if (supplier != null) initDoh(supplier);
 *   return (doh != null ? doh : Dns.SYSTEM).lookup(get(host));
 * }
 * </pre>
 * 也就是说 <b>没人调 {@code setDoh} 就永远走系统 DNS</b>。上游 Fongmi 靠设置页让用户
 * 手选 DoH 提供商，我们 TV 端从来没有那个入口，于是 {@code doh} 恒为 null。
 *
 * <p><b>实测症状</b>（MuMu，对比同一份配置的 docker 后端）：
 * <pre>
 * Gulu   TV: n=0  7.7s   |  docker: n=3  0.2s
 * Gz360  TV: n=0  1.1s   |  docker: n=2  0.6s
 * AppRJ  TV: n=0  0.2s   |  docker: n=1  0.2s
 * </pre>
 * 而且 TV 上 {@code ping gulu.tv} 解析到 {@code overdue.aliyun.com}（域名停放页）
 * —— 运营商的 DNS 污染。后端有 {@code core.Doh} 绕开，TV 没有，所以那 5 个站
 * 在 TV 上永远搜不到东西，但进程不崩、配置也对，极难归因。
 *
 * <p><b>为什么用配置里的 doh 表而不是硬编码公共 DoH</b>：用户所在网络下
 * 公共 DoH（Google / Cloudflare）常常也不通，配置里给的那几条是他自己验证过的。
 * 与后端 {@code dohProviderFromTable()} 保持同一优先级。
 */
public final class LocalDns {

    private static final String TAG = "MeowDns";
    private static final String PREF = "meow_tv_sites";
    /** 原始配置的 key（与 LocalSites.KEY_RAW 一致，见那里注释） */
    private static final String KEY_RAW = "config_raw";

    /** 上次应用的配置文件长度。用来判断"配置变了没有"，比逐次解析省得多。 */
    private static volatile long appliedLen = -1;

    /**
     * 配置变了就重新应用一次（每个请求前调，开销只有一次 stat）。
     *
     * <p><b>为什么需要它</b>：网关的 {@code /api/config/import} 走的是复用来的
     * 后端代码，**完全不经过 TV 的任何 Java 类**——没有回调点可以挂。
     * 而 {@code hosts}/{@code doh} 必须在导入后立刻生效，否则用户导入完
     * 马上搜索仍然搜不到（要等下次重启），看起来像"导入没生效"。
     *
     * <p>判据只用文件长度：配置变更时长度几乎必然改变（改一个站点名就会变），
     * 而误判的代价只是多解析一次 JSON。用 mtime 在部分 Android 机型上
     * 精度只有秒，反而不如长度可靠。
     */
    /**
     * 是否启用 DoH。**默认开启**（2026-10-29 起，靠 OkDns 的失败回退保证安全）。
     *
     * <p><b>历史</b>：早先默认关闭，因为实测（MuMu Android 15，两次独立验证）
     * 一旦 {@code setDoh(...)} 生效就**所有源一起挂**：
     * <pre>
     *   开 DoH: AppGet 0.1s n=0 | SaoHuo 0.1s n=0 | SP360 0.9s n=0  （11 站全空）
     *   关 DoH: AppGet 0.4s n=1 | SaoHuo 3.9s n=1 | SP360 2.0s n=1  （5/11 可用）
     * </pre>
     * 而同一页面里直接 fetch 阿里 DoH 返回 200 —— 网络与 DoH 服务都通，
     * 问题在 {@code okhttp-dnsoverhttps} 在该 ROM 上的请求被 reset。
     *
     * <p><b>为什么现在能开</b>：根因不是"DoH 有害"，是 {@code OkDns.lookup}
     * 那时**没有失败回退** —— 有 DoH 就只用 DoH，它抛异常就直接向上抛，
     * 于是一次解析失败 = 整站不可用。给 OkDns 补上"DoH 失败/空结果 → 退回系统 DNS"
     * 之后同一环境实测：
     * <pre>
     *   开 DoH + 回退: 3 轮均 36 条 / 11 源，中位 5.4s（与关闭时持平）
     * </pre>
     * 也就是"DoH 能用就绕开污染，不能用就退回系统 DNS"，两头都不吃亏。
     *
     * <p>要注意的能力边界：系统 DNS 本身是被污染的那个，所以回退只保证
     * "没被污染的域名照常可用"，绕开污染仍然依赖 DoH 真的可用。
     */
    private static boolean dohEnabled() {
        return true;
    }

    static void refreshIfChanged(Context ctx) {
        if (ctx == null) return;
        try {
            java.io.File f = configFile(ctx);
            long len = f.isFile() ? f.length() : -1;
            if (len == appliedLen) return;
            appliedLen = len;
            applyStored(ctx);
        } catch (Throwable t) {
            Log.w(TAG, "refreshIfChanged failed: " + t.getClass().getSimpleName());
        }
    }

    /** 网关数据目录里的完整配置（后端导入写的那个）。 */
    private static java.io.File configFile(Context ctx) {
        return new java.io.File(new java.io.File(ctx.getFilesDir(), "gateway"),
                "config.sites.json");
    }

    /**
     * 给已知的 DoH 域名补 bootstrap IP。
     *
     * <p>只覆盖内置那三家；其他（Google / Cloudflare 等）返回空 —— 它们的
     * IP 我们没有可靠来源，且在国内本来也不可用（见 pickReachableDoh 的注释）。
     */
    private static java.util.List<String> bootstrapIpsFor(String url) {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (url.contains("alidns.com")) {
            out.add("223.5.5.5");
            out.add("223.6.6.6");
        } else if (url.contains("doh.pub")) {
            out.add("1.12.12.12");
            out.add("120.53.53.53");
        } else if (url.contains("doh.360.cn")) {
            out.add("101.226.4.6");
            out.add("218.30.118.6");
        }
        return out;
    }

    /**
     * 从配置的 doh 表里挑一个**国内可达**的提供商。
     *
     * <p>顺序：先找白名单里的（阿里 / 腾讯 / 360 —— 这三家在国内实测可用），
     * 一个都没有才退回配置里的第一条。白名单是域名匹配，因为配置里给的是
     * 完整 URL（`https://dns.alidns.com/resolve`）。
     *
     * <p>为什么要这个白名单：配置的第一条是 Google DoH，它的 IP 能 ping 通
     * 但 HTTPS 请求被阻断 —— 用它会让**所有** DNS 查询超时，比不开 DoH 还糟。
     */
    private static Doh pickReachableDoh(JSONArray rows) {
        String[] preferred = {"alidns.com", "doh.pub", "doh.360.cn", "dnspod", "qq.com"};
        Doh firstForeign = null;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject o = rows.optJSONObject(i);
            if (o == null) continue;
            String url = o.optString("url", "").trim();
            if (!url.startsWith("http")) continue;
            // Doh 是 Gson bean（只有 getter），用 objectFrom 从同一份 JSON 造，
            // 比自己拼字段稳，也不会漏掉新增的 @SerializedName 字段。
            Doh item = Doh.objectFrom(o.toString());
            if (item.getIps() == null || item.getIps().isEmpty()) {
                /*
                 * 配置里没给 ips → 补一个已知的 bootstrap IP。
                 *
                 * 不补的话 DnsOverHttps 会退回系统 DNS 去解析 DoH 域名，
                 * 而系统 DNS 正是我们要绕开的污染源（实测结果：所有源
                 * 一起 0.0s 返回空，比不开 DoH 还差）。补的是同域名的
                 * 公共 IP，与内置 DoH.get() 用同一组。
                 */
                item.ips(bootstrapIpsFor(url));
            }
            if (firstForeign == null) firstForeign = item;
            for (String host : preferred) {
                if (url.contains(host)) return item;
            }
        }
        /*
         * ★ 配置里有 doh 表但全是国外服务（实测：Google / Cloudflare /
         * AdGuard / DNSWatch / Quad9 五条，一条国内都没有）→ **不要**用它。
         *
         * 踩过：退回第一条 Google DoH 后，该 IP 能 ping 通（192ms）但 HTTPS
         * 请求被阻断，于是每次 DNS 查询超时、**所有站点一起挂**
         * （AppGet / SaoHuo / AppDrama2 全部 timed out），比不开 DoH 还糟。
         *
         * 这时用内置的国内 DoH（阿里 / 腾讯 / 360）—— 它们在同一网络下实测可用。
         * 顺序上仍优先用户配置：只有当配置里没有任何国内提供商时才这么做。
         */
        java.util.List<Doh> builtin = Doh.get(null);
        if (!builtin.isEmpty()) {
            Doh cn = builtin.get(0);
            Log.i(TAG, "doh 表全是国外服务，改用内置国内 " + cn.getUrl()
                    + "（原第一条 " + (firstForeign == null ? "-" : firstForeign.getUrl()) + "）");
            return cn;
        }
        if (firstForeign != null) {
            Log.w(TAG, "没有任何国内 DoH 可用，退回配置第一条：" + firstForeign.getUrl()
                    + "（若网络受限会导致所有 DNS 超时）");
        }
        return firstForeign;
    }

    private LocalDns() {
    }

    /**
     * 应用一次配置里的 DNS 相关表。可重复调用（幂等）。
     *
     * @param cfg 整份 CatVod 配置（可能为 null）
     */
    static void apply(JSONObject cfg) {
        if (cfg == null) return;
        try {
            /*
             * hosts 表：形如 ["a.com=1.2.3.4", ...]，含通配（*.a.com）。
             * OkDns.addAll 内部会按 "=" 切分并保留通配规则。
             */
            JSONArray hosts = cfg.optJSONArray("hosts");
            if (hosts != null && hosts.length() > 0) {
                java.util.List<String> list = new java.util.ArrayList<>();
                for (int i = 0; i < hosts.length(); i++) {
                    String h = hosts.optString(i, "").trim();
                    if (!h.isEmpty()) list.add(h);
                }
                if (!list.isEmpty()) {
                    OkHttp.dns().addAll(list);
                    Log.i(TAG, "hosts: 载入 " + list.size() + " 条");
                }
            }

            /*
             * doh 表：取第一个 http(s) 的 url。与后端 dohProviderFromTable 同序。
             *
             * 用 Supplier 形式而不是直接 setDoh(item)：OkDns 的 supplier 是
             * 惰性初始化（首次 lookup 才建 DnsOverHttps），避免应用启动时就
             * 建一个 OkHttpClient。构造 Doh 需要解析 ips 数组。
             */
            JSONArray dohRows = cfg.optJSONArray("doh");
            if (dohRows != null && dohRows.length() > 0) {
                /*
                 * ★ 优先国内可达的 DoH。
                 *
                 * 踩过（实测，代价是"全部源挂掉"）：配置的 doh 表第一条是
                 * `https://dns.google/dns-query`（Google DoH）。它的 IP 能 ping
                 * 通（192ms），但 HTTPS 的 DoH 请求在国内基本被阻断 ——
                 * 一旦设成它，**每次 DNS 查询都超时**，所有站点一起挂：
                 *   AppGet / SaoHuo / AppDrama2 全部 timed out
                 * 比不开 DoH 还糟（不开时至少没被污染的域名还能用）。
                 *
                 * 所以按"国内可达性"排序，而不是照抄配置顺序：
                 * 先挑已知在国内可用的提供商（阿里/腾讯/360），
                 * 一个都没有才用配置里的第一条。
                 */
                final Doh chosen = pickReachableDoh(dohRows);
                if (chosen != null) {
                    if (dohEnabled()) {
                        OkHttp.dns().setDoh(() -> chosen);
                        Log.i(TAG, "doh: " + chosen.getUrl() + "（bootstrap "
                                + (chosen.getIps() == null ? 0 : chosen.getIps().size()) + " 个 IP）");
                    } else {
                        Log.i(TAG, "doh: 默认关闭（本 ROM 上 okhttp-dnsoverhttps 会让所有源失效），"
                                + "配置想用的 " + chosen.getUrl() + " 未启用");
                    }
                    return;
                }
                Log.w(TAG, "doh 表里没有可用的 http(s) url —— 仍走系统 DNS");
            } else {
                /*
                 * 配置里没有 doh 表：用内置公共 DoH 兜底。
                 *
                 * 不兜底的话，没配 doh 的那份配置在污染网络下会有一批源
                 * 静默搜不到（见类注释里的实测数字）。
                 * Doh.get() 内置阿里/腾讯/360 三家，都是国内可达的。
                 */
                java.util.List<Doh> builtin = Doh.get(null);
                if (!builtin.isEmpty() && dohEnabled()) {
                    final Doh item = builtin.get(0);
                    OkHttp.dns().setDoh(() -> item);
                    Log.i(TAG, "doh: 配置无 doh 表，用内置 " + item.getUrl());
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "apply failed: " + t.getClass().getSimpleName(), t);
        }
    }

    /**
     * 启动时调用：按磁盘上的最新配置应用一次 hosts/doh。
     *
     * <p><b>为什么读两处</b>：TV 上有两条导入路径，落点不同——
     * <ol>
     *   <li><b>网关的 {@code /api/config/import}</b>（走复用来的后端代码）
     *       写到 {@code filesDir/gateway/config.sites.json}。这是用户正常
     *       操作走的路（设置页「导入到本机」）</li>
     *   <li><b>TvBridge 的桥方法</b>（老的端内导入）从 {@code config_raw}
     *       读 SharedPreferences</li>
     * </ol>
     * 只读 SharedPreferences 的话，第 1 条路导入的配置完全看不到——
     * 实测就是这样：站表有 235 个、DNS 表一条没生效。
     *
     * <p>优先用网关那份（更新更全，61KB 含全部 13 张表），没有才回退。
     */
    static void applyStored(Context ctx) {
        if (ctx == null) return;
        // 1) 网关数据目录里的完整配置（后端导入写的）
        try {
            java.io.File f = new java.io.File(new java.io.File(ctx.getFilesDir(), "gateway"),
                    "config.sites.json");
            if (f.isFile() && f.length() > 2) {
                byte[] buf = new byte[(int) f.length()];
                try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                    int off = 0;
                    while (off < buf.length) {
                        int n = in.read(buf, off, buf.length - off);
                        if (n < 0) break;
                        off += n;
                    }
                }
                apply(new JSONObject(new String(buf, java.nio.charset.StandardCharsets.UTF_8)));
                return;
            }
        } catch (Throwable t) {
            Log.w(TAG, "读网关配置失败：" + t.getClass().getSimpleName());
        }
        // 2) 回退：SharedPreferences 里的原始配置（老的端内导入路径）
        try {
            String raw = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                    .getString(KEY_RAW, "");
            if (raw == null || raw.isEmpty()) {
                // 两条路都没配置：用内置公共 DoH 兜底，至少别裸奔系统 DNS
                apply(new JSONObject());
                return;
            }
            apply(new JSONObject(raw));
        } catch (Throwable t) {
            Log.w(TAG, "applyStored failed: " + t.getClass().getSimpleName());
        }
    }
}
