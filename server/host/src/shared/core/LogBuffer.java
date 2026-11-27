package core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Locale;

/**
 * 进程内日志环形缓冲 + 落盘文件，供「日志」页签与事后排查读取。
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
 * <p><b>两级上限</b>（2026-11-27）：只按条数限会被"一条几百字节的堆栈"撑爆
 * （实测 error 均 625B/条，2000 条 ≈ 1.2MB）。现在同时限条数与字节，谁先到丢谁，
 * 丢掉的条数记进 {@code dropped} —— 面板要能说明"日志被冲掉了"，否则用户会
 * 以为看到的就是全部。
 *
 * <p><b>落盘</b>：{@link #attachFile(String)} 之后每条同时追加到
 * {@code data/logs/backend.log}（超过 2MB 轮转为 {@code .1}，只留两份）。
 * 内存缓冲**不**从文件回填——面板里只有本次运行的日志，重启后的现场去文件里看，
 * 免得把"上次启动前的旧错误"混进当前排查。
 *
 * <p><b>内存与文件的口径不同</b>（2026-11-27）：内存缓冲把 5 秒内相邻重复的同一条
 * 合并成一行 {@code ×N}（面板友好），落盘文件则**每次事件一行**（取证友好：
 * "刷了 2500 次"在文件里就是 2500 行，数得出来）。
 *
 * <p><b>脱敏</b>：调用方传入「已经脱敏过」的文本，本类不做二次处理——但提供了
 * {@link #scrub(String)} 统一处理 query 里的敏感参数，调用方应当先过一遍。
 */
public final class LogBuffer {

    /** 保留条数。 */
    private static final int CAPACITY = 2000;

    /** 保留字节数：约 2000 条 × 750B，够装下几百条带堆栈的错误。 */
    private static final int MAX_BYTES = 1_500_000;

    /** 单条最大长度：超长的堆栈截断，否则一条异常能把缓冲撑爆。 */
    private static final int MAX_TEXT = 4000;

    /** 落盘单片上限；超过就轮转成 .1（只留两份，总量 ≤ 4MB）。 */
    private static final long FILE_MAX = 2L * 1024 * 1024;

    private static final ArrayDeque<Entry> RING = new ArrayDeque<>(CAPACITY);

    /** debug < info < warn < error；低于 {@link #minRank} 的直接丢弃。 */
    private static volatile int minRank = rankOf(System.getenv("MEOW_LOG_LEVEL"), 20);

    private static long seq = 0;
    private static long dropped = 0;
    private static long bytes = 0;

    private static PrintWriter file;
    private static File filePath;
    private static long fileBytes = 0;

    private LogBuffer() {
    }

    private static int rankOf(String name, int dflt) {
        if (name == null) return dflt;
        String s = name.trim().toLowerCase(Locale.US);
        if (s.equals("debug") || s.equals("verbose")) return 10;
        if (s.equals("info")) return 20;
        if (s.equals("warn") || s.equals("warning")) return 30;
        if (s.equals("error") || s.equals("quiet")) return 40;
        return dflt;
    }

    /** 当前级别名（面板/健康检查展示用）。 */
    public static String levelName() {
        int r = minRank;
        return r <= 10 ? "debug" : r <= 20 ? "info" : r <= 30 ? "warn" : "error";
    }

    /** debug 级是否开启。逐站/逐分片的调试打印要用它 gate，别直接 println。 */
    public static boolean debugEnabled() {
        return minRank <= 10;
    }

    /** 一条日志。{@code count} 是"这条文本在 5 秒窗口内重复了几次"（含首次）。 */
    public static final class Entry {
        public final long id;
        public long at;
        public final String level;
        public final String tag;

        /** 正文。重复合并时不变，所以对外表现为只读。 */
        public final String text;

        public long count;

        /**
         * 最后一次出现的时间（合并时更新；{@code at} 保持**首次**时间不变）。
         *
         * <p>为什么分开：面板按 {@code at} 排序，如果合并时把 {@code at} 改成"现在"，
         * 这一行会突然跳到列表底部，和它的位置对不上（真机实测：时间戳乱序）。
         * 去重窗口仍要用"最近一次"，所以单独记 lastAt。
         */
        public long lastAt;

