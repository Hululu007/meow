package routes;

import core.DataPaths;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 源健康：降级、手动停用、状态查询。
 *
 * <p><b>为什么从 ApiServer 搬出来</b>：这块有自己完整的生命周期（内存状态
 * → 落盘 → 启动读回）、自己的判定规则（自动降级 30 分钟窗口 vs 手动禁用无窗口），
 * 与路由分发、spider 加载没有关系。之前埋在 8000 行的主类里，改一条规则要通读全文。
 *
 * <p><b>唯一的反向依赖用回调解掉</b>：{@code /api/health} 需要站点总数（SITES/EXT 大小），
 * 探活需要站点键集与「调一次源」。这些属于核心注册表，不属于健康域。
 * 通过 {@link SiteSource} 注入，避免健康域反过来依赖主类——那样拆了等于没拆。
 */
public final class HealthRoutes {

    /** 核心注册表向健康域暴露的最小接口。 */
    public interface SiteSource {
        /** 站点总数（/api/health 的 sites 字段）。 */
        int siteCount();

        /** ext 数量。 */
        int extCount();

        /** spider jar 是否已加载。 */
        boolean spiderJarPresent();

        /** 全部站点键（探活用）。 */
        java.util.List<String> siteKeys();

        /** 调一次站点，返回是否成功；用于主动探活。 */
        boolean probeCall(String site);
    }

    private HealthRoutes() {
    }

    private static volatile SiteSource source;

    /** 由 ApiServer 在启动时注入一次。 */
    public static void bind(SiteSource s) {
        source = s;
    }

    // ---------------------------------------------------------------- 状态

    /**
     * 滑动窗口大小：只统计最近这么多次调用。
     *
     * <p>必须定义在 {@link SiteHealth} **之前** —— 内部类的字段初始化器
     * 直接用它（`new int[WINDOW]`），Java 不允许对后置静态字段的
     * 简单名前向引用（会报"非法前向引用"）。
     */
    private static final int WINDOW = 16;

    public static final class SiteHealth {
        public volatile int ok;
        public volatile int fail;
        public volatile int streak;
        public volatile long lastOkAt;
        public volatile long lastFailAt;
        public volatile String lastError = "";
        public volatile boolean degraded;
        /**
         * 最近一次成功调用的耗时（毫秒）。
         *
         * <p>给聚合搜索决定"还要等多久"用：慢源（实测 Gz360 首轮 17.9s，之后 0.8s）
         * 如果固定按 8 秒收尾，每次都要等满 8 秒；反之快源全部 0.5s 回来时，
         * 也不该为了一个从没慢过的源干等。用实测耗时做上限更贴近现实。
         */
        public volatile long lastCostMs;
        /**
         * 手动降权（设置页的"停用这个源"）。
         *
         * <p>与 {@link #degraded} 分开存：degraded 是过程状态，30 分钟窗口后会
         * 自动给一次机会；disabled 是用户意图，只有再点一次"恢复"才会消失。
         * 两者混成一个布尔，重启后就没法区分"自动恢复"和"用户要求保留禁用"。
         */
        public volatile boolean disabled;
        /** 最近一次手动切换的时间；恢复时归零。 */
        public volatile long disabledAt;
        /**
         * 环境性不可用（配置缺失 / 运行时未接 / 目标站返回非 API 内容）。
         *
         * <p>这类失败**不算源站故障**，因此不累加 {@link #fail}、不触发降级、
         * 也不该在 UI 上和"源站挂了"混在一起。实测背景：270 站里 244 个曾被标成
         * "降级"，其中 222 个是 drpy 源（`jsRuntime 未配置`）、19 个是 `ext` 为空
         * 或指向不存在的相对路径 —— 它们在任何环境都不会成功，混进降级让
         * "244/270 降级"这个数字看起来像大面积故障。
         */
        public volatile boolean unsupported;
        /** 最近一次 unsupported 的具体原因（给设置页展示）。 */
        public volatile String unsupportedReason = "";
        /** 最近一次搜索返回的条目数；健康分用它奖励"能给出结果"的源。 */
        public volatile int lastCount;
        /**
         * "慢且常空"：最近一次搜索耗时 ≥5 秒却返回 0 条。
         *
         * <p><b>为什么单独标记而不是降级</b>：这类源**连得上**（HTTP 200）、
         * 也确实**没有结果**，降级语义是错的。但它每次都会拖住聚合的收尾窗口。
         *
         * <p>实测 {@code Jiaozi}：首轮 30.8 秒、之后 0.2 秒，返回 {@code {"list":[]}}。
         * 因为"空结构算成功"，它常年 {@code ok=141 fail=0}，没有任何机制能看见它。
         *
         * <p>用法：排序时降权（{@link #score} 已经用 lastCostMs 扣分），
         * 够了；这里只留一个可查的痕迹给设置页。
         */
        public volatile boolean slowEmpty;
        /**
         * 最近一次搜索是不是"结构合法但零结果"（如 {@code {"list":[]}}）。
         *
         * <p><b>为什么必须和"成功"分开</b>（2026-10-30 OECT 实测）：
         * 这类返回**不是错误**（HTTP 200、JSON 合法），但也没有任何价值。
         * 原来它被算作成功，于是 {@code TingBook} 攒到 {@code ok=240 fail=0}、
         * 单次耗时 **76 秒**、返回 0 条 —— 健康分接近满分，永远排在最前面，
         * 每轮都占着一个并发槽 30~40 秒。
         *
         * <p>把"能调通"与"有内容"分开计之后，这类源的成功率项不再虚高，
         * 会自然沉到排序末尾。
         */
        public volatile boolean lastEmpty;
        /**
         * 最近 {@link #WINDOW} 次调用的滑动窗口（1=成功有内容，0=其它）。
         *
         * <p><b>为什么要窗口而不是全量计数</b>：{@code ok} 只增不减，
         * 跑了 240 轮的源和新加入的源差 59 分（成功率项的上限），
         * 排序一旦固化，配置更新后新源永远排不上来。
         * 窗口只看最近 16 次，老成绩不再压制新源。
         */
        public volatile int[] window = new int[WINDOW];
        public volatile int windowPos;
        public volatile int windowFill;
        /**
         * 连续超时次数（单源超时 = 外层 8 秒没等到结果）。
         *
         * <p><b>为什么要单独计数</b>：这类源的共同特征是"占着并发槽 8 秒、
         * 然后什么也不给"。实测 OECT 上 {@code TingBook}（76 秒）、
         * {@code Tvyb}（31 秒）就是这样把整轮搜索拖到 20 秒的。
         *
         * <p>健康分只能让它们排到末尾，但**末尾的源照样会被提交**
         * （270 个源 × 12 并发，总轮得到）。所以必须有硬阈值：
         * 连续 2 次超时就本轮不提交，避免它们持续消耗线程。
         *
         * <p>与"降级 30 分钟"的区别：这里**不设时间窗**，任意一次
         * 非超时结果（成功或快速失败）立刻清零重来 —— 源站恢复后
         * 第一次正常响应就能回来。
         */
        public volatile int timeoutStreak;
        /**
         * 最近一次被判超时的时刻。{@link #isTimeoutSkipped} 用它做 TTL 放行。
         *
         * <p>没有它就会死锁：连续超时 → 跳过 → 再也不调用 → 永远没有
         * "成功清零"的机会 → 源站恢复也回不来（实测：参与源 161→39）。
         */
        public volatile long lastTimeoutAt;
        /**
         * 上一次"TTL 到期放行"的时刻。
         *
         * <p>只用于给放行本身节流：否则 TTL 一过就每轮都放行，
         * 等于没拉黑（每次搜索照样为这个慢源等 8 秒）。
         */
        public volatile long lastProbeAt;
    }

