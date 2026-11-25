package jvm;

/**
 * 裁剪自检：确认"本平台实际会用的"原生库都在。
 *
 * 背景：guard-libs 会按目标平台裁掉别的平台的 .so/.dll/.dylib
 * （见 tools/guard/trim-guard-libs.sh|ps1）。裁剪规则依赖上游目录名，
 * 一旦 unidbg/jna 升级改了命名，只会在用户第一次用加密源时炸。
 * 探针把这一步提前到构建期。
 *
 * ★ 两条后端必须分开探（2026-11-25 实测）：
 *   · GuardShellMain 只在 os.name 含 "linux" 时 addBackendFactory(Unicorn2Factory)，
 *     走 unidbg-unicorn2 的 natives/（libunicorn.so）；
 *   · 其余平台（Windows）用 builder 默认的 legacy 后端 → UnicornBackend，
 *     加载 unicorn-1.0.15.jar 里的 unicorn_java.dll。
 *   只探一条的话，另一种平台会放行"裁掉了自己那份 .so/.dll"的包 ——
 *   Windows 实测报 "native library not found: natives/windows_64/unicorn_java.dll"，
 *   Linux 侧 legacy 绑定根本加载不起来（undefined symbol），所以必须按平台分支。
 *
 * 不参与业务，只被构建脚本以 `java -cp "guard-libs/*" jvm.GuardNativeProbe` 调用；
 * 成功输出 guard-native-ok，失败抛错（构建脚本按退出码拦截）。
 */
public final class GuardNativeProbe {

    public static void main(String[] args) throws Exception {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("linux")) {
            // Linux 产品路径：unicorn2（GuardShellMain 显式加的 backend）
            Class.forName("com.github.unidbg.arm.backend.Unicorn2Factory");
        } else {
            // Windows 产品路径：legacy（builder 默认），unicorn.Unicorn 的静态块加载 unicorn_java
            Class.forName("unicorn.Unicorn");
        }
        // keystone / capstone 都走 JNA，触发 libjnidispatch 加载
        com.sun.jna.Native.getLastError();
        System.out.println("guard-native-ok");
    }
}
