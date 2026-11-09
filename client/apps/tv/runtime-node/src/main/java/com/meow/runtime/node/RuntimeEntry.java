package com.meow.runtime.node;

import com.meow.runtime.NodeRuntimeApi;

import java.io.File;

/**
 * 模块入口：宿主通过 {@code DexClassLoader} 加载本类，再按 {@link NodeRuntimeApi} 调用。
 *
 * <p><b>加载链</b>（宿主侧负责）：
 * <pre>
 * DexClassLoader(moduleSourceDir, nativePath="module.apk!/lib/&lt;abi&gt;", …)
 *   → Class.forName("com.meow.runtime.node.RuntimeEntry", true, loader)
 *   → newInstance() → 按接口调用
 * </pre>
 * 关键在 nativePath：`System.loadLibrary("meow_node_bridge")` 用的是
 * **加载本类的那个 ClassLoader 的 librarySearchPath**，所以桥 .so 和它
 * DT_NEEDED 的 libnode.so 都会从模块 APK 的 zip 内路径解析出来 ——
 * 不需要解压到可写目录（Android 10+ 禁止从可写目录 dlopen）。
 */
public final class RuntimeEntry implements NodeRuntimeApi {

    static {
        System.loadLibrary("meow_node_bridge");
    }

    @Override
    public String id() {
        return "node";
    }

    @Override
    public String versionName() {
        return "18.20.4";
    }

    @Override
    public int startProcess(String workDir, String[] argv) {
        if (argv == null || argv.length == 0) {
            throw new IllegalArgumentException("argv is empty");
        }
        return NodeBridge.startProcess(workDir, argv);
    }

    @Override
    public boolean loaded() {
        return true; // 静态块成功执行才会走到这里
    }

    @Override
    public String libraryPath() {
        try {
            // 只是诊断展示：模块自己的 APK 路径
            return RuntimeEntry.class.getProtectionDomain()
                    .getCodeSource().getLocation().getPath();
        } catch (Throwable t) {
            return "";
        }
    }

    /** 供宿主探测是否有可写的 cwd（模块内部不用，留作诊断）。 */
    static boolean canWrite(String dir) {
        try {
            File f = new File(dir);
            return f.isDirectory() && f.canWrite();
        } catch (Throwable t) {
            return false;
        }
    }
}