    private static final Map<String, SiteHealth> HEALTH = new ConcurrentHashMap<>();
    private static final int HEALTH_DEGRADE_STREAK = 3;
    /**
     * 主动探活的单站超时。
     *
     * <p>比搜索的总预算短得多：探活回答的是"这个源现在还能不能用"，
     * 8 秒还不回话的源对交互式搜索已经没有意义，再等只会让探活整页转圈。
     */
    public static final long PROBE_SITE_TIMEOUT_MS = 8_000L;

    /**
     * 失败原因分类。
     *
     * <p>分类不是为了好看，是因为**不同原因要采取不同动作**：
     * <ul>
     *   <li>{@link Kind#UNSUPPORTED} —— 环境不支持，长期跳过，不计入故障数</li>
     *   <li>{@link Kind#TIMEOUT} —— 源站慢，参与搜索但排在后面</li>
     *   <li>{@link Kind#DNS} —— 解析失败，多为网络/污染，可重试</li>
     *   <li>{@link Kind#TLS} —— 证书/握手失败，多为中间设备拦截</li>
     *   <li>{@link Kind#ERROR} —— 其余业务异常（HTML 当 JSON、字段缺失…）</li>
     * </ul>
     *
     * <p>上游 Fongmi 的 {@code Net.failure()} 也是这套分法（TLS / timeout /
     * cancel / DNS / invalid），差别是它只用于展示文案，不参与调度。
     */
    public enum Kind { UNSUPPORTED, TIMEOUT, DNS, TLS, CANCEL, ERROR }

    /**
     * 从异常信息里判类别。
     *
     * <p>按"最能决定动作"的顺序判：环境不支持最先（它直接决定跳过），
     * 其次网络层，最后才是业务异常。顺序反了会把 `jsRuntime 未配置`
     * 归到 ERROR 里，那样它又会去累计 fail。
     */
    public static Kind classify(String error) {
        if (error == null) return Kind.ERROR;
        String e = error;
        // 环境不支持：配置缺失、运行时没接
        if (e.contains("jsRuntime 未配置") || e.contains("jsRuntime not configured")
                || e.contains("cannot load spider") || e.contains("ClassNotFoundException")
                || e.contains("ext 为空") || e.contains("ext missing")) {
            return Kind.UNSUPPORTED;
        }
        if (e.contains("timeout") || e.contains("Timeout") || e.contains("Timed out")) return Kind.TIMEOUT;
        if (e.contains("UnknownHost") || e.contains("Host resolution")) return Kind.DNS;
        if (e.contains("SSL") || e.contains("TLS") || e.contains("certificate")) return Kind.TLS;
        if (e.contains("Cancel") || e.contains("Interrupted")) return Kind.CANCEL;
        return Kind.ERROR;
    }

