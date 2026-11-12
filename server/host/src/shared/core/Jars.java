package core;

import org.json.JSONArray;
import org.json.JSONObject;
import platform.Bridge;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLClassLoader;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * 外部 spider jar 加载器（CatVod 生态），**仅 JVM 生效**。
 *
 * <p><b>为什么需要它</b>：JVM 端原来只会 {@code Class.forName}（类路径），
 * 配置里写的 {@code jar} / {@code spider} 一律被忽略——表现是"配了外部 jar
 * 但调用直接 ClassNotFoundException"，而且不报错、只是那个站永远空。
 * TV 端早就有这套（{@code LocalSpiderHost} + DexClassLoader），JVM 是缺的。
 *
 * <p><b>为什么不用 DexClassLoader 的那套</b>：JVM 能直接加载 {@code .class} jar，
 * 不需要 dex；两端各自实现反而简单——这里只管 class 形态，dex 归 TV。
 *
 * <p><b>加载顺序</b>：先类路径（内置混淆 jar），找不到再走外部 jar。
 * 理由：内置 jar 是主力，外部 jar 只补"社区源码编译的 spider"，两者类名不重叠；
 * 顺序反了会让外部 jar 有机会顶掉内置类，排查起来非常难。
 *
 * <p><b>只认显式配置</b>：不做目录扫描、不自动发现。来源只有两个：
 * 配置顶层的 {@code spider} 与站点级 {@code jar}，与 CatVod 的写法一致。
 */
public final class Jars {

    /** 已就绪的 loader，按配置出现顺序尝试 */
    private static final List<URLClassLoader> LOADERS = new ArrayList<>();
    private static volatile boolean hookInstalled;

    /**
     * git 加速候选（前端「网络与加速」里配置的代理前缀）。
     *
     * <p><b>为什么 jar 也要走加速</b>：配置里的 {@code spider} 常常指向
     * {@code raw.githubusercontent.com}。配置 JSON 抓取有加速（见 ApiServer
     * 的 fetchTextAccel），但 jar 下载原来是一根裸 HttpURLConnection ——
     * 国内/电视上配置能拉下来、jar 却永远超时，表现是"导入成功但站点全空"。
     *
     * <p>候选由前端在导入请求里带过来（只在用户启用对应开关时非空），
     * 导入时落盘到数据目录，这样**下次启动**重新下载缓存也不会退化。
     * 文件格式：JSON 字符串数组，最多 8 个 https 前缀。
     */
    private static volatile List<String> ACCEL;
    private static final String ACCEL_FILE = "git-accel.json";

    private Jars() {
    }

    /**
     * 重新读配置、准备并挂载所有外部 jar。
     *
     * <p>调用点两处：启动（{@code initAfterArgs}）与配置导入成功后。
     * 导入换了 jar 地址却不重新准备的话，用户看到的是"导入成功但站点还是老实现"。
     */
    /**
     * 记录 git 加速候选（导入请求里带过来），并落盘供下次启动复用。
     *
     * <p>只接受 https、最多 8 个；传空数组 = 用户关了加速，清掉旧文件。
     * 由 ApiServer 在**请求体确实带 proxies 字段**时调用 —— 老客户端不带这个
     * 字段，不能当成"用户关掉了加速"。
     */
    public static synchronized void setAccelProxies(List<String> proxies) {
        List<String> clean = new ArrayList<>();
        if (proxies != null) {
            for (String raw : proxies) {
                if (raw == null) continue;
                String v = raw.trim();
                if (isUsablePrefix(v) && !clean.contains(v) && clean.size() < 8) clean.add(v);
            }
        }
        ACCEL = clean;
        try {
            core.DataPaths.write(ACCEL_FILE, new JSONArray(clean).toString());
        } catch (Throwable t) {
            LogBuffer.warn("jar", "保存加速配置失败：" + t);
        }
        if (!clean.isEmpty()) LogBuffer.info("jar", "加速候选：" + clean.size() + " 个");
    }

    private static boolean isUsablePrefix(String s) {
        return s != null && s.startsWith("https://") && s.indexOf(' ') < 0 && s.length() <= 512;
    }

    private static List<String> accel() {
        List<String> a = ACCEL;
        if (a != null) return a;
        synchronized (Jars.class) {
            if (ACCEL != null) return ACCEL;
            List<String> out = new ArrayList<>();
            try {
                String raw = core.DataPaths.read(ACCEL_FILE);
                if (raw != null && !raw.trim().isEmpty()) {
                    JSONArray arr = new JSONArray(raw);
                    for (int i = 0; i < arr.length() && out.size() < 8; i++) {
                        String v = arr.optString(i, "").trim();
                        if (isUsablePrefix(v) && !out.contains(v)) out.add(v);
                    }
                }
            } catch (Throwable ignored) {
                /* 坏文件按"没有加速"处理，不影响导入 */
            }
            ACCEL = out;
            return out;
        }
    }

