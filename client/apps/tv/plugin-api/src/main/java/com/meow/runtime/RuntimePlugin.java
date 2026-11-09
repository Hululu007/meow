package com.meow.runtime;

/**
 * 运行时模块的标记接口。
 *
 * <p>宿主与模块**各编译一份**（同一个 Gradle 模块），靠"类名+方法签名完全一致"
 * 在运行时对齐：宿主用 {@code DexClassLoader(模块APK, nativePath)} 加载模块里的
 * 实现类，再按本接口做类型转换。这要求两边的接口**逐字相同** —— 所以接口
 * 一旦改动，宿主与所有已安装模块必须同批升级（因此模块清单里有
 * {@code compatibilityId}）。
 *
 * <p>与 Fongmi 的 {@code com.github.catvod.runtime.RuntimePlugin} 同一形态。
 */
public interface RuntimePlugin {

    /** 模块 id，与 catalog.json 里的一致，如 {@code node}。 */
    String id();

    /** 模块版本名，用于诊断展示。 */
    String versionName();
}