    public static SiteHealth healthOf(String site) {
        return HEALTH.computeIfAbsent(site, k -> new SiteHealth());
    }

    public static SiteHealth peek(String site) {
        return HEALTH.get(site);
    }

    public static Map<String, SiteHealth> all() {
        return HEALTH;
    }

    /**
     * 记一次调用结果。
     *
     * <p>连续失败 {@code HEALTH_DEGRADE_STREAK} 次即降级；任意一次成功立刻复亮。
     * 只在状态翻转时落盘——每次调用都写文件会在高并发下打满磁盘。
     */
    /** 带耗时与条目数的记录入口（聚合搜索专用）。 */
    public static void record(String site, boolean success, String error, long costMs, int count) {
        record(site, success, error, costMs);
        SiteHealth h = HEALTH.get(site);
        if (h == null) return;
        if (success) {
            h.lastCount = count;
            /*
             * ★ "结构合法但零结果"必须与"有内容的成功"区分开。
             *
             * 踩过（2026-10-30 OECT 实测）：TingBook 单次 **76 秒**、
             * 返回 {"list":[]}，被判为成功 → ok 一路涨到 240、
             * 成功率项接近满分（60*(240-0)/(240+4)≈59）→ 永远排最前，
             * 每轮都占一个并发槽 30~40 秒，把整轮搜索拖到 20 秒以上。
             *
             * 空的成功单独计数：不涨 ok（不奖）、进窗口记 0（计入成功率），
             * 让它的分数如实反映"能调通但没价值"。
             */
            h.lastEmpty = count == 0;
            if (count > 0) {
                // 只有真有内容才算一次成功样本
                pushWindow(h, 1);
            } else {
                pushWindow(h, 0);
            }
            /*
             * 慢且空 → 标记。5 秒是"明显拖住收尾"的门槛：正常源 0.1~1s，
             * 超过 5s 说明它在等网络，而结果还是空的。
             */
            h.slowEmpty = count == 0 && costMs >= 5_000L;
        } else {
            h.slowEmpty = false;
            h.lastEmpty = true;
            pushWindow(h, 0);
        }
    }

    /** 推入滑动窗口（环形）。 */
    private static void pushWindow(SiteHealth h, int v) {
        int[] w = h.window;
        int pos = h.windowPos;
        w[pos] = v;
        h.windowPos = (pos + 1) % WINDOW;
        if (h.windowFill < WINDOW) h.windowFill++;
    }

    /** 窗口压成 "1010..." 字符串（落盘用；只取已填充部分）。 */
    private static String windowToString(SiteHealth h) {
        StringBuilder sb = new StringBuilder(h.windowFill);
        for (int i = 0; i < h.windowFill; i++) sb.append(h.window[i] == 1 ? '1' : '0');
        return sb.toString();
    }

    /** 带耗时的记录入口（给收尾窗口提供依据）。 */
    public static void record(String site, boolean success, String error, long costMs) {
        if (site == null || site.isEmpty()) return;
        if (success) {
            record(site, true, error);
            SiteHealth h = HEALTH.get(site);
            if (h != null && costMs > 0) h.lastCostMs = costMs;
            return;
        }
        /*
         * 失败要先分类：UNSUPPORTED 走独立通道，不能累加 fail。
         *
         * 踩过：`jsRuntime 未配置` 这类环境缺失也会被当成源站失败，连续 3 次就进降级。
         * 实测 270 站里 244 个被标降级，其中 222 个是 drpy（TV 上没接 Node）——
         * 于是 `/api/health` 报"244 降级"，看起来像全线故障，其实一个都没坏。
         */
        Kind kind = classify(error);
        if (kind == Kind.UNSUPPORTED) {
            SiteHealth h = healthOf(site);
            h.unsupported = true;
            h.unsupportedReason = error == null ? "" : error;
            return;
        }
        if (kind == Kind.CANCEL) return;   // 主动取消不该影响健康
        record(site, false, error);
    }

