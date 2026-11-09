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
    private static final int SEG_SECONDS = 4;

    private static final Map<String, Job> JOBS = new ConcurrentHashMap<>();

    public static final class Job {
        public String id = "";
        public String source = "";
        public String state = "idle"; // idle|running|ready|failed|canceled
        public String error = "";
        public long startedAt = System.currentTimeMillis();
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

    private static Path dirOf(String id) {
        return DataPaths.dir(ROOT + "/" + id);
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
        Job found = JOBS.get(id);
        if (found != null && ("running".equals(found.state) || "ready".equals(found.state))) return found;
        final Job j;
        if (found == null) {
            j = new Job();
            j.id = id;
            j.source = sourceUrl;
            JOBS.put(id, j);
        } else {
            j = found;
        }
        // 已经转完的直接复用（产物在磁盘上）
        if (Files.isRegularFile(playlistOf(id)) && !forceVideo) {
            j.state = "ready";
            return j;
        }
        if ("running".equals(j.state)) return j;

        String ff = ffmpegPath();
        if (ff.isEmpty()) {
            j.state = "failed";
            j.error = "找不到 ffmpeg。装一个（或在 policy.json 里配 ffmpegPath）才能播这个格式。";
            return j;
        }

        List<String> cmd = new ArrayList<>();
        cmd.add(ff);
        cmd.add("-hide_banner");
        cmd.add("-loglevel"); cmd.add("error");
        cmd.add("-y");
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
        Job found = JOBS.get(id);
        if (found != null && ("running".equals(found.state) || "ready".equals(found.state))) return found;
        final Job j;
        if (found == null) {
            j = new Job();
            j.id = id;
            j.source = source;
            JOBS.put(id, j);
        } else {
            j = found;
        }
        if (Files.isRegularFile(playlistOf(id))) {
            j.state = "ready";
            return j;
        }
        if ("running".equals(j.state)) return j;

        String ff = ffmpegPath();
        if (ff.isEmpty()) {
            j.state = "failed";
            j.error = "找不到 ffmpeg。装一个（或在 policy.json 里配 ffmpegPath）才能播这个格式。";
            return j;
        }
        List<String> cmd = hlsCommand(ff, id, source);
        try {
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
    private static List<String> hlsCommand(String ff, String id, String source) {
        List<String> cmd = new ArrayList<>();
        cmd.add(ff);
        cmd.add("-hide_banner");
        cmd.add("-loglevel"); cmd.add("error");
        cmd.add("-y");
        cmd.add("-i"); cmd.add(source);
        // 视频统一降到 H.264：那是所有浏览器都有的解码器。
        // veryfast 实测 6.7 倍速；更快的 ultrafast 画质掉得明显，不值得。
        cmd.add("-c:v"); cmd.add("libx264");
        cmd.add("-preset"); cmd.add("veryfast");
        cmd.add("-crf"); cmd.add("23");
        // 4K 源降到 1080p：H.264 编 4K 慢 4 倍，而浏览器端肉眼收益很小
        cmd.add("-vf"); cmd.add("scale='min(1920,iw)':-2");
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
        return cmd;
    }

    /** 读 ffmpeg 输出（防管道写满阻塞），并在结束时判定结果。 */
    private static void pump(Job j) {
        StringBuilder tail = new StringBuilder();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(j.proc.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                tail.append(line).append('\n');
                if (tail.length() > 4000) tail.delete(0, tail.length() - 4000);
            }
        } catch (Exception ignored) {
        }
        try {
            j.proc.waitFor(5, TimeUnit.SECONDS);
        } catch (Exception ignored) {
        }
        int code = j.proc.exitValue();
        if (code == 0 || Files.isRegularFile(playlistOf(j.id))) {
            j.state = "ready";
        } else {
            j.state = "failed";
            String t = tail.toString().trim();
            j.error = t.isEmpty() ? ("ffmpeg 退出码 " + code) : t.substring(Math.max(0, t.length() - 300));
        }
    }

    public static Job status(String id) {
        Job j = JOBS.get(id);
        if (j == null) {
            if (Files.isRegularFile(playlistOf(id))) {
                Job s = new Job();
                s.id = id;
                s.state = "ready";
                s.segments = countSegments(id);
                s.readySeconds = s.segments * SEG_SECONDS;
                return s;
            }
            return null;
        }
        // 转码是增量的：清单里已有几个分片就能播几秒
        j.segments = countSegments(id);
        j.readySeconds = j.segments * SEG_SECONDS;
        if ("running".equals(j.state) && j.segments > 0 && j.segments >= 3) {
            // 前 3 个分片出来就够起播了；任务继续在后台转完
            j.state = "ready";
        }
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
        o.put("segments", j.segments);
        o.put("readySeconds", j.readySeconds);
        if ("ready".equals(j.state) || j.segments > 0) {
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
