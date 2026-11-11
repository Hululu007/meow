package core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * JVM 导入时的 dex → class jar 预处理器（实验）。
 *
 * <p>CatVod 生态里很多 jar 只有 {@code classes.dex}，JVM 的 URLClassLoader
 * 读不了。这里在**导入配置时**把 dex 转成 class jar，写回本地配置的
 * {@code spiderJvm} / 站点 {@code jar}，之后 Jars 正常加载。
 *
 * <p>只在 JVM 生效：Android 端继续用 DexClassLoader，不转换。
 *
 * <p>转换器通过 {@code MEOW_DEX2JAR} 指定（dex2jar 的 d2j-dex2jar.sh）。
 * 转换失败、含 native .so、或转换后没有 spider 类时，保留原配置并返回原因；
 * 不阻断其它非 jar 站点的导入。
 */
public final class Dex2Jvm {

    private static final long CONVERT_TIMEOUT_SEC = 90;
    private static final String SPIDER_CLASS_PREFIX = "com/github/catvod/spider/";

    private Dex2Jvm() {
    }

    /**
     * 改写配置里的 dex jar 为本地 class jar。
     *
     * @return 统计信息，供 /api/config/import 响应展示
     */
    public static JSONObject rewrite(JSONObject doc, String configBase) throws Exception {
        JSONObject out = new JSONObject();
        File tool = resolveTool();
        out.put("enabled", Jars.isJvm() && tool != null);
        if (!Jars.isJvm()) {
            out.put("skipped", "android-runtime");
            return out;
        }
        if (tool == null) {
            out.put("skipped", "dex2jar not found (tools/dex2jar or MEOW_DEX2JAR)");
            return out;
        }

        Map<String, Converted> seen = new LinkedHashMap<>();
        String toolTag = toolTag(tool);
        int converted = 0, alreadyJvm = 0, nativeJar = 0, failed = 0, noDex = 0;
        String lastError = "";

        // 顶层 spider：只有没有 spiderJvm 时才尝试转换
        if (doc.optString("spiderJvm", "").trim().isEmpty()) {
            String spider = doc.optString("spider", "").trim();
            if (!spider.isEmpty()) {
                Converted c = convertCached(spider, configBase, tool, toolTag, seen);
                switch (c.kind) {
                    case CONVERTED:
                        doc.put("spiderJvm", c.fileUri);
                        converted++;
                        break;
                    case ALREADY_JVM:
                        alreadyJvm++;
                        break;
                    case NATIVE:
                        nativeJar++;
                        break;
                    case NO_DEX:
                        noDex++;
                        break;
                    default:
                        failed++;
                        if (!c.reason.isEmpty()) lastError = c.reason;
                        break;
                }
            }
        }

        JSONArray sites = doc.optJSONArray("sites");
        if (sites != null) {
            for (int i = 0; i < sites.length(); i++) {
                JSONObject site = sites.optJSONObject(i);
                if (site == null) continue;
                String jar = site.optString("jar", "").trim();
                if (jar.isEmpty()) continue;
                Converted c = convertCached(jar, configBase, tool, toolTag, seen);
                switch (c.kind) {
                    case CONVERTED:
                        site.put("jar", c.fileUri);
                        converted++;
                        break;
                    case ALREADY_JVM:
                        alreadyJvm++;
                        break;
                    case NATIVE:
                        nativeJar++;
                        break;
                    case NO_DEX:
                        noDex++;
                        break;
                    default:
                        failed++;
                        if (!c.reason.isEmpty()) lastError = c.reason;
                        break;
                }
                if (c.kind == Kind.FAILED && !c.reason.isEmpty()) {
                    site.put("_dex2jvm", c.reason);
                }
            }
        }

        out.put("converted", converted);
        out.put("alreadyJvm", alreadyJvm);
        out.put("native", nativeJar);
        out.put("noDex", noDex);
        out.put("failed", failed);
        if (!lastError.isEmpty()) out.put("lastError", lastError);
        if (seen.size() > 0) {
            out.put("jars", seen.size());
        }
        LogBuffer.info("dex2jvm", out.toString());
        return out;
    }