    /** 连续超时多少次后，本轮不再提交这个源。 */
    private static final int TIMEOUT_SKIP_STREAK = 2;
    /**
     * 被跳过的源多久后自动放行一次。
     *
     * <p>没有这个 TTL 就是死锁：跳过 → 不调用 → 没有成功机会 → 永不清零。
     *
     * <p><b>为什么是 10 分钟而不是 60 秒</b>（2026-10-30 OECT 实测）：
     * 这个 TTL 同时用于 `isFailedSkipped`（失效源）。60 秒时，
     * 一轮搜索本身就要 30 秒 —— 跑两轮 TTL 就到期，被拉黑的源重新参与、
     * 又把整轮拖回 30 秒，**永远收敛不了**（实测连续 11 轮都在 30~32 秒）。
     * 10 分钟才能让"拉黑"真正生效。
     *
     * <p>代价是源站恢复后最多等 10 分钟才回来。这个取舍是刻意的：
     * 那批源指向已关停的站点，本来就不会恢复；而真的恢复的场景
     * （我们自己的 drpy 容器重启）由 `scriptRuntimeUsable()` 的
     * 15 秒探测兜底，不走这条 TTL。
     */
    private static final long TIMEOUT_SKIP_TTL_MS = 10L * 60 * 1000;

    /**
     * 累计失败多少次才考虑"已失效"。
     *
     * <p>5 次是"跑过两三轮搜索"的量级：偶发网络抖动打不到，
     * 而真的关停的站点第一轮就会失败好几次。
     */
    private static final int FAIL_SKIP_MIN_FAILS = 5;
    /**
     * 多久内成功过就算"还在用"。
     *
     * <p>30 分钟：有些源只在特定时段/特定词上出结果，窗口太短会误杀
     * 间歇可用的源（实测有 `ok=13 fail=30` 这种）。
     */
    private static final long FAIL_SKIP_RECENT_OK_MS = 30L * 60 * 1000;

    /**
     * 这个源是否应该在本轮**跳过不提交**（硬阈值）。
     *
     * <p>与 {@link #isSkipped} 分工不同：
     * <ul>
     *   <li>{@code isSkipped} = "永远不该搜"（用户停用 / 环境不支持）</li>
     *   <li>这个方法 = "现在搜它只是浪费时间，但源站可能随时恢复"</li>
     * </ul>
     *
     * <p>判据只有一条：<b>连续 {@value #TIMEOUT_SKIP_STREAK} 次超时</b>。
     * 任意一次非超时结果（成功、或快速失败）立刻清零。
     *
     * <p><b>还必须带 TTL，否则是死锁</b>：跳过之后就没有调用，
     * 也就没有"成功一次就清零"的机会 —— 源站恢复了也永远回不来。
     * 实测踩过（2026-10-30）：跑完一轮后参与源从 161 掉到 39，
     * 一小批慢站被永久拉黑。60 秒后自动放行一次：真恢复就清零，
     * 还慢就再记两次超时重新拉黑。
     *
     * <p>为什么不只用健康分排序：排序只决定提交顺序，而 270 个源 ÷ 12 并发
     * 意味着**排最后的源照样会被提交**。实测 OECT 上 TingBook/Tvyb
     * 排再后也每轮都占 8 秒并发槽，整轮被拖到 20 秒。必须硬拦。
     */
    /**
     * 这个源是否"已确认失效"，本轮不该再提交。
     *
     * <p><b>与 {@link #isTimeoutSkipped} 的区别</b>：
     * <ul>
     *   <li>{@code isTimeoutSkipped} = "慢，白占并发槽"（判据是连续超时）</li>
     *   <li>本方法 = "根本不能用"（判据是**累计失败多且很久没成功**）</li>
     * </ul>
     *
     * <p><b>为什么需要它</b>（2026-10-30 OECT 实测）：226 个 drpy 源里
     * 有近百个指向已关停的第三方站点，drpy 每次都返回 `fetch failed`。
     * 它们不是"超时"，所以 `timeoutStreak` 不涨；它们也不是 `unsupported`
     * （配置合法、容器也在），所以 `isSkipped` 也不拦。结果每轮各烧 3~6 秒，
     * 96 个这样的源把整轮拖到 30 秒总预算上限，jar 源的好结果白等。
     *
     * <p><b>判据为什么用"累计失败 + 最近成功时间"而不是纯失败次数</b>：
     * 有些源是"时好时坏"（实测 `ok=13 fail=30` 这种还在偶尔出结果），
     * 纯按失败次数会把它们误杀。要求"最近 30 分钟一次都没成功"才判失效，
     * 间歇可用的源只要有任意一次成功就会被放回来。
     *
     * <p><b>恢复</b>：与超时跳过共用 TTL 放行机制 —— 60 秒后自动试一次，
     * 成功即清零（见 recordHealth 的成功分支）。
     */
    public static boolean isFailedSkipped(String site) {
        SiteHealth h = HEALTH.get(site);
        if (h == null) return false;
        if (h.fail < FAIL_SKIP_MIN_FAILS) return false;
        long now = System.currentTimeMillis();
        // 近期成功过 → 不算失效（间歇可用的源要留）
        if (h.lastOkAt > 0 && now - h.lastOkAt < FAIL_SKIP_RECENT_OK_MS) return false;
        long since = Math.max(h.lastFailAt, h.lastProbeAt);
        if (since > 0 && now - since > TIMEOUT_SKIP_TTL_MS) {
            // 到点放行一次，与 isTimeoutSkipped 同一套节流
            h.lastProbeAt = now;
            saveQuietly();
            return false;
        }
        return true;
    }

