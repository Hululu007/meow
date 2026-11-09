package sources;

import core.Scrape;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 豆瓣（原生实现，**不依赖 spider.jar**）。
 *
 * <p><b>为什么是豆瓣</b>：它是"不内置 jar"时唯一还能让壳有内容的公开源——
 * 榜单/分类/详情全走明文 JSON，不需要登录、不需要播放地址。
 * 目标只有三条：首页榜单不空、热播榜不空、详情页有简介和海报。
 *
 * <p><b>接口来源</b>：肥猫 jar 里 {@code Douban} 小程序版接口（frodo）。
 * 实测三个必要条件，少一个就 403/400：
 * <ul>
 *   <li>{@code Host: frodo.douban.com}</li>
 *   <li>小程序 Referer（{@code servicewechat.com/wx2f...}）</li>
 *   <li>固定 apikey（公开的，在小程序包里）</li>
 * </ul>
 *
 * <p><b>本实现不做的</b>：搜索（jar 的豆瓣实现只有搜索，原生不实现 → 上层回退给 jar）、
 * 播放（豆瓣只提供元数据，没有线路）。
 *
 * <p><b>海报防盗链</b>：豆瓣图床裸请求回 418。这里**不在 url 上拼 {@code @Referer=}**，
 * 因为 {@code /api/proxy/image} 已按域名自动补豆瓣 Referer（见 {@code defaultRefererFor}）——
 * 拼了反而让 PosterStore 的 key 带上无意义的尾巴。
 */
public final class DoubanSource implements NativeSource {

    private static final String API = "https://frodo.douban.com/api/v2";
    private static final String KEY = "apikey=0ac44ae016490db2204ce0a042db2916";
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/53.0.2785.143 Safari/537.36 MicroMessenger/7.0.9.501 "
                    + "NetType/WIFI MiniProgramEnv/Windows WindowsWechat";
    private static final String REFERER =
            "https://servicewechat.com/wx2f9b06c1de1ccfca/84/page-frame.html";

    private static final int PAGE_SIZE = 20;
    private static final long TTL_MS = 10 * 60 * 1000L;
    /** 失败缓存：只挡"同一个 tab 连点几次"这种重复失败，不长期掩盖源站恢复 */
    private static final long FAIL_TTL_MS = 60 * 1000L;

    /**
     * type_id → 显示名。**顺序即首页顺序**，第一项是首页默认铺的那个分类。
     *
     * <p>这些 id 全部实测有数据（2026-11-04）。注意 {@code hot_gaia} 已失效
     * （返回 404 traversal_error），前端老代码还在用它 → 见 {@link #ALIAS}。
     */
    private static final String[][] TABS = {
            {"tv_hot", "热播剧集"},
            {"movie_hot", "热播电影"},
            {"show_hot", "热播综艺"},
            /*
             * 全量浏览（各 500 条、可翻 25 页）。这两个不是豆瓣的 collection id，
             * 是我们自己起的合成 id，路由到 /{kind}/recommend?sort=U。
             *
             * ★ 必须带 sort=U：不带时豆瓣返回的大半是「片单（playlist）」和广告位，
             *   卡片没有海报（实测 sort=T 的 4 条里 1 条 playlist + 1 条 ad）。
             */
            {"tv_all", "全部剧集"},
            {"movie_all", "全部电影"},
            {"tv_real_time_hotest", "剧集榜"},
            {"movie_real_time_hotest", "电影榜"},
            {"tv_chinese_best_weekly", "华语口碑剧"},
            {"tv_global_best_weekly", "全球口碑剧"},
            {"movie_weekly_best", "一周口碑电影"},
            {"tv_domestic", "国产剧"},
            {"tv_american", "欧美剧"},
            {"tv_japanese", "日剧"},
            {"tv_korean", "韩剧"},
            {"tv_animation", "动画"},
            {"tv_documentary", "纪录片"},
            {"movie_scifi", "科幻片"},
            {"movie_comedy", "喜剧片"},
            {"movie_action", "动作片"},
    };

