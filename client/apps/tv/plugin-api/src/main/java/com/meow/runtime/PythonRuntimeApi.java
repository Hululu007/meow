package com.meow.runtime;

/**
 * Python 运行时的调用契约（宿主 ←→ 模块）。
 *
 * <p><b>与 {@link NodeRuntimeApi} 的关键差别</b>：libnode 的 .so 能从 APK 内直接
 * dlopen（DexClassLoader 的 nativePath 指 `apk!/lib/abi`），而 Chaquopy 的
 * **stdlib 在模块 APK 的 assets 里**——只有该包的 AssetManager 读得到。
 * 所以宿主必须把自己的 Context 传进来，模块用
 * {@code hostContext.createPackageContext(自己的包名, 0)} 拿到"能读自己 assets
 * 的 Context"，再交给 {@code Python.start(new AndroidPlatform(modContext))}。
 *
 * <p><b>为什么 context 参数是 Object</b>：plugin-api 这个 Gradle 模块不允许
 * import android.*（它要能被任何宿主编译）。宿主传 Context，模块内部强转；
 * 这是本仓库既有的取舍（见 {@link RuntimePlugin} 的说明）。
 */
public interface PythonRuntimeApi extends RuntimePlugin {

    /**
     * 启动 Python 的 HTTP 服务（**阻塞**，跑在调用线程上，与 node 的
     * {@code startProcess} 同一模型）。
     *
     * <p>协议与 drpy 同形：`POST /{site}/{action}` + `X-DRPY-Api` 头，
     * 所以宿主的 `callScriptRuntime()` 一行都不用改，只要把 jsRuntime 指向这里。
     *
     * @param hostContext 宿主的 Context（模块拿它 createPackageContext）
     * @param scriptsDir  源脚本根目录，其下需有 `py/`；`base/` 可来自模块自带
     * @param port        监听端口（宿主探好的具体值，不能传 0）
     * @param drpyUpstream `.js` 转发目标；空串 = 不转发（TV 上指向同机 QuickJS）
     * @return 退出码；正常运行时不会返回
     */
    int startServer(Object hostContext, String scriptsDir, int port, String drpyUpstream)
            throws Exception;

    /** Python 是否已初始化成功（诊断用）。 */
    boolean ready();

    /** Python 版本号字符串（诊断用）；未初始化返回空串。 */
    String pythonVersion();
}