    public static boolean isTimeoutSkipped(String site) {
        SiteHealth h = HEALTH.get(site);
        if (h == null) return false;
        if (h.timeoutStreak < TIMEOUT_SKIP_STREAK) return false;
        long now = System.currentTimeMillis();
        long since = Math.max(h.lastTimeoutAt, h.lastProbeAt);
        if (since > 0 && now - since > TIMEOUT_SKIP_TTL_MS) {
            /*
             * ★ 到期只"放行一次"，**不清计数**。
             *
             * 踩过（2026-10-30 本地实测）：原来这里 `timeoutStreak = 0`，
             * 于是每次到期就清零 → 下一轮重新数两次超时 → 又被放行……
             * 慢源（TingBook/Tvyb）每轮都占 8 秒并发槽，永远拉黑不了。
             * 日志里 `跳过连续超时源` 一次都没出现，而 `slow TingBook 8000ms`
             * 每轮都在。
             *
             * 正确语义：TTL 只决定"什么时候再给它一次机会"，
             * 计数归零只由**真的成功**触发（recordTimeout(site,false) 与
             * recordHealth 的成功分支）。这样：
             *   - 放行后成功 → 清零，恢复正常
             *   - 放行后再超时 → streak 继续往上加，立刻重新拉黑
             *
             * `lastProbeAt` 记"上一次放行时刻"，让放行本身按
             * TIMEOUT_SKIP_TTL_MS 节流 —— 否则 TTL 一过就每轮都放行，
             * 等于没拉黑。
             */
            h.lastProbeAt = now;
            saveQuietly();
            return false;
        }
        return true;
    }

    /** 该站最近一次成功耗时；没记录过返回 0。 */
    public static long lastCost(String site) {
        SiteHealth h = HEALTH.get(site);
        return h == null ? 0L : h.lastCostMs;
    }

    /**
     * 记一次"这次是超时"（供硬阈值跳过用）。
     *
     * <p>单独入口而不是塞进 {@link #record}：超时是聚合层（外层 8 秒）判定的，
     * 而 {@code record} 是 call() 内部按真实成败记的 —— 两层口径不同，
     * 混在一起会让"外层放弃了但内层最终成功"这种情形互相覆盖。
     */
    public static void recordTimeout(String site, boolean timedOut) {
        if (site == null || site.isEmpty()) return;
        SiteHealth h = healthOf(site);
        boolean wasSkip = h.timeoutStreak >= TIMEOUT_SKIP_STREAK;
        if (timedOut) {
            int before = h.timeoutStreak;
            h.timeoutStreak++;
            /*
             * ★ lastTimeoutAt 只在"刚跨过阈值"时记，不要每次超时都刷新。
             *
             * 踩过（2026-10-30 本地实测 4 轮）：每次超时都更新它，导致
             * TTL 的起点一直在往后跑 —— `now - lastTimeoutAt` 永远小于 60 秒，
             * 于是 `isTimeoutSkipped` 永远返回"该跳过"，而 TTL 分支永远不
             * 触发放行，可慢源又因为别的原因仍然参与……两边都不成立。
             *
             * 语义应该是"从什么时候开始拉黑"：跨过阈值那一刻。
             * 之后无论再超时多少次，拉黑起点不变，60 秒后必然放行一次。
             */
            if (before < TIMEOUT_SKIP_STREAK) {
                h.lastTimeoutAt = System.currentTimeMillis();
                h.lastProbeAt = 0;
            }
        } else {
            h.timeoutStreak = 0;
            h.lastTimeoutAt = 0;
            h.lastProbeAt = 0;
        }
        boolean nowSkip = h.timeoutStreak >= TIMEOUT_SKIP_STREAK;
        // 只在"是否被跳过"翻转时落盘：每次搜索成功都写文件会打满磁盘，
        // 而中间态（1 次超时）重启后重新累计也无所谓。
        if (wasSkip != nowSkip) saveQuietly();
    }

    public static void record(String site, boolean success, String error) {
        if (site == null || site.isEmpty()) return;
        SiteHealth h = healthOf(site);
        boolean was = h.degraded;
        if (success) {
            h.ok++;
            h.streak = 0;
            h.lastOkAt = System.currentTimeMillis();
            h.degraded = false;
            // 能调通就不再是"环境不支持"（配置可能刚被修好）
            h.unsupported = false;
            h.unsupportedReason = "";
        } else {
            h.fail++;
            h.streak++;
            h.lastFailAt = System.currentTimeMillis();
            if (error != null) h.lastError = error;
            if (h.streak >= HEALTH_DEGRADE_STREAK) h.degraded = true;
        }
        if (was != h.degraded) saveQuietly();
    }

