package jvm;

import core.DataPaths;
import core.LogBuffer;

import java.io.*;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 加密 Guard 壳（assets/*guard_v*.so + assets/*shinidie.guard）在 JVM 端的自动加载器。
 *
 * <p>两段子进程：
 * <ol>
 *   <li>{@link GuardShellMain}：unidbg 跑壳 so、dex2jar -r、字节码修复，产出明文 class jar；</li>
 *   <li>{@link GuardServeMain}：装载明文 jar、InitOrigin/远程配置初始化，暴露本地 HTTP
 *       入口给宿主转发。</li>
 * </ol>
 * 为什么站点调用不直接跑在 ApiServer 的 JVM 里：宿主自己的 HTTP 栈/线程池会让壳的
 * y0.g 请求被中断（实测 ApiServer 里恒空、独立进程里全通），所以 guard 站点走 companion。
 */
public final class GuardShell {

    /** 解密/修复逻辑版本：改 GuardShellMain/GuardRepair 后必须 +1，否则复用旧缓存。 */
    private static final int REPAIR_VERSION = 2;

    private static final Set<ClassLoader> PAYLOAD_LOADERS =
            Collections.newSetFromMap(new WeakHashMap<>());
    private static final Map<ClassLoader, File> PAYLOAD_FILES =
            Collections.synchronizedMap(new WeakHashMap<>());
    private static final Set<ClassLoader> INITED =
            Collections.newSetFromMap(new WeakHashMap<>());
    private static final Map<String, Companion> COMPANIONS = new LinkedHashMap<>();

    private GuardShell() {
    }

