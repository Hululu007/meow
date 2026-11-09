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

    private Jars() {
    }

    /**
     * 重新读配置、准备并挂载所有外部 jar。
     *
     * <p>调用点两处：启动（{@code initAfterArgs}）与配置导入成功后。
     * 导入换了 jar 地址却不重新准备的话，用户看到的是"导入成功但站点还是老实现"。
     */
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
            addSpec(out, cfg.optString("spider", ""));
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
        if (!part.renameTo(dst)) {
            // Windows 上目标被占用时 renameTo 会失败，退回覆盖拷贝
            copy(part, dst);
            //noinspection ResultOfMethodCallIgnored
            part.delete();
        }
        verify(dst, md5);
        return dst;
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
    private static boolean isJvm() {
        try {
            Class.forName("jvm.JvmHttpServer");
            return true;
        } catch (Throwable e) {
            return false;
        }
    }
}
