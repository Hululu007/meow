package core;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * 按需转码：把浏览器放不了的片子（MKV / HEVC / DTS…）实时转成 HLS。
 *
 * <p><b>为什么不预先处理用户的文件</b>：用户的片库是只读的资产，
 * 转码产物一律写进我们的缓存目录，原文件一个字节都不动。
 *
 * <p><b>为什么转成 HLS 而不是 mp4</b>：mp4 必须等 moov 写完才能播（整片转完），
 * 而 HLS 是分片产出——ffmpeg 转完头两个分片播放器就能起播。
 * 实测 H.264 转码约 6.7 倍速（60s 内容 9s 转完），片头几百毫秒就能看。
 *
 * <p><b>为什么必须重编码视频</b>：`-c copy` 换容器只需 16 秒且无损，
 * 但 HEVC 在 Chromium/WebView2 里根本没有解码器（实测
 * {@code canPlayType('video/mp4; codecs="hvc1"')} 返回空串），
 * 换容器解决不了播放问题。TV 端走 ExoPlayer 不需要这条路。
 */
public final class Transcode {

    private Transcode() {
    }

    private static final String ROOT = "cache/transcode";
    /** 每个分片的秒数。2 秒是 HLS 惯例，起播延迟与请求数之间的平衡点。 */
    /**
     * HLS 分片时长（秒）。
     *
     * <p>2026-11-17 从 4 改成 2：转码首片要等"第一个分片"落盘，分片越短首帧越快。
     * OECT 实测 4K HEVC 全链路 3 fps，4 秒片要 32 秒、2 秒片只要 ~16 秒。
     * 规范建议 2~6 秒；代价是分片数翻倍（21 分钟片 ~630 片，内网无感）。
     */
    private static final int SEG_SECONDS = 2;

    private static final Map<String, Job> JOBS = new ConcurrentHashMap<>();

    public static final class Job {
        public String id = "";
        public String source = "";
        /**
         * 源站要求的请求头（JSON：{"User-Agent":"…","Referer":"…"}）。
         * 点播线路大量依赖 UA/Referer（2026-11-23 实报：咕噜4K 无 UA 直接 404），
         * 转码是后端自己拉流，必须替前端把这份头带上，否则"浏览器能播、转码 404"。
         */
        String header = "";
        public String state = "idle"; // idle|running|ready|failed|canceled
        public String error = "";
        public long startedAt = System.currentTimeMillis();
        /**
         * 最后被播放器访问的时间（拉 m3u8/分片时刷新）。
         * 生命周期清理用它判断"正在播的绝不删"——只看目录 mtime 不够：
         * 读分片不会更新 mtime，后端重启后 Job 又丢了（2026-11-17 S4）。
         */
        public volatile long lastAccess = 0;
        /**
         * 本次是否跑在 rkmpp 硬解硬编路径上（2026-11-17）。
         * 硬解失败（VDEC 通道被占 / 编码规格不被 MPP 支持）时用来决定是否回退软解。
         */
        boolean hw = false;
        /**
         * 本次是「原分辨率修复」任务（2026-11-24）。
         * 高丢帧自愈用：源是"全 B 帧 GOP"这类时间轴/码流结构病，copy 修不了，
         * 只能按原分辨率用显卡重编一遍（4K 仍是 4K，不降画质）。
         */
        boolean repair = false;
        /** repair 从源的第几秒开始（0 = 从头）。前端播放时间 = 修复流时间 + startOffset。 */
        int startOffset = 0;
        /**
         * 客户端能否解 HEVC（2026-11-24）。旧客户端不传，默认 true 保持原行为；
         * 新前端按端侧实测能力传 false 时，repair 只出 H.264（低端 TV 安全）。
         */
        boolean allowHevc = true;
        /** 已回退过几次（只回退一次，避免来回折腾）。 */
        int hwRetry = 0;
        /** 短产出自动重试次数（回环流断开会让 ffmpeg 正常退出但只转出一段）。 */
        int shortRetry = 0;
        /** 启动本次任务用的 ffmpeg 路径与探测结果（pump 回退重试用）。 */
        String ffPath = "";
        Probe probeSnap;
        Process proc;
        public int segments;
        /** 已产出的可播时长（秒），用于前端显示"转码中 x 秒" */
        public int readySeconds;
        /** 机器可读的失败原因：slow_4k / no_ffmpeg / source_timeout / ... */
        public String code = "";
        /** probe | transcode | ready | failed | cancelled（前端据此说人话） */
        public String phase = "idle";
        /** 最近一次分片增长的时间；前端/状态接口用它判断"是不是卡住了" */
        public long lastSegmentAt = 0;
    }

    /**
     * 模式化的幂等键（2026-11-24）：copy / repair 的产物不能和普通转码互相复用。
     *
     * <p>同一个 4K 源可能先被普通转码过（1080p），再做修复转码（4K）；
     * 若共用 id，第二次会直接拿到旧产物。分隔符用 \u0001，URL 里不会出现。
     */
    public static String idFor(String source, boolean copy, boolean repair) {
        String m = repair ? "repair" : copy ? "copy" : "";
        return m.isEmpty() ? idFor(source) : idFor(source + "\u0001" + m);
    }

