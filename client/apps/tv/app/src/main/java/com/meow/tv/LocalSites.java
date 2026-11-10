package com.meow.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.FileInputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 端上站点表：哪些站点由本地 jar 执行。
 *
 * ## 为什么单独存一份，而不是复用后端的
 *
 * 后端在别的机器上（甚至不存在），它的站点表 TV 读不到。
 * 端上执行是 TV 独有的能力，站点表也必须端上维护。
 *
 * ## 存哪
 *
 * SharedPreferences（App 私有）。存 JSON 字符串而不是建数据库：
 * 一个配置几百个站点，序列化一次几毫秒，没有查询需求。
 */
public final class LocalSites {

    private static final String PREF = "meow_tv_sites";
    private static final String KEY = "sites";
    private static final String TAG = "MeowSites";

    /** 一个本地执行的站点 */
    static final class Site {
        String key = "";       // 路由用的名字（/api/{key}/home）
        String name = "";      // 显示名
        String api = "";       // csp_Xxx
        String jar = "";       // jar 地址（不含 ;md5;）
        String md5 = "";       // 期望 md5，空 = 不校验
        String ext = "";       // 站点 ext（spider 的 init 参数）
    }

    private static final Map<String, Site> TABLE = new LinkedHashMap<>();
    private static volatile boolean loaded;

    private LocalSites() {
    }