    /**
     * 健康分（参考影视仓 {@code SiteHealthStore.score}，用于排序而非过滤）。
     *
     * <pre>
     *   score = 60 * windowRate                  // 最近 16 次里"有内容"的比例
     *         + min(lastCount, 20) * 1.2         // 能出结果的有加分
     *         - min(lastCostMs/1000, 30)         // 慢的扣分（最多扣 30 分，不封顶在 8）
     *         - 15 (如果 lastEmpty)              // 零结果额外重罚
     * </pre>
     *
     * <p><b>为什么用窗口比例而不是全量 ok/fail</b>（2026-10-30 修正）：
     * 全量计数只增不减，跑了 240 轮的源和新源差 59 分，排序一旦固化，
     * 配置更新后新源永远排不上来。窗口只看最近 16 次，源站恢复后
     * 十几个样本就能翻身。
     *
     * <p><b>为什么耗时扣分不封顶在 8 分</b>（2026-10-30 修正）：
     * 实测 {@code TingBook lastCostMs=75992}（76 秒）与一个 8 秒的源
     * 扣分完全相同（都是 -8），最该沉底的源没被惩罚。现在按秒扣、
     * 上限 30 分，76 秒的源直接扣满。
     *
     * <p><b>为什么零结果额外重罚</b>：{@code {"list":[]}} 不是错误，
     * 但对我们毫无价值，而且这类源往往很慢（TingBook 76 秒）。
     * 原来它算"成功"、ok 涨到 240、分数接近满分，永远排最前。
     *
     * <p><b>为什么 count 的权重是 1.2</b>：一个能给出 20 条结果的源，比一个
     * 常年返回 0 条的源有用得多，但"结果多"不等于"质量高"，所以给个小权重，
     * 不压过成功率。上限 20 是防止某个源一次吐 500 条就把分数拉爆。
     *
     * <p><b>没记录的源给 0 分</b>而不是负分：让它落在中间，既不优先也不惩罚。
     */
    public static double score(String site) {
        SiteHealth h = HEALTH.get(site);
        if (h == null) return 0.0;
        if (h.windowFill == 0) return 0.0;
        int good = 0;
        for (int i = 0; i < h.windowFill; i++) good += h.window[i];
        double rate = h.windowFill == 0 ? 0.0 : (double) good / h.windowFill;
        double s = 60.0 * rate;
        s += Math.min(Math.max(h.lastCount, 0), 20) * 1.2;
        // 每慢 1 秒扣 1 分，上限 30 分（76 秒的源扣满，8 秒的源扣 8 分）
        s -= Math.min(Math.max(h.lastCostMs, 0) / 1000.0, 30.0);
        if (h.lastEmpty) s -= 15.0;
        // slowEmpty 已由 lastEmpty + lastCostMs 共同覆盖（零结果 + 慢各扣一次），
        // 不再单独扣 —— 重复扣会让同一个问题被罚两遍，排序失真。
        return s;
    }

    /**
     * 按健康分从高到低排序（**只排序，不过滤**）。
     *
     * <p>与影视仓 {@code SiteHealthStore.sortSites} 同语义：搜索仍然对全部站点
     * 发起请求，只是让"历史上更可靠、更快、结果更多"的源先返回 ——
     * 用户先看到的就是这些，慢源/死源的结果晚到也不影响首屏。
     *
     * <p>为什么不过滤：过滤会让源永久"隐身"（这也是删掉 30 分钟失活窗口的原因）。
     * 排序是软性的，源站恢复后分数自然回升，不需要任何"复亮"机制。
     */
    public static java.util.List<String> sortByScore(java.util.List<String> sites) {
        java.util.List<String> out = new java.util.ArrayList<>(sites);
        out.sort((a, b) -> Double.compare(score(b), score(a)));
        return out;
    }

    /**
     * 这个源现在该不该被聚合跳过——**唯一判定入口**。
     *
     * <p>搜索、直播、主动探活三处共用。
     *
     * <p><b>这里只剩两种跳过，且都不用时间窗</b>：
     * <ol>
     *   <li><b>手动停用</b>：用户意图，直到他自己恢复</li>
     *   <li><b>环境不支持</b>（{@code unsupported}）：配置缺失 / 运行时未接，
     *       在配置被修好之前搜一万次也是同样结果。一次成功即自动清除</li>
     * </ol>
     *
     * <p><b>为什么删掉了"自动降级 30 分钟"</b>：
     * <ul>
     *   <li><b>逻辑上自相矛盾</b>：降级期间源根本不参与搜索，就不可能"任意一次成功
     *       立即复亮"——唯一恢复路径是用户手动点设置页的"探活"。不点就干等 30 分钟。</li>
     *   <li><b>实测不需要它挡任何东西</b>：270 站全量搜索 2.14s，跳过降级（26 站）
     *       反而 2.70s，结果完全持平（36 条 / 11 源）。因为真正被它挡住的源分两类：
     *       一类是环境不支持（0.025s 就失败，留着不花钱），一类是真慢源——
     *       而慢源已经由收尾策略消化（把 4 个 10~12s 的慢源强制加入，搜索反而只要 1.77s）。</li>
     *   <li><b>上游三家都不这么做</b>：Fongmi 只有手动开关；影视仓
     *       （{@code SiteHealthStore}）有健康分但**明确只排序、从不过滤**；
     *       CatVodSpider 完全没有健康概念。</li>
     * </ul>
     *
     * <p>失败次数仍然记录（{@link SiteHealth#fail}），用途改为：
     * 设置页展示"这个源最近老失败"、搜索结果按健康分排序。
     */
    public static boolean isSkipped(String site) {
        SiteHealth h = HEALTH.get(site);
        if (h == null) return false;
        if (h.disabled) return true;
        return h.unsupported;
    }

