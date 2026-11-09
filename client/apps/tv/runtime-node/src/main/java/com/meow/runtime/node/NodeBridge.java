package com.meow.runtime.node;

/** native 桥（见 cpp/node_bridge.cpp）。只暴露一个方法。 */
final class NodeBridge {

    private NodeBridge() {
    }

    /**
     * 阻塞运行 node，返回退出码。
     *
     * @param workDir node 的 cwd
     * @param argv    参数，第 0 个是进程名（与命令行一致）
     */
    static native int startProcess(String workDir, String[] argv);
}