    static synchronized void load(Context ctx) {
        if (loaded) return;
        loaded = true;
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_MULTI_PROCESS);
            String raw = sp.getString(KEY, "");
            if (raw == null || raw.isEmpty()) return;
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Site s = new Site();
                s.key = o.optString("key", "");
                s.name = o.optString("name", s.key);
                s.api = o.optString("api", "");
                s.jar = o.optString("jar", "");
                s.md5 = o.optString("md5", "");
                s.ext = o.optString("ext", "");
                if (!s.key.isEmpty() && !s.api.isEmpty() && !s.jar.isEmpty()) {
                    TABLE.put(s.key, s);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "load failed", t);
        }
    }

    static synchronized void save(Context ctx) {
        try {
            JSONArray arr = new JSONArray();
            for (Site s : TABLE.values()) {
                JSONObject o = new JSONObject();
                o.put("key", s.key);
                o.put("name", s.name);
                o.put("api", s.api);
                o.put("jar", s.jar);
                o.put("md5", s.md5);
                o.put("ext", s.ext);
                arr.put(o);
            }
            ctx.getSharedPreferences(PREF, Context.MODE_MULTI_PROCESS)
                    .edit().putString(KEY, arr.toString()).apply();
        } catch (Throwable t) {
            Log.w(TAG, "save failed", t);
        }
    }

    static Site get(String key) {
        return TABLE.get(key);
    }

    /** 全部站点（类加载钩子按需准备 jar 时遍历用）。 */
    static java.util.List<Site> all() {
        return new java.util.ArrayList<>(TABLE.values());
    }

    static int size() {
        return TABLE.size();
    }

    /**
     * 从一份 CatVod 配置里挑出"本机能执行"的站点。
     *
     * <p>只收 `api` 是 `csp_` 且配置里带 jar 的：drpy（.js）需要 JS 引擎、
     * 直接 http 的不需要本地执行。跳过的原因要能报出来（见 {@link ImportResult}）。
     */
    static ImportResult importFrom(Context ctx, String configJson, String configBase) {
        ImportResult r = new ImportResult();
        configBase = core.ConfigText.idnUrl(configBase);
        try {
            JSONObject cfg = new JSONObject(configJson);
            // DNS 相关的表（hosts / doh）必须在这里就应用：spider 的第一次
            // 请求可能紧跟着导入发生，晚一步就是一次"搜不到"（见 LocalDns 注释）
            LocalDns.apply(cfg);
            String topJar = topJarOf(cfg);
            JSONArray sites = cfg.optJSONArray("sites");
            if (sites == null) {
                r.message = "配置里没有 sites";
                return r;
            }
            r.total = sites.length();
            for (int i = 0; i < sites.length(); i++) {
                JSONObject o = sites.optJSONObject(i);
                if (o == null) continue;
                String api = o.optString("api", "");
                if (!api.startsWith("csp_")) {
                    r.skipped++;
                    continue;
                }
                String jarRaw = siteJarOf(o, topJar);
                if (jarRaw.isEmpty()) {
                    // 没有 jar 的 csp_ 站点要靠内置类，端上不认识 → 跳过
                    r.skipped++;
                    continue;
                }
                String[] jm = LocalSpiderHost.splitMd5(jarRaw);
                Site s = new Site();
                s.key = o.optString("key", api);
                s.name = o.optString("name", s.key);
                s.api = api;
                s.jar = absolutize(jm[0], configBase);
                s.md5 = jm[1];
                // ext 可能是对象也可能是字符串，统一转成字符串给 spider
                Object ext = o.opt("ext");
                s.ext = ext == null ? "" : String.valueOf(ext);
                TABLE.put(s.key, s);
                r.imported++;
            }
            save(ctx);
            r.ok = true;
            r.message = "已导入 " + r.imported + "/" + r.total + " 站";
        } catch (Throwable t) {
            r.ok = false;
            r.message = "配置解析失败：" + t.getClass().getSimpleName();
        }
        return r;
    }

    /**
     * 顶层 jar 地址，两种键名都认。
     *
     * <p><b>为什么必须认 `spider`</b>：CatVod 标准（Fongmi / TVBox 全系）的顶层字段
     * 叫 `spider`，形如 {@code http://x/spider.php;md5;abc}。我们原来只读 `jar`，
     * 拿肥猫的真实配置实测是 <b>0/38 全跳过</b>——因为每一站都被判成"没有 jar"。
     * 同一份内容只把顶层键改名成 `jar` 就变成 3/3 导入成功，差别只在这个键名。
     *
     * <p>顺序是先 `spider` 再 `jar`：我们自己的后端 /config.json 两种都写，
     * 但外部配置以 `spider` 为准。
     */
    private static String topJarOf(JSONObject cfg) {
        String spider = cfg.optString("spider", "");
        if (!spider.isEmpty()) return spider;
        return cfg.optString("jar", "");
    }

    /**
     * 站点级 jar：先 `jar` 再 `spider`，都没有才用顶层。
     *
     * <p>顺序与顶层相反，因为站点级写 `jar` 是 CatVod 的原生写法
     * （我们后端的 sitesForCatVod 就是给每个 csp_ 站补 {@code "jar":"./spider-latest.jar"}），
     * 站点级写 `spider` 的极罕见但认一下不吃亏。
     */
    private static String siteJarOf(JSONObject site, String topJar) {
        String jar = site.optString("jar", "");
        if (!jar.isEmpty()) return jar;
        String spider = site.optString("spider", "");
        if (!spider.isEmpty()) return spider;
        return topJar;
    }

    /** 相对 jar 路径按配置地址补全（配置里常见 `./jar/spider.jar`） */
    private static String absolutize(String u, String base) {
        if (u.isEmpty()) return u;
        if (u.startsWith("http://") || u.startsWith("https://")) return u;
        if (base == null || base.isEmpty()) return u;
        try {
            return new java.net.URL(new java.net.URL(base), u).toString();
        } catch (Throwable t) {
            return u;
        }
    }

    /**
     * 把一份 CatVod 配置并进**网关**的 {@code gateway/config.sites.json}。
     *
     * <p><b>为什么需要反向同步</b>：设置页有两个导入入口——
     * 「导入配置」走 {@code /api/config/import}（只写网关表），
     * 「导入到本机」走 {@code meowTv.importLocalConfig}（只写端上表）。
     * 用户点哪个都期望"站点能看到、jar 也能执行"，所以两边必须收敛：
     * 网关导入 → {@code Bridge.ConfigImportHook} 写端上表；
     * 端上导入 → 这里写网关表。任一方向缺一半就会出现
     * "导入成功但站点列表为空 / 站点在但一调就 ClassNotFound"。
     *
     * <p>合并语义：按 {@code key} 合并，同 key 以**新导入的为准**；
     * 其它表（parses/lives/doh…）原样保留，不动。
     *
     * @return 是否写成功（失败不影响端上表，只是网关看不到新站）
     */
    static synchronized boolean syncGatewayConfig(Context ctx, String rawConfig, String base) {
        if (ctx == null || rawConfig == null || rawConfig.trim().isEmpty()) return false;
        try {
            File dir = new File(ctx.getFilesDir(), "gateway");
            if (!dir.isDirectory() && !dir.mkdirs()) return false;
            File f = new File(dir, "config.sites.json");

            JSONObject cur = new JSONObject();
            if (f.isFile()) {
                String txt = readText(f);
                if (txt != null && !txt.trim().isEmpty()) cur = new JSONObject(txt);
            }
            JSONObject in = new JSONObject(rawConfig);

            // 顶层 spider：新导入的优先（用户刚换的 jar 源），相对路径补全
            String sp = in.optString("spider", "");
            if (!sp.isEmpty()) cur.put("spider", absolutize(sp, base));

            JSONArray out = cur.optJSONArray("sites");
            if (out == null) {
                out = new JSONArray();
                cur.put("sites", out);
            }
            Map<String, Integer> at = new LinkedHashMap<>();
            for (int i = 0; i < out.length(); i++) {
                JSONObject o = out.optJSONObject(i);
                if (o != null) at.put(o.optString("key", ""), i);
            }

            JSONArray inSites = in.optJSONArray("sites");
            if (inSites != null) {
                for (int i = 0; i < inSites.length(); i++) {
                    JSONObject o = inSites.optJSONObject(i);
                    if (o == null) continue;
                    String jar = o.optString("jar", "");
                    if (!jar.isEmpty()) o.put("jar", absolutize(jar, base));
                    String sp2 = o.optString("spider", "");
                    if (!sp2.isEmpty()) o.put("spider", absolutize(sp2, base));
                    Integer idx = at.get(o.optString("key", ""));
                    if (idx != null) out.put(idx, o);
                    else {
                        at.put(o.optString("key", ""), out.length());
                        out.put(o);
                    }
                }
            }
            writeText(f, cur.toString());
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "syncGatewayConfig failed", t);
            return false;
        }
    }

    private static String readText(File f) throws Exception {
        try (InputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) bo.write(buf, 0, n);
            return new String(bo.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    private static void writeText(File f, String text) throws Exception {
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
    }

    static String asJson() {
        try {
            JSONArray arr = new JSONArray();
            for (Site s : TABLE.values()) {
                JSONObject o = new JSONObject();
                o.put("key", s.key);
                o.put("name", s.name);
                o.put("api", s.api);
                arr.put(o);
            }
            return new JSONObject().put("sites", arr).toString();
        } catch (Throwable t) {
            return "{\"sites\":[]}";
        }
    }

    /** 导入结果，给 UI 展示"导了几个、跳过几个、为什么" */
    static final class ImportResult {
        boolean ok;
        int total;
        int imported;
        int skipped;
        String message = "";
    }

    static synchronized void clearAll(Context ctx) {
        TABLE.clear();
        save(ctx);
    }

    /**
     * 用内置 dex jar 装几个不依赖 ext 的内置站点。
     *
     * <p>挑这三个是因为它们最"干净"：Douban 只要 apikey（jar 内自带）、
     * Config 是配置中心、YGP 是豆瓣预告——都不需要用户填 ext、也不需要登录，
     * 够验证「jar 能加载 + 能出数据」这条链路。
     *
     * @return 本次新增条数；已存在返回 0
     */
    static synchronized int addBundled(Context ctx, String jarPath) {
        String[][] defs = {
                {"豆瓣", "豆瓣", "csp_Douban"},
                {"豆瓣预告", "豆瓣预告", "csp_YGP"},
                {"config", "配置中心", "csp_Config"},
        };
        int added = 0;
        for (String[] d : defs) {
            if (TABLE.containsKey(d[0])) continue;
            Site s = new Site();
            s.key = d[0];
            s.name = d[1];
            s.api = d[2];
            s.jar = jarPath;
            s.md5 = "";
            s.ext = "";
            TABLE.put(s.key, s);
            added++;
        }
        if (added > 0) save(ctx);
        return added;
    }

    static List<String> keys() {
        return new ArrayList<>(TABLE.keySet());
    }
}