    /**
     * 手动降权 / 恢复。
     *
     * <p>恢复时顺手清掉 streak 与 degraded：用户点"恢复"的语义是
     * "现在就再给它一次机会"，而不是"解除锁定后再等 30 分钟"。
     */
    public static void setDisabled(String site, boolean disabled) {
        SiteHealth h = healthOf(site);
        h.disabled = disabled;
        h.disabledAt = disabled ? System.currentTimeMillis() : 0;
        if (!disabled) {
            h.streak = 0;
            h.degraded = false;
        }
        saveQuietly();
    }

    /** {@code /api/health/state} 的响应体。 */
    public static String stateJson() {
        JSONArray degraded = new JSONArray();
        JSONArray disabled = new JSONArray();
        JSONArray unsupported = new JSONArray();
        JSONObject items = new JSONObject();
        try {
            for (Map.Entry<String, SiteHealth> e : HEALTH.entrySet()) {
                SiteHealth h = e.getValue();
                JSONObject o = new JSONObject();
                o.put("ok", h.ok).put("fail", h.fail).put("streak", h.streak)
                        .put("degraded", h.degraded).put("disabled", h.disabled)
                        .put("lastError", h.lastError)
                        .put("unsupported", h.unsupported)
                        .put("unsupportedReason", h.unsupportedReason)
                        .put("lastCount", h.lastCount)
                        .put("lastCostMs", h.lastCostMs)
                        .put("lastOkAt", h.lastOkAt).put("lastFailAt", h.lastFailAt);
                if (h.degraded) degraded.put(e.getKey());
                if (h.disabled) disabled.put(e.getKey());
                if (h.unsupported) unsupported.put(e.getKey());
                items.put(e.getKey(), o);
            }
            JSONObject out = new JSONObject();
            out.put("degraded", degraded).put("disabled", disabled)
                    .put("unsupported", unsupported).put("sites", items);
            return out.toString();
        } catch (Exception e) {
            // android-json 的受检异常：宁可返回空结构，也不要 500 空 body
            return "{\"degraded\":[],\"disabled\":[],\"sites\":{}}";
        }
    }

    // ---------------------------------------------------------------- 持久化

    private static File healthFile() {
        return DataPaths.file("site-health.json");
    }

    /**
     * 清空全部源健康记录（含跳过/降档/降级标记），并落盘。
     *
     * <p>给设置页的「重置源健康」按钮用。典型场景：
     * <ul>
     *   <li>刚修好了源站/换了网络，不想等 10 分钟 TTL 才恢复</li>
     *   <li>误判了大批源（比如在错误的网络环境下跑过一轮），想立刻重来</li>
     *   <li>排查"为什么这个源没参与搜索"</li>
     * </ul>
     *
     * <p>只清文件与内存表，不影响 {@code config.sites.json}（用户停用状态
     * 存在源码表那边，不在这个文件里）。
     */
    public static synchronized void resetAll() {
        int n = HEALTH.size();
        HEALTH.clear();
        try {
            File f = healthFile();
            if (f.exists() && !f.delete()) {
                // 删不掉就写空表，效果等价
                saveQuietly();
            }
        } catch (Throwable ignored) {
        }
        core.LogBuffer.info("health", "手动重置源健康记录 " + n + " 条");
    }