    /**
     * 下载候选：直连 + 已配置的加速前缀（给 TV 端 {@code LocalSpiderHost} 复用）。
     *
     * <p>TV 本机执行不经过 {@link #reload()}（它走 DexClassLoader），但配置导入
     * 是由同一个 ApiServer 处理的 —— 加速配置已经落盘，这里只是把候选算出来。
     */
    public static List<String> jarCandidates(String url) {
        List<String> out = new ArrayList<>();
        if (url == null || url.trim().isEmpty()) return out;
        out.add(url);
        if (isGithubHost(url)) {
            for (String p : accel()) {
                String u = withPrefix(p, url);
                if (u != null && !out.contains(u)) out.add(u);
            }
        }
        return out;
    }

    /** jar 地址是否属于 GitHub 公开下载口（与 ApiServer 的配置加速判定一致）。 */
    private static boolean isGithubHost(String url) {
        try {
            String host = new URL(url).getHost();
            if (host == null) return false;
            host = host.toLowerCase();
            if ("raw.githubusercontent.com".equals(host)
                    || "gist.githubusercontent.com".equals(host)) return true;
            if ("github.com".equals(host)) {
                return url.contains("/releases/download/") || url.contains("/releases/latest/download/");
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    /** 前缀 + 原始地址（支持 {url} 占位），与前端 gitAccel 的约定一致。 */
    private static String withPrefix(String prefix, String url) {
        String p = prefix == null ? "" : prefix.trim();
        if (!isUsablePrefix(p)) return null;
        if (p.contains("{url}")) return p.replace("{url}", url);
        return p.endsWith("/") ? p + url : p + "/" + url;
    }

    public static synchronized void reload() {
        if (!isJvm()) return;   // Android 走 LocalSpiderHost 的 DexClassLoader，别插手
        closeAll();
        for (String spec : collect()) {
            try {
                File f = prepare(spec);
                if (f == null) continue;
                LOADERS.add(new URLClassLoader(new URL[]{f.toURI().toURL()}, Jars.class.getClassLoader()));
                LogBuffer.info("jar", "已挂载 " + f.getName() + "（" + f.length() + "B）");
            } catch (Throwable t) {
                LogBuffer.warn("jar", "准备失败 " + shortSpec(spec) + " → " + t);
            }
        }
        installHook();
    }

    /**
     * 把 jar 内 {@code Proxy} 的探测端口固定成本进程真实端口。
     *
     * <p>混淆 jar 的 {@code Proxy.a()} 只会扫 9978–9999（见 {@code javap -c}），
     * 而 fnOS 微应用把 Java 起在 30011（PC 插件也可能顺延到 9982+ 之外），
     * 于是 Bili/Hxq 的 play 返回 {@code http://127.0.0.1:-1/proxy?...}，播放必坏。
     * 直接在类加载后写私有静态字段 {@code a}，让 {@code getPort()} 跳过扫描。
     */
    public static void pinProxyPort(int port) {
        if (!isJvm() || port <= 0) return;
        try {
            Class<?> c;
            try {
                c = Class.forName("com.github.catvod.spider.Proxy");
            } catch (ClassNotFoundException e) {
                c = load("com.github.catvod.spider.Proxy");
            }
            if (c == null) return;
            java.lang.reflect.Field f = c.getDeclaredField("a");
            f.setAccessible(true);
            f.setInt(null, port);
            LogBuffer.info("jar", "Proxy 端口固定为 " + port);
        } catch (Throwable t) {
            LogBuffer.warn("jar", "Proxy 端口固定失败：" + t);
        }
    }

    /** 在已挂载的外部 jar 里找类；找不到返回 null（调用方决定抛什么）。 */
    public static Class<?> load(String fqcn) {
        if (fqcn == null || LOADERS.isEmpty()) return null;
        for (URLClassLoader l : LOADERS) {
            try {
                return l.loadClass(fqcn);
            } catch (Throwable ignored) {
                // 这个 jar 里没有，试下一个
            }
        }
        return null;
    }

    // ---------------------------------------------------------------- 内部

    /**
     * 挂载 {@link Bridge} 的类加载钩子。
     *
     * <p>★ 用 "if absent"：TV 端在 {@code GatewayServer} 里会装自己的 DexClassLoader
     * 钩子，谁先装谁生效。JVM 从来没装过，所以这里必然能装上；Android 上这行是空操作。
     */
    private static void installHook() {
        if (hookInstalled) return;
        hookInstalled = true;
        Bridge.installClassLoaderIfAbsent(fqcn -> {
            try {
                return Class.forName(fqcn);
            } catch (ClassNotFoundException e) {
                Class<?> c = load(fqcn);
                if (c != null) return c;
                throw e;
            }
        });
    }

    /** 配置里的 jar 规格：顶层 spider + 各站点 jar，去重。 */
    private static LinkedHashSet<String> collect() {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        try {
            String txt = DataPaths.read("config.sites.json");
            if (txt == null || txt.trim().isEmpty()) return out;
            JSONObject cfg = new JSONObject(txt);
            /*
             * 自定义字段 spiderJvm：统一配置里顶层 spider 必须是 **dex jar**（Fongmi/
             * Android 会用 DexClassLoader 加载它），JVM 不能读 dex。JVM 侧优先读
             * spiderJvm 指向的 class jar；没有这个字段才回退到 spider。
             * Fongmi 会忽略未知字段，因此同一份 config 可以同时给 Android 和 JVM。
             */
            String jvmSpider = cfg.optString("spiderJvm", "").trim();
            if (jvmSpider.isEmpty()) jvmSpider = cfg.optString("spider", "");
            addSpec(out, jvmSpider);
            JSONArray sites = cfg.optJSONArray("sites");
            if (sites != null) {
                for (int i = 0; i < sites.length(); i++) {
                    JSONObject s = sites.optJSONObject(i);
                    if (s != null) addSpec(out, s.optString("jar", ""));
                }
            }
        } catch (Throwable t) {
            LogBuffer.warn("jar", "读配置失败：" + t);
        }
        return out;
    }

    private static void addSpec(LinkedHashSet<String> out, String spec) {
        String s = spec == null ? "" : spec.trim();
        if (s.isEmpty()) return;
        // 内置 jar 的两种写法（我们自己导出时就是 ./spider-latest.jar）→ 跳过，
        // 它在类路径上，不需要也不能再下载一份
        String bare = s.toLowerCase();
        if (bare.contains("spider-latest.jar") || bare.contains("spider-complete")) return;
        if (bare.startsWith("http://") || bare.startsWith("https://")
                || bare.startsWith("file:") || bare.startsWith("/") || bare.matches("^[a-zA-Z]:[\\\\/].*")) {
            out.add(s);
        } else {
            // 相对路径（./jar/x.jar）在 JVM 上没有基准 URL 可解析；静默跳过会让人
            // 以为"配了没生效"，这里留一条日志
            LogBuffer.info("jar", "跳过相对路径 jar（JVM 只认 http/file/绝对路径）：" + s);
        }
    }

    /**
     * 供导入期预处理器使用：下载/校验一条 jar 规格，返回本地文件。
     * 不改变加载器状态。
     */
    public static File prepareForImport(String spec) throws Exception {
        return prepare(spec);
    }

    /**
     * 把一条规格变成本地可用的 jar 文件。
     *
     * <p>规格形如 {@code https://host/x.jar;md5;<32位>}，md5 段可省。
     * 缓存命中且 md5 一致就直接复用（避免每次启动重下 1MB+）。
     */
    private static File prepare(String spec) throws Exception {
        String url = spec;
        String md5 = "";
        int i = spec.toLowerCase().indexOf(";md5;");
        if (i > 0) {
            url = spec.substring(0, i).trim();
            md5 = spec.substring(i + 5).trim();
        }

        if (url.startsWith("file:") || !url.toLowerCase().startsWith("http")) {
            File f = url.startsWith("file:") ? new File(java.net.URI.create(url).getPath()) : new File(url);
            if (!f.isFile()) throw new Exception("本地 jar 不存在：" + f);
            verify(f, md5);
            return f;
        }

        File dir = DataPaths.dir("jars") != null ? DataPaths.dir("jars").toFile() : DataPaths.file("jars").getParentFile();
        if (dir == null) throw new Exception("无法创建 jars 目录");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建 jars 目录：" + dir);
        File dst = new File(dir, fileNameOf(url));

        if (dst.isFile() && (md5.isEmpty() || md5.equalsIgnoreCase(md5Of(dst)))) return dst;

        File part = new File(dst.getAbsolutePath() + ".part");
        /*
         * 候选顺序：直连 → 加速前缀。
         * 命中加速时每个候选都重新校验 md5：代理返回错误页/旧包时必须换下一个，
         * 原来"一次下载 + 最后一次校验"的写法会把可用候选挡在门外。
         */
        List<String> cands = new ArrayList<>();
        cands.add(url);
        if (isGithubHost(url)) {
            for (String p : accel()) {
                String u = withPrefix(p, url);
                if (u != null && !cands.contains(u)) cands.add(u);
            }
        }
        Exception last = null;
        boolean ok = false;
        for (String u : cands) {
            try {
                downloadTo(part, u);
                verify(part, md5);
                if (!u.equals(url)) LogBuffer.info("jar", "加速命中：" + u);
                ok = true;
                break;
            } catch (Exception e) {
                last = e;
                //noinspection ResultOfMethodCallIgnored
                part.delete();
            }
        }
        if (!ok) {
            if (last != null) throw last;
            throw new Exception("下载失败");
        }
        if (!part.renameTo(dst)) {
            // Windows 上目标被占用时 renameTo 会失败，退回覆盖拷贝
            copy(part, dst);
            //noinspection ResultOfMethodCallIgnored
            part.delete();
        }
        verify(dst, md5);
        return dst;
    }

    /** 下载一个候选到 .part；HTTP 错误、超限、HTML 错误页都抛异常。 */
    private static void downloadTo(File part, String url) throws Exception {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8_000);
            c.setReadTimeout(20_000);
            c.setRequestProperty("User-Agent", "meow-spider-jar/1");
            int code = c.getResponseCode();
            if (code != 200) throw new Exception("HTTP " + code);
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[65536];
                int n;
                long total = 0;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    // 防呆：正常 spider jar 几十 KB~几 MB，超过 64MB 一定是下错东西了
                    if (total > 64L * 1024 * 1024) throw new Exception("jar 超过 64MB，已放弃");
                    out.write(buf, 0, n);
                }
            }
        } finally {
            if (c != null) c.disconnect();
        }
        // 加速节点失败时常用 200 返回 HTML 错误页；不拦会被当 jar 缓存下来，
        // 之后 URLClassLoader 报 "zip END header not found"，排查方向全错。
        if (looksLikeHtml(part)) throw new Exception("返回的是 HTML（加速节点错误页）");
    }

    private static boolean looksLikeHtml(File f) {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] head = new byte[64];
            int n = in.read(head);
            for (int i = 0; i < n; i++) {
                byte b = head[i];
                if (b == ' ' || b == '\n' || b == '\r' || b == '\t') continue;
                return b == '<';
            }
        } catch (Exception ignored) {
            /* 读不了交给 md5/加载阶段报错 */
        }
        return false;
    }

    private static void verify(File f, String md5) throws Exception {
        if (md5 != null && !md5.isEmpty()) {
            String got = md5Of(f);
            if (!got.equalsIgnoreCase(md5)) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
                throw new Exception("md5 不匹配：期望 " + md5 + "，实际 " + got);
            }
        }
    }

    /** 文件名 = URL 末段 + URL 哈希前缀，避免不同站点的同名 jar 互相覆盖。 */
    private static String fileNameOf(String url) {
        String base = url;
        int q = base.indexOf('?');
        if (q > 0) base = base.substring(0, q);
        int slash = base.lastIndexOf('/');
        String name = slash >= 0 ? base.substring(slash + 1) : base;
        if (name.isEmpty() || !name.endsWith(".jar")) name = "spider.jar";
        return Integer.toHexString(url.hashCode()) + "-" + name;
    }

    private static String md5Of(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("MD5");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static void copy(File src, File dst) throws Exception {
        try (InputStream in = new FileInputStream(src); FileOutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        }
    }

    private static void closeAll() {
        for (URLClassLoader l : LOADERS) {
            try {
                l.close();
            } catch (Throwable ignored) {
            }
        }
        LOADERS.clear();
    }

    private static String shortSpec(String spec) {
        return spec.length() > 80 ? spec.substring(0, 80) + "…" : spec;
    }

    /**
     * 是否 JVM 宿主。
     *
     * <p>判据用 {@code jvm.JvmHttpServer}：TV 的 gradle 只挂 {@code shared/}，
     * 这个类根本没编进 APK；同理 Android 的 {@code com.meow.tv.SocketHttpServer}
     * 在 JVM 上不存在。比"看 Build.VERSION"可靠——我们在 JVM 上也提供 android 桩。
     */
    public static boolean isJvm() {
        try {
            Class.forName("jvm.JvmHttpServer");
            return true;
        } catch (Throwable e) {
            return false;
        }
    }
}