    /** 转码 id：源地址的哈希。同一集重复点播复用同一份产物。 */
    public static String idFor(String source) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
            byte[] d = md.digest(source.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.substring(0, 16);
        } catch (Exception e) {
            return Integer.toHexString(source.hashCode());
        }
    }

    /**
     * 转码「真正做完」的标记文件。
     *
     * <p><b>为什么必须有</b>（2026-11-17 实测踩过）：原来只看 `index.m3u8` 在不在，
     * ffmpeg 中途被杀/崩溃时清单已经写出几片，于是被判成 ready —— 用户播到断点
     * 就永远卡住（实测 01.mkv 只有 74 秒、03.mkv 只有 6 秒就被当成"转完了"），
     * 而且再点播放也不会重转。只有 ffmpeg **exit 0** 才写这个标记。
     */
    private static final String DONE_FILE = ".done";

    /**
     * 源总时长（秒），落盘在转码目录的 `.duration`。
     *
     * <p><b>为什么落盘</b>：转码还没转完时，HLS 清单只包含已转出的分片，
     * 前端 `video.duration` 就等于"已转出时长"——进度条总长会随着转码一点点变长
     * （用户看到 0:03 / 0:12，而整集是 22 分钟）。把真实时长告诉前端，
     * 进度条才能一次显示对的。落盘也让 java 重启后仍能报出正确总长。
     */
    private static final String DURATION_FILE = ".duration";

    private static void saveDuration(String id, double dur) {
        if (dur <= 0) return;
        try {
            Files.createDirectories(dirOf(id));
            Files.write(dirOf(id).resolve(DURATION_FILE),
                    String.valueOf((long) Math.round(dur)).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception ignored) {
        }
    }

    /** 读源总时长；没有记录返回 0。 */
    public static double durationOf(String id) {
        try {
            Path f = dirOf(id).resolve(DURATION_FILE);
            if (!Files.isRegularFile(f)) return 0;
            return Double.parseDouble(new String(Files.readAllBytes(f),
                    java.nio.charset.StandardCharsets.UTF_8).trim());
        } catch (Exception e) {
            return 0;
        }
    }

    /** 转码产物是否完整可用（完成标记 + 清单都在）。 */
    public static boolean playable(String id) {
        return Files.isRegularFile(dirOf(id).resolve(DONE_FILE))
                && Files.isRegularFile(playlistOf(id));
    }

    private static void markDone(String id) {
        try {
            Files.createDirectories(dirOf(id));
            Files.write(dirOf(id).resolve(DONE_FILE), new byte[0]);
        } catch (Exception ignored) {
        }
    }

    private static void clearDone(String id) {
        try {
            Files.deleteIfExists(dirOf(id).resolve(DONE_FILE));
        } catch (Exception ignored) {
        }
    }

    /**
     * 同一时刻只允许一个重转码在跑。
     *
     * <p><b>为什么</b>（实测）：RK 的 VDEC 通道有限，两个 4K 任务并发时第二个会以
     * "Error while opening decoder: Generic error in an external library" 直接崩；
     * 而且用户切集后旧任务还在白烧 CPU。被停掉的任务顺手把半成品清掉，
     * 下次进来自动重转（没有 .done 就不算完成）。
     */
    /**
     * 空闲自动取消：任务在跑但超过这个时长没有任何分片/清单访问 → 判为"没人看"。
     * 2026-11-23 用户要求：退出播放页后后端别空转（10-bit 一集要转两小时）。
     * 120 秒是折中：短暂退出再回来仍能续看，长期不白烧 CPU。
     */
    private static final long IDLE_CANCEL_MS = 120_000L;
    private static final java.util.concurrent.atomic.AtomicBoolean IDLE_WATCH =
            new java.util.concurrent.atomic.AtomicBoolean();

    /** 起一次守护线程（幂等）：每 15 秒扫一遍运行中的任务，超时就取消。 */
    private static void armIdleWatcher() {
        if (!IDLE_WATCH.compareAndSet(false, true)) return;
        Thread t = new Thread(() -> {
            while (true) {
                try {
                    Thread.sleep(15_000L);
                    long now = System.currentTimeMillis();
                    for (Job j : new java.util.ArrayList<>(JOBS.values())) {
                        if (!"running".equals(j.state)) continue;
                        long last = Math.max(j.lastAccess, j.startedAt);
                        if (now - last <= IDLE_CANCEL_MS) continue;
                        j.state = "cancelled";
                        j.phase = "cancelled";
                        j.code = "idle_timeout";
                        j.error = "";
                        try {
                            if (j.proc != null) j.proc.destroyForcibly();
                        } catch (Exception ignored) {
                        }
                        System.err.println("[transcode] cancelled " + j.id
                                + " (idle " + ((now - last) / 1000) + "s)");
                    }
                } catch (InterruptedException e) {
                    return;
                } catch (Throwable ignored) {
                    // 守护线程绝不能被单次异常打死
                }
            }
        }, "transcode-idle-watch");
        t.setDaemon(true);
        t.start();
    }

    private static boolean stopOtherJobs(String keepId, boolean newNeedsHw) {
        long now = System.currentTimeMillis();
        /*
         * 抢占保护（2026-11-23 用户要求）：另一台设备正在看 4K 硬转时，
         * 新来的硬件任务不再"无条件杀掉它"——被杀的那台会立刻 404 卡死。
         * 30 秒内有分片访问 = 真的在看（播放器 5 秒一轮询）；此时拒绝新任务，
         * 由前端明确提示「另一台设备正在转码」。
         */
        if (newNeedsHw) {
            for (Job o : new java.util.ArrayList<>(JOBS.values())) {
                if (o.id.equals(keepId) || !"running".equals(o.state)) continue;
                /*
                 * 只有**硬件**任务占 VDEC；copy（-c:v copy）和软编不吃硬解通道。
                 * 把它们也算成"忙"会误伤：片库 8-bit 的 copy 任务在跑时点开 4K，
                 * 立刻被 hw_busy 挡住（实测踩过）。
                 */
                if (!o.hw) continue;
                if (now - o.lastAccess < 30_000L) {
                    System.err.println("[transcode] busy: " + o.id
                            + " watched, reject new hw job " + keepId);
                    return false;
                }
            }
        }
        for (Job o : new java.util.ArrayList<>(JOBS.values())) {
            if (o.id.equals(keepId) || !"running".equals(o.state)) continue;
            // 新硬件任务只跟硬件任务抢 VDEC；copy/软编任务继续跑，不打断观看
            if (newNeedsHw && !o.hw) continue;
            /*
             * ★ 有人正在看（60 秒内取过分片）就不抢：2026-11-23 实报。
             *
             * 原实现"只有新任务能活"是为了防两路硬件转码抢 VDEC 崩库。但实际
             * 打脸场景是：用户在放 8-bit 片（copy 视频，几乎不吃 CPU），一个
             * 诊断请求/第二台设备点开别的集 → 新任务直接把正在看的任务杀掉 →
             * 播放器拿 404 → 前端弹「转码失败」，退出再进也报错。
             *
             * 现在只在**新任务要用硬件解码**时才无条件停旧的（VDEC 通道有限，
             * 这个理由仍然成立）；软件任务并发只是分 CPU，打断观看的代价更大。
             */
            if (!newNeedsHw && now - o.lastAccess < 60_000L) {
                System.err.println("[transcode] keep " + o.id + " (watched, new job is software, keep=" + keepId + ")");
                continue;
            }
            o.state = "cancelled";
            /*
             * ★ 严格串行：不再因为 `.access` 十分钟内有写入就放行（2026-11-20 改）。
             *
             * 原来那条豁免是为了"两台设备同时看不同集"不互相打断，实际后果是
             * 串行形同虚设：OECT 上 A 刚被播放器取过分片 → 一直"最近被播"，
             * B 起来时 A 不会被杀，两路 ffmpeg 并发各占 575MB 空转。
             *
             * 现在只有**新任务**能活：旧任务一律取消。两台设备同时看时，
             * 被取消的那台下次取分片会重新触发转码（幂等），代价小于双进程
             * 抢 VDEC/内存导致的整机卡死。
             */
            o.state = "cancelled";
            o.phase = "cancelled";
            o.code = "cancelled_by_other";
            o.error = "";
            try {
                if (o.proc != null) {
                    o.proc.destroyForcibly();
                    // 等它真的退出：RGA/MPP 的设备句柄要等进程回收才释放，
                    // 立刻起新进程会撞上"设备忙"，表现为新 ffmpeg 在 rga_api
                    // 版本号打印后直接崩（2026-11-17 实测）。
                    o.proc.waitFor(3, java.util.concurrent.TimeUnit.SECONDS);
                }
            } catch (Exception ignored) {
            }
            /*
             * ★ 不删已产出的分片（2026-11-20）：删了会让另一台正在看的人立刻 404。
             * 保留后前端可以把"已转部分"当降级可播，盘上的半成品由 prune 回收。
             */
            System.err.println("[transcode] cancelled " + o.id + " (serialize, keep=" + keepId + ")");
        }
        return true;
    }

    private static Path dirOf(String id) {
        return DataPaths.dir(ROOT + "/" + id);
    }

    /**
     * 本进程实际监听的端口（ApiServer.listen 写入）。
     *
     * <p>片库 SMB 转码（F2）要把 {@code http://127.0.0.1:<port>/api/library/stream}
     * 交给 ffmpeg 自己拉，所以运行时必须知道真实端口（PC 顺延、TV 网关 9978、
     * fpk 30011）。放在这里而不是 ApiServer：ApiServer 在默认包，routes 包
     * 引用不到（编译期实测报「程序包 shared 不存在」）。
     */
    public static volatile int apiPort = 0;

    // ------------------------------------------------------------ 并发与生命周期（2026-11-17）

    /**
     * 每个转码 id 一把锁。
     *
     * <p><b>为什么必须有</b>：`ensure`/`ensureLocal` 的「检查状态 → 起 ffmpeg」
     * 不是原子的。前端 start 请求与 2 秒一次的状态轮询（旧代码里轮询也会走到
     * stage 拷贝）并发进来时，两个线程会同时起 ffmpeg / 同时写同一个源文件。
     * 单集锁让同 id 的启动串行化，第二个请求拿到的就是 running。
     */
    private static final java.util.concurrent.ConcurrentHashMap<String, Object> LOCKS =
            new java.util.concurrent.ConcurrentHashMap<>();

    private static Object lockFor(String id) {
        return LOCKS.computeIfAbsent(id, k -> new Object());
    }

    /** 播放器每次拉清单/分片时刷新，供生命周期清理判断"正在看"。 */
    public static void touch(String id) {
        if (id == null || id.isEmpty()) return;
        Job j = JOBS.get(id);
        if (j != null) j.lastAccess = System.currentTimeMillis();
        /*
         * 同时落一个独立的访问标记文件（.access 的 mtime）。
         *
         * ★ 不能用目录 mtime：目录 mtime 在"转码写分片"时也会更新，那样
         *   刚转完的任务全被当成"正在看"，prune 永远不删（2026-11-17 实测
         *   6 个任务一个都没清）。.access 只在**播放器来取**时才写，语义干净；
         *   后端重启丢了内存 Job 后也能靠它判断。
         */
        try {
            Path d = dirOf(id);
            if (Files.isDirectory(d)) {
                Files.write(d.resolve(ACCESS_FILE), new byte[0],
                        java.nio.file.StandardOpenOption.CREATE,
                        java.nio.file.StandardOpenOption.TRUNCATE_EXISTING);
            }
        } catch (Exception ignored) {
        }
    }

    /** 播放标记文件名（内容为空，只看 mtime）。 */
    private static final String ACCESS_FILE = ".access";

    private static final Object PRUNE_LOCK = new Object();

    /** 保留的转码任务数（用户口径 2026-11-17：保留最近 3 个）。 */
    private static final int KEEP_JOBS = 3;
    /** 最近这段时间内被播过的任务不删（"正在播的绝不删"的保守窗口）。 */
    private static final long PLAYING_GRACE_MS = 10 * 60_000L;

    /** 目录的最后活动时间 = max(目录 mtime, .access mtime, 内存 Job 的 lastAccess)。 */
    private static long lastActive(Path d) {
        long t = 0;
        try {
            t = Files.getLastModifiedTime(d).toMillis();
        } catch (Exception ignored) {
        }
        try {
            Path acc = d.resolve(ACCESS_FILE);
            if (Files.isRegularFile(acc)) t = Math.max(t, Files.getLastModifiedTime(acc).toMillis());
        } catch (Exception ignored) {
        }
        Job j = JOBS.get(d.getFileName().toString());
        if (j != null && j.lastAccess > t) t = j.lastAccess;
        return t;
    }

    /** 这个任务是否"最近被播放器取过"（.access 在宽限窗口内）。 */
    private static boolean recentlyPlayed(Path d, long now) {
        try {
            Path acc = d.resolve(ACCESS_FILE);
            if (!Files.isRegularFile(acc)) return false;
            return now - Files.getLastModifiedTime(acc).toMillis() < PLAYING_GRACE_MS;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 起新任务前清历史产物：只保留最近 {@link #KEEP_JOBS} 个任务。
     *
     * <p><b>为什么是"起新任务前"而不是定时</b>：转码目录只增不减（2026-11-17
     * 实测 OECT 上已积累 6.1GB），但绝大多数时间没人在转码——放在启动路径上，
     * 既不引入后台线程，也能保证"每播一集新的，就回收一集旧的"。
     *
     * <p><b>保护</b>：running（ffmpeg 正在写）与最近 10 分钟被播过的任务
     * 绝不删——删了会让正在看的画面 404。
     */
    private static void pruneProducts() {
        synchronized (PRUNE_LOCK) {
            try {
                Path root = DataPaths.of(ROOT);
                if (!Files.isDirectory(root)) return;
                final long now = System.currentTimeMillis();
                List<Path> dirs = new ArrayList<>();
                try (java.util.stream.Stream<Path> s = Files.list(root)) {
                    s.filter(Files::isDirectory).forEach(dirs::add);
                }
                dirs.sort((a, b) -> Long.compare(lastActive(b), lastActive(a)));
                int kept = 0;
                for (Path d : dirs) {
                    String id = d.getFileName().toString();
                    Job j = JOBS.get(id);
                    boolean running = j != null && "running".equals(j.state)
                            && j.proc != null && j.proc.isAlive();
                    /*
                     * 只有 .access 在宽限窗口内才算"正在看"。不能用目录 mtime：
                     * 转码写分片也会更新它，刚转完的任务会全被保住（实测 prune
                     * 一个都不删）。
                     */
                    boolean playing = recentlyPlayed(d, now);
                    if (running) continue;                       // 正在转：绝不碰
                    if (playing) {                               // 正在看：只清源文件
                        cleanStagedSource(d);
                        continue;
                    }
                    if (kept < KEEP_JOBS) {
                        kept++;
                        cleanStagedSource(d);
                        continue;
                    }
                    deleteTree(d);
                    JOBS.remove(id);
                    LOCKS.remove(id);
                    // 日志用英文：fpk 的 Java stderr 不是 UTF-8，中文会变成 ???
                    System.err.println("[transcode] prune " + id + " (keep last " + KEEP_JOBS + ")");
                }
            } catch (Exception e) {
                System.err.println("[transcode] prune failed: " + e);
            }
        }
    }

    /**
     * 删掉 stage 拷贝留下的源文件（F2 后不再需要整份拷贝）。
     *
     * <p>不删 running 的——ffmpeg 可能正读它（回退 stage 的路径）。
     */
    private static void cleanStagedSource(Path dir) {
        try (java.util.stream.Stream<Path> s = Files.list(dir)) {
            s.filter(p -> {
                String n = p.getFileName().toString();
                return n.startsWith("source.") || n.endsWith(".part");
            }).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
    }

    private static void deleteTree(Path dir) {
        try (java.util.stream.Stream<Path> s = Files.walk(dir)) {
            s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
    }

    public static Path playlistOf(String id) {
        return dirOf(id).resolve("index.m3u8");
    }

    /**
     * 转码目录下的某个文件。只允许单段文件名，防穿越。
     *
     * <p>与 {@code VideoCache.fileOf} 同一套判据（含盘符检查）：
     * Windows 上 `resolve("P:policy.json")` 是盘符相对路径，会越出目录 ——
     * 实测能读到后端 policy.json（里面含 authToken）。
     */
    public static Path fileOf(String id, String name) {
        if (name == null || name.isEmpty()) return null;
        if (name.contains("/") || name.contains("\\") || name.contains("..")) return null;
        if (name.indexOf(':') >= 0) return null;
        Path dir = dirOf(id);
        Path out = dir.resolve(name).normalize();
        if (!out.startsWith(dir.normalize())) return null;
        return out;
    }

    /**
     * 找 ffmpeg。
     *
     * <p>顺序：policy 里显式配的 → 环境变量 MEOW_FFMPEG → PATH。
     * 找不到就明确报错，不要伪装成"转码中"——用户会一直等一个永远不会开始的任务。
     */
    public static String ffmpegPath() {
        String configured = System.getProperty("meow.ffmpeg", "");
        if (!configured.isEmpty() && isExec(configured)) return configured;
        String env = System.getenv("MEOW_FFMPEG");
        if (env != null && !env.isEmpty() && isExec(env)) return env;
        // policy.json 的 ffmpegPath：PC 的 ffmpeg 插件装好后自动写这一项，
        // 用户零配置（与 drpy 插件写 jsRuntime 是同一套接线方式）。
        //
        // ★ 配了就用它，**不再回退 PATH**：回退会让"插件装了但路径写错"表现为
        //   "莫名其妙能用了"（其实用的是系统里另一个 ffmpeg），
        //   到用户机器上没有 PATH 里的那份时才暴露，排障成本极高。
        //   路径无效时返回空串，让上层明确报"ffmpeg 不可用"。
        String fromPolicy = readPolicyFfmpeg();
        if (!fromPolicy.isEmpty()) {
            return isExec(fromPolicy) ? fromPolicy : "";
        }
        String exe = isWindows() ? "ffmpeg.exe" : "ffmpeg";
        String path = System.getenv("PATH");
        if (path != null) {
            for (String dir : path.split(File.pathSeparator)) {
                File f = new File(dir, exe);
                if (isExec(f.getAbsolutePath())) return f.getAbsolutePath();
            }
        }
        /*
         * PATH 兜底（2026-11-17 OECT 实测）：fnOS 应用中心拉起的 meowd，
         * 进程 PATH 不一定包含 /usr/bin —— 宿主机明明有 /usr/bin/ffmpeg
         * （还是 mediasrv 的符号链接），却探测不到，整条转码链被判死
         * （available=false → 前端全部「起播超时」）。这几个位置覆盖
         * Linux/macOS 常见安装点；命中与否都在日志里留一行，便于排障。
         */
        if (!isWindows()) {
            for (String p : new String[]{"/usr/bin/" + exe, "/usr/local/bin/" + exe,
                    "/opt/homebrew/bin/" + exe}) {
                if (isExec(p)) {
                    System.err.println("[transcode] ffmpeg found via fallback: " + p);
                    return p;
                }
            }
        }
        System.err.println("[transcode] ffmpeg NOT found (policy/system-prop/env/PATH/common-paths all missed)");
        return "";
    }

    /**
     * 是否可执行。
     *
     * <p>不能用 {@code File.canExecute()}：Windows 上它对普通 .exe 返回 false
     * （只有 exec 位概念在 POSIX 上才有意义），会把装好的 ffmpeg 判成"没装"。
     */
    private static boolean isExec(String path) {
        File f = new File(path);
        if (!f.isFile()) return false;
        return isWindows() || f.canExecute();
    }

    /** 读 policy.json 的 ffmpegPath（插件注入点）。 */
    private static String readPolicyFfmpeg() {
        try {
            String s = DataPaths.read("policy.json");
            if (s == null || s.trim().isEmpty()) return "";
            return new org.json.JSONObject(s).optString("ffmpegPath", "");
        } catch (Exception e) {
            return "";
        }
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }

    /**
     * 是不是 iOS（OpenJDK 的 iOS 移植把 os.name 设为 "iOS"）。
     *
     * <p>★ 必须显式判：JDK 9 的 {@code ProcessImpl$Platform.get()} 不认识 "iOS"，
     * 第一次 {@code ProcessBuilder.start()} 就抛 {@code Error: iOS is not a supported
     * OS platform} —— 这会把整个 {@code ApiServer.main} 打死（真机实测）。
     * iOS 本来就没有 fork/exec，所有起进程的路径都应当直接降级。
     */
    public static boolean isIos() {
        return System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("ios");
    }

    /**
     * 确保某个源已经开始转码。幂等：已在转或已转好就直接返回。
     *
     * @param sourceUrl 可被 ffmpeg 直接读到的地址（http/https）
     */
    public static Job ensure(String sourceUrl, boolean forceVideo) {
        return ensure(sourceUrl, forceVideo, "");
    }

    /**
     * 带源站请求头的版本：点播线路常要求 UA/Referer（见 {@link Job#header}）。
     * 幂等键仍只取 URL —— 同一集换头重来应当复用同一份产物。
     */
    public static Job ensure(String sourceUrl, boolean forceVideo, String headerJson) {
        return ensure(sourceUrl, forceVideo, headerJson, false);
    }

    /**
     * preferCopy=true：客户端明确要求"视频原样 copy、只转音频"（remux）。
     *
     * <p>只在片库这类已知场景由前端请求（在线源 copy 成 HLS 的时间戳风险大），
     * 且仍要求编码在 h264/hevc/av1 里 —— 其他编码不赌。
     */
    public static Job ensure(String sourceUrl, boolean forceVideo, String headerJson,
                             boolean preferCopy) {
        return ensure(sourceUrl, forceVideo, headerJson, preferCopy, false);
    }

    /**
     * repair=true：**原分辨率**重编码修复（显卡编码，不降分辨率）。
     *
     * <p>用于「画面丢帧但源本身能解」的场景：某些 4K 源整段 GOP 全是 B 帧
     * （has_b_frames=5），Chromium 解码后持续丢 28% 帧；copy 保留码流所以
     * 修不好，只能重编。给 repair 时后端不会退回 copy，也不会缩到 1080p。
     */
    public static Job ensure(String sourceUrl, boolean forceVideo, String headerJson,
                             boolean preferCopy, boolean repair) {
        return ensure(sourceUrl, forceVideo, headerJson, preferCopy, repair, 0);
    }

    /**
     * startSec &gt; 0：repair 从源的第 startSec 秒开始转（`-ss` 输入快进）。
     *
     * <p>为什么必须支持：用户往往已经看到第 10 分钟才出现丢帧；从头转 4K 要等
     * 转码追上播放点（几分钟）。从当前位置起转，2 秒分片几秒内就能续播。
     * 修复流的清单时间轴从 0 开始，前端用 {@link Job#startOffset} 换算进度。
     */
    public static Job ensure(String sourceUrl, boolean forceVideo, String headerJson,
                             boolean preferCopy, boolean repair, int startSec) {
        return ensure(sourceUrl, forceVideo, headerJson, preferCopy, repair, startSec, true);
    }

    /** allowHevc=false：repair 只出 H.264（客户端解不了 HEVC 时用）。 */
    public static Job ensure(String sourceUrl, boolean forceVideo, String headerJson,
                             boolean preferCopy, boolean repair, int startSec, boolean allowHevc) {
        String id = idFor(sourceUrl, preferCopy, repair);
        /*
         * 单集锁（S1，2026-11-17）：前端 start 请求与 2 秒一次的轮询可能
         * 同时进来，"检查状态 → 起 ffmpeg"必须串行，否则会起两个进程写同一目录。
         */
        synchronized (lockFor(id)) {
            return ensure0(sourceUrl, forceVideo, id,
                    headerJson == null ? "" : headerJson, preferCopy, repair, startSec, allowHevc);
        }
    }

    private static Job ensure0(String sourceUrl, boolean forceVideo, String id, String headerJson,
                               boolean preferCopy, boolean repair, int startSec, boolean allowHevc) {
        Job found = JOBS.get(id);
        if (found != null) {
            if ("running".equals(found.state)) {
                /*
                 * 真的在转就直接复用；进程已经没了却没写 .done，说明上一次异常中断
                 * （崩溃/被杀），必须重来，否则任务永远停在 running、前端一直等。
                 */
                boolean alive = found.proc != null && found.proc.isAlive();
                if (alive) return found;
                found.state = "idle";
                found.error = "";
                System.err.println("[transcode] job " + id + " running but process gone -> restart");
            } else if ("ready".equals(found.state)) {
                /*
                 * ready 必须和磁盘核对（2026-11-17 实测踩过）：缓存被清理、或用户
                 * 手工删了转码目录后，内存里的 Job 仍是 ready，直接返回会让前端
                 * 拉到 404 的清单、永远"起播超时"。产物不完整就当没转过，重转。
                 */
                if (playable(id)) return found;
                found.state = "idle";
                found.error = "";
                System.err.println("[transcode] job " + id + " ready but incomplete -> retranscode");
            }
        }
        final Job j;
        if (found == null) {
            j = new Job();
            j.id = id;
            j.source = sourceUrl;
            JOBS.put(id, j);
        } else {
            j = found;
        }
        // 每次启动前都按最新请求覆盖：同一 URL 的头可能被源站轮换，旧头拉不到就白转
        j.header = headerJson;
        // 已经转完的直接复用（**必须有完成标记**，半成品不算）
        if (playable(id) && !forceVideo) {
            j.state = "ready";
            j.lastAccess = System.currentTimeMillis();
            /*
             * ★ 复用磁盘产物时也要补齐元数据（2026-11-24）：原来直接返回一个
             * 空 Job，copy/repair 的前端门槛（copyVideo / outHeight / startOffset）
             * 全拿不到 —— 重启应用后播放已转好的 remux 会被判成"无法原画转封装"。
             */
            j.repair = repair;
            j.allowHevc = allowHevc;
            if (repair) j.startOffset = readStartOffset(id);
            String ff0 = ffmpegPath();
            if ((preferCopy || repair) && j.probeSnap == null && !ff0.isEmpty()) {
                Probe p0 = probe(ff0, sourceUrl, headerJson);
                if (preferCopy) applyCopyPreference(p0);
                if (repair && p0 != null) p0.copyVideo = false;
                j.probeSnap = p0;
            }
            return j;
        }
        if ("running".equals(j.state)) return j;

        // 起新任务前清掉上一轮的错误文案：否则重试时 state=running 却还带着
        // 旧 error，排障会误读（2026-11-17 OECT 重放实测踩过：running + 旧
        // 「找不到 ffmpeg」同时出现）。
        j.error = "";
        // S4：起新任务前回收历史产物（保留最近 3 个；正在转/正在看的不动）
        pruneProducts();
        /*
         * 串行决策挪到 probe 之后（见下方 stopOtherJobs(hwCapable)）：
         * 此刻还不知道新任务是硬件还是软件 —— 提前停会把"正在被观看的
         * 便宜任务"误杀（2026-11-23 实报「转码失败」的根因之一）。
         */

        String ff = ffmpegPath();
        if (ff.isEmpty()) {
            j.state = "failed";
            j.phase = "failed";
            j.code = "no_ffmpeg";
            j.error = "找不到 ffmpeg。装一个（或在 policy.json 里配 ffmpegPath）才能播这个格式。";
            // 不打日志的话排障只剩前端的「起播超时」，真实原因永远看不到
            System.err.println("[transcode] job " + id + " ffmpeg missing -> failed");
            return j;
        }

        /*
         * ★ 在线源与片库共用同一套 probe + startFfmpeg（2026-11-20 对齐）。
         *
         * 旧实现 here 手写一条 libx264 命令，导致点播：
         *   - 永远软编（有 rkmpp 也不用）→ OECT 上 4K 只有 0.9fps；
         *   - H.264 ≤1080 也重编码，而片库同样片源走 copy 只要 1–2 秒；
         *   - 没有 hw 失败回退、没有 4K 预判、phase/看门狗语义也不一致。
         * 现在共用 hlsCommand()，点播自动获得 copy/hw/回退/预判。
         */
        j.phase = "probe";
        /*
         * remux 时先把母清单解析成"最高档变体"：ffmpeg 对 master 只取第一个
         * 变体（实测 1080p），直接 copy 会把 4K 降成 1080p。
         */
        String playSrc = preferCopy ? bestVariant(sourceUrl, headerJson) : sourceUrl;
        Probe probe = probe(ff, playSrc, headerJson);
        if (preferCopy) applyCopyPreference(probe);
        if (repair && probe != null) {
            // repair 必须重编码：不能被 probe 默认的"能 copy 就 copy"带走
            probe.copyVideo = false;
        }
        if (repair && probe == null) {
            /*
             * 探测失败 ≠ 没有编码器（2026-11-24 实报把两者混成一个 code，用户看到
             * 「没有硬件编码器」但 caps 明明有 NVENC）。上游忙/限流/超时都会到这里，
             * 前端看到 probe_failed 会在 15 秒后自动重试一次。
             */
            j.state = "failed";
            j.phase = "failed";
            j.code = "probe_failed";
            j.error = "片源探测失败（上游超时或限流），稍后会自动重试修复。";
            System.err.println("[transcode] job " + id + " repair probe failed");
            return j;
        }
        if (repair && repairEncoder(ff, probe == null ? "" : probe.vcodec, allowHevc) == null) {
            /*
             * 没有硬件编码器时**不做软件 4K 重编**（x86 上也许能跑，但 4K 软编
             * 追不上播放；ARM NAS 上必死）。直接失败，让前端恢复原样播放并提示，
             * 而不是静默降分辨率——那是用户明确拒绝的降级。
             */
            j.state = "failed";
            j.phase = "failed";
            j.code = "no_repair_encoder";
            j.error = "这台后端没有可用的硬件编码器（NVENC/QSV/AMF），"
                    + "无法在不降分辨率的前提下修复该片源。";
            System.err.println("[transcode] job " + id + " repair rejected: no hw encoder");
            return j;
        }
        /*
         * ★ 这里必须传**真实**的硬解能力（2026-11-20 复核修正）。
         * 原来传死 false，等于把"RK3566 + rkmpp"也当成无硬解：4K HEVC 明明
         * 能硬解降到 1080p（OEC 实测首片 13.6 秒），却被 slow_4k 直接拒掉。
         * hwTranscode 内部有缓存（各 50ms 探测一次），不会给等待链加开销。
         */
        boolean hwCapable = probe != null && hwTranscode(ff, probe);
        if (slow4kHopeless(probe, hwCapable)) {
            j.state = "failed";
            j.code = "slow_4k";
            j.phase = "failed";
            j.error = SLOW_4K_MSG;
            System.err.println("[transcode] job " + id + " reject slow 4k (soft)");
            return j;
        }
        if (probe != null) {
            System.err.println("[transcode] probe " + id + ": " + probe.detail
                    + " -> copyVideo=" + probe.copyVideo + " copyAudio=" + probe.copyAudio);
        } else {
            System.err.println("[transcode] probe " + id + " failed (ffprobe timeout?) -> software path");
        }
        j.probeSnap = probe;
        j.repair = repair;
        j.allowHevc = allowHevc;
        j.startOffset = repair ? Math.max(0, startSec) : 0;
        /*
         * 中途修复：先生成"0..startOffset"的黑场填充。失败就退回从头修
         * （startOffset=0），行为与之前一致，不会因为填充失败而整单失败。
         */
        if (j.repair && j.startOffset > 1 && !ensureFiller(j, ff, j.startOffset)) {
            j.startOffset = 0;
        }
        if (repair) saveStartOffset(id, j.startOffset);
        if (probe != null) saveDuration(id, probe.duration);
        j.ffPath = ff;
        try {
            startFfmpeg(j, ff, playSrc, false);
        } catch (Exception e) {
            j.state = "failed";
            j.phase = "failed";
            j.error = "启动 ffmpeg 失败：" + e.getMessage();
            System.err.println("[transcode] start failed " + id + ": " + e);
        }
        return j;
    }

    /**
     * 本地文件的转码：{@code source} 是磁盘绝对路径，直接交给 ffmpeg。
     *
     * <p><b>为什么要和 {@link #ensure} 分开</b>：那个方法把参数当 URL 用
     * （幂等键取自 URL、错误文案也按 URL 写），而这里要的是"任意可读路径"。
     * 幂等键单独给一个 {@code key}，同一个片库文件重复点转码会复用同一份产物。
     */
    public static Job ensureLocal(String source, String key) {
        return ensureLocal(source, key, false);
    }

    /** preferCopy=true：视频原样 copy、只转音频（片库 remux）。 */
    public static Job ensureLocal(String source, String key, boolean preferCopy) {
        return ensureLocal(source, key, preferCopy, false);
    }

    /** repair=true：原分辨率重编码修复（片库 4K 高丢帧自愈）。 */
    public static Job ensureLocal(String source, String key, boolean preferCopy, boolean repair) {
        return ensureLocal(source, key, preferCopy, repair, 0);
    }

    /** startSec &gt; 0：修复从第 startSec 秒开始（片库同样支持中途续修）。 */
    public static Job ensureLocal(String source, String key, boolean preferCopy, boolean repair,
                                  int startSec) {
        return ensureLocal(source, key, preferCopy, repair, startSec, true);
    }

    /** allowHevc=false：repair 只出 H.264（客户端解不了 HEVC 时用）。 */
    public static Job ensureLocal(String source, String key, boolean preferCopy, boolean repair,
                                  int startSec, boolean allowHevc) {
        String id = idFor(key, preferCopy, repair);
        // 单集锁：与 ensure 同理（幂等键是 lib|path，同一集并发点击只起一个任务）
        synchronized (lockFor(id)) {
            return ensureLocal0(source, key, id, preferCopy, repair, startSec, allowHevc);
        }
    }

    private static Job ensureLocal0(String source, String key, String id, boolean preferCopy,
                                    boolean repair, int startSec, boolean allowHevc) {
        Job found = JOBS.get(id);
        if (found != null) {
            if ("running".equals(found.state)) {
                /*
                 * 真的在转就直接复用；进程已经没了却没写 .done，说明上一次异常中断
                 * （崩溃/被杀），必须重来，否则任务永远停在 running、前端一直等。
                 */
                boolean alive = found.proc != null && found.proc.isAlive();
                if (alive) return found;
                found.state = "idle";
                found.error = "";
                System.err.println("[transcode] job " + id + " running but process gone -> restart");
            } else if ("ready".equals(found.state)) {
                /*
                 * ready 必须和磁盘核对（2026-11-17 实测踩过）：缓存被清理、或用户
                 * 手工删了转码目录后，内存里的 Job 仍是 ready，直接返回会让前端
                 * 拉到 404 的清单、永远"起播超时"。产物不完整就当没转过，重转。
                 */
                if (playable(id)) return found;
                found.state = "idle";
                found.error = "";
                System.err.println("[transcode] job " + id + " ready but incomplete -> retranscode");
            }
        }
        final Job j;
        if (found == null) {
            j = new Job();
            j.id = id;
            j.source = source;
            JOBS.put(id, j);
        } else {
            j = found;
        }
        if (playable(id)) {
            j.state = "ready";
            j.lastAccess = System.currentTimeMillis();
            // 同 ensure0：复用磁盘产物也要有 probe/模式元数据，否则 copy/repair 门槛失效
            j.repair = repair;
            j.allowHevc = allowHevc;
            if (repair) j.startOffset = readStartOffset(id);
            String ff0 = ffmpegPath();
            if ((preferCopy || repair) && j.probeSnap == null && !ff0.isEmpty()) {
                Probe p0 = probe(ff0, source);
                if (preferCopy) applyCopyPreference(p0);
                if (repair && p0 != null) p0.copyVideo = false;
                j.probeSnap = p0;
            }
            return j;
        }
        if ("running".equals(j.state)) return j;

        // 起新任务前清掉上一轮的错误文案：否则重试时 state=running 却还带着
        // 旧 error，排障会误读（2026-11-17 OECT 重放实测踩过：running + 旧
        // 「找不到 ffmpeg」同时出现）。
        j.error = "";

        String ff = ffmpegPath();
        if (ff.isEmpty()) {
            j.state = "failed";
            j.phase = "failed";
            j.code = "no_ffmpeg";
            j.error = "找不到 ffmpeg。装一个（或在 policy.json 里配 ffmpegPath）才能播这个格式。";
            // 不打日志的话排障只剩前端的「起播超时」，真实原因永远看不到
            System.err.println("[transcode] job " + id + " ffmpeg missing -> failed");
            return j;
        }
        /*
         * F1 智能 remux（2026-11-17）：源已经是 H.264 ≤1080p / AAC ≤2ch 时
         * 不重编码，只换封装（`-c copy`）。OECT 实测：416MB 1080p mp4 重编码
         * 首片要 20 秒，copy 只要 1~2 秒。探测失败一律回退全转码。
         */
        j.phase = "probe";
        Probe probe = probe(ff, source);
        if (preferCopy) applyCopyPreference(probe);
        if (repair && probe != null) probe.copyVideo = false;
        if (repair && probe == null) {
            j.state = "failed";
            j.phase = "failed";
            j.code = "probe_failed";
            j.error = "片源探测失败（上游超时或限流），稍后会自动重试修复。";
            System.err.println("[transcode] job " + id + " repair probe failed");
            return j;
        }
        if (repair && repairEncoder(ff, probe == null ? "" : probe.vcodec, allowHevc) == null) {
            j.state = "failed";
            j.phase = "failed";
            j.code = "no_repair_encoder";
            j.error = "这台后端没有可用的硬件编码器（NVENC/QSV/AMF），"
                    + "或客户端解不了可用的输出编码，无法在不降分辨率的前提下修复该片源。";
            System.err.println("[transcode] job " + id + " repair rejected: no hw encoder");
            return j;
        }
        boolean hwCapable = probe != null && hwTranscode(ff, probe);
        if (slow4kHopeless(probe, hwCapable)) {
            j.state = "failed";
            j.code = "slow_4k";
            j.phase = "failed";
            j.error = SLOW_4K_MSG;
            System.err.println("[transcode] job " + id + " reject slow 4k (soft)");
            return j;
        }
        if (probe != null) {
            System.err.println("[transcode] probe " + id + ": " + probe.detail
                    + " -> copyVideo=" + probe.copyVideo + " copyAudio=" + probe.copyAudio);
        } else {
            // 没这条日志的话，hw=false 会被误读成"设备没硬解"，其实是探测超时
            System.err.println("[transcode] probe " + id + " failed (ffprobe timeout?) -> software path");
        }
        // S4：起新任务前回收历史产物（保留最近 3 个；正在转/正在看的不动）
        pruneProducts();
        // 硬解任务才无条件抢通道；软件任务不打断正在被观看的旧任务（见 stopOtherJobs）
        stopOtherJobs(j.id, hwCapable);
        j.probeSnap = probe;
        j.repair = repair;
        j.allowHevc = allowHevc;
        j.startOffset = repair ? Math.max(0, startSec) : 0;
        if (j.repair && j.startOffset > 1 && !ensureFiller(j, ff, j.startOffset)) {
            j.startOffset = 0;
        }
        if (repair) saveStartOffset(id, j.startOffset);
        if (probe != null) saveDuration(id, probe.duration);
        j.ffPath = ff;
        try {
            startFfmpeg(j, ff, source, false);
        } catch (Exception e) {
            j.state = "failed";
            j.error = "启动 ffmpeg 失败：" + e.getMessage();
            System.err.println("[transcode] start failed " + id + ": " + e);
        }
        return j;
    }

    /**
     * 把 SMB 文件先抓到本地临时文件，返回它的绝对路径。
     *
     * <p>ffmpeg 没有 SMB 协议支持（{@code smb://} 直接失败），所以必须先落盘。
     * 落地文件名带转码 id，与产物同目录，取消时会一起清掉。
     *
     * <p>已经抓过就复用——一个 4K MKV 1.3GB，重复抓是分钟级浪费。
     */
    public static String stageSmbSource(String libId, String relPath, org.json.JSONObject lib)
            throws Exception {
        String id = idFor("lib|" + libId + "|" + relPath);
        java.io.File dst = dirOf(id).resolve("source" + extOf(relPath)).toFile();
        if (dst.isFile() && dst.length() > 0) return dst.getAbsolutePath();

        java.nio.file.Files.createDirectories(dirOf(id));
        // 先写 .part 再改名：中途失败不会留下一个"看起来完整"的文件
        java.io.File tmp = new java.io.File(dst.getAbsolutePath() + ".part");
        com.hierynomus.smbj.SMBClient client = new com.hierynomus.smbj.SMBClient();
        com.hierynomus.smbj.connection.Connection conn = null;
        try {
            conn = client.connect(core.Library.smbHostOf(lib));
            com.hierynomus.smbj.session.Session session = core.Library.authenticateSmb(conn, lib);
            com.hierynomus.smbj.share.DiskShare disk = (com.hierynomus.smbj.share.DiskShare)
                    session.connectShare(core.Library.smbShareOf(lib));
            String path = core.Library.smbSubPathOf(lib, relPath);
            com.hierynomus.smbj.share.File f = disk.openFile(path,
                    java.util.EnumSet.of(com.hierynomus.msdtyp.AccessMask.GENERIC_READ),
                    null,
                    java.util.EnumSet.of(com.hierynomus.mssmb2.SMB2ShareAccess.FILE_SHARE_READ),
                    com.hierynomus.mssmb2.SMB2CreateDisposition.FILE_OPEN,
                    null);
            try (java.io.OutputStream os = new java.io.BufferedOutputStream(
                    new java.io.FileOutputStream(tmp), 1 << 20)) {
                byte[] buf = new byte[1 << 20];
                long pos = 0;
                int n;
                while ((n = f.read(buf, pos, 0, buf.length)) > 0) {
                    os.write(buf, 0, n);
                    pos += n;
                }
            } finally {
                try {
                    f.close();
                } catch (Exception ignored) {
                }
            }
        } catch (Exception e) {
            tmp.delete();
            throw e;
        } finally {
            if (conn != null) {
                try {
                    conn.close();
                } catch (Exception ignored) {
                }
            }
            try {
                client.close();
            } catch (Exception ignored) {
            }
        }
        if (!tmp.renameTo(dst)) {
            tmp.delete();
            throw new java.io.IOException("落地失败：无法重命名临时文件");
        }
        return dst.getAbsolutePath();
    }

    private static String extOf(String p) {
        int dot = p.lastIndexOf('.');
        if (dot < 0 || dot < p.length() - 8) return ".bin";
        String e = p.substring(dot).toLowerCase();
        return e.matches("\\.[a-z0-9]{1,5}") ? e : ".bin";
    }

    /** HLS 转码命令。ensure 与 ensureLocal 共用，避免两份参数漂移。 */
    /**
     * ffprobe 探测结果（F1 智能 remux，2026-11-17）。
     *
     * <p>只决定"能不能 copy"，不改变输出格式：HLS(TS) + H.264/AAC 的组合
     * 是所有端都能播的最大公约数。
     */
    private static final class Probe {
        boolean copyVideo;
        boolean copyAudio;
        /** 源视频编码（h264/hevc/av1…），用于挑对应的 rkmpp 硬件解码器。 */
        String vcodec = "";
        /**
         * 源像素格式（yuv420p / yuv420p10le…）。copy 与硬解只对 8-bit 4:2:0
         * 成立 —— Hi10P 是 2026-11-23 片库"解码失败"的实报根因。
         */
        String pixFmt = "";
        /** 源音频编码（aac/ac3/eac3/dts…）：播放分配（直连/原生/转码）的判定输入。 */
        String acodec = "";
        /** 源宽高：硬解硬编走 RGA 缩放时才需要（4K 必须降到 1080p，见 hw 分支）。 */
        int width;
        int height;
        /** 源总时长（秒）。0 = 没探到 —— 用来判断 ffmpeg 是不是只转了一小段就退出。 */
        double duration;
        /** 位深（8/10/12）：高位深判定用，缺省按 pixFmt 推。 */
        int bitDepth;
        /** 色彩传输（smpte2084=PQ / arib-std-b67=HLG 判 HDR）；空 = 未知。 */
        String colorTransfer = "";
        /** 音频声道数（2 / 6 / 8…）。 */
        int channels;
        /** 源码率（bps，format 级）。探不到 = 0（HLS 常见），修复码率改按高度给。 */
        long bitRate;
        String detail = "";
    }

    /** pix_fmt → 位深（8/10/12/16）；认不出按 8。 */
    private static int bitDepthOf(String pixFmt) {
        String pf = pixFmt == null ? "" : pixFmt.toLowerCase();
        if (pf.isEmpty()) return 0;
        if (pf.contains("p016") || pf.contains("16le") || pf.contains("16be")) return 16;
        if (pf.contains("p012") || pf.contains("12le") || pf.contains("12be")) return 12;
        if (pf.contains("p010") || pf.contains("10le") || pf.contains("10be")) return 10;
        return 8;
    }

    /** 是否 HDR（PQ / HLG）。探测不到 color_transfer 时按 SDR 处理，绝不乱 tonemap。 */
    private static boolean isHdr(Probe p) {
        if (p == null) return false;
        String ct = p.colorTransfer == null ? "" : p.colorTransfer.toLowerCase();
        return "smpte2084".equals(ct) || "arib-std-b67".equals(ct)
                || "smpte-st-2084".equals(ct);
    }

    /**
     * 客户端明确要求 remux 时放宽 copy：只要编码在 h264/hevc/av1 里就原样复制。
     *
     * <p>位深不设限 —— 是否真的能解由前端按端侧实测能力判断（它只在能解时
     * 才带 copy=1）；后端不再替客户端做"10-bit 一律不行"的猜测。
     */
    private static void applyCopyPreference(Probe p) {
        if (p == null) return;
        String v = p.vcodec == null ? "" : p.vcodec.toLowerCase();
        if ("h264".equals(v) || "hevc".equals(v) || "av1".equals(v)) {
            p.copyVideo = true;
        }
    }

    /**
     * 母清单选最高档变体（2026-11-24）。
     *
     * <p>为什么必须做：ffmpeg 对 master m3u8 只取**第一个**变体（实测 1080p），
     * 而 ffprobe 取最高档（2160p）—— probe 说 2160、copy 出来却是 1080，
     * 用户看到"原画转封装"却降了分辨率。这里先解析母清单，选 RESOLUTION
     * 最高的变体，probe 与 ffmpeg 都用它。
     *
     * <p>只处理 http(s) 且 URL 含 .m3u8 的源；解析失败/不是母清单就原样返回。
     */
    private static String bestVariant(String source, String headerJson) {
        if (source == null) return source;
        String low = source.toLowerCase();
        if (!(low.startsWith("http://") || low.startsWith("https://"))) return source;
        if (!low.contains(".m3u8")) return source;
        try {
            String ua = "";
            String referer = "";
            if (headerJson != null && !headerJson.trim().isEmpty()) {
                try {
                    JSONObject h = new JSONObject(headerJson);
                    ua = h.optString("User-Agent", h.optString("user-agent", ""));
                    referer = h.optString("Referer", h.optString("referer", ""));
                } catch (Throwable ignored) {
                }
            }
            java.net.URL u = new java.net.URL(source);
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
            c.setConnectTimeout(10_000);
            c.setReadTimeout(15_000);
            c.setRequestProperty("User-Agent", ua.isEmpty() ? "Mozilla/5.0" : ua);
            if (!referer.isEmpty()) c.setRequestProperty("Referer", referer);
            StringBuilder sb = new StringBuilder();
            try (java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                int n = 0;
                while ((line = r.readLine()) != null && n++ < 4000) sb.append(line).append('\n');
            } finally {
                c.disconnect();
            }
            String text = sb.toString();
            if (!text.startsWith("#EXTM3U")) {
                // 部分源把清单 base64 后返回（实测咕噜的 m.php 对浏览器 UA 如此）
                try {
                    String dec = new String(java.util.Base64.getMimeDecoder().decode(text),
                            StandardCharsets.UTF_8);
                    if (dec.startsWith("#EXTM3U")) text = dec;
                } catch (Throwable ignored) {
                }
            }
            if (!text.startsWith("#EXTM3U") || !text.contains("#EXT-X-STREAM-INF")) return source;
            String best = "";
            int bestH = -1;
            long bestBw = -1;
            String[] lines = text.split("\n");
            for (int i = 0; i < lines.length; i++) {
                String l = lines[i].trim();
                if (!l.startsWith("#EXT-X-STREAM-INF")) continue;
                int h = 0;
                long bw = 0;
                java.util.regex.Matcher mr = java.util.regex.Pattern
                        .compile("RESOLUTION=(\\d+)x(\\d+)").matcher(l);
                if (mr.find()) h = Integer.parseInt(mr.group(2));
                java.util.regex.Matcher mb = java.util.regex.Pattern
                        .compile("BANDWIDTH=(\\d+)").matcher(l);
                if (mb.find()) bw = Long.parseLong(mb.group(1));
                String uri = "";
                for (int j = i + 1; j < lines.length; j++) {
                    String x = lines[j].trim();
                    if (x.isEmpty() || x.startsWith("#")) continue;
                    uri = x;
                    break;
                }
                if (uri.isEmpty()) continue;
                if (h > bestH || (h == bestH && bw > bestBw)) {
                    bestH = h;
                    bestBw = bw;
                    best = uri;
                }
            }
            if (best.isEmpty()) return source;
            String abs = u.toURI().resolve(best).toString();
            System.err.println("[transcode] variant pick " + bestH + "p");
            return abs;
        } catch (Throwable e) {
            System.err.println("[transcode] variant pick failed: " + e);
            return source;
        }
    }

    // ------------------------------------------------------------ rkmpp 硬解硬编（2026-11-17）

    /**
     * 设备上的 rkmpp 硬件解码器集合 / 是否有 h264_rkmpp 硬件编码器。
     *
     * <p><b>为什么需要</b>：OEC（RK3566，4×A55）软件转 4K HEVC 只有 0.9 fps，
     * 纯硬解能到 16 fps。开销只在第一次探测（各跑一次 ffmpeg -decoders/-encoders，
     * 约 50ms），结果缓存。非 Rockchip 设备探测为空 → 自动走原 libx264。
     */
    private static volatile java.util.Set<String> RKMPP_DEC = null;
    private static volatile Boolean RKMPP_ENC = null;

    private static java.util.Set<String> rkmppDecoders(String ff) {
        java.util.Set<String> cached = RKMPP_DEC;
        if (cached != null) return cached;
        synchronized (Transcode.class) {
            if (RKMPP_DEC != null) return RKMPP_DEC;
            java.util.Set<String> s = new java.util.HashSet<>();
            String out = runCapture(java.util.Arrays.asList(ff, "-hide_banner", "-decoders"), 10);
            if (out != null) {
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("(?m)^\\s*V\\S*\\s+(\\w+_rkmpp)\\b").matcher(out);
                while (m.find()) s.add(m.group(1));
            }
            RKMPP_DEC = s;
            System.err.println("[transcode] rkmpp hw decoders: " + s);
            return s;
        }
    }

    private static boolean rkmppEncoder(String ff) {
        Boolean cached = RKMPP_ENC;
        if (cached != null) return cached;
        synchronized (Transcode.class) {
            if (RKMPP_ENC != null) return RKMPP_ENC;
            String out = runCapture(java.util.Arrays.asList(ff, "-hide_banner", "-encoders"), 10);
            boolean ok = out != null && out.contains("h264_rkmpp");
            RKMPP_ENC = ok;
            System.err.println("[transcode] rkmpp hw h264 encoder: " + ok);
            return ok;
        }
    }

    /**
     * 硬解硬编开关（policy.json 的 {@code transcodeHwDecode}，默认 **true**）。
     *
     * <p><b>2026-11-17 定因</b>：之前「apiserver 里硬解必报 Generic error」不是
     * JVM 环境问题，而是命令里带了 {@code -vf scale} —— MPP 解码出的是硬件帧，
     * scale 只能软件做，ffmpeg 插 hwdownload 失败（实测 -22）。去掉缩放、
     * 按源分辨率硬编后，apiserver 内实测可跑：4K HEVC 首片清单 **24 秒**
     * （纯软解 100 秒），分片仍是精确 2.002s（force_key_frames 对
     * h264_rkmpp 生效）。
     *
     * <p><b>设备权限（2026-11-17 OEC 实测，最容易踩的一脚）</b>：
     * MPP 需要 {@code /dev/mpp_service} 与 {@code /dev/dri/card0|renderD128}。
     * fnOS 上 mpp_service 是 {@code root:root 0600}、dri 是 {@code root:video/render 0660}，
     * 而 fpk 的 java 以 {@code meow} 用户运行 → 打不开设备，报的是
     * "Error while opening decoder: Generic error in an external library"
     * （看起来像硬件坏了，其实是权限）。修法：meow 加进 video/render 组 +
     * mpp_service 设成 {@code root:video 0660}（udev 规则），或临时
     * {@code setfacl -m u:meow:rw}。见 client/apps/fnos。
     *
     * <p>只有探测到对应的 rkmpp 解码器 + h264_rkmpp 编码器才会走硬解
     * （见 hwTranscode），非 Rockchip 设备自动落软解；万一硬解失败，
     * pump 会自动重试一次软解（[transcode] hw failed, retry software）。
     * 想强制软解的设备在 policy.json 里设 {@code "transcodeHwDecode": false}。
     */
    private static boolean hwEnabled() {
        try {
            String s = DataPaths.read("policy.json");
            if (s == null || s.trim().isEmpty()) return true;
            return new org.json.JSONObject(s).optBoolean("transcodeHwDecode", true);
        } catch (Exception e) {
            return true;
        }
    }

    /** 这个源能否走「rkmpp 硬解 + h264_rkmpp 硬编」。 */
    private static boolean hwTranscode(String ff, Probe p) {
        if (p == null || p.vcodec.isEmpty()) return false;
        if (!hwEnabled()) return false;
        // H.264 Hi10P（10-bit）rkmpp 解不了，硬解只会产出空分片 → 软解兜底
        // （HEVC 10-bit 不受影响：RK3566 的 hevc_rkmpp 支持 Main10）
        if ("h264".equals(p.vcodec) && !is8BitPix(p.pixFmt)) return false;
        return rkmppDecoders(ff).contains(p.vcodec + "_rkmpp") && rkmppEncoder(ff);
    }

    /**
     * 8-bit 4:2:0 判定（2026-11-23 片库 10-bit 实报）。
     *
     * <p>高比特深（Hi10P）是浏览器和盒子硬解的共同盲区：Chromium 只带
     * 8-bit H.264 解码器，rkmpp 的 h264 解码器同样只吃 8-bit —— 碰到
     * yuv420p10le 只能软件重编码。pix_fmt 探不到时按"不可 copy"处理
     * （多转一次码比把坏流交给播放器便宜）。
     */
    private static boolean is8BitPix(String pixFmt) {
        if (pixFmt == null || pixFmt.isEmpty()) return false;
        return "yuv420p".equalsIgnoreCase(pixFmt) || "yuvj420p".equalsIgnoreCase(pixFmt);
    }

    /** ffmpeg 同目录的 ffprobe（PC 插件/系统/镜像里都是成对安装的）。 */
    private static String ffprobeOf(String ff) {
        if (ff == null || ff.isEmpty()) return "";
        String name = isWindows() ? "ffprobe.exe" : "ffprobe";
        java.io.File same = new java.io.File(new java.io.File(ff).getParentFile(), name);
        if (isExec(same.getAbsolutePath())) return same.getAbsolutePath();
        // PATH 探测（与 ffmpeg 同样的兜底顺序）
        String path = System.getenv("PATH");
        if (path != null) {
            for (String dir : path.split(File.pathSeparator)) {
                java.io.File f = new java.io.File(dir, name);
                if (isExec(f.getAbsolutePath())) return f.getAbsolutePath();
            }
        }
        if (!isWindows()) {
            for (String p : new String[]{"/usr/bin/" + name, "/usr/local/bin/" + name,
                    "/opt/homebrew/bin/" + name}) {
                if (isExec(p)) return p;
            }
        }
        return "";
    }

    /**
     * 探测源能否直接 copy 进 HLS 容器。
     *
     * <p>判定收紧（宁可多转一次，不要产出播不了的流）：
     * <ul>
     *   <li>视频 copy 仅当 h264 且 ≤1920×1080（HEVC/4K 必须真转，
     *       否则 Safari/Android 兼容性会炸）；</li>
     *   <li>音频 copy 仅当 aac 且 ≤2 声道（5.1/TrueHD/DTS 一律转 AAC）。</li>
     * </ul>
     * 探测失败（没有 ffprobe、超时、解析不了）返回 null = 按原逻辑全转码。
     */
    /** 片库播放分配用的编码探测缓存（key=转码 source；进程内，重启即清）。 */
    private static final Map<String, Probe> PROBE_CACHE = new ConcurrentHashMap<>();

    /**
     * 片库播放分配的编码探测（O5，2026-11-21）：ffprobe 一次、进程内缓存，
     * 供 {@code /api/library?action=probe} 下发 —— 前端拿 vcodec/acodec 做
     * 「直连/原生/转码」预判，不用等运行时无声/黑屏才发现。
     *
     * <p>缓存 key 用转码 source（回环流 URL / 本地路径），同一文件不同表述
     * 会各探一次，量级可接受。探测失败不缓存（网络抖动下次还能成）。
     */
    public static JSONObject probeMedia(String source) throws org.json.JSONException {
        JSONObject out = new JSONObject();
        if (source == null || source.isEmpty()) return out.put("ok", false);
        Probe cached = PROBE_CACHE.get(source);
        if (cached == null) {
            String ff = ffmpegPath();
            if (ff.isEmpty()) return out.put("ok", false);
            cached = probe(ff, source);
            if (cached == null) return out.put("ok", false);
            PROBE_CACHE.put(source, cached);
        }
        return out.put("ok", true)
                .put("vcodec", cached.vcodec == null ? "" : cached.vcodec)
                .put("acodec", cached.acodec == null ? "" : cached.acodec)
                .put("pixfmt", cached.pixFmt == null ? "" : cached.pixFmt)
                .put("bitDepth", cached.bitDepth)
                .put("colorTransfer", cached.colorTransfer == null ? "" : cached.colorTransfer)
                .put("channels", cached.channels)
                .put("width", cached.width)
                .put("height", cached.height)
                .put("duration", (long) Math.round(cached.duration));
    }

    private static Probe probe(String ff, String source) {
        return probe(ff, source, "");
    }

    private static Probe probe(String ff, String source, String header) {
        String fp = ffprobeOf(ff);
        if (fp.isEmpty()) return null;
        try {
            List<String> v = new ArrayList<>();
            v.add(fp);
            v.add("-v"); v.add("error");
            v.add("-select_streams"); v.add("v:0");
            // pix_fmt 必须一起探（2026-11-23 片库 10-bit 实报）：csv=p=0 的输出
            // 顺序是 codec_name,width,height,pix_fmt（不是请求顺序，实测过），
            // 所以只按位置取前 4 段；不要顺手加 profile——它排在 width 前面，
            // 会把解析顶歪（`h264,High 10,1396,866,...`）。
            /*
             * color_transfer 排在 pix_fmt 之后（ffprobe 按 stream 结构体顺序输出，
             * 不是按请求顺序）；缺这个字段时 csv 只有 4 段，按长度判断即可。
             */
            v.add("-show_entries"); v.add("stream=codec_name,width,height,pix_fmt,color_transfer");
            v.add("-of"); v.add("csv=p=0");
            addHttpInputOptions(v, source, header);
            v.add(source);
            // 设备忙（4K 转码在跑）时 ffprobe 读 SMB 会明显变慢；10 秒会误判成
            // "探测失败" → 直接退软解（4K 从 2.0x 掉到 0.025x）。给到 30 秒。
            String vo = runCapture(v, 30);
            if (vo == null) return null;
            String[] vf = vo.trim().split("[,\\s]+");
            if (vf.length < 3) return null;
            String vcodec = vf[0];
            int w = parseIntSafe(vf[1], 0);
            int h = parseIntSafe(vf[2], 0);
            String pixFmt = vf.length > 3 ? vf[3] : "";
            String colorTransfer = vf.length > 4 ? vf[4] : "";

            List<String> a = new ArrayList<>();
            a.add(fp);
            a.add("-v"); a.add("error");
            a.add("-select_streams"); a.add("a:0");
            a.add("-show_entries"); a.add("stream=codec_name,channels");
            a.add("-of"); a.add("csv=p=0");
            addHttpInputOptions(a, source, header);
            a.add(source);
            String ao = runCapture(a, 30);
            // 总时长：pump 用它判断"exit 0 但只转了一小段"（输入被截断时会出现）
            List<String> d = new ArrayList<>();
            d.add(fp);
            d.add("-v"); d.add("error");
            d.add("-show_entries"); d.add("format=duration,bit_rate");
            d.add("-of"); d.add("csv=p=0");
            addHttpInputOptions(d, source, header);
            d.add(source);
            // 这条只影响进度条总长（UI）与修复码率，不值得拖慢起播：12 秒拿不到就用 0
            String dOut = runCapture(d, 12);
            double dur = 0;
            long srcBitRate = 0;
            if (dOut != null) {
                /*
                 * ffprobe 的 format 字段按结构体顺序输出（bit_rate 在 duration 前），
                 * 但不同版本可能不同；用数值大小区分（码率 ≥ 100kbps，时长远小于它）。
                 */
                for (String tok : dOut.trim().split("[,\\s]+")) {
                    try {
                        double val = Double.parseDouble(tok);
                        if (val >= 100_000) srcBitRate = (long) val;
                        else if (dur == 0) dur = val;
                    } catch (Exception ignored) {
                    }
                }
            }
            String acodec = "";
            int ch = 0;
            if (ao != null) {
                String[] af = ao.trim().split("[,\\s]+");
                if (af.length >= 1) acodec = af[0];
                if (af.length >= 2) ch = parseIntSafe(af[1], 0);
            }

            Probe p = new Probe();
            p.vcodec = vcodec;
            p.pixFmt = pixFmt;
            p.acodec = acodec;
            p.bitRate = srcBitRate;
            /*
             * copy 只对 8-bit 4:2:0 成立（2026-11-23 片库 10-bit 实报）：
             * Hi10P（yuv420p10le）浏览器解不了、rkmpp 也解不了，原样 copy
             * 进 HLS 等于把"解码失败"原样复制过去（实测：copyVideo=true 的
             * 转码产物照样黑屏报错）。pix_fmt 探不到时也不赌 —— 宁可重编码。
             */
            p.copyVideo = "h264".equals(vcodec) && w > 0 && h > 0 && w <= 1920 && h <= 1080
                    && is8BitPix(pixFmt);
            p.width = w;
            p.height = h;
            p.duration = dur;
            p.copyAudio = "aac".equals(acodec) && ch > 0 && ch <= 2;
            p.bitDepth = bitDepthOf(pixFmt);
            p.colorTransfer = colorTransfer;
            p.channels = ch;
            p.detail = vcodec + " " + w + "x" + h + (pixFmt.isEmpty() ? "" : " " + pixFmt)
                    + " / " + acodec + " " + ch + "ch"
                    + (colorTransfer.isEmpty() ? "" : " / " + colorTransfer);
            return p;
        } catch (Exception e) {
            return null;
        }
    }

    /** 跑一条只读命令拿 stdout（带真超时：读线程独立，主线程只等时钟）。 */
    private static String runCapture(List<String> cmd, int timeoutSec) {
        if (isIos()) return "";   // 没有 exec；探针/探测一律当作不可用
        Process p = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(cmd);
            p = pb.start();
            final Process proc = p;
            final java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            /*
             * ★ 必须用独立线程读 stdout。原实现是"先循环读到 EOF，再 waitFor
             * 超时"—— 源挂住时 read 永远不返回，超时形同虚设，整个请求会被
             * 拖死（2026-11-17 复查改掉）。
             */
            Thread reader = new Thread(() -> {
                try (java.io.InputStream in = proc.getInputStream()) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                } catch (Exception ignored) {
                }
            }, "probe-read");
            reader.setDaemon(true);
            reader.start();
            if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                return null;
            }
            reader.join(1500);
            if (p.exitValue() != 0) return null;
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            if (p != null) {
                try {
                    p.destroyForcibly();
                } catch (Exception ignored) {
                }
            }
            return null;
        }
    }

    private static int parseIntSafe(String s, int def) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Exception e) {
            return def;
        }
    }

    /**
     * 起一个转码进程（硬解还是软解由 probe + 设备能力决定），pump 线程随后接管。
     *
     * <p>{@code forceSw=true} 用于「硬解失败后的软解重试」。
     */
    private static void startFfmpeg(Job j, String ff, String source, boolean forceSw) throws Exception {
        if (isIos()) throw new Exception("iOS 上不能启动 ffmpeg");
        // 一次只跑一个重转码 / 清半成品：在下面按 hw 判定统一处理（main 的 hw_busy 逻辑）
        armIdleWatcher();
        Probe p = j.probeSnap;
        boolean hw = !forceSw && p != null && !p.copyVideo && hwTranscode(ff, p);
        // 一次只跑一个**硬件**转码（VDEC 通道有限；被放弃的旧任务要停）。
        // 软件任务不抢正在被观看的旧任务（2026-11-23 实报「转码失败」根因）
        // repair 用显卡编码，同样属于"硬件任务"：必须参与串行，避免两个 4K 重编抢 GPU
        if (!stopOtherJobs(j.id, hw || j.repair)) {
            j.state = "failed";
            j.phase = "failed";
            j.code = "hw_busy";
            j.error = "有播放任务正在转码这部 4K 片源（本机或另一台设备），请稍后再试，或换 1080p / H.264 线路。";
            System.err.println("[transcode] job " + j.id + " rejected: hw_busy");
            return;
        }
        // 从零开始转：清掉可能残留的半成品与完成标记，否则清单会指向不存在的分片
        cleanSegments(j.id);
        j.hw = hw;
        j.ffPath = ff;
        List<String> cmd = hlsCommand(ff, j.id, source, p, hw, j.header, j.repair, j.startOffset,
                j.allowHevc);
        java.nio.file.Files.createDirectories(dirOf(j.id));
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        j.proc = pb.start();
        /*
         * 上一次失败留下的 code/error 必须清掉：实测同一条 src 先 slow_4k 失败、
         * 改配置后重试成功，状态是 ready 却还带着 code=slow_4k，前端/日志都会误读。
         */
        j.code = "";
        j.error = "";
        j.state = "running";
        j.phase = "transcode";
        j.startedAt = System.currentTimeMillis();
        j.lastSegmentAt = j.startedAt;
        Thread th = new Thread(() -> pump(j), "transcode-" + j.id);
        th.setDaemon(true);
        th.start();
        System.err.println("[transcode] start " + j.id + " hw=" + hw
                + (j.repair ? " (repair "
                        + repairEncoder(ff, p == null ? "" : p.vcodec, j.allowHevc) + ")" : "")
                + (hw ? " (" + p.vcodec + "_rkmpp)" : ""));
    }

    /**
     * 清掉上一次进程遗留的转码 ffmpeg（app 重启/升级后它们会变成孤儿）。
     *
     * <p><b>为什么必须做</b>（2026-11-17）：ffmpeg 是 java 的子进程，但 java 被
     * kill 时它不一定跟着退出——孤儿会继续写分片、继续占 VDEC/RGA。新进程再起
     * 一个同集任务就会和它抢硬件（"Generic error" 崩 → 退软解 → 卡）。
     * 而且没有 pump 盯着，孤儿永远不会写 `.done`，产物只能当半成品重转。
     *
     * <p>匹配串用 `cache/transcode/seg-`：只命中我们自己的转码 ffmpeg
     * （命令行里有 `-hls_segment_filename .../transcode/<id>/seg-%05d.ts`），
     * 不会误杀用户自己的 ffmpeg。
     */
    public static void killStaleTranscodes() {
        if (isWindows() || isIos()) return;
        try {
            Process p = new ProcessBuilder("pkill", "-f", "cache/transcode/seg-").start();
            p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS);
            System.err.println("[transcode] stale transcode processes cleaned");
        } catch (Exception e) {
            System.err.println("[transcode] cleanup stale failed: " + e);
        }
    }

    /** 修复起点落盘（重启后复用产物时，页面上的"已转出 x 秒"和提示要靠它）。 */
    private static Path startOffsetFile(String id) {
        return dirOf(id).resolve(".start-offset");
    }

    private static int readStartOffset(String id) {
        try {
            Path p = startOffsetFile(id);
            if (!java.nio.file.Files.isRegularFile(p)) return 0;
            return Integer.parseInt(new String(java.nio.file.Files.readAllBytes(p),
                    java.nio.charset.StandardCharsets.UTF_8).trim());
        } catch (Exception e) {
            return 0;
        }
    }

    private static void saveStartOffset(String id, int v) {
        try {
            java.nio.file.Files.write(startOffsetFile(id),
                    String.valueOf(v).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception ignored) {
        }
    }

    /** 修复用的原始清单（ffmpeg 写它；对外提供的 index.m3u8 是"黑场 + 原始"合并版）。 */
    private static Path rawPlaylistOf(String id) {
        return dirOf(id).resolve("raw.m3u8");
    }

    /** 黑场填充清单（与分片同目录，文件名 fill-*.ts —— 路由只允许单段文件名）。 */
    private static Path fillPlaylistOf(String id) {
        return dirOf(id).resolve("fill.m3u8");
    }

    /**
     * 生成"从 0 到 startSec"的黑场填充（2026-11-24）。
     *
     * <p>要解决的是**中途修复**：用户看到第 10 分钟才丢帧，如果修复流从 0 开始、
     * 清单也从 0 计时，播放器 seek 到第 10 分钟时后续分片还没转出来。做法是
     * 用 2 秒生成 640x360 的黑场片段把时间轴垫到 startSec，再 #EXT-X-DISCONTINUITY
     * 接真实内容 —— 清单总时长、进度条、弹幕、字幕的绝对时间全都对得上，
     * 前端不需要任何时间偏移。代价：往回拖到修复点之前是黑屏（可接受）。
     */
    private static boolean ensureFiller(Job j, String ff, int startSec) {
        if (startSec <= 1) return false;
        Path fl = fillPlaylistOf(j.id);
        Path off = dirOf(j.id).resolve(".fill-offset");
        try {
            java.nio.file.Files.createDirectories(dirOf(j.id));
            if (java.nio.file.Files.isRegularFile(fl) && java.nio.file.Files.isRegularFile(off)) {
                String prev = new String(java.nio.file.Files.readAllBytes(off),
                        java.nio.charset.StandardCharsets.UTF_8).trim();
                if (String.valueOf(startSec).equals(prev)) return true;
            }
            try (java.util.stream.Stream<Path> st = java.nio.file.Files.list(dirOf(j.id))) {
                st.filter(p -> p.getFileName().toString().startsWith("fill-")).forEach(p -> {
                    try {
                        java.nio.file.Files.deleteIfExists(p);
                    } catch (Exception ignored) {
                    }
                });
            } catch (Exception ignored) {
            }
            List<String> cmd = new ArrayList<>();
            cmd.add(ff); cmd.add("-hide_banner"); cmd.add("-loglevel"); cmd.add("error"); cmd.add("-y");
            cmd.add("-f"); cmd.add("lavfi"); cmd.add("-i"); cmd.add("color=black:s=640x360:r=25");
            cmd.add("-f"); cmd.add("lavfi"); cmd.add("-i"); cmd.add("anullsrc=r=48000:cl=stereo");
            cmd.add("-t"); cmd.add(String.valueOf(startSec));
            cmd.add("-c:v"); cmd.add("libx264"); cmd.add("-preset"); cmd.add("ultrafast");
            cmd.add("-tune"); cmd.add("stillimage"); cmd.add("-g"); cmd.add("50");
            cmd.add("-pix_fmt"); cmd.add("yuv420p");
            cmd.add("-c:a"); cmd.add("aac"); cmd.add("-b:a"); cmd.add("64k");
            cmd.add("-f"); cmd.add("hls"); cmd.add("-hls_time"); cmd.add("10");
            cmd.add("-hls_list_size"); cmd.add("0");
            cmd.add("-hls_segment_filename"); cmd.add(dirOf(j.id).resolve("fill-%04d.ts").toString());
            cmd.add(fl.toString());
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            Thread drain = new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(
                        p.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
                    while (r.readLine() != null) { /* discard */ }
                } catch (Exception ignored) {
                }
            }, "fill-" + j.id);
            drain.setDaemon(true);
            drain.start();
            boolean ok = p.waitFor(90, TimeUnit.SECONDS) && p.exitValue() == 0;
            if (!ok) {
                System.err.println("[transcode] filler failed for " + j.id + " start=" + startSec);
                return false;
            }
            java.nio.file.Files.write(off, String.valueOf(startSec).getBytes(
                    java.nio.charset.StandardCharsets.UTF_8));
            System.err.println("[transcode] filler ok " + j.id + " " + startSec + "s");
            return true;
        } catch (Exception e) {
            System.err.println("[transcode] filler error " + j.id + ": " + e);
            return false;
        }
    }

    /**
     * 合并清单：黑场填充 + #EXT-X-DISCONTINUITY + 真实分片。
     * ffmpeg 只写 raw.m3u8；对外 index.m3u8 每次分片增长后重写。
     */
    private static void composeMerged(String id) {
        Job j = JOBS.get(id);
        int off = j == null ? 0 : j.startOffset;
        if (off <= 1) return;
        try {
            Path raw = rawPlaylistOf(id);
            Path fill = fillPlaylistOf(id);
            if (!java.nio.file.Files.isRegularFile(raw) || !java.nio.file.Files.isRegularFile(fill)) return;
            List<String> fl = java.nio.file.Files.readAllLines(fill,
                    java.nio.charset.StandardCharsets.UTF_8);
            List<String> rw = java.nio.file.Files.readAllLines(raw,
                    java.nio.charset.StandardCharsets.UTF_8);
            StringBuilder sb = new StringBuilder();
            sb.append("#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:10\n")
              .append("#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n");
            for (String l : fl) {
                String t = l.trim();
                if (t.startsWith("#EXTINF") || t.endsWith(".ts")) sb.append(t).append('\n');
            }
            sb.append("#EXT-X-DISCONTINUITY\n");
            for (String l : rw) {
                String t = l.trim();
                if (t.isEmpty() || t.startsWith("#EXTM3U") || t.startsWith("#EXT-X-VERSION")
                        || t.startsWith("#EXT-X-TARGETDURATION") || t.startsWith("#EXT-X-MEDIA-SEQUENCE")
                        || t.startsWith("#EXT-X-INDEPENDENT-SEGMENTS")
                        || t.startsWith("#EXT-X-PLAYLIST-TYPE")) continue;
                sb.append(t).append('\n');
            }
            Path out = playlistOf(id);
            Path tmp = dirOf(id).resolve("index.tmp.m3u8");
            java.nio.file.Files.write(tmp, sb.toString().getBytes(
                    java.nio.charset.StandardCharsets.UTF_8));
            try {
                java.nio.file.Files.move(tmp, out,
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            } catch (Exception e) {
                java.nio.file.Files.deleteIfExists(tmp);
            }
        } catch (Exception e) {
            System.err.println("[transcode] compose failed " + id + ": " + e);
        }
    }

    /** 删掉半成品分片与清单（硬解失败重试前清干净）。 */
    private static void cleanSegments(String id) {
        try (java.util.stream.Stream<Path> st = Files.list(dirOf(id))) {
            st.filter(p -> {
                String n = p.getFileName().toString();
                return n.startsWith("seg-") || n.startsWith("index.tmp")
                        || "index.m3u8".equals(n) || "raw.m3u8".equals(n) || DONE_FILE.equals(n);
            }).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
    }

    /** 本机可用的修复编码器（只认显卡编码；缓存一次，ffmpeg 不会中途装/卸）。 */
    private static volatile java.util.List<String> REPAIR_ENCS = null;
    private static volatile boolean REPAIR_ENC_PROBED = false;
    private static final String[] H264_ENCS = {"h264_nvenc", "h264_qsv", "h264_amf"};
    private static final String[] HEVC_ENCS = {"hevc_nvenc", "hevc_qsv", "hevc_amf"};

    private static java.util.List<String> repairEncoders(String ff) {
        if (REPAIR_ENC_PROBED) {
            return REPAIR_ENCS == null ? java.util.Collections.emptyList() : REPAIR_ENCS;
        }
        /*
         * ★ 只有拿到 -encoders 输出才写缓存（2026-11-24 实测踩过）：
         * 冷启动/杀软扫描 105MB 的 ffmpeg.exe 时 runCapture 可能超时返回 null，
         * 若此时把"没编码器"缓存下来，这台机器到重启前都修不了 4K（用户实报
         * 「还在卡」的根因之一）。超时留到下次重试。
         */
        try {
            String enc = runCapture(new ArrayList<>(List.of(ff, "-hide_banner", "-encoders")), 30);
            if (enc == null) {
                return REPAIR_ENCS == null ? java.util.Collections.emptyList() : REPAIR_ENCS;
            }
            java.util.List<String> found = new java.util.ArrayList<>();
            for (String cand : new String[]{
                    "hevc_nvenc", "h264_nvenc", "hevc_qsv", "h264_qsv", "hevc_amf", "h264_amf"}) {
                if (enc.contains(cand)) found.add(cand);
            }
            REPAIR_ENCS = found;
            REPAIR_ENC_PROBED = true;
            if (!found.isEmpty()) System.err.println("[transcode] repair encoders = " + found);
        } catch (Throwable ignored) {
            return REPAIR_ENCS == null ? java.util.Collections.emptyList() : REPAIR_ENCS;
        }
        return REPAIR_ENCS;
    }

    /**
     * 选修复编码器：**同编码优先** + 客户端能力门禁（2026-11-24 低端设备收敛）。
     *
     * <ul>
     *   <li>H.264 源 → 先 H.264（客户端一定能解）；没有 H.264 硬编且客户端允许 HEVC 才退 HEVC。</li>
     *   <li>HEVC/AV1 源 → 客户端允许 HEVC 时先 HEVC（省带宽、保留 10-bit/HDR），否则 H.264。</li>
     * </ul>
     *
     * <p>不返回 libx264/libx265 —— 4K 软编追不上实时，等于把"卡顿"换成"等半天"。
     */
    private static String repairEncoder(String ff, String srcCodec, boolean allowHevc) {
        java.util.List<String> list = repairEncoders(ff);
        if (list.isEmpty()) return null;
        String v = srcCodec == null ? "" : srcCodec.toLowerCase();
        boolean srcHigh = v.contains("hevc") || v.contains("h265") || v.contains("av1");
        String[] first = (srcHigh && allowHevc) ? HEVC_ENCS : H264_ENCS;
        String[] second = (srcHigh && allowHevc) ? H264_ENCS : HEVC_ENCS;
        for (String c : first) {
            if (list.contains(c)) return c;
        }
        // 回退到另一族：只有客户端允许 HEVC 时才允许退到 HEVC
        for (String c : second) {
            if (!allowHevc && c.startsWith("hevc")) continue;
            if (list.contains(c)) return c;
        }
        return null;
    }

    /**
     * 修复目标码率（bps）：**跟随源**（1.5 倍），再按输出高度夹上下限。
     *
     * <p>低端设备收敛（2026-11-24）：原来固定 4K=16M，而很多在线 4K 源只有 3~4M，
     * 等于把码率放大 4~5 倍（缓存 46 分钟约 5GB、弱 Wi-Fi 直接缓冲）。
     */
    private static long repairTargetBps(Probe p, String enc) {
        long h = p == null ? 0 : p.height;
        long src = p == null ? 0 : p.bitRate;
        long cap = h >= 2000 ? 16_000_000L : h >= 1400 ? 12_000_000L : h >= 900 ? 8_000_000L : 4_000_000L;
        long floor = h >= 2000 ? 6_000_000L : h >= 1400 ? 5_000_000L : h >= 900 ? 3_000_000L : 2_000_000L;
        // H.264 4K 给到 16M 的收益很低，封 12M
        if (enc != null && enc.startsWith("h264")) cap = Math.min(cap, 12_000_000L);
        long target = src > 100_000 ? Math.round(src * 1.5) : (cap * 3) / 4;
        target = Math.max(floor, Math.min(cap, target));
        return target;
    }

    private static String mbps(long bps) {
        return ((bps + 500_000L) / 1_000_000L) + "M";
    }

    /** 修复编码的目标码率：跟随源（见 {@link #repairTargetBps}）。 */
    private static String repairBitrate(Probe p, String enc) {
        return mbps(repairTargetBps(p, enc));
    }

    /** 修复编码的峰值码率（VBR 上限，防止复杂场景糊）。 */
    private static String repairMaxrate(Probe p, String enc) {
        // 峰值只给 1.25x：NVENC 的 VBV 在 2 秒分片里会贴近 maxrate，
        // 1.5x（如 12M→18M）对弱 Wi-Fi 仍然偏高（实测分片 18.6M）。
        return mbps(repairTargetBps(p, enc) * 5 / 4);
    }

    /** 硬编码率分档（按**输出**高度；硬解路径最高出 1080p）。 */
    private static String hwBitrate(int h) {
        // 2026-11-24：5M 在 1080p 上明显发糊（用户实报「降画质」），提到 8M。
        if (h > 900) return "8M";
        if (h > 600) return "3M";
        return "2M";
    }

    /**
     * http(s) 输入的公共超时/重连选项。
     *
     * <p>★ 为什么必须有（2026-11-20 OECT 实测）：两个在线源 ffprobe 报
     * "TLS Error / IO error: End of file"，ffmpeg 卡在网络读上永不返回，
     * 进程各占 ~575MB 空转、30 秒兜底也执行不到（pump 卡在 readLine）。
     * `-rw_timeout` 让**每一次网络读写**超过 15 秒就报错退出，进程能自己死；
     * 重连选项只在真抖动时救一次，不会把卡死变成永久重试。
     *
     * <p>单位是微秒（ffmpeg 的 AVIO 约定），15000000 = 15 秒。
     */
    /** ffmpeg major（0 = 没探测到）。只探一次：版本不会中途变，probe/转码都要用。 */
    private static volatile int FFMPEG_MAJOR = -1;

    private static int ffmpegMajor() {
        if (FFMPEG_MAJOR >= 0) return FFMPEG_MAJOR;
        int major = 0;
        try {
            String ff = ffmpegPath();
            if (!ff.isEmpty()) {
                String v = runCapture(new ArrayList<>(List.of(ff, "-version")), 5);
                if (v != null) {
                    java.util.regex.Matcher m = java.util.regex.Pattern
                            .compile("version\\s+n?(\\d+)\\.").matcher(v);
                    if (m.find()) major = Integer.parseInt(m.group(1));
                }
            }
        } catch (Throwable ignored) {
        }
        FFMPEG_MAJOR = major;
        return major;
    }

    private static void addHttpInputOptions(List<String> cmd, String source) {
        addHttpInputOptions(cmd, source, "");
    }

    private static void addHttpInputOptions(List<String> cmd, String source, String headerJson) {
        if (!(source.startsWith("http://") || source.startsWith("https://"))) return;
        cmd.add("-rw_timeout"); cmd.add("15000000");
        cmd.add("-reconnect"); cmd.add("1");
        cmd.add("-reconnect_streamed"); cmd.add("1");
        cmd.add("-reconnect_delay_max"); cmd.add("5");
        /*
         * 伪装扩展名的 HLS：2026-11-23 实报「咕噜4K」把 TS 分片写成 .png
         * （Content-Type: image/png）。ffmpeg 7 起 extension_picky 默认 true，
         * 直接报 "not in allowed_segment_extensions" 并以 Invalid data 退出
         * → probe 失败、4K 线路判死。6 及更早是 hls 的 allowed_extensions。
         * 参数名不兼容：传错会让 ffmpeg 以 "Option not found" 直接不启动，
         * 所以按 major 只挑一个；版本探测不到（0）就都不传，保持旧行为。
         */
        /*
         * ★ 只对 HLS 输入加这两个选项（2026-11-24 实测踩过）：
         * ffmpeg 9 里 `-extension_picky` 是 **HLS demuxer 的选项**，对 MKV/MP4
         * 这类普通 http 输入会报 "Option not found" 直接打不开（ffprobe 反而
         * 接受，所以 probe 能过、转码必挂）。片库 SMB 流是 MKV → 全部中招。
         */
        int major = ffmpegMajor();
        boolean hlsSource = source.toLowerCase().contains(".m3u8");
        if (hlsSource && major >= 7) {
            cmd.add("-extension_picky"); cmd.add("0");
        } else if (hlsSource && major >= 1) {
            cmd.add("-allowed_extensions"); cmd.add("ALL");
        }
        /*
         * 源站要求的请求头：点播线路大量依赖 UA/Referer（2026-11-23 实测：
         * 咕噜4K 无 UA 取清单直接 404，浏览器能播是因为播放器带了头）。
         * ffmpeg 只认两种形态：User-Agent 单列一个 -user_agent，其余走
         * -headers（每行 "Key: value\r\n"）。
         */
        if (headerJson == null || headerJson.trim().isEmpty()) return;
        try {
            JSONObject h = new JSONObject(headerJson);
            StringBuilder rest = new StringBuilder();
            // 用 keys() 迭代：仓库里的 org.json 版本没有 keySet()（编译期实测）
            java.util.Iterator<String> it = h.keys();
            while (it.hasNext()) {
                String k = it.next();
                String v = h.optString(k, "");
                if (v.isEmpty()) continue;
                if ("User-Agent".equalsIgnoreCase(k) || "user-agent".equalsIgnoreCase(k)) {
                    cmd.add("-user_agent"); cmd.add(v);
                    continue;
                }
                rest.append(k).append(": ").append(v).append("\r\n");
            }
            if (rest.length() > 0) {
                cmd.add("-headers"); cmd.add(rest.toString());
            }
        } catch (Throwable ignored) {
            // 头不是合法 JSON 就当没有：宁可按无头拉，也不要让 ffmpeg 起不来
        }
    }

    /** 目标机是不是 ARM（OECT/RK3566、多数 NAS）。x86 桌面软转 4K 还有一线希望。 */
    private static boolean isArmHost() {
        String a = System.getProperty("os.arch", "").toLowerCase();
        return a.contains("aarch64") || a.contains("arm");
    }

    /**
     * 4K 且没有硬编时的"必死任务"预判。
     *
     * <p>OECT 实测：RK3566 软转 4K HEVC 只有 0.9–2.4 fps，首片要 100 秒以上，
     * 整集永远追不上播放速度；起这种任务只会烧 CPU/写满磁盘，最后被看门狗杀。
     * 直接在 probe 后拒绝，前端按 code=slow_4k 提示"用原生播放器/换 1080p 线路"。
     *
     * <p>不拦 x86（桌面/服务器多核软转可能 1x），也不拦 copyVideo（只换封装）。
     * 调试用 meow.transcode.allowSlow4k=true 放行，rejectSlow4k=true 强制拒绝（测试）。
     */
    static boolean slow4kHopeless(Probe p, boolean hw) {
        if (p == null || p.copyVideo) return false;
        if (p.height < 2000 && p.width < 2000) return false;
        if (hw) return false;
        if (Boolean.getBoolean("meow.transcode.allowSlow4k")) return false;
        return isArmHost() || Boolean.getBoolean("meow.transcode.rejectSlow4k");
    }

    private static final String SLOW_4K_MSG =
            "这台设备没有 4K 硬编码能力，软转 4K 速度远低于播放（实测 <3 fps，首片要 100 秒以上）。"
            + "请改用「原生播放器」（投影仪可硬解 4K），或换 1080p / H.264 线路。";

    private static List<String> hlsCommand(String ff, String id, String source, Probe p, boolean hw,
                                           String header, boolean repair, int startSec,
                                           boolean allowHevc) {
        List<String> cmd = new ArrayList<>();
        boolean http = source.startsWith("http://") || source.startsWith("https://");
        cmd.add(ff);
        cmd.add("-hide_banner");
        cmd.add("-loglevel"); cmd.add("error");
        cmd.add("-y");
        if (http) {
            /*
             * F2（2026-11-17）：片库 SMB 转码现在喂的是后端自己的回环流地址
             * （支持 Range，mp4 的 moov 在尾部也能先跳过去读），不再先拷整份。
             * 选项按 ffmpeg 8.1 的 http 协议实测可用集来写：
             *   -seekable 1      明确告诉它可 seek（否则可能放弃读 moov）
             *   -multiple_requests 1  keep-alive，减少每次 Range 的 TCP 握手
             *   -reconnect*      抖动自动重连一次，别让整集转码断在半路
             * ★ 不能用 -http_persistent：ffmpeg 8.1 里不存在，实测直接
             *   "Option http_persistent not found" 退出（2026-11-17 踩过）。
             */
            cmd.add("-seekable"); cmd.add("1");
            cmd.add("-multiple_requests"); cmd.add("1");
            // 超时/重连/伪装扩展名/源站请求头统一在 addHttpInputOptions 里给
            addHttpInputOptions(cmd, source, header);
        }
        /*
         * 硬解走通用 hwaccel 路径，帧格式必须显式声明 drm_prime：
         * 只有 drm_prime 帧能直接喂给 RGA 缩放滤镜（scale_rkrga）和 rkmpp 编码器。
         * 用 `-c:v <codec>_rkmpp` 会得到普通 AVFrame，RGA/编码器都接不上
         * （实测 -22 Terminating thread）。
         */
        if (hw) {
            cmd.add("-hwaccel"); cmd.add("rkmpp");
            cmd.add("-hwaccel_output_format"); cmd.add("drm_prime");
        }
        /*
         * 修复从当前位置起转（2026-11-24）：`-ss` 必须放在 -i **前面**（输入快进，
         * 秒级完成；放后面是解码后丢弃，4K 要等整段解完）。实测远程 4K HLS
         * `-ss 390` 再编 6 秒只要 5 秒。
         * 输出时间轴从 0 开始，前端用 startOffset 换算显示的绝对进度。
         */
        if (repair && startSec > 1) {
            cmd.add("-ss"); cmd.add(String.valueOf(startSec));
        }
        cmd.add("-i"); cmd.add(source);
        /*
         * 只输出「主视频 + 主音轨」（2026-11-17 实测）：
         * 片源 mkv 常带 6~7 个字幕流和多余音轨，ffmpeg 默认会把字幕全转成
         * WebVTT（目录里冒出一堆 indexN.vtt + index_vtt.m3u8），CPU 白烧 2~3 倍，
         * 播放器还可能去拉那些 vtt 干扰起播。我们的字幕走前端自己的轨道选择。
         */
        cmd.add("-map"); cmd.add("0:v:0");
        cmd.add("-map"); cmd.add("0:a:0?");
        if (p != null && p.copyVideo) {
            // F1：源就是 H.264 ≤1080p，重编码纯属浪费（OECT 上 4 秒内容要 20 秒）
            cmd.add("-c:v"); cmd.add("copy");
        } else if (repair) {
            /*
             * 原分辨率修复（2026-11-24）：显卡重编，**不做任何缩放**。
             *
             * 触发场景：源码流是"整 GOP 全 B 帧"（has_b_frames=5），Chromium
             * 解出来但渲染器稳定丢 28% 帧；copy 会原样保留这个结构，修不好。
             * NVENC 重编后（仍 4K HEVC）实测丢帧 0，这是唯一不降画质的修法。
             *
             * HDR 源保留 10-bit 交给浏览器 tone map：4K 上跑 zscale 软 tonemap
             * 追不上实时，反而会重新引入卡顿。
             */
            String enc = repairEncoder(ff, p == null ? "" : p.vcodec, allowHevc);
            cmd.add("-pix_fmt"); cmd.add(
                    (p != null && isHdr(p) && enc != null && enc.startsWith("hevc"))
                            ? "p010le" : "yuv420p");
            cmd.add("-c:v"); cmd.add(enc);
            if (enc != null && enc.endsWith("_nvenc")) {
                cmd.add("-preset"); cmd.add("p5");
                cmd.add("-rc"); cmd.add("vbr");
                cmd.add("-b:v"); cmd.add(repairBitrate(p, enc));
                cmd.add("-maxrate"); cmd.add(repairMaxrate(p, enc));
                cmd.add("-bufsize"); cmd.add(repairMaxrate(p, enc));
                /*
                 * 实测（2026-11-24）：hevc_nvenc 默认不认 force_key_frames，
                 * 10 秒才出一个关键帧 → 分片全是 10 秒，修复起播要多等 10 秒。
                 * 加 -forced-idr 1 后稳定切出 2 秒分片。
                 */
                cmd.add("-forced-idr"); cmd.add("1");
            } else if (enc != null && enc.endsWith("_qsv")) {
                cmd.add("-preset"); cmd.add("medium");
                cmd.add("-b:v"); cmd.add(repairBitrate(p, enc));
            } else {
                cmd.add("-quality"); cmd.add("balanced");
                cmd.add("-b:v"); cmd.add(repairBitrate(p, enc));
            }
            if (p != null && isHdr(p)) {
                cmd.add("-color_primaries"); cmd.add("bt2020");
                cmd.add("-color_trc"); cmd.add(p.colorTransfer);
                cmd.add("-colorspace"); cmd.add("bt2020nc");
            }
            cmd.add("-force_key_frames");
            cmd.add("expr:gte(t,n_forced*" + SEG_SECONDS + ")");
        } else if (hw) {
            /*
             * 硬解 + 硬编（2026-11-17，RK 设备专属，OEC/ RK3566 实测）：
             *   - 解码：-hwaccel rkmpp -hwaccel_output_format drm_prime（见 -i 前）
             *   - 缩放：scale_rkrga（RGA 硬件缩放，帧不出显存）
             *   - 编码：h264_rkmpp VBR
             *
             * ★ 三个实测出来的硬约束，改任何一条都会退化成不能播：
             *   1. **必须降到 ≤1080p**：RK3566 的编码器只有 1080p 级吞吐，
             *      4K 硬编实测 0.28x（20 秒内容 71 秒），1080p 是 1.28x。
             *   2. **缩放只能用 scale_rkrga**：普通 `-vf scale` 要 hwdownload
             *      硬件帧，实测 -22（apiserver 里表现为 Generic error）。
             *   3. **force_key_frames 对 h264_rkmpp 生效**（分片精确 2.002s），
             *      不加则首片退化成源 GOP（7.5s）。
             *
             * OEC 实测 4K HEVC Main10 → 1080p：首片清单 13.6 秒（纯软解 100 秒），
             * 持续 1.28x 实时，可正常连播。
             */
            if (p.height > 1080) {
                int outW = 1920;
                int outH = p.width > 0 ? Math.max(2, (int) Math.round(p.height * 1920.0 / p.width / 2) * 2) : 1080;
                cmd.add("-vf"); cmd.add("scale_rkrga=w=" + outW + ":h=" + outH + ":format=nv12");
            }
            cmd.add("-force_key_frames");
            cmd.add("expr:gte(t,n_forced*" + SEG_SECONDS + ")");
            cmd.add("-c:v"); cmd.add("h264_rkmpp");
            cmd.add("-rc_mode"); cmd.add("VBR");
            cmd.add("-qp_init"); cmd.add("23");
            // rkmpp VBR 不给目标码率时默认很低（1080p 也糊）
            cmd.add("-b:v"); cmd.add(hwBitrate(p.height > 1080 ? 1080 : p.height));
        } else {
            // 视频统一降到 H.264：那是所有浏览器都有的解码器。
            // veryfast 实测 6.7 倍速；更快的 ultrafast 画质掉得明显，不值得。
            cmd.add("-c:v"); cmd.add("libx264");
            cmd.add("-preset"); cmd.add("veryfast");
            cmd.add("-crf"); cmd.add("23");
            /*
             * ★ 必须显式钉 8-bit（2026-11-23 实测踩过）：ffmpeg 的 libx264
             * 在 10-bit 输入下会**沿用源位深**（输出 yuv420p10le / High 10），
             * 转出来的 HLS 浏览器照样解不了 —— 转码等于白转。钉死 yuv420p
             * 后 High10 源会被降位深重编码。
             */
            cmd.add("-pix_fmt"); cmd.add("yuv420p");
            /*
             * ★ 强制按 SEG_SECONDS 插关键帧（2026-11-17 实测踩过）：
             * -hls_time 只是「最小片长」，实际切点看源关键帧。这批 mkv 的 GOP
             * 7.5 秒 → 首片要转 7.46 秒内容（4K 10bit 软解 ~200 秒），必然超过
             * 前端 180 秒超时 → "第一集永远播不了"。加 force_key_frames 后
             * 首片真的只有 2 秒内容。
             */
            cmd.add("-force_key_frames");
            cmd.add("expr:gte(t,n_forced*" + SEG_SECONDS + ")");
            /*
             * HDR→SDR（2026-11-24）：只对 PQ/HLG 做 tonemap。
             * 不加的话 HDR 源转出来仍贴 bt2020 标签、在 SDR 屏上发灰，
             * 用户看到的就是"降画质"。SDR 10-bit 绝不能走这条链（会偏色）。
             */
            String vf = "scale='min(1920,iw)':-2";
            if (p != null && isHdr(p)) {
                vf = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                        + "tonemap=tonemap=hable:desat=0,"
                        + "zscale=t=bt709:m=bt709:r=tv,format=yuv420p,"
                        + "scale='min(1920,iw)':-2";
                cmd.add("-color_primaries"); cmd.add("bt709");
                cmd.add("-color_trc"); cmd.add("bt709");
                cmd.add("-colorspace"); cmd.add("bt709");
            }
            // 4K 源降到 1080p：H.264 编 4K 慢 4 倍，而浏览器端肉眼收益很小
            cmd.add("-vf"); cmd.add(vf);
        }
        if (p != null && p.copyAudio) {
            cmd.add("-c:a"); cmd.add("copy");
        } else {
            cmd.add("-c:a"); cmd.add("aac");
            cmd.add("-b:a"); cmd.add("192k");
            cmd.add("-ac"); cmd.add("2");
        }
        cmd.add("-f"); cmd.add("hls");
        cmd.add("-hls_time"); cmd.add(String.valueOf(SEG_SECONDS));
        cmd.add("-hls_list_size"); cmd.add("0");
        cmd.add("-hls_flags"); cmd.add("independent_segments");
        cmd.add("-hls_segment_filename");
        cmd.add(dirOf(id).resolve("seg-%05d.ts").toString());
        // 中途修复：ffmpeg 只写 raw.m3u8，对外 index.m3u8 由 composeMerged 合并
        cmd.add(startSec > 1 ? rawPlaylistOf(id).toString() : playlistOf(id).toString());
        return cmd;
    }

    /** 进程活着但这么久没有新分片，判定卡死（4K 软解首片实测约 100 秒）。 */
    private static final long HANG_NO_SEGMENT_MS = 180_000L;

    /**
     * 读 ffmpeg 输出（防管道写满阻塞），并在结束时判定结果。
     *
     * <p>★ 读与等必须分两条线程（2026-11-20 OECT 实测）：原实现先 readLine
     * 读到 EOF 才 waitFor(30s)，而 ffmpeg 卡在网络读时管道不关、readLine
     * 永不返回 —— 那个"卡住 30 秒强杀"的保护永远执行不到。现在 reader
     * 线程只负责排水；主线程按秒巡检，进程活着但 180 秒没有新分片就强杀。
     * 网络读本身的 15 秒超时由 -rw_timeout 兜底（见 addHttpInputOptions）。
     */
    private static void pump(Job j) {
        final Process proc = j.proc;
        final StringBuilder tail = new StringBuilder();
        Thread reader = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    synchronized (tail) {
                        tail.append(line).append('\n');
                        if (tail.length() > 4000) tail.delete(0, tail.length() - 4000);
                    }
                }
            } catch (Exception ignored) {
            }
        }, "transcode-log-" + j.id);
        reader.setDaemon(true);
        reader.start();

        int lastSeg = countSegments(j.id);
        long lastProgress = System.currentTimeMillis();
        boolean exited = false;
        try {
            while (!(exited = proc.waitFor(1, TimeUnit.SECONDS))) {
                int n = countSegments(j.id);
                if (n > lastSeg) {
                    lastSeg = n;
                    lastProgress = System.currentTimeMillis();
                    composeMerged(j.id);
                } else if (System.currentTimeMillis() - lastProgress > HANG_NO_SEGMENT_MS) {
                    try {
                        proc.destroyForcibly();
                    } catch (Exception ignored) {
                    }
                    j.state = "failed";
                    j.phase = "failed";
                    j.code = "stalled";
                    j.error = "转码 " + (HANG_NO_SEGMENT_MS / 1000)
                            + " 秒没有新分片（上游卡住或编码器无响应），已强制结束";
                    System.err.println("[transcode] job " + j.id + " stall -> killed");
                    return;
                }
            }
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        }
        try {
            reader.join(2_000);
        } catch (InterruptedException ignored) {
        }
        int code;
        try {
            code = proc.exitValue();
        } catch (Exception e) {
            code = -1;
        }
        String tailText;
        synchronized (tail) {
            tailText = tail.toString().trim();
        }

        /*
         * ★ 只有正常退出才写完成标记（2026-11-17 实测踩过）：原来
         * `code == 0 || 清单存在` 就算 ready，ffmpeg 被杀/崩溃时清单里已有几片，
         * 于是「播几秒就卡」且再点也不会重转。
         */
        if (code == 0) {
            /*
             * ★ exit 0 不等于"转完了"（2026-11-17 实测踩过）：输入流被对端提前
             * 关闭时 ffmpeg 会把已有的写出、然后以 0 退出 —— 清单看起来正常，
             * 实际只有几十秒，用户播到断点就卡死，而且因为标了 ready 再点也不会重转。
             * 所以必须拿产出时长和源时长对一下。
             */
            j.segments = countSegments(j.id);
            double srcDur = j.probeSnap != null ? j.probeSnap.duration : 0;
            double gotDur = j.startOffset + j.segments * (double) SEG_SECONDS;
            if (srcDur > 30 && gotDur < srcDur - 15) {
                /*
                 * ★ 短产出自动重试（2026-11-21 OECT 实测）：SMB 回环流被对端
                 *   提前关闭时，ffmpeg 会把已转部分正常写出并以 0 退出 ——
                 *   表现就是"转码中断：只产出 922 秒（源 2723 秒）"。HLS 分段
                 *   无法从中间续转（段号/时间轴要整体重排），所以重试 = 从头
                 *   再转一遍；重试仍短才判 failed（由前端给"用原生播放"出路）。
                 */
                if (j.shortRetry < 1) {
                    j.shortRetry++;
                    j.state = "running";
                    j.phase = "running";
                    j.code = "";
                    j.error = "";
                    System.err.println("[transcode] job " + j.id + " short output "
                            + (int) gotDur + "s of " + (int) srcDur + "s -> retry "
                            + j.shortRetry);
                    cleanSegments(j.id);
                    try {
                        startFfmpeg(j, j.ffPath, j.source, false);
                    } catch (Exception e) {
                        System.err.println("[transcode] short-output retry failed to start: " + e);
                    }
                    return;
                }
                j.state = "failed";
                j.phase = "failed";
                j.code = "short_output";
                j.error = "转码中断：只产出 " + (int) gotDur + " 秒（源 " + (int) srcDur + " 秒）";
                System.err.println("[transcode] job " + j.id + " short output "
                        + (int) gotDur + "s of " + (int) srcDur + "s -> failed");
                return;
            }
            composeMerged(j.id);
            markDone(j.id);
            j.state = "ready";
            j.phase = "ready";
            return;
        }
        if ("cancelled".equals(j.state)) return;
        /*
         * 硬解失败自动回退软解（2026-11-17 OEC 实测）：RK 的 VDEC 通道数有限，
         * 两个 4K 转码并发时第二个会以
         * "Error while opening decoder: Generic error in an external library" 失败。
         * 不回退的话这种情况直接"播不了"，比优化前更差。只回退一次。
         */
        if (j.hw && j.hwRetry < 2 && !j.ffPath.isEmpty()) {
            j.hwRetry++;
            /*
             * 第一次失败先重试硬解：退出前一个任务后设备句柄可能还没释放完，
             * 表现就是新进程打印一行 rga_api 版本号后直接崩（实测）。
             * 第二次才退软解 —— 4K 软解只有 0.025x，能硬解就别退。
             */
            boolean retryHw = j.hwRetry == 1;
            if (!retryHw && slow4kHopeless(j.probeSnap, false)) {
                j.state = "failed";
                j.phase = "failed";
                j.code = "slow_4k";
                j.error = SLOW_4K_MSG;
                System.err.println("[transcode] hw failed and soft 4k hopeless -> reject " + j.id);
                return;
            }
            System.err.println("[transcode] hw failed, retry " + (retryHw ? "hw" : "software")
                    + ": " + j.id
                    + " | " + (tailText.length() > 200 ? tailText.substring(tailText.length() - 200) : tailText));
            cleanSegments(j.id);
            try {
                if (retryHw) {
                    try {
                        Thread.sleep(1500);
                    } catch (InterruptedException ignored) {
                    }
                    startFfmpeg(j, j.ffPath, j.source, false);
                } else {
                    startFfmpeg(j, j.ffPath, j.source, true);
                }
                return;
            } catch (Exception e) {
                System.err.println("[transcode] retry failed to start: " + e);
            }
        }
        j.state = "failed";
        j.phase = "failed";
        String low = tailText.toLowerCase();
        if (low.contains("error reading http response") || low.contains("-138")
                || low.contains("connection timed out") || low.contains("etimedout")
                || low.contains("tls error")) {
            j.code = "source_timeout";
            j.error = "源站连接超时/断开（15 秒无响应已停止）。换一条线路试试。";
        } else if (low.contains("403") || low.contains("404") || low.contains("http error")) {
            j.code = "source_http";
            j.error = "源站拒绝访问（链接可能已过期或需要鉴权）。换一条线路试试。";
        } else if (low.contains("invalid data") || low.contains("moov atom")
                || low.contains("could not find codec")) {
            j.code = "bad_source";
            j.error = "源文件不完整或格式异常（不是有效的视频流）。换一条线路试试。";
        } else {
            j.code = "ffmpeg_failed";
            j.error = tailText.isEmpty() ? ("ffmpeg 退出码 " + code)
                    : tailText.substring(Math.max(0, tailText.length() - 300));
        }
    }

    public static Job status(String id) {
        Job j = JOBS.get(id);
        if (j == null) {
            /*
             * java 重启后内存 Job 丢了：只有「清单 + .done 都在」才算 ready。
             * 只看清单会把中断的半成品又报成可播（用户播到断点卡死），
             * 下次 ensure 虽然会重转，但状态查询这一路会先误导前端。
             */
            if (Files.isRegularFile(playlistOf(id))) {
                Job s = new Job();
                s.id = id;
                s.state = playable(id) ? "ready" : "idle";
                s.segments = countSegments(id);
                s.readySeconds = s.segments * SEG_SECONDS;
                return s;
            }
            return null;
        }
        /*
         * 转码是增量的：清单里已有几个分片就能播几秒（前 3 片就够起播）。
         *
         * ★ 但**不能改 state**（2026-11-17 实测踩过的死循环）：把 running 改成
         * ready 之后，下一次 ensure 看到 "ready 但没有 .done" 就判成"过期的半成品"，
         * 于是另起一个 ffmpeg —— 旧进程还活着、两个 ffmpeg 同时写同一批分片，
         * MPP 直接崩（Generic error），用户看到的就是"播几秒就卡"。
         * 状态只让 pump 改；"能不能播"由 playlist + readySeconds 表达。
         */
        /*
         * ★ 状态轮询也算"有人关心"（2026-11-23）：播放器暂停时不再拉分片，
         *   但前端每 5 秒还在轮询进度；不刷新 lastAccess 的话，暂停两分钟
         *   就会被空闲看门狗误杀。退出播放页后轮询停止 → 才会真的超时取消。
         */
        j.lastAccess = System.currentTimeMillis();
        int n = countSegments(id);
        if (n > j.segments) j.lastSegmentAt = System.currentTimeMillis();
        j.segments = n;
        j.readySeconds = (j.startOffset > 1 ? j.startOffset : 0) + n * SEG_SECONDS;
        return j;
    }

    private static int countSegments(String id) {
        try {
            File[] fs = dirOf(id).toFile().listFiles((d, n) -> n.startsWith("seg-") && n.endsWith(".ts"));
            return fs == null ? 0 : fs.length;
        } catch (Exception e) {
            return 0;
        }
    }

    public static boolean cancel(String id) {
        Job j = JOBS.get(id);
        if (j == null) return false;
        j.state = "cancelled";
        j.phase = "cancelled";
        j.code = "cancelled";
        try {
            j.proc.destroyForcibly();
        } catch (Exception ignored) {
        }
        return true;
    }

    public static JSONObject toJson(Job j) throws Exception {
        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("id", j.id);
        o.put("state", j.state);
        o.put("error", j.error);
        /*
         * ★ 可播与否只能按「磁盘上真有 index.m3u8」来报（2026-11-17 实测踩过）：
         * 清掉转码目录后内存里的 Job 仍是 ready/289 片，start 立刻回一个
         * playlist 地址 → 前端马上去拉 → 404 manifestLoadError → 用户看到
         * 「播放失败」，可实际上转码刚重新开始。计数一起归零，否则界面还会
         * 显示一个虚的「已就绪 578 秒」。
         */
        boolean hasPlaylist = Files.isRegularFile(playlistOf(j.id))
                && !"failed".equals(j.state);
        double dur = durationOf(j.id);
        if (dur <= 0 && j.probeSnap != null) dur = j.probeSnap.duration;
        o.put("duration", (long) Math.round(dur));
        o.put("segments", hasPlaylist ? j.segments : 0);
        o.put("readySeconds", hasPlaylist ? j.readySeconds : 0);
        if (hasPlaylist && ("ready".equals(j.state) || j.segments > 0)) {
            o.put("playlist", "/api/transcode/" + j.id + "/index.m3u8");
        }
        o.put("phase", j.phase == null ? "" : j.phase);
        o.put("hw", j.hw);
        o.put("startedAt", j.startedAt);
        /*
         * 源/输出编码（2026-11-23 用户要求面板显示）：
         * 转码后 videoWidth 是输出分辨率，用户会把「4K 变 1080p」误读成
         * "4K 没生效"；必须把 **源** 与 **输出** 分开给。
         * 输出规则按 hlsCommand 的三条分支写死：
         *   copyVideo → 原编码原分辨率
         *   hw / 软编 → h264 + yuv420p，高度封顶 1080
         */
        if (j.probeSnap != null) {
            Probe p = j.probeSnap;
            o.put("srcVcodec", p.vcodec);
            o.put("srcAcodec", p.acodec);
            o.put("srcPixfmt", p.pixFmt);
            o.put("srcBitDepth", p.bitDepth);
            o.put("srcColorTransfer", p.colorTransfer == null ? "" : p.colorTransfer);
            o.put("srcChannels", p.channels);
            o.put("srcWidth", p.width);
            o.put("srcHeight", p.height);
            o.put("copyVideo", p.copyVideo);
            o.put("copyAudio", p.copyAudio);
            if (p.copyVideo) {
                o.put("outVcodec", p.vcodec);
                o.put("outPixfmt", p.pixFmt);
                o.put("outHeight", p.height);
            } else if (j.repair) {
                String enc = repairEncoder(j.ffPath.isEmpty() ? ffmpegPath() : j.ffPath,
                        p.vcodec, j.allowHevc);
                o.put("outVcodec", enc != null && enc.startsWith("hevc") ? "hevc" : "h264");
                o.put("outPixfmt", "yuv420p");
                // 修复必须保持分辨率：前端拿它做"不许降画质"的硬门槛
                o.put("outHeight", p.height);
                // 修复流从源的 startOffset 秒开始：前端显示进度 = 流时间 + 它
                o.put("startOffset", j.startOffset);
            } else {
                o.put("outVcodec", "h264");
                o.put("outPixfmt", "yuv420p");
                o.put("outHeight", p.height > 0 ? Math.min(p.height, 1080) : 0);
            }
        }
        o.put("lastSegmentAge",
                j.lastSegmentAt > 0 ? (System.currentTimeMillis() - j.lastSegmentAt) / 1000 : -1);
        if (j.code != null && !j.code.isEmpty()) o.put("code", j.code);
        return o;
    }

    /** 转码能力缓存（ffmpeg 不会中途换，10 分钟刷一次足够）。 */
    private static volatile JSONObject CAPS_CACHE = null;
    private static volatile long CAPS_AT = 0;

    /**
     * 后端转码能力（前端选路/提示用）：
     *   available  ffmpeg 是否存在
     *   hw         是否有 rkmpp 硬编（h264_rkmpp）
     *   tonemap    是否有 zscale + tonemap（HDR→SDR 可用）
     *   maxHeight  硬编路径最大输出高度（0 = 不限）
     */
    public static JSONObject caps() throws org.json.JSONException {
        JSONObject cached = CAPS_CACHE;
        if (cached != null && System.currentTimeMillis() - CAPS_AT < 600_000L) {
            return new JSONObject(cached.toString());
        }
        JSONObject o = new JSONObject();
        String ff = ffmpegPath();
        if (ff.isEmpty()) {
            o.put("ok", true).put("available", false).put("hw", false)
                    .put("tonemap", false).put("maxHeight", 0)
                    .put("encoders", new org.json.JSONArray()).put("hwEnc", false);
        } else {
            boolean hw = false;
            boolean tonemap = false;
            String enc = null;
            try {
                enc = runCapture(java.util.Arrays.asList(
                        ff, "-hide_banner", "-encoders"), 10);
                if (enc != null) hw = enc.contains("h264_rkmpp");
                String fil = runCapture(java.util.Arrays.asList(
                        ff, "-hide_banner", "-filters"), 10);
                if (fil != null) tonemap = fil.contains("zscale") && fil.contains("tonemap");
            } catch (Exception ignored) {
            }
            // 修复转码用的显卡编码器（前端据此决定"能不能原分辨率修丢帧"）
            org.json.JSONArray encs = new org.json.JSONArray();
            if (enc != null) {
                for (String cand : new String[]{
                        "hevc_nvenc", "h264_nvenc", "hevc_qsv", "h264_qsv", "hevc_amf", "h264_amf"}) {
                    if (enc.contains(cand)) encs.put(cand);
                }
            }
            o.put("ok", true).put("available", true).put("hw", hw)
                    .put("tonemap", tonemap).put("maxHeight", hw ? 1080 : 0)
                    .put("encoders", encs).put("hwEnc", encs.length() > 0);
        }
        CAPS_CACHE = new JSONObject(o.toString());
        CAPS_AT = System.currentTimeMillis();
        return o;
    }

    public static long totalBytes() {
        try {
            return VideoCache.dirSize(DataPaths.of(ROOT));
        } catch (Exception e) {
            return 0;
        }
    }
}