        Entry(long id, long at, String level, String tag, String text) {
            this.id = id;
            this.at = at;
            this.lastAt = at;
            this.level = level;
            this.tag = tag;
            this.text = text;
            this.count = 1;
        }

        JSONObject toJson() throws org.json.JSONException {
            JSONObject o = new JSONObject()
                    .put("id", id)
                    .put("at", at)
                    .put("level", level)
                    .put("tag", tag)
                    .put("text", text);
            if (count > 1) o.put("count", count);
            if (lastAt != at) o.put("lastAt", lastAt);
            return o;
        }
    }

    /**
     * 记一条。
     *
     * @param level debug | info | warn | error
     * @param tag   模块标签，如 req / cache / danmaku / proxy / search / import / transcode
     */
    public static void add(String level, String tag, String text) {
        if (text == null) return;
        String lv = level == null || level.isEmpty() ? "info" : level;
        if (rankOf(lv, 20) < minRank) return;
        String norm = text.length() > MAX_TEXT ? text.substring(0, MAX_TEXT) + "…" : text;
        synchronized (RING) {
            long now = System.currentTimeMillis();
            /*
             * 相邻重复合并：同一 (级别, 标签, 正文) 在 5 秒内连续出现，
             * 只把计数 +1、时间前移，不再新增一条。
             *
             * 判据刻意只看**队尾**：正常日志是交替的，只有"卡在循环里"才会
             * 连出同一条。用全局指纹表会让任意一条旧文案命中历史记录，
             * 反而把新出现的现场吞掉。
             */
            Entry last = RING.peekLast();
            if (last != null && now - last.lastAt <= 5000
                    && last.level.equals(lv) && last.tag.equals(tag) && last.text.equals(norm)) {
                last.count++;
                // at 不动（面板排序要稳定），只推 lastAt（去重窗口按最近一次算）
                last.lastAt = now;
                /*
                 * 落盘仍然**一行一次**（不加 ×N 后缀）：落盘文件是取证用的原始事件流，
                 * 合并只发生在内存缓冲（面板用）。这样"这条刷了 2500 次"在文件里
                 * 就是 2500 行，事后数得出来；而面板里是一行 ×2500。
                 */
                writeFile(lv, tag, norm);
                return;
            }
            Entry e = new Entry(++seq, now, lv, tag, norm);
            RING.addLast(e);
            bytes += norm.length();
            evict();
            writeFile(lv, tag, norm);
        }
    }

    /** 逐出到两条上限之内，同时累计 dropped。调用方已持锁。 */
    private static void evict() {
        while (RING.size() > CAPACITY || bytes > MAX_BYTES) {
            Entry old = RING.pollFirst();
            if (old == null) break;
            bytes -= old.text.length();
            dropped++;
        }
        if (bytes < 0) bytes = 0;
    }

