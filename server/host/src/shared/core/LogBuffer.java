package core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Locale;

/**
 * 进程内日志环形缓冲，供「日志」页签读取。
 *
 * <p><b>为什么需要它</b>：后端一直用 {@code System.out.println} 打日志，但那些只在
 * 容器/控制台的 stdout 里——用户遇到「为什么连不上/为什么这个源失败」时，
 * 拿不到任何线索，只能 ssh 进机器看 {@code docker logs}。把最近 N 条留在内存里
 * 再用一个端点 expose 出去，网页上就能直接看到。
 *
 * <p><b>为什么是环形而不是 Append-Only</b>：后端可能跑几周，无上限增长会吃满
 * 内存（OOM 会直接让影视服务挂掉）。保留最近 2000 条足够定位「刚刚发生了什么」，
 * 与常见网关面板的做法一致。
 *
 * <p><b>脱敏</b>：这里只由调用方传入「已经脱敏过」的文本，本类不做二次处理——
 * 但提供了 {@link #scrub(String)} 统一处理 query 里的敏感参数，调用方应当先过一遍。
 */
public final class LogBuffer {

    /** 保留条数。2000 条 × 平均 200 字节 ≈ 400KB，对盒子/容器都可接受。 */
    private static final int CAPACITY = 2000;

    /** 单条最大长度：超长的堆栈截断，否则一条异常能把缓冲撑爆。 */
    private static final int MAX_TEXT = 2000;

    private static final ArrayDeque<Entry> RING = new ArrayDeque<>(CAPACITY);
    private static long seq = 0;

    private LogBuffer() {
    }

    /** 一条日志。 */
    public static final class Entry {
        public final long id;
        public final long at;
        public final String level;
        public final String tag;
        public final String text;

        Entry(long id, long at, String level, String tag, String text) {
            this.id = id;
            this.at = at;
            this.level = level;
            this.tag = tag;
            this.text = text;
        }

        JSONObject toJson() throws org.json.JSONException {
            return new JSONObject()
                    .put("id", id)
                    .put("at", at)
                    .put("level", level)
                    .put("tag", tag)
                    .put("text", text);
        }
    }

    /**
     * 记一条。
     *
     * @param level info | warn | error
     * @param tag   模块标签，如 req / cache / danmaku / proxy / search / import
     */
    public static void add(String level, String tag, String text) {
        if (text == null) return;
        String norm = text.length() > MAX_TEXT ? text.substring(0, MAX_TEXT) + "…" : text;
        synchronized (RING) {
            if (RING.size() >= CAPACITY) RING.pollFirst();
            RING.addLast(new Entry(++seq, System.currentTimeMillis(),
                    level == null || level.isEmpty() ? "info" : level,
                    tag == null ? "" : tag, norm));
        }
    }

    public static void info(String tag, String text) {
        add("info", tag, text);
    }

    public static void warn(String tag, String text) {
        add("warn", tag, text);
    }

    public static void error(String tag, String text) {
        add("error", tag, text);
    }

    /**
     * 取日志（按 id 升序）。
     *
     * @param level 空=全部；否则精确匹配 info/warn/error
     * @param tag   空=全部；否则精确匹配模块标签
     * @param since 只取 id > since 的（增量轮询用；0=从头）
     * @param limit 最多返回多少条（取**最新的** limit 条）
     */
    public static JSONArray query(String level, String tag, long since, int limit)
            throws org.json.JSONException {
        int cap = limit <= 0 ? 500 : Math.min(limit, CAPACITY);
        java.util.List<Entry> picked = new java.util.ArrayList<>();
        synchronized (RING) {
            // 从新到旧扫，凑够 cap 再反转，避免把整个环形都复制一遍
            java.util.Iterator<Entry> it = RING.descendingIterator();
            while (it.hasNext()) {
                Entry e = it.next();
                if (e.id <= since) break;
                if (level != null && !level.isEmpty() && !level.equals(e.level)) continue;
                if (tag != null && !tag.isEmpty() && !tag.equals(e.tag)) continue;
                picked.add(e);
                if (picked.size() >= cap) break;
            }
        }
        java.util.Collections.reverse(picked);
        JSONArray arr = new JSONArray();
        for (Entry e : picked) arr.put(e.toJson());
        return arr;
    }

    /** 当前最新 id（前端据此做增量拉取）。 */
    public static long lastId() {
        synchronized (RING) {
            return seq;
        }
    }

    /** 清空（页面上点「清空」）。 */
    public static void clear() {
        synchronized (RING) {
            RING.clear();
        }
    }

    /** 面板要展示的总数/错误数，避免前端把所有条目拉一遍只为计数。 */
    public static JSONObject stats() throws org.json.JSONException {
        int total = 0;
        int errors = 0;
        int warns = 0;
        synchronized (RING) {
            total = RING.size();
            for (Entry e : RING) {
                if ("error".equals(e.level)) errors++;
                else if ("warn".equals(e.level)) warns++;
            }
        }
        return new JSONObject().put("total", total).put("errors", errors)
                .put("warns", warns).put("capacity", CAPACITY).put("lastId", lastId());
    }

    /**
     * 脱敏：把 query 里可能带凭据的参数值替换成 ***。
     *
     * <p>这些参数实测会出现在 URL 里：{@code url}=（代理目标，可能含 token）、
     * {@code token}=、{@code authToken}=、{@code password}=、{@code pwd}=。
     * 其余原样保留——日志的可读性比"过度打码"更重要。
     */
    public static String scrub(String raw) {
        if (raw == null || raw.isEmpty()) return raw;
        String out = raw;
        for (String key : new String[]{"url", "token", "authToken", "password", "pwd", "pass"}) {
            out = out.replaceAll("(?i)([?&]" + key + "=)[^&\\s]*", "$1***");
        }
        return out;
    }

    /** 毫秒时间戳 → HH:mm:ss（面板里显示用）。 */
    public static String clock(long at) {
        return new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date(at));
    }
}