    /** 合成 id → recommend 的 kind（`/movie/recommend` / `/tv/recommend`）。 */
    private static final Map<String, String> BROWSE = new LinkedHashMap<>();

    static {
        BROWSE.put("movie_all", "movie");
        BROWSE.put("tv_all", "tv");
    }

    /**
     * 老 id 别名。
     *
     * <p>{@code hot_gaia} 曾经是"热门电影"，豆瓣已下线（404）。
     * 搜索页的历史 tab 里还写着它，映射过去比让那一栏空白要好。
     */
    private static final Map<String, String> ALIAS = new LinkedHashMap<>();

    static {
        ALIAS.put("hot_gaia", "movie_hot");
    }

    /**
     * 响应缓存：tab 列表页 10 分钟。
     *
     * <p>为什么必须有：搜索页每次进页面都会拉一次热播榜，首页铺首屏会连续拉 2–3 页；
     * 没有缓存时每次切 tab/回页面都要打豆瓣，既慢又容易撞限流。
     * 用 {@code synchronizedMap} 是因为分发是多线程的（搜索并发）。
     */
    private static final Map<String, Cached> CACHE =
            java.util.Collections.synchronizedMap(new LinkedHashMap<String, Cached>() {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Cached> eldest) {
                    return size() > 200;
                }
            });

    private static final class Cached {
        final String body;
        final long at;
        /** 成功结果；false = 上次抓失败了，只缓存很短时间 */
        final boolean ok;

        Cached(String body, long at, boolean ok) {
            this.body = body;
            this.at = at;
            this.ok = ok;
        }
    }

    private static Map<String, String> headers() {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Host", "frodo.douban.com");
        h.put("Referer", REFERER);
        h.put("User-Agent", UA);
        h.put("Accept", "application/json");
        return h;
    }

    @Override
    public String home() {
        try {
            JSONArray cls = new JSONArray();
            for (String[] t : TABS) {
                cls.put(new JSONObject().put("type_id", t[0]).put("type_name", t[1]));
            }
            return new JSONObject().put("class", cls).put("filters", new JSONObject()).toString();
        } catch (Throwable t) {
            return "{\"class\":[],\"filters\":{}}";
        }
    }

    @Override
    public String category(String id, String page, JSONObject filters) {
        String tid = normalizeTab(id);
        int p = Math.max(1, parseInt(page, 1));
        int start = (p - 1) * PAGE_SIZE;
        String kind = BROWSE.get(tid);
        String url = kind != null
                ? API + "/" + kind + "/recommend?start=" + start + "&count=" + PAGE_SIZE
                        + "&sort=U&" + KEY
                : API + "/subject_collection/" + tid + "/items?start=" + start
                        + "&count=" + PAGE_SIZE + "&" + KEY;
        return toCategory(fetch("c:" + tid + ":" + p, url), p);
    }

    /**
     * 详情。id 是豆瓣条目 id；兼容 jar 搜索产出的 {@code msearch:<id>} 前缀
     * （用户可能从"豆瓣搜索"结果点进来）。
     */
    @Override
    public String detail(String id) {
        String sid = strip(id);
        if (sid.isEmpty()) return "{\"list\":[]}";
        JSONObject d = fetchDetail(sid);
        if (d == null) return "{\"list\":[]}";
        try {
            JSONObject v = new JSONObject();
            v.put("vod_id", sid);
            v.put("vod_name", d.optString("title", ""));
            v.put("vod_pic", pic(d));
            // vod_content 会被前端剥掉 HTML 标签后原样展示；intro 本身就是纯文本
            String intro = d.optString("intro", "");
            if (intro.trim().isEmpty()) intro = d.optString("card_subtitle", "");
            v.put("vod_content", intro.trim());
            v.put("vod_year", d.optString("year", ""));
            v.put("vod_area", first(d.optJSONArray("countries")));
            v.put("vod_remarks", d.optString("episodes_info", ""));
            v.put("vod_director", names(d.optJSONArray("directors"), 2));
            v.put("vod_actor", names(d.optJSONArray("actors"), 6));
            /*
             * 空的 play_from/play_url 是**有意**的：豆瓣没有线路。
             * 前端据此显示「该片暂无播放源」，但海报/简介/年份照常渲染——
             * 这正是"没 jar 时详情页也有内容"要的效果。
             */
            v.put("vod_play_from", "");
            v.put("vod_play_url", "");
            JSONObject out = new JSONObject();
            out.put("list", new JSONArray().put(v));
            return out.toString();
        } catch (Throwable t) {
            return "{\"list\":[]}";
        }
    }

    // ---------------------------------------------------------------- 内部

    private static String normalizeTab(String id) {
        String t = id == null ? "" : id.trim();
        if (t.isEmpty()) return TABS[0][0];
        String a = ALIAS.get(t);
        return a == null ? t : a;
    }

    private static String fetch(String key, String url) {
        Cached c = CACHE.get(key);
        long now = System.currentTimeMillis();
        if (c != null && now - c.at < (c.ok ? TTL_MS : FAIL_TTL_MS)) return c.body;
        String body;
        try {
            body = Scrape.fetchText(url, headers(), 6_000, 9_000);
        } catch (Throwable t) {
            // 拿不到就返回空串：调用方会产出空列表，不会把整个请求变成 500
            body = "";
        }
        /*
         * 失败也缓存（60 秒），只是短得多。
         *
         * 豆瓣下线一个集合后是稳定 404（如 hot_gaia），失败不缓存的话
         * 每次切 tab / 回首页都要重连一次、白等 6 秒超时。
         */
        CACHE.put(key, new Cached(body, now, !body.isEmpty()));
        return body;
    }

    private static JSONObject fetchDetail(String sid) {
        String key = "d:" + sid;
        Cached c = CACHE.get(key);
        long now = System.currentTimeMillis();
        if (c != null && now - c.at < TTL_MS) {
            try {
                return new JSONObject(c.body);
            } catch (Throwable ignored) {
            }
        }
        // 不知道类型：电影优先，再试剧集。错的类型会回 404 或没有 title 的错误体。
        for (String kind : new String[]{"movie", "tv"}) {
            String body;
            try {
                body = Scrape.fetchText(API + "/" + kind + "/" + sid + "?" + KEY,
                        headers(), 6_000, 9_000);
            } catch (Throwable t) {
                continue;
            }
            try {
                JSONObject o = new JSONObject(body);
                if (o.optString("title", "").isEmpty()) continue;
                if (o.has("intro") || o.has("pic") || o.has("card_subtitle")) {
                    CACHE.put(key, new Cached(body, now, true));
                    return o;
                }
            } catch (Throwable ignored) {
            }
        }
        return null;
    }

    private static String toCategory(String body, int p) {
        JSONArray list = new JSONArray();
        int total = 0;
        try {
            JSONObject d = new JSONObject(body);
            total = d.optInt("total", 0);
            JSONArray items = d.optJSONArray("subject_collection_items");
            if (items == null) items = d.optJSONArray("items");
            if (items != null) {
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.optJSONObject(i);
                    if (it == null) continue;
                    JSONObject v = toItem(it);
                    if (v != null) list.put(v);
                }
            }
        } catch (Throwable ignored) {
        }
        try {
            JSONObject out = new JSONObject();
            out.put("page", p);
            // 有 total 才能给出真实页数：HomeView 靠 pagecount 停止补屏，
            // 恒为 0 时它会一路补到第 20 页（20 次请求）。
            out.put("pagecount", total > 0 ? (total + PAGE_SIZE - 1) / PAGE_SIZE : (list.length() > 0 ? p + 1 : 0));
            out.put("limit", PAGE_SIZE);
            out.put("total", total);
            out.put("list", list);
            return out.toString();
        } catch (Throwable t) {
            return "{\"list\":[]}";
        }
    }

    private static JSONObject toItem(JSONObject it) {
        String id = it.optString("id", "").trim();
        String name = it.optString("title", "").trim();
        if (id.isEmpty() || name.isEmpty()) return null;
        /*
         * 过滤非条目：/recommend 会把「片单」和广告位混进 items 里
         * （实测 sort=T 的 4 条里就有 1 playlist + 1 ad），它们的 id/title 看着正常，
         * 但没有海报 → 卡片是空色块，点进去也没有详情。宁可少一条。
         */
        String type = it.optString("type", it.optString("item_type", ""));
        if ("playlist".equals(type) || "ad".equals(type) || "ads".equals(type)) return null;
        try {
            JSONObject v = new JSONObject();
            v.put("vod_id", id);
            v.put("vod_name", name);
            String p = pic(it);
            if (p.isEmpty()) return null;
            v.put("vod_pic", p);
            /*
             * 卡片角标：剧集类给「29集全」，电影类没有集数就退到评分。
             * 两者都没有时干脆不写 —— 空角标会在海报上留一个空色块。
             */
            String remark = it.optString("episodes_info", "").trim();
            if (remark.isEmpty()) {
                double score = score(it);
                if (score > 0) remark = String.format(java.util.Locale.US, "%.1f", score);
            }
            if (!remark.isEmpty()) v.put("vod_remarks", remark);
            String year = it.optString("year", "").trim();
            if (year.isEmpty()) year = yearOf(it.optString("card_subtitle", ""));
            if (!year.isEmpty()) v.put("vod_year", year);
            return v;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 海报：三种 item 形状各不一样，按命中顺序取。 */
    private static String pic(JSONObject it) {
        JSONObject pic = it.optJSONObject("pic");
        if (pic != null) {
            String s = pic.optString("normal", "");
            if (s.isEmpty()) s = pic.optString("large", "");
            if (!s.isEmpty()) return s;
        }
        String s = it.optString("cover_url", "");
        if (!s.isEmpty()) return s;
        JSONObject cover = it.optJSONObject("cover");
        if (cover != null) {
            s = cover.optString("url", "");
            if (!s.isEmpty()) return s;
        }
        JSONArray photos = it.optJSONArray("photos");
        if (photos != null && photos.length() > 0) return photos.optString(0, "");
        return "";
    }

    private static double score(JSONObject it) {
        JSONObject r = it.optJSONObject("rating");
        return r == null ? 0 : r.optDouble("value", 0);
    }

    private static String first(JSONArray arr) {
        if (arr == null || arr.length() == 0) return "";
        return arr.optString(0, "");
    }

    /** 详情里的演员/导演是 [{name:...}]，列表里的 actors 是纯字符串数组。 */
    private static String names(JSONArray arr, int max) {
        if (arr == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < arr.length() && i < max; i++) {
            JSONObject o = arr.optJSONObject(i);
            String n = o == null ? arr.optString(i, "") : o.optString("name", "");
            if (n == null || n.trim().isEmpty()) continue;
            if (sb.length() > 0) sb.append(' ');
            sb.append(n.trim());
        }
        return sb.toString();
    }

    /** {@code "2026 / 中国大陆 / 剧情"} 的第一个 4 位年份。 */
    private static String yearOf(String cardSubtitle) {
        String s = cardSubtitle == null ? "" : cardSubtitle;
        for (int i = 0; i + 4 <= s.length(); i++) {
            boolean ok = true;
            for (int k = 0; k < 4; k++) {
                char ch = s.charAt(i + k);
                if (ch < '0' || ch > '9') {
                    ok = false;
                    break;
                }
            }
            if (!ok) continue;
            String y = s.substring(i, i + 4);
            int n = parseInt(y, 0);
            if (n >= 1900 && n <= 2100) return y;
        }
        return "";
    }

    private static String strip(String id) {
        String s = id == null ? "" : id.trim();
        if (s.startsWith("msearch:")) s = s.substring("msearch:".length()).trim();
        return s;
    }

    private static int parseInt(String s, int def) {
        try {
            return Integer.parseInt(s == null ? "" : s.trim());
        } catch (Throwable t) {
            return def;
        }
    }
}
