package com.meow.runtime;

/**
 * Node 运行时的调用契约（宿主 ←→ 模块）。
 *
 * <p><b>为什么参数全是 String/原始类型</b>：见 {@link RuntimePlugin} 的说明 ——
 * 接口要能被宿主与模块各编译一份，不能带 android.* 类型。
 * 模块内部自己去 `PackageManager` 拿自己的 nativeLibraryDir。
 *
 * <p><b>调用模型</b>：{@link #startProcess} 是**阻塞**的（node 的 event loop 跑在
 * 调用线程上），宿主必须放在专用线程；返回时 node 已退出。
 */
public interface NodeRuntimeApi extends RuntimePlugin {

    /**
     * 启动 node，阻塞直到 node 退出。
     *
     * @param workDir 工作目录（node 的 cwd，也是相对 require 的根）
     * @param argv    node 参数，如 {@code ["node", "/data/.../server.js"]}
     *                （第 0 个是进程名，与命令行一致）
     * @return node 退出码
     */
    int startProcess(String workDir, String[] argv) throws Exception;

    /** 模块里 libnode 是否已成功装载（诊断用）。 */
    boolean loaded();

    /** libnode.so 的绝对路径（诊断用）。 */
    String libraryPath();
}
