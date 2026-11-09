package core;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 数据目录统一入口。
 *
 * <p>解决两个问题：
 * <ol>
 *   <li>原代码用 {@code new File("policy.json")} 这种相对路径，工作目录一变配置就丢
 *       （Docker 容器里会写到 {@code /} 下，容器重建即丢失）</li>
 *   <li>本地运行、容器运行、PC 内置三种场景的落盘位置不同，需要可配置</li>
 * </ol>
 *
 * <p>优先级：{@code -Dmeow.data} 系统属性 &gt; {@code MEOW_DATA} 环境变量
 * &gt; 命令行 {@code --data-dir=...} &gt; 默认 {@code ./data}。
 *
 * <p>目录结构：
 * <pre>
 *   data/
 *     policy.json          用户策略（弹幕 API、DNS 等）
 *     config.sites.json    多实例站点（可选）
 *     state/               进度/收藏（阶段 3）
 *     cache/               TTL 缓存（可丢）
 *     jar/                 spider jar 缓存（PC 内置时用）
 * </pre>
 */
public final class DataPaths {

    private static final String ENV_DATA = "MEOW_DATA";
    private static final String PROP_DATA = "meow.data";
    private static volatile Path root;

    private DataPaths() {
    }

    /** 数据根目录，首次调用时解析并创建。 */
    public static Path root() {
        Path r = root;
        if (r != null) return r;
        synchronized (DataPaths.class) {
            if (root != null) return root;
            root = resolveRoot();
            try {
                Files.createDirectories(root);
            } catch (Exception e) {
                System.out.println("[data] cannot create " + root + ": " + e);
            }
            System.out.println("[data] root = " + root.toAbsolutePath());
            return root;
        }
    }

    private static Path resolveRoot() {
        // 1) -Dmeow.data=...
        String prop = System.getProperty(PROP_DATA);
        if (prop != null && !prop.trim().isEmpty()) return Paths.get(prop.trim());

        // 2) MEOW_DATA 环境变量（Docker / PC sidecar 用）
        String env = System.getenv(ENV_DATA);
        if (env != null && !env.trim().isEmpty()) return Paths.get(env.trim());

        // 3) 命令行 --data-dir=...（PC sidecar 也可用参数传）
        for (String arg : MainArgs.get()) {
            if (arg.startsWith("--data-dir=")) {
                String v = arg.substring("--data-dir=".length()).trim();
                if (!v.isEmpty()) return Paths.get(v);
            }
        }

        // 4) 默认：当前工作目录下的 data/
        return Paths.get("data");
    }

    /** 数据根下的子路径（不保证存在）。 */
    public static Path of(String name) {
        return root().resolve(name);
    }

    /** 确保子目录存在并返回。 */
    public static Path dir(String name) {
        Path p = of(name);
        try {
            Files.createDirectories(p);
        } catch (Exception e) {
            System.out.println("[data] cannot create " + p + ": " + e);
        }
        return p;
    }

    // ------------------------------------------------------------ 读写辅助

    /** 读文本；文件不存在或失败返回 null。 */
    public static String read(String name) {
        Path p = of(name);
        if (!Files.isRegularFile(p)) return null;
        try {
            return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
        } catch (Exception e) {
            System.out.println("[data] read failed " + p + ": " + e);
            return null;
        }
    }

    /**
     * 原子写：先写 .tmp 再 rename，避免写一半被读到。
     *
     * @return 是否成功
     */
    public static boolean write(String name, String content) {
        Path p = of(name);
        Path tmp = p.resolveSibling(p.getFileName() + ".tmp");
        try {
            Files.createDirectories(p.getParent());
            Files.write(tmp, content.getBytes(StandardCharsets.UTF_8));
            Files.move(tmp, p, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            return true;
        } catch (Exception e) {
            System.out.println("[data] write failed " + p + ": " + e);
            try {
                Files.deleteIfExists(tmp);
            } catch (Exception ignored) {
            }
            return false;
        }
    }

    public static boolean exists(String name) {
        return Files.isRegularFile(of(name));
    }

    public static File file(String name) {
        return of(name).toFile();
    }

    /**
     * 命令行参数的全局载体。
     *
     * <p>因为 {@link DataPaths} 可能在 {@code main} 解析参数之前被调用
     * （静态初始化链），所以参数先存这里。
     */
    public static final class MainArgs {
        private static volatile String[] args = new String[0];

        private MainArgs() {
        }

        public static void set(String[] a) {
            args = a == null ? new String[0] : a;
        }

        public static String[] get() {
            return args;
        }
    }
}