    public static void debug(String tag, String text) {
        add("debug", tag, text);
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
     * 记一条带堆栈的错误。
     *
     * <p>为什么不直接把 {@code t.toString()} 塞进正文：排查时最需要的恰恰是
     * 「哪一行抛的」。这里取前 8 行，既够定位又不会让一条异常占满缓冲。
     */
    public static void error(String tag, String text, Throwable t) {
        if (t == null) {
            error(tag, text);
            return;
        }
        error(tag, text + "\n" + stackOf(t, 8));
    }

    /** 异常 → 类名: 消息 + 前 N 行堆栈。 */
    public static String stackOf(Throwable t, int maxLines) {
        if (t == null) return "";
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        String[] lines = sw.toString().split("\r?\n");
        StringBuilder sb = new StringBuilder();
        int n = Math.min(lines.length, Math.max(1, maxLines));
        for (int i = 0; i < n; i++) {
            if (i > 0) sb.append('\n');
            sb.append(lines[i].trim());
        }
        return sb.toString();
    }

    /**
     * 取日志（按 id 升序）。
     *
     * @param level 空=全部；否则精确匹配 debug/info/warn/error
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

    /** 清空（页面上点「清空」）。落盘文件不动——那是事后排查用的。 */
    public static void clear() {
        synchronized (RING) {
            RING.clear();
            bytes = 0;
            dropped = 0;
        }
    }

    /** 面板要展示的统计。 */
    public static JSONObject stats() throws org.json.JSONException {
        int total;
        int errors = 0;
        int warns = 0;
        long b;
        long d;
        synchronized (RING) {
            total = RING.size();
            b = bytes;
            d = dropped;
            for (Entry e : RING) {
                if ("error".equals(e.level)) errors++;
                else if ("warn".equals(e.level)) warns++;
            }
        }
        JSONObject o = new JSONObject().put("total", total).put("errors", errors)
                .put("warns", warns).put("capacity", CAPACITY).put("lastId", lastId())
                .put("bytes", b).put("bytesCap", MAX_BYTES).put("dropped", d)
                .put("level", levelName());
        if (filePath != null) o.put("file", filePath.getAbsolutePath());
        return o;
    }

    // ---------------------------------------------------------------- 落盘

    /**
     * 挂上落盘文件（启动时调一次）。
     *
     * <p>写失败只关掉这条通道并打一行 stderr：日志落盘失败绝不能影响服务本身
     * （只读数据目录、容器无写权限都会命中）。
     */
    public static void attachFile(String path) {
        if (path == null || path.trim().isEmpty()) return;
        synchronized (RING) {
            closeFile();
            try {
                File f = new File(path);
                File dir = f.getParentFile();
                if (dir != null && !dir.exists() && !dir.mkdirs()) {
                    System.err.println("[log] 无法创建日志目录：" + dir);
                    return;
                }
                filePath = f;
                fileBytes = f.exists() ? f.length() : 0;
                file = new PrintWriter(new OutputStreamWriter(
                        new FileOutputStream(f, true), java.nio.charset.StandardCharsets.UTF_8), true);
                writeFile("info", "log", "=== 进程启动 pid=" + pid() + " level=" + levelName() + " ===");
            } catch (Throwable t) {
                file = null;
                filePath = null;
                System.err.println("[log] 落盘不可用：" + t);
            }
        }
    }

    /** 当前落盘路径（没有则空串）。 */
    public static String filePath() {
        return filePath == null ? "" : filePath.getAbsolutePath();
    }

    private static void closeFile() {
        if (file != null) {
            try {
                file.flush();
                file.close();
            } catch (Throwable ignored) {
            }
            file = null;
        }
    }

    /** 追加一行；超过单片上限先轮转。调用方已持锁。 */
    private static void writeFile(String level, String tag, String text) {
        PrintWriter w = file;
        if (w == null) return;
        try {
            /*
             * 行格式：ISO 时间 + 级别 + [tag] + 正文（换行压成 " | "）。
             *
             * ★ 用 ISO 时间而不是 HH:mm:ss：落盘文件要能被**读回来**（见 tailFile），
             *   跨天后只有 HH:mm:ss 没法还原时间戳，AI 排查时又变成"不知道什么时候"。
             */
            String line = ISO_TIME.format(new Date(System.currentTimeMillis())) + " "
                    + level.toUpperCase(Locale.US) + " [" + tag + "] "
                    + text.replace("\n", " | ") + "\n";
            w.write(line);
            w.flush();
            fileBytes += line.length();
            if (fileBytes >= FILE_MAX && filePath != null) {
                closeFile();
                File old = new File(filePath.getAbsolutePath() + ".1");
                if (old.exists() && !old.delete()) {
                    // 删不掉就别再轮转，避免两份都写满
                    fileBytes = 0;
                    reopen(filePath, true);
                    return;
                }
                if (filePath.renameTo(old)) {
                    reopen(filePath, false);
                    fileBytes = 0;
                } else {
                    // 重命名失败（Windows 上被占用最常见）：继续追加原文件
                    reopen(filePath, true);
                }
            }
        } catch (IOException | RuntimeException e) {
            closeFile();
            System.err.println("[log] 落盘失败，已停用文件日志：" + e);
        }
    }

    private static void reopen(File f, boolean append) throws IOException {
        file = new PrintWriter(new OutputStreamWriter(
                new FileOutputStream(f, append), java.nio.charset.StandardCharsets.UTF_8), true);
    }

    /**
     * 读落盘文件的末尾若干行（**重启后的现场**）。
     *
     * <p>内存环形缓冲随进程一起没了，而后端重启恰恰是最需要看日志的时候。
     * 这个方法让网页/AI 也能读到重启前写下的那一份。
     *
     * <p>行格式由 {@link #writeFile} 写入：{@code ISO时间 级别 [tag] 正文}。
     * 旧格式（只有 HH:mm:ss）解析不出时间戳的行会被跳过，不报错。
     *
     * @param maxLines 最多返回多少行（最新的在前）
     */
    public static JSONArray tailFile(int maxLines) throws org.json.JSONException {
        int cap = maxLines <= 0 ? 200 : Math.min(maxLines, 2000);
        JSONArray out = new JSONArray();
        File f = filePath;
        if (f == null) return out;
        java.util.List<String> lines = new java.util.ArrayList<>();
        // 先读 .1（更老的那份），再读当前文件；顺序即时间顺序
        File older = new File(f.getAbsolutePath() + ".1");
        if (older.isFile()) lines.addAll(readLines(older));
        if (f.isFile()) lines.addAll(readLines(f));
        int from = Math.max(0, lines.size() - cap);
        for (int i = from; i < lines.size(); i++) {
            String line = lines.get(i);
            int sp1 = line.indexOf(' ');
            if (sp1 <= 0) continue;
            int sp2 = line.indexOf(' ', sp1 + 1);
            if (sp2 <= 0) continue;
            String ts = line.substring(0, sp1);
            String level = line.substring(sp1 + 1, sp2);
            int lb = line.indexOf('[');
            int rb = lb >= 0 ? line.indexOf(']', lb) : -1;
            if (lb < 0 || rb < 0) continue;
            String tag = line.substring(lb + 1, rb);
            String text = line.substring(Math.min(line.length(), rb + 1)).trim();
            long at = 0;
            try {
                at = ISO_TIME.parse(ts).getTime();
            } catch (Exception ignored) {
                // 旧格式行：没有绝对时间，跳过（保留正文也不算错，但时间不可信）
                continue;
            }
            out.put(new JSONObject()
                    .put("at", at)
                    .put("level", level.toLowerCase(Locale.US))
                    .put("tag", tag)
                    .put("text", text));
        }
        return out;
    }

    /** 读一个文件的全部行（单文件 ≤ 2MB，安全）。 */
    private static java.util.List<String> readLines(File f) {
        java.util.List<String> out = new java.util.ArrayList<>();
        try {
            byte[] raw = java.nio.file.Files.readAllBytes(f.toPath());
            for (String s : new String(raw, java.nio.charset.StandardCharsets.UTF_8).split("\r?\n")) {
                if (!s.isEmpty()) out.add(s);
            }
        } catch (Throwable ignored) {
            // 读不到就当没有（面板仍然能用内存缓冲）
        }
        return out;
    }

    /**
     * 当前进程 pid。
     *
     * <p><b>为什么用反射</b>：这份代码**同时**编译进 JVM 宿主（server/host）
     * 和 TV 的 Android 壳（TV 把 shared/ 一起编），而
     * {@code java.lang.ProcessHandle} 在 Android 上要到 API 33 才有 ——
     * 直接调用会让整个 TV 构建挂掉（实测：找不到符号 ProcessHandle.pid）。
     * 反射拿不到就退化成 "?"，不影响排查。
     */
    private static String pid() {
        try {
            Class<?> c = Class.forName("java.lang.ProcessHandle");
            Object cur = c.getMethod("current").invoke(null);
            return String.valueOf(c.getMethod("pid").invoke(cur));
        } catch (Throwable ignored) {
            return "?";
        }
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

    private static final SimpleDateFormat ISO_TIME =
            new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS", Locale.US);

    /** 毫秒时间戳 → HH:mm:ss（面板里显示用）。 */
    public static String clock(long at) {
        return new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date(at));
    }
}
