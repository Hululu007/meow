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
        /** 已回退过几次（只回退一次，避免来回折腾）。 */
        int hwRetry = 0;
        /** 启动本次任务用的 ffmpeg 路径与探测结果（pump 回退重试用）。 */
        String ffPath = "";
        Probe probeSnap;
        Process proc;
        public int segments;
        /** 已产出的可播时长（秒），用于前端显示"转码中 x 秒" */
        public int readySeconds;
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
    private static void stopOtherJobs(String keepId) {
        long now = System.currentTimeMillis();
        for (Job o : new java.util.ArrayList<>(JOBS.values())) {
            if (o.id.equals(keepId) || !"running".equals(o.state)) continue;
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
            cleanSegments(o.id);
            System.err.println("[transcode] cancelled " + o.id + " (serialize, keep=" + keepId + ")");
        }
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
     * 确保某个源已经开始转码。幂等：已在转或已转好就直接返回。
     *
     * @param sourceUrl 可被 ffmpeg 直接读到的地址（http/https）
     */
    public static Job ensure(String sourceUrl, boolean forceVideo) {
        String id = idFor(sourceUrl);
        /*
         * 单集锁（S1，2026-11-17）：前端 start 请求与 2 秒一次的轮询可能
         * 同时进来，"检查状态 → 起 ffmpeg"必须串行，否则会起两个进程写同一目录。
         */
        synchronized (lockFor(id)) {
            return ensure0(sourceUrl, forceVideo, id);
        }
    }

    private static Job ensure0(String sourceUrl, boolean forceVideo, String id) {
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
        // 已经转完的直接复用（**必须有完成标记**，半成品不算）
        if (playable(id) && !forceVideo) {
            j.state = "ready";
            j.lastAccess = System.currentTimeMillis();
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
         * ★ 在线源兜底也要串行（2026-11-20 OECT 实测漏点）：
         * 原实现只有 startFfmpeg（本地/片库路径）调 stopOtherJobs，
         * ensure() 这条远程路径完全不拦 —— 两次"播放失败→转码"就能并发出
         * 两个 ffmpeg（各 575MB 空转）。这里补上，和本地路径同一语义。
         */
        stopOtherJobs(j.id);

        String ff = ffmpegPath();
        if (ff.isEmpty()) {
            j.state = "failed";
            j.error = "找不到 ffmpeg。装一个（或在 policy.json 里配 ffmpegPath）才能播这个格式。";
            // 不打日志的话排障只剩前端的「起播超时」，真实原因永远看不到
            System.err.println("[transcode] job " + id + " ffmpeg missing -> failed");
            return j;
        }

        List<String> cmd = new ArrayList<>();
        cmd.add(ff);
        cmd.add("-hide_banner");
        cmd.add("-loglevel"); cmd.add("error");
        cmd.add("-y");
        // 在线源必须有网络超时：源站半死不活时 ffmpeg 会卡在 read 上永不退出
        addHttpInputOptions(cmd, sourceUrl);
        // 只处理到转出文件的磁盘 io：不写日志文件，避免缓存目录里混入杂物
        cmd.add("-i"); cmd.add(sourceUrl);
        // 视频统一降到 H.264：那是所有浏览器都有的解码器。
        // veryfast 实测 6.7 倍速；更快的 ultrafast 画质掉得明显，不值得。
        cmd.add("-c:v"); cmd.add("libx264");
        cmd.add("-preset"); cmd.add("veryfast");
        cmd.add("-crf"); cmd.add("23");
        // 4K 源降到 1080p：H.264 编 4K 慢 4 倍，而浏览器端肉眼收益很小
        cmd.add("-vf"); cmd.add("scale='min(1920,iw)':-2");
        // 音频优先 copy（多数是 AAC/AC3→AAC 需要转，EAC3 浏览器不支持）
        cmd.add("-c:a"); cmd.add("aac");
        cmd.add("-b:a"); cmd.add("192k");
        cmd.add("-ac"); cmd.add("2");
        cmd.add("-f"); cmd.add("hls");
        cmd.add("-hls_time"); cmd.add(String.valueOf(SEG_SECONDS));
        cmd.add("-hls_list_size"); cmd.add("0");
        cmd.add("-hls_flags"); cmd.add("independent_segments");
        cmd.add("-hls_segment_filename");
        cmd.add(dirOf(id).resolve("seg-%05d.ts").toString());
        cmd.add(playlistOf(id).toString());

        try {
            // ★ 必须先建输出目录：ffmpeg 不会自己创建，段文件写到不存在的目录时
            // 整条命令以 "Failed to open file ... No such file or directory" 失败，
            // 而且 exit code 非 0、日志里只有一行，很容易误判成"源不可达"（实测踩过）。
            java.nio.file.Files.createDirectories(dirOf(id));
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            j.proc = pb.start();
            j.state = "running";
            j.startedAt = System.currentTimeMillis();
            Thread th = new Thread(() -> pump(j), "transcode-" + id);
            th.setDaemon(true);
            th.start();
        } catch (Exception e) {
            j.state = "failed";
            j.error = "启动 ffmpeg 失败：" + e.getMessage();
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
        String id = idFor(key);
        // 单集锁：与 ensure 同理（幂等键是 lib|path，同一集并发点击只起一个任务）
        synchronized (lockFor(id)) {
            return ensureLocal0(source, key, id);
        }
    }

    private static Job ensureLocal0(String source, String key, String id) {
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
        Probe probe = probe(ff, source);
        if (probe != null) {
            System.err.println("[transcode] probe " + id + ": " + probe.detail
                    + " -> copyVideo=" + probe.copyVideo + " copyAudio=" + probe.copyAudio);
        } else {
            // 没这条日志的话，hw=false 会被误读成"设备没硬解"，其实是探测超时
            System.err.println("[transcode] probe " + id + " failed (ffprobe timeout?) -> software path");
        }
        // S4：起新任务前回收历史产物（保留最近 3 个；正在转/正在看的不动）
        pruneProducts();
        /*
         * ★ 在线源兜底也要串行（2026-11-20 OECT 实测漏点）：
         * 原实现只有 startFfmpeg（本地/片库路径）调 stopOtherJobs，
         * ensure() 这条远程路径完全不拦 —— 两次"播放失败→转码"就能并发出
         * 两个 ffmpeg（各 575MB 空转）。这里补上，和本地路径同一语义。
         */
        stopOtherJobs(j.id);
        j.probeSnap = probe;
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
        /** 源宽高：硬解硬编走 RGA 缩放时才需要（4K 必须降到 1080p，见 hw 分支）。 */
        int width;
        int height;
        /** 源总时长（秒）。0 = 没探到 —— 用来判断 ffmpeg 是不是只转了一小段就退出。 */
        double duration;
        String detail = "";
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
        return rkmppDecoders(ff).contains(p.vcodec + "_rkmpp") && rkmppEncoder(ff);
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
    private static Probe probe(String ff, String source) {
        String fp = ffprobeOf(ff);
        if (fp.isEmpty()) return null;
        try {
            List<String> v = new ArrayList<>();
            v.add(fp);
            v.add("-v"); v.add("error");
            v.add("-select_streams"); v.add("v:0");
            v.add("-show_entries"); v.add("stream=codec_name,width,height");
            v.add("-of"); v.add("csv=p=0");
            addHttpInputOptions(v, source);
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

            List<String> a = new ArrayList<>();
            a.add(fp);
            a.add("-v"); a.add("error");
            a.add("-select_streams"); a.add("a:0");
            a.add("-show_entries"); a.add("stream=codec_name,channels");
            a.add("-of"); a.add("csv=p=0");
            addHttpInputOptions(a, source);
            a.add(source);
            String ao = runCapture(a, 30);
            // 总时长：pump 用它判断"exit 0 但只转了一小段"（输入被截断时会出现）
            List<String> d = new ArrayList<>();
            d.add(fp);
            d.add("-v"); d.add("error");
            d.add("-show_entries"); d.add("format=duration");
            d.add("-of"); d.add("csv=p=0");
            addHttpInputOptions(d, source);
            d.add(source);
            // 这条只影响进度条总长（UI），不值得让它拖慢起播：12 秒拿不到就用 0
            String dOut = runCapture(d, 12);
            double dur = 0;
            if (dOut != null) {
                try {
                    dur = Double.parseDouble(dOut.trim().split("[,\s]+")[0]);
                } catch (Exception ignored) {
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
            p.copyVideo = "h264".equals(vcodec) && w > 0 && h > 0 && w <= 1920 && h <= 1080;
            p.width = w;
            p.height = h;
            p.duration = dur;
            p.copyAudio = "aac".equals(acodec) && ch > 0 && ch <= 2;
            p.detail = vcodec + " " + w + "x" + h + " / " + acodec + " " + ch + "ch";
            return p;
        } catch (Exception e) {
            return null;
        }
    }

    /** 跑一条只读命令拿 stdout（带真超时：读线程独立，主线程只等时钟）。 */
    private static String runCapture(List<String> cmd, int timeoutSec) {
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
            return bos.toString(StandardCharsets.UTF_8);
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
        // 一次只跑一个重转码（VDEC 通道有限；被放弃的旧任务要停）
        stopOtherJobs(j.id);
        // 从零开始转：清掉可能残留的半成品与完成标记，否则清单会指向不存在的分片
        cleanSegments(j.id);
        Probe p = j.probeSnap;
        boolean hw = !forceSw && p != null && !p.copyVideo && hwTranscode(ff, p);
        j.hw = hw;
        j.ffPath = ff;
        List<String> cmd = hlsCommand(ff, j.id, source, p, hw);
        java.nio.file.Files.createDirectories(dirOf(j.id));
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        j.proc = pb.start();
        j.state = "running";
        j.startedAt = System.currentTimeMillis();
        Thread th = new Thread(() -> pump(j), "transcode-" + j.id);
        th.setDaemon(true);
        th.start();
        System.err.println("[transcode] start " + j.id + " hw=" + hw
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
        if (isWindows()) return;
        try {
            Process p = new ProcessBuilder("pkill", "-f", "cache/transcode/seg-").start();
            p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS);
            System.err.println("[transcode] stale transcode processes cleaned");
        } catch (Exception e) {
            System.err.println("[transcode] cleanup stale failed: " + e);
        }
    }

    /** 删掉半成品分片与清单（硬解失败重试前清干净）。 */
    private static void cleanSegments(String id) {
        try (java.util.stream.Stream<Path> st = Files.list(dirOf(id))) {
            st.filter(p -> {
                String n = p.getFileName().toString();
                return n.startsWith("seg-") || "index.m3u8".equals(n) || DONE_FILE.equals(n);
            }).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
    }

    /** 硬编码率分档（按**输出**高度；硬解路径最高出 1080p）。 */
    private static String hwBitrate(int h) {
        if (h > 900) return "5M";
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
    private static void addHttpInputOptions(List<String> cmd, String source) {
        if (!(source.startsWith("http://") || source.startsWith("https://"))) return;
        cmd.add("-rw_timeout"); cmd.add("15000000");
        cmd.add("-reconnect"); cmd.add("1");
        cmd.add("-reconnect_streamed"); cmd.add("1");
        cmd.add("-reconnect_delay_max"); cmd.add("5");
    }

    private static List<String> hlsCommand(String ff, String id, String source, Probe p, boolean hw) {
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
            // 网络读 15 秒不返回就让 ffmpeg 自己报错退出（见 addHttpInputOptions）
            cmd.add("-rw_timeout"); cmd.add("15000000");
            cmd.add("-reconnect"); cmd.add("1");
            cmd.add("-reconnect_streamed"); cmd.add("1");
            cmd.add("-reconnect_delay_max"); cmd.add("5");
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
             * ★ 强制按 SEG_SECONDS 插关键帧（2026-11-17 实测踩过）：
             * -hls_time 只是「最小片长」，实际切点看源关键帧。这批 mkv 的 GOP
             * 7.5 秒 → 首片要转 7.46 秒内容（4K 10bit 软解 ~200 秒），必然超过
             * 前端 180 秒超时 → "第一集永远播不了"。加 force_key_frames 后
             * 首片真的只有 2 秒内容。
             */
            cmd.add("-force_key_frames");
            cmd.add("expr:gte(t,n_forced*" + SEG_SECONDS + ")");
            // 4K 源降到 1080p：H.264 编 4K 慢 4 倍，而浏览器端肉眼收益很小
            cmd.add("-vf"); cmd.add("scale='min(1920,iw)':-2");
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
        cmd.add(playlistOf(id).toString());
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
                } else if (System.currentTimeMillis() - lastProgress > HANG_NO_SEGMENT_MS) {
                    try {
                        proc.destroyForcibly();
                    } catch (Exception ignored) {
                    }
                    j.state = "failed";
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
            double gotDur = j.segments * (double) SEG_SECONDS;
            if (srcDur > 30 && gotDur < srcDur - 15) {
                j.state = "failed";
                j.error = "转码中断：只产出 " + (int) gotDur + " 秒（源 " + (int) srcDur + " 秒）";
                System.err.println("[transcode] job " + j.id + " short output "
                        + (int) gotDur + "s of " + (int) srcDur + "s -> failed");
                return;
            }
            markDone(j.id);
            j.state = "ready";
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
        j.error = tailText.isEmpty() ? ("ffmpeg 退出码 " + code)
                : tailText.substring(Math.max(0, tailText.length() - 300));
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
        j.segments = countSegments(id);
        j.readySeconds = j.segments * SEG_SECONDS;
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
        j.state = "canceled";
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
                && !"failed".equals(j.state)
                && !"cancelled".equals(j.state);
        double dur = durationOf(j.id);
        if (dur <= 0 && j.probeSnap != null) dur = j.probeSnap.duration;
        o.put("duration", (long) Math.round(dur));
        o.put("segments", hasPlaylist ? j.segments : 0);
        o.put("readySeconds", hasPlaylist ? j.readySeconds : 0);
        if (hasPlaylist && ("ready".equals(j.state) || j.segments > 0)) {
            o.put("playlist", "/api/transcode/" + j.id + "/index.m3u8");
        }
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
