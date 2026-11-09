package sources;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 苹果CMS（maccms）直连源：把 采集站 的公开 JSON 接口当站点用，**不依赖 spider.jar**。
 *
 * <p><b>为什么要有这一层</b>：社区 90% 的"源"其实是 苹果CMS 采集站
 * （{@code /api.php/provide/vod}），它们只暴露三个动作：最新列表、搜索、详情。
 * 以前这些站点在配置里能导入（{@code type=1}），但 {@code call()} 没有 http 分支，
 * 直接落到 {@code instance()} 撞 ClassNotFoundException —— 导入报告写着
 * "苹果CMS直连"，实际一个都不能用。
 *
 * <p><b>和 jar 源的区别</b>：这里不发任何协议转换，采集站返回的
 * {@code vod_play_from}/{@code vod_play_url} 本身就是 CatVod 契约格式
 * （{@code a$$$b} + {@code 第1集$url#第2集$url}），原样透传即可。
 *
 * <p><b>实测的两个坑（2026-11-06）</b>：
 * <ul>
 *   <li>{@code ac=list} 的条目**没有 vod_pic**，卡片会是空色块 → 列表也用
 *       {@code ac=detail}（46~325KB / 0.7~3.2s，可接受）</li>
 *   <li>分类过滤**不统一**：{@code type_id=2} 在 ikunzy/maotaizy/360zy 全被忽略
 *       （返回所有类型），{@code t=2} 只在 maotaizy 生效。所以不能照文档写，
 *       要先探一次"这个站到底认不认"，不认就只给"最新更新"一个 tab，
 *       免得用户点"电影"看到一堆综艺。</li>
 * </ul>
 */
public final class CmsSource {

    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/120.0.0.0 Safari/537.36";
    private static final int CONNECT_MS = 3_000;
    private static final int READ_MS = 6_000;
    /** 首页/能力探测缓存：同一个站 10 分钟内不重复探 */
    private static final long TTL_MS = 10 * 60 * 1000L;
    /** 失败缓存：只挡"同一个站连点几次"，不长期掩盖源站恢复 */
    private static final long FAIL_TTL_MS = 60 * 1000L;

    private static final Map<String, Cache> CACHE = new ConcurrentHashMap<>();

    private static final class Cache {
        final long at = System.currentTimeMillis();
        final String home;
        final String filterParam;
        /** 探测失败（网络）用短 TTL：不能把"这次没连上"当成"这个站不支持分类"记 10 分钟 */
        final long ttl;

        Cache(String home, String filterParam) {
            this(home, filterParam, TTL_MS);
        }

        Cache(String home, String filterParam, long ttl) {
            this.home = home;
            this.filterParam = filterParam;
            this.ttl = ttl;
        }

        boolean alive() {
            return System.currentTimeMillis() - at < ttl;
        }
    }

    private CmsSource() {
    }

    /**
     * 分派一次调用。
     *
     * @return CatVod 契约 JSON；{@code null} = 本层不实现（play/live/action），
     *         由 {@code call()} 走空结构兜底，不能变成 500
     */
    public static String invoke(String apiBase, String action, String body) {
        if (apiBase == null || apiBase.isEmpty()) return null;
        String base = normalize(apiBase);
        JSONObject b = new JSONObject();
        if (body != null && !body.trim().isEmpty()) {
            try {
                b = new JSONObject(body);
            } catch (Throwable ignored) {
            }
        }
        try {
            switch (action) {
                case "home":
                    return home(base);
                case "category": {
                    String id = b.optString("id", b.optString("tid", ""));
                    String page = b.optString("page", b.optString("pg", "1"));
                    return category(base, id, page);
                }
                case "detail": {
                    String id = b.optString("id", b.optString("ids", ""));
                    return detail(base, firstId(id));
                }
                case "search": {
                    String wd = b.optString("wd", b.optString("key", ""));
                    String pg = b.optString("pg", b.optString("page", "1"));
                    return search(base, wd, pg);
                }
                /*
                 * 播放：前端只发 {flag, id}，且两种 id 都会出现——
                 *   · 普通入口 id = vod_id（此时取该线路第 1 集）
                 *   · 从详情页点某一集时 id 已经是**整条 url**（见 PlayView 传 ep.url）
                 * 不做这个分支时播放页只显示「该源未提供播放地址」，
                 * 前面 search/detail 全对也没用（实测 TV 端就是这样）。
                 */
                case "play": {
                    String flag = b.optString("flag", "");
                    String id = b.optString("id", b.optString("vod", ""));
                    return play(base, flag, id);
                }
                default:
                    return null;
            }
        } catch (Throwable t) {
            // 源站挂了是常态（57/69 存活），不能让一条错误把整轮搜索打挂
            return "{\"list\":[]}";
        }
    }

    // ---------------------------------------------------------------- 三个动作

    private static String home(String base) throws Exception {
        Cache c = probe(base);
        return c.home;
    }

    private static String category(String base, String id, String page) throws Exception {
        int pg = pageNum(page);
        String tid = id == null ? "" : id.trim();
        Cache c = probe(base);
        String q = "ac=detail&pg=" + pg;
        if (!tid.isEmpty() && !"0".equals(tid)) {
            String param = c.filterParam;
            if (param == null) {
                // 这个站不认分类参数：宁可回空，也不要把综艺当电影推给用户
                return "{\"list\":[]}";
            }
            q = "ac=detail&pg=" + pg + "&" + param + "=" + enc(tid);
        }
        JSONObject j = get(base, q);
        if (j == null) return "{\"list\":[]}";
        return listJson(j);
    }

    private static String detail(String base, String id) throws Exception {
        if (id == null || id.isEmpty()) return "{\"list\":[]}";
        JSONObject j = get(base, "ac=detail&ids=" + enc(id));
        if (j == null) return "{\"list\":[]}";
        JSONArray arr = j.optJSONArray("list");
        if (arr == null || arr.length() == 0) return "{\"list\":[]}";
        JSONObject v = arr.optJSONObject(0);
        if (v == null) return "{\"list\":[]}";
        JSONObject out = new JSONObject();
        out.put("list", new JSONArray().put(toDetail(v)));
        return out.toString();
    }

    /**
     * 播放：把 id/flag 解析成一条直链。
     *
     * <p>两种入参都要认（前端两个入口各发一种）：
     * <ul>
     *   <li>{@code id} 是整条 url —— 详情页点某一集时就是这样，直接用</li>
     *   <li>{@code id} 是 vod_id —— 取 {@code flag} 那条线路的第 1 集</li>
     * </ul>
     *
     * <p>采集站的线路名形如 {@code 360zy$$$lzm3u8}，与 url 的 {@code $$$} 分段一一对应，
     * 所以选定 flag 后必须用**同一序号**取那段 url，不能按名字猜。
     */
    private static String play(String base, String flag, String id) throws Exception {
        if (id == null || id.isEmpty()) return playJson("");
        // 已经是整条地址：详情页传来的 ep.url，直接用
        if (id.startsWith("http")) return playJson(id);

        JSONObject j = get(base, "ac=detail&ids=" + enc(id));
        if (j == null) return playJson("");
        JSONArray arr = j.optJSONArray("list");
        if (arr == null || arr.length() == 0) return playJson("");
        JSONObject v = arr.optJSONObject(0);
        if (v == null) return playJson("");

        String[] froms = v.optString("vod_play_from", "").split("\\$\\$\\$");
        String[] lines = v.optString("vod_play_url", "").split("\\$\\$\\$");
        int idx = 0;
        String want = flag == null ? "" : flag.trim();
        if (!want.isEmpty()) {
            for (int i = 0; i < froms.length && i < lines.length; i++) {
                if (froms[i].trim().equals(want)) {
                    idx = i;
                    break;
                }
            }
        }
        if (idx >= lines.length) return playJson("");
        String first = lines[idx].split("#")[0];
        String url = first.contains("$") ? first.substring(first.indexOf('$') + 1) : first;
        return playJson(url);
    }

    /** CatVod 的 playerContent 形状：{@code {"parse":0,"url":"..."}}，不是 list。 */
    private static String playJson(String url) throws Exception {
        JSONObject o = new JSONObject();
        /*
         * 采集站有两大类集地址：
         *   · 直链 m3u8 → 自己播
         *   · {@code /share/<hash>} 中转页 → 必须走第三方解析
         * 判据只看路径里有没有 /share/：这类地址直接请求只会拿到 HTML，
         * 交给播放器就是黑屏（实测 26/44 是直链、13 个是 share）。
         */
        o.put("parse", url.contains("/share/") ? 1 : 0);
        o.put("url", url);
        return o.toString();
    }

    private static String search(String base, String wd, String page) throws Exception {
        if (wd == null || wd.trim().isEmpty()) return "{\"list\":[]}";
        JSONObject j = get(base, "ac=detail&wd=" + enc(wd.trim()) + "&pg=" + pageNum(page));
        if (j == null) return "{\"list\":[]}";
        return listJson(j);
    }

    // ---------------------------------------------------------------- 能力探测

    /**
     * 探一次这个站认哪种分类参数，并顺带把首页 tab 表缓存下来。
     *
     * <p>判据是"返回条目的 type_id 是否真的等于请求的那个"——采集站对不认识的
     * 参数**不报错、直接返回全部类型**（实测 ikunzy 请求 type_id=2 回来的是
     * 港台综艺/动作片/日漫混排），只看"有没有返回"会全部误判成支持。
     */
    private static Cache probe(String base) throws Exception {
        Cache c = CACHE.get(base);
        if (c != null && c.alive()) return c;

        /*
         * ★ 必须用 ac=list 取 class：实测（ikunzy/maotaizy）ac=detail 的响应里
         *   **没有 class 数组**，用 detail 探测会永远拿不到分类，
         *   表现是首页只有"最新更新"一个 tab。
         */
        JSONObject first = get(base, "ac=list&pg=1");
        JSONArray classes = first == null ? null : first.optJSONArray("class");
        if (classes == null || classes.length() == 0) {
            // 连不上、或这个站不返回 class：只能给"最新更新"，至少别让首页整行空着。
            // 网络失败用短 TTL，避免一次超时把"分类不可用"记 10 分钟。
            Cache only = new Cache(homeJson(null, false), null, first == null ? FAIL_TTL_MS : TTL_MS);
            CACHE.put(base, only);
            return only;
        }

        String probeId = null;
        for (int i = 0; i < classes.length(); i++) {
            JSONObject o = classes.optJSONObject(i);
            if (o == null) continue;
            if (o.optInt("type_pid", 0) != 0) continue;  // 子分类一般不认，先拿一级的
            probeId = o.optString("type_id", "");
            if (!probeId.isEmpty()) break;
        }

        String param = null;
        boolean netFail = false;
        if (probeId != null && !probeId.isEmpty()) {
            for (String p : new String[]{"t", "type_id"}) {
                JSONObject t = get(base, "ac=detail&pg=1&" + p + "=" + enc(probeId));
                if (t == null) {
                    // 这次没连上 ≠ 这个站不支持分类，不能按 10 分钟缓存
                    netFail = true;
                    continue;
                }
                if (typeMatches(t, probeId)) {
                    param = p;
                    break;
                }
            }
        }
        Cache fresh = new Cache(homeJson(classes, param != null), param,
                netFail && param == null ? FAIL_TTL_MS : TTL_MS);
        CACHE.put(base, fresh);
        return fresh;
    }

    /** 返回的条目里有 type_id 且都等于请求值 → 这个参数真的生效了。 */
    private static boolean typeMatches(JSONObject j, String want) {
        JSONArray arr = j.optJSONArray("list");
        if (arr == null || arr.length() == 0) return false;
        int checked = 0;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            String tid = o.optString("type_id", "");
            if (tid.isEmpty()) continue;
            if (!tid.equals(want)) return false;
            checked++;
            if (checked >= 3) break;
        }
        return checked > 0;
    }

    /**
     * 首页 tab 表。
     *
     * <p>{@code withTabs=false}（这个站不认分类参数）时**只给"最新更新"**：
     * 摆一排点了就空的分类比"只有一个可用分类"更糟——用户会以为源挂了。
     */
    private static String homeJson(JSONArray classes, boolean withTabs) throws Exception {
        JSONArray tabs = new JSONArray();
        // 空 type_id = 不带过滤，永远可用（采集站都支持最新列表）
        tabs.put(new JSONObject().put("type_id", "").put("type_name", "最新更新"));
        if (withTabs && classes != null) {
            for (int i = 0; i < classes.length(); i++) {
                JSONObject o = classes.optJSONObject(i);
                if (o == null) continue;
                if (o.optInt("type_pid", 0) != 0) continue;  // 只给一级分类，子类太多
                String id = o.optString("type_id", "");
                String name = o.optString("type_name", "").trim();
                if (id.isEmpty() || name.isEmpty()) continue;
                tabs.put(new JSONObject().put("type_id", id).put("type_name", name));
            }
        }
        JSONObject out = new JSONObject();
        out.put("class", tabs);
        out.put("filters", new JSONObject());
        return out.toString();
    }

    // ---------------------------------------------------------------- 映射

    private static String listJson(JSONObject j) throws Exception {
        JSONArray out = new JSONArray();
        JSONArray arr = j.optJSONArray("list");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                JSONObject v = toItem(o);
                if (v != null) out.put(v);
            }
        }
        JSONObject res = new JSONObject();
        int page = j.optInt("page", 1);
        int limit = j.optInt("limit", 20);
        int total = j.optInt("total", 0);
        int pages = j.optInt("pagecount", 0);
        if (pages <= 0) pages = total > 0 && limit > 0 ? (total + limit - 1) / limit : 0;
        res.put("page", page);
        res.put("pagecount", pages);
        res.put("limit", limit);
        res.put("total", total);
        res.put("list", out);
        return res.toString();
    }

    private static JSONObject toItem(JSONObject v) throws Exception {
        String id = v.optString("vod_id", "").trim();
        String name = v.optString("vod_name", "").trim();
        // 没有 id 或名字的条目点进去必然空，直接丢（采集站里确实有这类脏数据）
        if (id.isEmpty() || name.isEmpty()) return null;
        JSONObject o = new JSONObject();
        o.put("vod_id", id);
        o.put("vod_name", name);
        String pic = v.optString("vod_pic", "");
        if (!pic.isEmpty()) o.put("vod_pic", pic);
        String remarks = v.optString("vod_remarks", "");
        if (!remarks.isEmpty()) o.put("vod_remarks", remarks);
        String tn = v.optString("type_name", "");
        if (!tn.isEmpty()) o.put("type_name", tn);
        return o;
    }

    private static JSONObject toDetail(JSONObject v) throws Exception {
        JSONObject o = new JSONObject();
        o.put("vod_id", v.optString("vod_id", ""));
        o.put("vod_name", v.optString("vod_name", ""));
        copy(v, o, "vod_pic");
        copy(v, o, "vod_content");
        copy(v, o, "vod_blurb");
        copy(v, o, "vod_year");
        copy(v, o, "vod_area");
        copy(v, o, "vod_lang");
        copy(v, o, "vod_remarks");
        copy(v, o, "vod_actor");
        copy(v, o, "vod_director");
        copy(v, o, "vod_score");
        copy(v, o, "type_name");
        /*
         * 播放线路原样透传：采集站给的就是 CatVod 契约形状
         * （from 用 $$$ 分段，url 里 集名$地址 用 # 分段）。
         * 不做任何改写——改了反而和 jar 源产出的形状不一致。
         */
        copy(v, o, "vod_play_from");
        copy(v, o, "vod_play_url");
        // 简介为空时用 blurb 兜一下，详情页不至于一片空白
        if (o.optString("vod_content", "").trim().isEmpty()) {
            String blurb = o.optString("vod_blurb", "").trim();
            if (!blurb.isEmpty()) o.put("vod_content", blurb);
        }
        return o;
    }

    private static void copy(JSONObject from, JSONObject to, String key) throws Exception {
        String val = from.optString(key, "");
        if (!val.isEmpty() && !"null".equals(val)) to.put(key, val);
    }

    // ---------------------------------------------------------------- HTTP

    private static JSONObject get(String base, String query) {
        HttpURLConnection c = null;
        try {
            URL u = new URL(base + "/?" + query);
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(CONNECT_MS);
            c.setReadTimeout(READ_MS);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept", "application/json,text/plain,*/*");
            int code = c.getResponseCode();
            if (code != 200) {
                /*
                 * 采集站回 403/404 是常见事（换域名、拦 UA）。
                 * 打一行日志：不然后端日志里只剩"这个源没结果"，
                 * 和"这个词真没片"分不开（踩过：TV 端 0.3 秒返回空，
                 * 看上去像源没内容，实际是请求被拒）。
                 */
                core.LogBuffer.warn("cms", base + " HTTP " + code + " q=" + query);
                return null;
            }
            byte[] bytes;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                long total = 0;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    // 防呆上限：正常 20~300KB，超过 4MB 说明端点行为变了
                    if (total > 4L * 1024 * 1024) break;
                    bos.write(buf, 0, n);
                }
                bytes = bos.toByteArray();
            }
            String text = new String(bytes, StandardCharsets.UTF_8);
            try {
                return new JSONObject(text);
            } catch (Throwable bad) {
                /*
                 * 少量采集站回 GBK。UTF-8 解不出来时用 GBK 再试一次，
                 * 不行才认输——不做这一步的话这些站在日志里表现为
                 * "JSON 解析失败"，和"源站挂了"分不开。
                 */
                try {
                    return new JSONObject(new String(bytes, Charset.forName("GBK")));
                } catch (Throwable still) {
                    String head = new String(bytes, 0, Math.min(bytes.length, 80), StandardCharsets.UTF_8);
                    core.LogBuffer.warn("cms", base + " 非 JSON（" + bytes.length + "B）: " + head);
                    return null;
                }
            }
        } catch (Throwable t) {
            // 异常类名 + 消息一起打：Android 与 JVM 的报错文本不一样，
            // 只写"失败"在两边都查不出原因
            core.LogBuffer.warn("cms", base + " 请求异常: " + t.getClass().getSimpleName()
                    + " " + String.valueOf(t.getMessage()));
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String normalize(String api) {
        String s = api.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (Throwable t) {
            return s;
        }
    }

    private static int pageNum(String page) {
        try {
            int p = Integer.parseInt(page == null ? "" : page.trim());
            return p < 1 ? 1 : p;
        } catch (Throwable t) {
            return 1;
        }
    }

    private static String firstId(String ids) {
        if (ids == null) return "";
        int i = ids.indexOf(',');
        return (i < 0 ? ids : ids.substring(0, i)).trim();
    }
}
