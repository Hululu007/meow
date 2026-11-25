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
import java.util.Map;

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
     * 每条 jar 规格最近一次的装载结果（issue #9/#14/#10 的可见性来源）。
     *
     * <p>这层必须存在：jar 准备失败原来只有一行 WARN，站点在列表里静默消失，
     * 用户和客服都只能猜"是不是源挂了"。导入结果、站点明细、/api/health
     * 都从这里取一致的说法。
     */
    public static final class Status {
        public String spec = "";
        public String name = "";
        public boolean ok;
        /** md5 与配置一致；配置没写 md5 时视为 true */
        public boolean md5Ok = true;
        public String md5Expected = "";
        public String md5Actual = "";
        public String error = "";
        /** 加密 Guard 壳（assets/*.guard + ARM .so + 极小的 classes.dex） */
        public boolean encrypted;
        public String encryptedReason = "";
        public long bytes;

        public JSONObject json() throws Exception {
            JSONObject o = new JSONObject();
            o.put("spec", spec);
            o.put("name", name);
            o.put("ok", ok);
            o.put("md5Ok", md5Ok);
            o.put("bytes", bytes);
            o.put("encrypted", encrypted);
            if (!error.isEmpty()) o.put("error", error);
            if (!md5Ok) {
                o.put("md5Expected", md5Expected);
                o.put("md5Actual", md5Actual);
            }
            if (encrypted && !encryptedReason.isEmpty()) o.put("encryptedReason", encryptedReason);
            return o;
        }
    }

    private static final List<Status> STATUS = new ArrayList<>();

    /**
     * 下载失败冷却：同 URL 10 分钟内不再重试（issue #14 P2）。
     *
     * <p>为什么需要：导入/启动都会 reload，源站挂了时每次都要等满超时 +
     * 失败，一次导入卡十几秒。冷却期内有缓存就用缓存，没缓存直接报"冷却中"。
     */
    private static final Map<String, Long> FAIL_UNTIL =
            new java.util.concurrent.ConcurrentHashMap<>();
    private static final long JAR_FAIL_COOLDOWN_MS = 10L * 60_000L;

    /** 最近一次 prepare 的 md5 结果（prepare 是私有核心，reload 用它填 Status）。 */
    private static volatile boolean LAST_MD5_OK = true;
    private static volatile String LAST_MD5_EXPECTED = "";
    private static volatile String LAST_MD5_ACTUAL = "";

    /** {@link #reload()} 的代次，见 generation() 的说明。 */
    private static final java.util.concurrent.atomic.AtomicInteger GENERATION =
            new java.util.concurrent.atomic.AtomicInteger();

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

    /** 装载结果快照（导入结果 / 站点明细 / /api/health 共用）。 */
    public static synchronized JSONArray statusJson() throws Exception {
        JSONArray arr = new JSONArray();
        for (Status s : STATUS) arr.put(s.json());
        return arr;
    }

    /** 有 jar 装载失败时返回第一句原因，否则空串。 */
    public static synchronized String lastError() {
        for (Status s : STATUS) {
            if (!s.ok && !s.error.isEmpty()) return s.error;
        }
        return "";
    }

    /** 配置里有加密 Guard 壳（本构建的 JVM/桌面跑不了它的 ARM 原生库）。 */
    public static synchronized boolean hasEncrypted() {
        for (Status s : STATUS) {
            if (s.encrypted) return true;
        }
        return false;
    }

    public static synchronized String encryptedReason() {
        for (Status s : STATUS) {
            if (s.encrypted && !s.encryptedReason.isEmpty()) return s.encryptedReason;
        }
        return "";
    }

    public static synchronized boolean hasFailure() {
        for (Status s : STATUS) {
            if (!s.ok) return true;
        }
        return false;
    }

    /**
     * md5 不匹配是否按致命错误处理（policy.json 的 {@code jarStrictMd5}）。
     *
     * <p>默认 **false**：TVBox 生态里同一份配置能在 TVBox 跑、在我们这里整站消失，
     * 最常见的原因就是配置作者换了 jar 却忘了改 {@code ;md5;}，或者图片 CDN
     * 按 UA 返回了不同字节（实测两条都出现过）。不匹配时挂载 + WARN 比
     * "整站不可见"有用得多；洁癖用户可显式打开。
     */
    public static boolean strictMd5() {
        if (Boolean.getBoolean("meow.jarStrictMd5")) return true;
        try {
            String raw = DataPaths.read("policy.json");
            if (raw != null && !raw.trim().isEmpty()) {
                Object v = new JSONObject(raw).opt("jarStrictMd5");
                if (v instanceof Boolean) return (Boolean) v;
                if (v != null) return "true".equalsIgnoreCase(String.valueOf(v).trim());
            }
        } catch (Throwable ignored) {
            /* 坏 policy 按默认（宽松）处理 */
        }
        return false;
    }

    private static void resetMd5State() {
        LAST_MD5_OK = true;
        LAST_MD5_EXPECTED = "";
        LAST_MD5_ACTUAL = "";
    }

    /**
     * 识别"加密 Guard 壳"jar（issue #10）。
     *
     * <p>判据全部来自 jar 条目，不联网：正常 spider jar 是 1–4MB 的 .class；
     * 加密壳只带一个几十 KB 的 classes.dex，真逻辑在 assets/*.guard 里，
     * 由 assets/*wexguard*.so 在运行时解密。这类包在 JVM / x86 设备上
     * 必然点开才报 DexNative/UnsatisfiedLinkError，必须在导入期就说清。
     */
    static String detectEncrypted(File f) {
        try (java.util.jar.JarFile jf = new java.util.jar.JarFile(f)) {
            int classCount = 0;
            long dexSize = 0;
            boolean guardAsset = false;
            boolean guardSo = false;
            boolean nativeRef = false;
            java.util.Enumeration<java.util.jar.JarEntry> en = jf.entries();
            while (en.hasMoreElements()) {
                java.util.jar.JarEntry e = en.nextElement();
                String n = e.getName();
                String ln = n.toLowerCase(java.util.Locale.ROOT);
                if (n.endsWith(".class")) classCount++;
                if ("classes.dex".equals(ln)) {
                    dexSize = e.getSize();
                    nativeRef = dexHasNativeBridge(jf, e);
                }
                if (ln.startsWith("assets/") && (ln.endsWith(".guard") || ln.endsWith(".grd"))) {
                    guardAsset = true;
                }
                if ((ln.startsWith("assets/") || ln.startsWith("lib/"))
                        && ln.endsWith(".so") && ln.contains("guard")) {
                    guardSo = true;
                }
            }
            boolean shell = classCount == 0 && dexSize > 0 && dexSize < 200L * 1024;
            if (!guardAsset && !guardSo && !(shell && nativeRef)) return "";
            String reason = "加密接口（jar 里只有 Guard 加密壳，需要影视仓宿主）";
            String abi = deviceAbi();
            if (abi.contains("x86") || abi.contains("amd64")) {
                reason += "；该壳只带 ARM 原生库，本设备（" + abi + "）跑不了";
            }
            return reason;
        } catch (Throwable t) {
            return "";
        }
    }

    /** dex 里是否出现 DexNative / NativeLoader（加密壳的外部运行时桥）。 */
    private static boolean dexHasNativeBridge(java.util.jar.JarFile jf, java.util.jar.JarEntry e) {
        try (InputStream in = jf.getInputStream(e)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            long total = 0;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > 2L * 1024 * 1024) break;
                out.write(buf, 0, n);
            }
            String s = new String(out.toByteArray(), java.nio.charset.StandardCharsets.ISO_8859_1);
            return s.contains("DexNative") || s.contains("NativeLoader");
        } catch (Throwable t) {
            return false;
        }
    }

    /** 本进程的 CPU ABI（Android 用 Build，主机用 os.arch）。 */
    private static String deviceAbi() {
        String abi = "";
        try {
            Class<?> b = Class.forName("android.os.Build");
            Object v = b.getField("CPU_ABI").get(null);
            if (v instanceof String) abi = (String) v;
            try {
                Object arr = b.getField("SUPPORTED_ABIS").get(null);
                if (arr instanceof String[] && ((String[]) arr).length > 0) {
                    abi = ((String[]) arr)[0];
                }
            } catch (Throwable ignored) {
            }
        } catch (Throwable ignored) {
        }
        if (abi == null || abi.trim().isEmpty()) abi = System.getProperty("os.arch", "");
        return abi == null ? "" : abi.toLowerCase(java.util.Locale.ROOT);
    }

    public static synchronized void reload() {
        if (!isJvm()) return;   // Android 走 LocalSpiderHost 的 DexClassLoader，别插手
        closeAll();
        /*
         * 代次自增：ApiServer 的「类名是否存在」缓存靠它失效。
         *
         * 为什么要缓存：未命中的 Class.forName 会逐个 jar 扫一遍 zip 目录 ——
         * 桌面 JIT 下几毫秒，iOS 的 Zero 解释执行下一次几十到几百毫秒。
         * /api/health 与 /api/sites 对每个站点都问一次，59 个站 × 每次几十次
         * 未命中，能把整个网关拖成"像挂了"（2026-11-24 真机现象：
         * 导入后首页请求超时，服务端日志只有 [req] 没有下文）。
         */
        GENERATION.incrementAndGet();
        synchronized (Jars.class) {
            STATUS.clear();
        }
        for (String spec : collect()) {
            Status st = new Status();
            st.spec = spec;
            try {
                File f = prepare(spec);
                if (f == null) {
                    st.error = "没有本地文件";
                    addStatus(st);
                    continue;
                }
                st.bytes = f.length();
                st.name = f.getName();
                st.md5Ok = LAST_MD5_OK;
                st.md5Expected = LAST_MD5_EXPECTED;
                st.md5Actual = LAST_MD5_ACTUAL;
                String enc = detectEncrypted(f);
                if (!enc.isEmpty()) {
                    st.encrypted = true;
                    st.encryptedReason = enc;
                }
                boolean guard = isJvm() && isGuardShell(f);
                if (guard) {
                    File payload = materializeGuard(f);
                    if (payload == null) {
                        st.error = "加密 Guard 壳解密失败";
                        addStatus(st);
                        LogBuffer.warn("jar", "加密 Guard 壳解密失败，跳过 " + shortSpec(spec));
                        continue;
                    }
                    f = payload;
                } else {
                    /*
                     * 站点级 dex jar（实测 Jable 的 spider-ext-dex.jar）在这条路径上
                     * 不会经过导入流程的 Dex2Jvm.rewrite —— 直接挂 dex 会让
                     * URLClassLoader 加载失败，表现是「该源在当前构建不可用」。
                     * 已经是 class jar / 非 JVM / 工具缺失时原样返回。
                     */
                    f = Dex2Jvm.convertLocal(f);
                }
                URLClassLoader loader = new URLClassLoader(new URL[]{f.toURI().toURL()}, Jars.class.getClassLoader());
                LOADERS.add(loader);
                if (guard) registerGuardLoader(loader, f);
                st.ok = true;
                addStatus(st);
                LogBuffer.info("jar", (guard ? "已挂载加密源 " : "已挂载 ") + f.getName() + "（" + f.length() + "B）");
                if (!st.md5Ok) {
                    LogBuffer.warn("jar", "md5 不匹配但仍挂载（policy.jarStrictMd5=false）："
                            + shortSpec(spec) + " 期望 " + st.md5Expected + " 实际 " + st.md5Actual);
                }
                if (st.encrypted) LogBuffer.warn("jar", "加密 Guard 壳：" + st.encryptedReason);
            } catch (Throwable t) {
                st.error = t.getMessage() == null ? String.valueOf(t) : t.getMessage();
                addStatus(st);
                LogBuffer.warn("jar", "准备失败 " + shortSpec(spec) + " → " + t);
            }
        }
        installHook();
    }

    private static synchronized void addStatus(Status st) {
        STATUS.add(st);
    }

    /** jar 集合的代次；每次 {@link #reload()} 自增。缓存方拿它做失效判据。 */
    public static int generation() {
        return GENERATION.get();
    }

    /**
     * 手动作废类名缓存（站点表重建时调）。
     *
     * <p>Android 不走 {@link #reload()}（DexClassLoader 在 LocalSpiderHost），
     * 但它同样会换站点表，缓存必须失效。
     */
    public static void invalidateClassCache() {
        GENERATION.incrementAndGet();
    }

    /**
     * 把 jar 内 {@code Proxy} 的探测端口固定成本进程真实端口。
     *
     * <p>混淆 jar 的 {@code Proxy.a()} 只会扫 9978–9999（见 {@code javap -c}），
     * 而 fnOS 微应用把 Java 起在 30011（PC 插件也可能顺延到 9982+ 之外），
     * 于是 Bili/Hxq 的 play 返回 {@code http://127.0.0.1:-1/proxy?...}，播放必坏。
     * 直接在类加载后写私有静态字段 {@code a}，让 {@code getPort()} 跳过扫描。
     */
    private static volatile int PROXY_PORT;

    public static int proxyPort() {
        return PROXY_PORT;
    }

    public static void pinProxyPort(int port) {
        if (port > 0) PROXY_PORT = port;
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
        Class<?> c = loadExact(fqcn);
        // 加密 Guard 壳解出来的 payload 去掉了 Guard 后缀（XxxGuard -> Xxx）
        if (c == null && fqcn != null && fqcn.endsWith("Guard")) {
            c = loadExact(fqcn.substring(0, fqcn.length() - 5));
        }
        return c;
    }

    private static Class<?> loadExact(String fqcn) {
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

    // ---------------------------------------------------------------- 加密 Guard 壳（JVM）

    /** 供 ApiServer 在 newInstance 之前调用；命中原生加密源返回 true。 */
    public static boolean initGuardPayload(Class<?> c) {
        Class<?> g = guardClass();
        if (g == null || c == null) return false;
        try {
            boolean is = (Boolean) g.getMethod("isGuardPayload", Class.class).invoke(null, c);
            if (!is) return false;
            g.getMethod("initPayload", ClassLoader.class).invoke(null, c.getClassLoader());
            return true;
        } catch (Throwable t) {
            LogBuffer.warn("jar", "Guard 初始化失败：" + t);
            return false;
        }
    }

    private static Class<?> guardClass() {
        if (!isJvm()) return null;
        try {
            return Class.forName("jvm.GuardShell");
        } catch (Throwable t) {
            return null;
        }
    }

    private static boolean isGuardShell(File f) {
        Class<?> g = guardClass();
        if (g == null) return false;
        try {
            return (Boolean) g.getMethod("isGuard", File.class).invoke(null, f);
        } catch (Throwable t) {
            return false;
        }
    }

    private static File materializeGuard(File f) {
        Class<?> g = guardClass();
        if (g == null) return null;
        try {
            return (File) g.getMethod("materialize", File.class).invoke(null, f);
        } catch (Throwable t) {
            LogBuffer.warn("jar", "Guard 解密调用失败：" + t);
            return null;
        }
    }

    private static void registerGuardLoader(ClassLoader loader, File payload) {
        Class<?> g = guardClass();
        if (g == null) return;
        try {
            g.getMethod("register", ClassLoader.class, File.class).invoke(null, loader, payload);
        } catch (Throwable ignored) {
        }
    }

    /** guard 站点转发到 companion；非 guard 返回 null。 */
    public static String forwardGuard(String site, String action, String body) {
        if (!isJvm() || site == null) return null;
        Class<?> g = guardClass();
        if (g == null) return null;
        String base = site;
        int hash = base.indexOf('#');
        if (hash > 0) base = base.substring(0, hash);
        if (base.isEmpty()) return null;
        Class<?> c = load("com.github.catvod.spider." + base);
        if (c == null || !isGuardPayloadClass(c)) return null;
        try {
            return (String) g.getMethod("forward", Class.class, String.class, String.class, String.class)
                    .invoke(null, c, site, action, body);
        } catch (Throwable t) {
            LogBuffer.warn("jar", "guard 转发失败：" + t);
            return null;
        }
    }

    public static boolean isGuardPayloadClass(Class<?> c) {
        Class<?> g = guardClass();
        if (g == null || c == null) return false;
        try {
            return (Boolean) g.getMethod("isGuardPayload", Class.class).invoke(null, c);
        } catch (Throwable t) {
            return false;
        }
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
        resetMd5State();
        String url = spec;
        String md5 = "";
        int i = spec.toLowerCase().indexOf(";md5;");
        if (i > 0) {
            url = spec.substring(0, i).trim();
            md5 = spec.substring(i + 5).trim();
            /*
             * ★ 兼容 `;md5;?<32位>?`：肥猫等源包用问号包住 hash
             * （实测 `...png;md5;?252d4d89...?`），整段比对必然
             * "md5 不匹配"，jar 永远下不下来 → 所有 csp_ 站静默不可用。
             * 只取第一个 32 位十六进制串；没有就当没写 md5（跳过校验）。
             */
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("([0-9a-fA-F]{32})").matcher(md5);
            md5 = m.find() ? m.group(1) : "";
        }

        if (url.startsWith("file:") || !url.toLowerCase().startsWith("http")) {
            File f = url.startsWith("file:") ? new File(java.net.URI.create(url).getPath()) : new File(url);
            if (!f.isFile()) throw new Exception("本地 jar 不存在：" + f);
            // 本地文件是用户的原始文件：校验失败可以报错，**绝不能删**
            checkMd5(f, md5, false);
            return f;
        }

        File dir = DataPaths.dir("jars") != null ? DataPaths.dir("jars").toFile() : DataPaths.file("jars").getParentFile();
        if (dir == null) throw new Exception("无法创建 jars 目录");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建 jars 目录：" + dir);
        File dst = new File(dir, fileNameOf(url));

        boolean hadCache = dst.isFile();
        if (hadCache) {
            if (md5.isEmpty()) return dst;
            String got = md5Of(dst);
            if (md5.equalsIgnoreCase(got)) return dst;
            // 配置换了 md5（或旧包不对）：重下一次，仍不对再按宽松策略决定
            LogBuffer.info("jar", "缓存 md5 不一致，重新下载：" + shortSpec(spec));
        }
        long now = System.currentTimeMillis();
        Long failUntil = FAIL_UNTIL.get(url);
        if (failUntil != null && failUntil > now) {
            if (hadCache) {
                String got = md5.isEmpty() ? "" : md5Of(dst);
                LAST_MD5_EXPECTED = md5;
                LAST_MD5_ACTUAL = got;
                LAST_MD5_OK = md5.isEmpty() || md5.equalsIgnoreCase(got);
                LogBuffer.info("jar", "下载冷却中，使用缓存 " + shortSpec(spec));
                return dst;
            }
            long mins = Math.max(1, (failUntil - now + 59_999L) / 60_000L);
            throw new Exception("最近下载失败，冷却中（约 " + mins + " 分钟后重试）");
        }

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
                checkMd5(part, md5);
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
            FAIL_UNTIL.put(url, System.currentTimeMillis() + JAR_FAIL_COOLDOWN_MS);
            /*
             * 下载全失败（源站挂了/换了域名）但本地有缓存：宽松模式继续用缓存。
             *
             * 这类配置往往能用很久 —— 站点消失只因为"今天下不动 jar"，
             * 比 md5 不匹配更冤（issue #14 的同一个坑，只是触发点更靠前）。
             */
            if (!strictMd5() && hadCache) {
                String got = md5Of(dst);
                LAST_MD5_EXPECTED = md5;
                LAST_MD5_ACTUAL = got;
                LAST_MD5_OK = md5.isEmpty() || md5.equalsIgnoreCase(got);
                LogBuffer.warn("jar", "下载失败，沿用本地缓存 " + shortSpec(spec)
                        + (LAST_MD5_OK ? "" : "（md5 不匹配）"));
                return dst;
            }
            if (last != null) throw last;
            throw new Exception("下载失败");
        }
        if (!part.renameTo(dst)) {
            // Windows 上目标被占用时 renameTo 会失败，退回覆盖拷贝
            copy(part, dst);
            //noinspection ResultOfMethodCallIgnored
            part.delete();
        }
        FAIL_UNTIL.remove(url);
        checkMd5(dst, md5);
        return dst;
    }

    /** 下载一个候选到 .part；HTTP 错误、超限、HTML 错误页都抛异常。 */
    private static void downloadTo(File part, String url) throws Exception {
        /*
         * iOS：先让壳用 NSURLSession 下。
         *
         * Zero 解释执行下 JVM 的 TLS + 大文件 IO 要十几秒，原生是秒级；
         * 失败（或下回来是 HTML 错误页）就落回下面的 JVM 路径，功能不变。
         */
        if (platform.Bridge.hasDownloader()) {
            try {
                if (platform.Bridge.nativeDownload(url, part.getAbsolutePath())) {
                    long len = part.length();
                    if (len > 0 && len <= 64L * 1024 * 1024 && !looksLikeHtml(part)) return;
                }
            } catch (Throwable ignored) {
                // 落到 JVM 路径
            }
        }
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

    /**
     * 校验 md5。返回 false = 不一致但**保留文件**（宽松模式，见 {@link #strictMd5()}）。
     *
     * <p>踩过（2026-11-24 飞牛实测）：用户配置里 jar 的 {@code ;md5;} 值过期
     * （维护者换了包没改 hash，或图片 CDN 按 UA 返回不同字节），旧实现删文件 + 抛异常，
     * 结果**整站静默消失**，而同一份配置在 TVBox 上正常。不匹配不是"文件坏了"的
     * 证据，先挂载再说；严格模式只给明确要求的人。
     */
    private static boolean checkMd5(File f, String md5) throws Exception {
        return checkMd5(f, md5, true);
    }

    private static boolean checkMd5(File f, String md5, boolean deletable) throws Exception {
        LAST_MD5_EXPECTED = md5 == null ? "" : md5;
        if (md5 == null || md5.isEmpty()) {
            LAST_MD5_OK = true;
            LAST_MD5_ACTUAL = "";
            return true;
        }
        String got = md5Of(f);
        LAST_MD5_ACTUAL = got;
        if (got.equalsIgnoreCase(md5)) {
            LAST_MD5_OK = true;
            return true;
        }
        LAST_MD5_OK = false;
        if (strictMd5()) {
            if (deletable) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
            throw new Exception("md5 不匹配：期望 " + md5 + "，实际 " + got);
        }
        return false;
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