    private static Converted convertCached(String spec, String configBase, File tool,
                                           String toolTag, Map<String, Converted> seen) {
        String resolved = resolve(spec, configBase);
        Converted hit = seen.get(resolved);
        if (hit != null) return hit;
        Converted c = convert(resolved, tool, toolTag);
        seen.put(resolved, c);
        return c;
    }

    private static Converted convert(String spec, File tool, String toolTag) {
        try {
            File src = Jars.prepareForImport(spec);
            if (src == null || !src.isFile()) {
                return Converted.failed("jar download failed");
            }
            JarInfo info = inspect(src);
            // 只看 spider 包里的 class：有些 dex jar 会顺带塞几个无关 .class，
            // 按"有任意 class"判成 JVM 会直接跳过转换。
            if (info.hasSpiderClass) return Converted.alreadyJvm();
            if (info.hasNative) return Converted.nativeJar();
            if (!info.hasDex) return Converted.noDex();

            String sha = sha256(src);
            File dir = DataPaths.dir("jars/converted").toFile();
            if (!dir.exists() && !dir.mkdirs()) {
                return Converted.failed("cannot create converted dir");
            }
            // 缓存键带上转换器版本：升级 dex2jar 后不会误用旧转换结果。
            File out = new File(dir, sha + "-" + toolTag + "-jvm.jar");
            File cached = validCache(out);
            if (cached == null) cached = findAltCache(dir, out.getName());
            if (cached != null) return Converted.converted(cached.toURI().toString());

            // 缓存损坏：能删就原地重建；删不掉（Windows 上旧 jar 还被
            // URLClassLoader 打开）就写一份带代数后缀的新文件，下次直接命中，
            // 避免"缓存一坏这个源就永久失败"。
            File target = out;
            if (out.exists() && !out.delete()) {
                target = new File(dir, out.getName() + "." + System.nanoTime() + ".jar");
            }
            File tmp = Files.createTempFile(dir.toPath(), out.getName() + ".", ".part").toFile();
            try {
                ProcessResult pr = run(tool, src, tmp);
                if (!pr.ok || !tmp.isFile() || tmp.length() == 0) {
                    return Converted.failed("dex2jar: " + pr.message());
                }
                try {
                    Files.move(tmp.toPath(), target.toPath(),
                            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                            java.nio.file.StandardCopyOption.ATOMIC_MOVE);
                } catch (Exception e) {
                    return Converted.failed("move converted jar: " + e.getMessage());
                }
            } finally {
                tmp.delete();
            }
            String err = validate(target);
            if (err != null) {
                target.delete();
                return Converted.failed(err);
            }
            return Converted.converted(target.toURI().toString());
        } catch (Throwable t) {
            return Converted.failed(t.getClass().getSimpleName() + ": " + t.getMessage());
        }
    }

    private static File validCache(File f) {
        if (!f.isFile() || f.length() == 0) return null;
        return validate(f) == null ? f : null;
    }

    /** 找同一源在缓存文件被占用时写下的代数副本（base + "." + nano + ".jar"）。 */
    private static File findAltCache(File dir, String base) {
        File[] fs = dir.listFiles((d, n) ->
                n.startsWith(base + ".") && n.endsWith(".jar"));
        if (fs == null) return null;
        for (File f : fs) {
            if (validCache(f) != null) return f;
            f.delete();
        }
        return null;
    }

