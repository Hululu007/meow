package platform;

/**
 * 两端能力差异的注入点。
 *
 * <p><b>只有两件事</b>：spider 的 {@code init} 需要一个 Context；日志要写到
 * 对应平台的可见位置（JVM 是 stdout，Android 是 logcat + 内存环形缓冲）。
 *
 * <p><b>为什么 Context 必须能注入</b>：{@code ApiServer.instance()} 原来用
 * {@code android.content.Context.class.getDeclaredConstructor().newInstance()}
 * 造一个 JVM 侧 stub 实例。这个方法在 Android 上必然失败——真实
 * {@code android.content.Context} 是抽象类且构造器是 protected，
 * {@code newInstance()} 抛 InstantiationException（不是 NoSuchMethodException，
 * 不会被那里唯一的 catch 拦住）→ 表现成「所有站点都加载失败」。
 *
 * <p><b>为什么不做成接口让实现类注册</b>：注入点只有一个值和一个方法，
 * 加一层接口只会让两端各写一个类；静态钩子已经够，且调用点只有 2 处。
 */
public final class Bridge {

    private Bridge() {
    }

    /** 给 spider {@code init(Context, String)} 用的对象；null = 用反射造 stub。 */
    public interface ContextProvider {
        Object get();
    }

    /** 日志落点；默认写 stdout（JVM）。Android 侧换成 logcat。 */
    public interface Logger {
        void log(String line);
    }

    /**
     * spider 类加载。
     *
     * <p><b>为什么这必须是个注入点</b>：JVM 上 spider 在类路径里，{@code Class.forName}
     * 直接就能拿到；Android 上它在一个 {@code classes.dex} 里，必须走
     * {@code DexClassLoader}，且那个 loader 要从 {@code codeCacheDir} 加载（Android 10+
     * 禁止从可写目录加载 dex）。这不是"实现细节不同"，是**根本不同的查找机制**。
     *
     * <p>同时它也是 parser 类的来源（{@code parser.JsonXxx} / {@code MixXxx} 与 spider
     * 在同一个 jar 里），所以 {@code /api/parse} 的 type 2/3 也走这里。
     */
    public interface ClassLoaderHook {
        Class<?> loadClass(String fqcn) throws ClassNotFoundException;
    }

    /**
     * 本机运行时模块提供的弹幕服务地址（TV：node 模块里的 danmu_api）。
     *
     * <p><b>为什么是"每次问一次"而不是启动时定一次</b>：端口是探出来的
     * （19341 被占就顺延），而且模块可能中途崩溃重启换端口。写成启动时
     * 一次性注入，改端口后要重启整个网关才能生效 —— 表现为"模块明明在跑，
     * 弹幕就是不出来"。
     *
     * <p>没装 hook 时返回空串（PC/Docker 走环境变量与 policy，不需要它）。
     */
    public interface DanmakuHostProvider {
        String bundledHost();
    }

    private static volatile ContextProvider context;
    private static volatile Logger logger;
    private static volatile ClassLoaderHook classLoader;
    private static volatile DanmakuHostProvider danmakuHost;

    public static void installContext(ContextProvider p) {
        context = p;
    }

    public static void installLogger(Logger l) {
        logger = l;
    }

    public static void installClassLoader(ClassLoaderHook h) {
        classLoader = h;
    }

    /**
     * 只在还没装过时挂载。
     *
     * <p><b>为什么要有这个版本</b>：TV 端在 {@code GatewayServer} 里装 DexClassLoader 钩子，
     * JVM 端在 {@code initAfterArgs} 里装 URLClassLoader 钩子——两边跑的是同一份
     * {@code ApiServer}，谁先装谁生效。用"强制覆盖"会让后启动的一方顶掉另一方
     * （TV 上顶掉就是所有 jar 站点 ClassNotFound，且不报错、只是空）。
     */
    public static synchronized void installClassLoaderIfAbsent(ClassLoaderHook h) {
        if (classLoader == null) classLoader = h;
    }

    public static void installDanmakuHost(DanmakuHostProvider p) {
        danmakuHost = p;
    }

    /**
     * 配置导入完成的回调（平台侧同步自己的表）。
     *
     * <p><b>为什么需要</b>：TV 端有**两套站点表**——
     * <ul>
     *   <li>网关的 {@code config.sites.json}（{@code ApiServer} 读，管 drpy/CMS/jar 全部站）</li>
     *   <li>端上的 {@code LocalSites}（SharedPreferences，只管"能执行"的 csp_+jar 子集）</li>
     * </ul>
     * {@code /api/config/import} 原来只写前者，结果设置页里"导入成功 37 站"，
     * 但 jar 站一个都调不通（{@code ClassNotFoundException}）——用户完全看不出为什么。
     * 反向的 {@code meowTv.importLocalConfig} 又只写后者。两边各写一半。
     *
     * <p>这里让"网关导入"成为唯一入口，平台侧只负责被通知后补自己的那份。
     */
    public interface ConfigImportHook {
        /**
         * @param rawConfigJson 本次导入的配置原文（已解析成功的 JSON 文本）
         * @param configBase    配置地址，用于把 {@code ./jar/x.jar} 这类相对路径补全
         * @param replace       true = 替换模式（平台侧要先清掉旧表）
         */
        void onImported(String rawConfigJson, String configBase, boolean replace);
    }

    private static volatile ConfigImportHook configImport;

    public static void installConfigImport(ConfigImportHook h) {
        configImport = h;
    }

    /** 配置导入成功后由 {@code ApiServer} 调用；没装钩子（JVM）就是空操作。 */
    public static void notifyConfigImported(String rawConfigJson, String configBase, boolean replace) {
        ConfigImportHook h = configImport;
        if (h == null) return;
        try {
            h.onImported(rawConfigJson, configBase, replace);
        } catch (Throwable ignored) {
            // 平台侧同步失败不能影响已完成的导入（文件已经写好了）
        }
    }

    /** 当前本机模块弹幕地址；空串 = 没有/不可用。 */
    public static String danmakuHost() {
        DanmakuHostProvider p = danmakuHost;
        if (p == null) return "";
        try {
            String v = p.bundledHost();
            return v == null ? "" : v;
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 按全限定名加载类。
     *
     * <p>没装 hook 时退回 {@code Class.forName}（JVM 的默认行为），
     * 所以后端不需要显式注册任何东西。
     */
    public static Class<?> loadClass(String fqcn) throws ClassNotFoundException {
        ClassLoaderHook h = classLoader;
        if (h == null) return Class.forName(fqcn);
        return h.loadClass(fqcn);
    }

    /** 取注入的 Context；没装返回 null（JVM 侧会退回 stub 造实例）。 */
    public static Object context() {
        ContextProvider p = context;
        return p == null ? null : p.get();
    }

    /** 统一日志出口。注意参数拼接发生在调用方，热路径别在这里做格式化。 */
    public static void log(String line) {
        Logger l = logger;
        if (l != null) {
            l.log(line);
            return;
        }
        System.out.println(line);
    }

    /** 清空注入（Android Activity 销毁时调用，避免静态引用泄漏）。 */
    public static void reset() {
        context = null;
        logger = null;
        classLoader = null;
        danmakuHost = null;
    }
}