    /** 壳 jar 的判据：既有 .guard/.grd/.bin 大载荷，又有 *guard_v*.so。 */
    public static boolean isGuard(File jar) {
        if (jar == null || !jar.isFile()) return false;
        boolean payload = false, so = false;
        try (ZipFile zip = new ZipFile(jar)) {
            java.util.Enumeration<? extends ZipEntry> en = zip.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) continue;
                String n = e.getName();
                if (!n.startsWith("assets/")) continue;
                String lower = n.toLowerCase();
                if ((lower.endsWith(".guard") || lower.endsWith(".grd") || lower.endsWith(".bin"))
                        && e.getSize() > 50_000) {
                    payload = true;
                }
                if (lower.matches(".*guard_v[0-9]+\\.so$")) so = true;
            }
        } catch (Throwable ignored) {
            return false;
        }
        return payload && so;
    }

    /** 解出并缓存真实 spider jar；失败返回 null（该源本次不可用，不影响其它源）。 */
    public static synchronized File materialize(File shellJar) {
        File dir = guardDir();
        if (dir == null) return null;
        String md5 = md5(shellJar);
        if (md5.isEmpty()) return null;
        File out = new File(dir, "payload-r" + REPAIR_VERSION + "-" + md5 + ".jar");
        if (out.isFile() && out.length() > 0) return out;

        File tmp = new File(dir, "payload-r" + REPAIR_VERSION + "-" + md5 + ".part-" + ProcessHandle.current().pid());
        File log = new File(dir, "decrypt-r" + REPAIR_VERSION + "-" + md5 + ".log");
        try {
            String java = new File(System.getProperty("java.home"), "bin/java").getAbsolutePath();
            String cp = selfClasspath() + File.pathSeparator + new File(guardLibs(), "*").getAbsolutePath();
            ProcessBuilder pb = new ProcessBuilder(java,
                    "-Dfile.encoding=UTF-8",
                    "-cp", cp,
                    "jvm.GuardShellMain",
                    shellJar.getAbsolutePath(),
                    tmp.getAbsolutePath());
            pb.redirectErrorStream(true);
            pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
            LogBuffer.info("guard", "解密壳 " + shellJar.getName() + "（md5=" + md5 + "），日志 " + log);
            Process p = pb.start();
            if (!p.waitFor(300, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                LogBuffer.warn("guard", "解密超时（300s），见 " + log);
                return null;
            }
            if (p.exitValue() != 0 || !tmp.isFile() || tmp.length() == 0) {
                LogBuffer.warn("guard", "解密失败 exit=" + p.exitValue() + "，见 " + log);
                return null;
            }
            try {
                Files.move(tmp.toPath(), out.toPath(), StandardCopyOption.REPLACE_EXISTING,
                        StandardCopyOption.ATOMIC_MOVE);
            } catch (Throwable atomicFailed) {
                Files.move(tmp.toPath(), out.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
            LogBuffer.info("guard", "解密完成 " + out.getName() + "（" + out.length() + "B）");
            return out;
        } catch (Throwable t) {
            LogBuffer.warn("guard", "解密异常：" + t);
            return null;
        } finally {
            try {
                Files.deleteIfExists(tmp.toPath());
            } catch (Throwable ignored) {
            }
        }
    }

    public static void register(ClassLoader loader, File payloadJar) {
        if (loader == null) return;
        PAYLOAD_LOADERS.add(loader);
        if (payloadJar != null) PAYLOAD_FILES.put(loader, payloadJar);
    }

    public static boolean isGuardPayload(Class<?> c) {
        return c != null && PAYLOAD_LOADERS.contains(c.getClassLoader());
    }

    /** 宿主的本地 instance 路径用：只做轻量 seed，真正初始化在 companion。 */
    public static synchronized void initPayload(ClassLoader loader) {
        if (loader == null || !PAYLOAD_LOADERS.contains(loader) || INITED.contains(loader)) return;
        INITED.add(loader);
        try {
            Class<?> io = Class.forName("com.github.catvod.spider.InitOrigin", true, loader);
            android.app.Application app = new android.app.Application();
            Object inst = io.getMethod("get").invoke(null);
            try {
                io.getField("c").set(inst, app);
            } catch (Throwable ignored) {
            }
            try {
                io.getField("f").set(null, app.getFilesDir().getPath());
            } catch (Throwable ignored) {
            }
            LogBuffer.info("guard", "InitOrigin 轻量 seed 完成");
        } catch (Throwable t) {
            LogBuffer.warn("guard", "InitOrigin seed 失败：" + t);
        }
    }

    /** 站点调用转发到 companion；不是 guard 站点/启动失败返回 null。 */
    public static String forward(Class<?> c, String site, String action, String body) {
        if (c == null) return null;
        File payload = PAYLOAD_FILES.get(c.getClassLoader());
        if (payload == null) return null;
        Companion comp = companion(payload);
        if (comp == null) return null;
        try (Socket s = new Socket(InetAddress.getLoopbackAddress(), comp.port)) {
            s.setSoTimeout(120000);
            DataOutputStream out = new DataOutputStream(new BufferedOutputStream(s.getOutputStream()));
            writeString(out, site);
            writeString(out, action);
            writeString(out, body == null ? "{}" : body);
            out.flush();
            DataInputStream in = new DataInputStream(new BufferedInputStream(s.getInputStream()));
            return readString(in);
        } catch (Throwable t) {
            LogBuffer.warn("guard", "companion 转发失败：" + t);
            synchronized (COMPANIONS) {
                comp = COMPANIONS.remove(payload.getAbsolutePath());
            }
            if (comp != null) comp.stop();
            return null;
        }
    }

    private static Companion companion(File payload) {
        synchronized (COMPANIONS) {
            Companion c = COMPANIONS.get(payload.getAbsolutePath());
            if (c != null && c.alive()) return c;
            if (c != null) COMPANIONS.remove(payload.getAbsolutePath());
            Companion n = Companion.start(payload);
            if (n != null) COMPANIONS.put(payload.getAbsolutePath(), n);
            return n;
        }
    }

    // ---------------------------------------------------------------- companion

    private static final class Companion {
        final Process process;
        final int port;

        private Companion(Process process, int port) {
            this.process = process;
            this.port = port;
        }

        boolean alive() {
            return process.isAlive() && port > 0;
        }

        void stop() {
            try {
                process.destroyForcibly();
            } catch (Throwable ignored) {
            }
        }

        static Companion start(File payload) {
            File dir = guardDir();
            File helper = new File(guardLibs(), "guard-helper.jar");
            if (!helper.isFile()) {
                LogBuffer.warn("guard", "缺少 guard-helper.jar（先跑 server/tools/guard/build-guard-helper）");
                return null;
            }
            File log = dir == null ? null : new File(dir, "serve-" + payload.getName() + ".log");
            try {
                String java = new File(System.getProperty("java.home"), "bin/java").getAbsolutePath();
                StringBuilder cp = new StringBuilder(selfClasspath());
                File libs = libsDir();
                if (libs != null) cp.append(File.pathSeparator).append(new File(libs, "*").getAbsolutePath());
                cp.append(File.pathSeparator).append(helper.getAbsolutePath());
                int proxyPort = Integer.getInteger("meow.guard.proxyPort", core.Jars.proxyPort());
                ProcessBuilder pb = new ProcessBuilder(java, "-Dfile.encoding=UTF-8",
                        "-cp", cp.toString(), "jvm.GuardServeMain",
                        payload.getAbsolutePath(), String.valueOf(proxyPort));
                pb.redirectErrorStream(true);
                if (log != null) LogBuffer.info("guard", "启动 companion：" + log);
                Process p = pb.start();
                BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
                int port = 0;
                long deadline = System.currentTimeMillis() + 60000;
                while (System.currentTimeMillis() < deadline) {
                    String line = reader.readLine();
                    if (line == null) break;
                    if (line.startsWith("PORT=")) {
                        port = Integer.parseInt(line.substring(5).trim());
                        break;
                    }
                }
                final BufferedReader tail = reader;
                final File logFile = log;
                Thread drain = new Thread(() -> {
                    try (Writer w = logFile == null ? new OutputStreamWriter(new OutputStream() {   // iOS 端 --release 9：没有 nullOutputStream（Java 11）
                                @Override public void write(int b) { }
                            }, StandardCharsets.UTF_8)
                            : new OutputStreamWriter(new FileOutputStream(logFile, true), StandardCharsets.UTF_8)) {
                        String line;
                        while ((line = tail.readLine()) != null) {
                            w.write(line);
                            w.write('\n');
                            w.flush();
                        }
                    } catch (Throwable ignored) {
                    }
                }, "guard-serve-log");
                drain.setDaemon(true);
                drain.start();
                if (port <= 0) {
                    p.destroyForcibly();
                    LogBuffer.warn("guard", "companion 启动失败（无 PORT）");
                    return null;
                }
                LogBuffer.info("guard", "companion 端口 " + port);
                return new Companion(p, port);
            } catch (Throwable t) {
                LogBuffer.warn("guard", "companion 启动异常：" + t);
                return null;
            }
        }
    }

    // ---------------------------------------------------------------- 路径

    private static File guardDir() {
        try {
            Path p = DataPaths.dir("guard");
            if (p != null) {
                File f = p.toFile();
                if (!f.isDirectory() && !f.mkdirs() && !f.isDirectory()) return null;
                return f;
            }
        } catch (Throwable ignored) {
        }
        try {
            File f = DataPaths.file("guard/payload").getParentFile();
            if (f != null && (f.isDirectory() || f.mkdirs())) return f;
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static String selfClasspath() {
        try {
            File self = new File(GuardShell.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            return self.getAbsolutePath();
        } catch (Throwable t) {
            return ".";
        }
    }

    private static File baseDir() {
        File self = new File(selfClasspath());
        return self.isFile() ? self.getParentFile() : self;
    }

    private static File guardLibs() {
        String p = System.getProperty("meow.guard.libs");
        if (p != null && !p.trim().isEmpty()) return new File(p.trim());
        File base = baseDir();
        for (File c : new File[]{new File(base, "guard-libs"), new File(base.getParentFile(), "guard-libs")}) {
            if (c.isDirectory()) return c;
        }
        return new File(base.getParentFile(), "guard-libs");
    }

    private static File libsDir() {
        File base = baseDir();
        for (File c : new File[]{new File(base, "libs"), new File(base.getParentFile(), "libs"),
                new File("/app/libs"), new File("libs")}) {
            if (c.isDirectory()) return c;
        }
        return null;
    }

    private static String md5(File f) {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    static String readString(DataInputStream in) throws IOException {
        int len = in.readInt();
        byte[] b = new byte[len];
        in.readFully(b);
        return new String(b, StandardCharsets.UTF_8);
    }

    static void writeString(DataOutputStream out, String s) throws IOException {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        out.writeInt(b.length);
        out.write(b);
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] b = new byte[16384];
        int n;
        while ((n = in.read(b)) != -1) o.write(b, 0, n);
        return o.toByteArray();
    }
}