    private static String validate(File jar) {
        try (ZipFile z = new ZipFile(jar)) {
            boolean found = false;
            var en = z.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                String n = e.getName();
                if (n.startsWith(SPIDER_CLASS_PREFIX) && n.endsWith(".class")) {
                    found = true;
                    break;
                }
            }
            if (!found) return "converted jar has no com.github.catvod.spider classes";
        } catch (Throwable t) {
            return "converted jar unreadable: " + t.getMessage();
        }
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{jar.toURI().toURL()}, Dex2Jvm.class.getClassLoader())) {
            // 只做类加载验证，不执行 init/home（可能联网/有副作用）
            cl.loadClass("com.github.catvod.spider.Proxy");
            return null;
        } catch (Throwable t) {
            // Proxy 不是每个 jar 都有；有其它 spider 类也算通过
            try (ZipFile z = new ZipFile(jar)) {
                var en = z.entries();
                while (en.hasMoreElements()) {
                    String n = en.nextElement().getName();
                    if (n.startsWith(SPIDER_CLASS_PREFIX) && n.endsWith(".class")) {
                        return null;
                    }
                }
            } catch (Throwable ignored) {
            }
            return "classload failed: " + t.getClass().getSimpleName();
        }
    }

    private static JarInfo inspect(File file) throws IOException {
        JarInfo info = new JarInfo();
        try (ZipFile z = new ZipFile(file)) {
            var en = z.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                String n = e.getName();
                if (n.startsWith(SPIDER_CLASS_PREFIX) && n.endsWith(".class")) {
                    info.hasSpiderClass = true;
                }
                if (n.startsWith("classes") && n.endsWith(".dex")) info.hasDex = true;
                if (n.endsWith(".so")) info.hasNative = true;
            }
        }
        return info;
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (var in = Files.newInputStream(f.toPath())) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    private static ProcessResult run(File tool, File src, File out) {
        List<String> cmd = new ArrayList<>();
        if (tool.isDirectory()) {
            // 插件/fpk/Docker 里带的是 dex2jar 的 lib 目录，不依赖宿主装 java：
            // 用当前 JVM 的 java 直接跑 Dex2jarCmd。
            cmd.add(javaExe());
            cmd.add("-Xmx512m");
            cmd.add("-cp");
            cmd.add(new File(new File(tool, "lib"), "*").getAbsolutePath());
            cmd.add("com.googlecode.dex2jar.tools.Dex2jarCmd");
        } else if (tool.getName().toLowerCase().endsWith(".jar")) {
            cmd.add(javaExe());
            cmd.add("-Xmx512m");
            cmd.add("-cp");
            cmd.add(tool.getAbsolutePath());
            cmd.add("com.googlecode.dex2jar.tools.Dex2jarCmd");
        } else {
            if (tool.getName().toLowerCase().endsWith(".bat")) {
                cmd.add("cmd");
                cmd.add("/c");
            }
            cmd.add(tool.getAbsolutePath());
        }
        cmd.add("-f");
        cmd.add("-o");
        cmd.add(out.getAbsolutePath());
        cmd.add(src.getAbsolutePath());
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        Process p = null;
        try {
            p = pb.start();
            StringBuilder log = new StringBuilder();
            // 必须边读边等：先读满 stdout 再 waitFor 会被卡住的子进程永久阻塞，
            // 超时永远不生效。读线程是 daemon，超时强杀后也不会挂住 JVM。
            Process proc = p;
            Thread reader = new Thread(() -> {
                try (var r = new java.io.BufferedReader(new java.io.InputStreamReader(
                        proc.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        synchronized (log) {
                            if (log.length() < 2000) log.append(line).append('\n');
                        }
                    }
                } catch (Throwable ignored) {
                }
            }, "dex2jar-log");
            reader.setDaemon(true);
            reader.start();
            if (!p.waitFor(CONVERT_TIMEOUT_SEC, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                p.waitFor(5, TimeUnit.SECONDS);
                reader.join(1000);
                return new ProcessResult(false, "timeout");
            }
            reader.join(2000);
            String text;
            synchronized (log) { text = log.toString(); }
            if (p.exitValue() != 0) {
                return new ProcessResult(false, "exit=" + p.exitValue() + " " + text);
            }
            return new ProcessResult(true, text);
        } catch (Throwable t) {
            if (p != null) p.destroyForcibly();
            return new ProcessResult(false, t.getClass().getSimpleName() + ": " + t.getMessage());
        }
    }

    private static String javaExe() {
        try {
            String home = System.getProperty("java.home", "");
            File f = new File(home, "bin/java" + (System.getProperty("os.name", "")
                    .toLowerCase().contains("win") ? ".exe" : ""));
            if (f.isFile()) return f.getAbsolutePath();
        } catch (Throwable ignored) {
        }
        return "java";
    }

    private static String resolve(String spec, String base) {
        String s = spec == null ? "" : spec.trim();
        if (s.isEmpty()) return s;
        // 保留 ;md5; 校验段，只解析前半段
        String url = s;
        int md5 = url.toLowerCase().indexOf(";md5;");
        String suffix = "";
        if (md5 > 0) {
            suffix = url.substring(md5);
            url = url.substring(0, md5);
        }
        try {
            URI u = URI.create(url);
            if (u.isAbsolute()) return url + suffix;
            if (base != null && !base.trim().isEmpty()) {
                return URI.create(base).resolve(url).toString() + suffix;
            }
        } catch (Throwable ignored) {
        }
        return s;
    }

    /**
     * 找转换器：环境变量优先，其次插件/fpk 的工作目录、Docker 的 /app/tools。
     * 目录形态要求内含 lib/*.jar（dex2jar 发行包）。
     */
    private static File resolveTool() {
        String env = System.getenv("MEOW_DEX2JAR");
        if (env != null && !env.trim().isEmpty()) {
            File f = new File(env.trim());
            if (usableTool(f)) return f;
        }
        String[] candidates = {
                "tools/dex2jar",
                "../tools/dex2jar",
                "/app/tools/dex2jar",
                "/opt/dex2jar",
                "dex2jar"
        };
        for (String c : candidates) {
            File f = new File(c);
            if (usableTool(f)) return f;
        }
        return null;
    }

    /** 缓存键里的转换器标识（目录形态取 lib/dex-tools-*.jar 的文件名）。 */
    private static String toolTag(File tool) {
        try {
            if (tool.isDirectory()) {
                File lib = new File(tool, "lib");
                File[] jars = lib.listFiles((d, n) ->
                        n.startsWith("dex-tools") && n.endsWith(".jar"));
                if (jars != null && jars.length > 0) {
                    return sanitize(jars[0].getName().replaceFirst("\\.jar$", ""));
                }
            } else {
                return sanitize(tool.getName().replaceFirst("\\.(sh|bat|jar)$", ""));
            }
        } catch (Throwable ignored) {
        }
        return "dex2jar";
    }

    private static String sanitize(String s) {
        return s.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private static boolean usableTool(File f) {
        if (f == null || !f.exists()) return false;
        if (f.isDirectory()) {
            File lib = new File(f, "lib");
            return lib.isDirectory() && lib.listFiles((d, n) -> n.endsWith(".jar")) != null;
        }
        String n = f.getName().toLowerCase();
        return n.endsWith(".sh") || n.endsWith(".bat") || n.endsWith(".jar");
    }

    private enum Kind {CONVERTED, ALREADY_JVM, NATIVE, NO_DEX, FAILED}

    private static final class Converted {
        final Kind kind;
        final String fileUri;
        final String reason;

        private Converted(Kind kind, String fileUri, String reason) {
            this.kind = kind;
            this.fileUri = fileUri == null ? "" : fileUri;
            this.reason = reason == null ? "" : reason;
        }

        static Converted converted(String uri) { return new Converted(Kind.CONVERTED, uri, ""); }
        static Converted alreadyJvm() { return new Converted(Kind.ALREADY_JVM, "", ""); }
        static Converted nativeJar() { return new Converted(Kind.NATIVE, "", "contains native .so"); }
        static Converted noDex() { return new Converted(Kind.NO_DEX, "", "no classes.dex"); }
        static Converted failed(String why) { return new Converted(Kind.FAILED, "", why); }
    }

    private static final class JarInfo {
        boolean hasSpiderClass;
        boolean hasDex;
        boolean hasNative;
    }

    private record ProcessResult(boolean ok, String message) {
    }
}