    public static synchronized void saveQuietly() {
        try {
            JSONObject items = new JSONObject();
            for (Map.Entry<String, SiteHealth> e : HEALTH.entrySet()) {
                SiteHealth h = e.getValue();
                JSONObject o = new JSONObject();
                o.put("ok", h.ok).put("fail", h.fail).put("streak", h.streak)
                        .put("lastOkAt", h.lastOkAt).put("lastFailAt", h.lastFailAt)
                        .put("lastError", h.lastError).put("degraded", h.degraded)
                        .put("disabled", h.disabled).put("disabledAt", h.disabledAt)
                        .put("unsupported", h.unsupported)
                        .put("unsupportedReason", h.unsupportedReason)
                        .put("lastCount", h.lastCount).put("lastCostMs", h.lastCostMs)
                        .put("slowEmpty", h.slowEmpty)
                        .put("lastEmpty", h.lastEmpty)
                        // 窗口压成 "1010..." 字符串：16 次调用只占 16 字节，
                        // 比 JSONArray 省一半以上，且读回解析简单。
                        .put("win", windowToString(h))
                        .put("winFill", h.windowFill).put("winPos", h.windowPos)
                        /*
                         * timeoutStreak 要落盘：慢源（TingBook 76 秒）
                         * 重启后如果计数归零，会立刻又被提交、又白占 8 秒。
                         * 保留它等于"重启后仍认得这个慢源"。
                         */
                        .put("timeoutStreak", h.timeoutStreak)
                        /*
                         * lastTimeoutAt 必须一起落盘：isTimeoutSkipped 的
                         * TTL 放行靠它。丢了时间戳，重启后源会被无限跳过
                         * （timeoutStreak 还在、但没有基准时间）。
                         */
                        .put("lastTimeoutAt", h.lastTimeoutAt)
                        .put("lastProbeAt", h.lastProbeAt);
                items.put(e.getKey(), o);
            }
            JSONObject root = new JSONObject();
            root.put("sites", items);
            Files.write(healthFile().toPath(),
                    root.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            // 落盘失败只影响重启后的记忆，不能影响在线功能
        }
    }

    /** 启动时读回。格式不认就当空表——宁可丢历史状态，也不要起不来。 */
    public static synchronized void load() {
        try {
            File f = healthFile();
            if (!f.isFile()) return;
            String s = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
            if (s.trim().isEmpty()) return;
            JSONObject root = new JSONObject(s);
            JSONObject items = root.optJSONObject("sites");
            if (items == null) return;
            // android-json 的 JSONObject 没有 keySet()，只有 keys() 迭代器
            java.util.Iterator<String> it = items.keys();
            while (it.hasNext()) {
                String k = it.next();
                JSONObject o = items.optJSONObject(k);
                if (o == null) continue;
                SiteHealth h = new SiteHealth();
                h.ok = o.optInt("ok");
                h.fail = o.optInt("fail");
                h.streak = o.optInt("streak");
                h.lastOkAt = o.optLong("lastOkAt");
                h.lastFailAt = o.optLong("lastFailAt");
                h.lastError = o.optString("lastError", "");
                h.degraded = o.optBoolean("degraded");
                h.disabled = o.optBoolean("disabled");
                h.disabledAt = o.optLong("disabledAt");
                /*
                 * ★ unsupported 不跨进程保留。
                 *
                 * 它表达的是"**上次这个运行环境**不支持这个源"（drpy 缺运行时、
                 * ext 为空、类加载失败）。而重启往往正是因为改了配置/换了 jar ——
                 * 把旧标记带回来会让修好的源继续被跳过，看起来像"改了也没用"。
                 *
                 * 实测踩过：PC 插件用错 classpath 启动后 237 个源被标 unsupported，
                 * 换成正确 classpath 重启，标记还在，搜索只剩 33 个源参与。
                 *
                 * degraded / fail 仍保留（那是源站本身的历史表现，与环境无关）。
                 */
                h.unsupported = false;
                h.unsupportedReason = "";
                h.lastCount = o.optInt("lastCount");
                h.lastCostMs = o.optLong("lastCostMs");
                h.slowEmpty = o.optBoolean("slowEmpty");
                h.lastEmpty = o.optBoolean("lastEmpty");
                h.timeoutStreak = o.optInt("timeoutStreak");
                h.lastTimeoutAt = o.optLong("lastTimeoutAt");
                h.lastProbeAt = o.optLong("lastProbeAt");
                // 窗口是老版本没有的字段：读不到就保持空窗口，
                // 第一次调用会自然填上（分数从 0 开始，不偏袒任何源）
                String win = o.optString("win", "");
                int fill = o.optInt("winFill", 0);
                if (!win.isEmpty() && fill > 0 && fill <= WINDOW) {
                    int[] arr = new int[WINDOW];
                    int n = Math.min(Math.min(win.length(), fill), WINDOW);
                    for (int i = 0; i < n; i++) arr[i] = win.charAt(i) == '1' ? 1 : 0;
                    h.window = arr;
                    h.windowFill = n;
                    h.windowPos = o.optInt("winPos", 0) % WINDOW;
                }
                HEALTH.put(k, h);
            }
        } catch (Exception ignored) {
        }
    }

    /**
     * {@code /api/health} 里的健康段。
     *
     * <p>把"需要用户关注的"（degraded = 真源站反复失败）与
     * "配置/环境问题"（unsupported）分开报：混在一起时
     * 一个配错的 drpy 表就能让"降级 244/270"看起来像全线崩溃。
     */
    public static void putSummary(JSONObject o) throws org.json.JSONException {
        JSONArray degraded = new JSONArray();
        JSONArray unsupported = new JSONArray();
        for (Map.Entry<String, SiteHealth> e : HEALTH.entrySet()) {
            SiteHealth h = e.getValue();
            if (h.unsupported) unsupported.put(e.getKey());
            else if (h.degraded || h.disabled) degraded.put(e.getKey());
        }
        o.put("degraded", degraded);
        o.put("degradedCount", degraded.length());
        o.put("unsupported", unsupported);
        o.put("unsupportedCount", unsupported.length());
    }
}
