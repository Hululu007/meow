package com.meow.tv.runtime;

import android.content.Context;
import android.content.pm.PackageInfo;

import com.meow.runtime.NodeRuntimeApi;

import java.io.File;

import dalvik.system.DexClassLoader;

/**
 * 宿主侧的运行时模块加载器（对应 Fongmi 的 {@code RuntimeModule.createEntry}）。
 *
 * <p><b>关键点：为什么 nativePath 要写成 {@code apk!/lib/<abi>}</b>
 * —— Android 10+ 禁止从可写目录 dlopen，但也**不能**去读别的 App 的
 * {@code nativeLibraryDir}（SELinux 不稳）。唯一稳妥的路径是
 * "只读 APK 的 zip 内 lib"，动态链接器原生支持这种写法：
 * <pre>
 * new DexClassLoader(moduleSourceDir, odexDir, moduleSourceDir + "!/lib/" + abi, parent)
 * </pre>
 * 模块代码里的 {@code System.loadLibrary("meow_node_bridge")} 会用**这个**
 * librarySearchPath，于是桥 .so 和它 DT_NEEDED 的 libnode.so 一起被解析出来。
 *
 * <p><b>接口类为什么要从父加载器拿</b>：模块 APK 里也编了一份
 * {@code com.meow.runtime.NodeRuntimeApi}。DexClassLoader 是 parent-first，
 * 会先命中宿主自己那份 —— 所以模块实现类实现的正是宿主的接口，
 * {@code instanceof} / 强转才成立。两边接口必须逐字一致（见 plugin-api 注释）。
 */
public final class RuntimeModuleHost {

    /** 运行时模块的包名（固定，不随版本变）。 */
    public static final String NODE_PACKAGE = "com.meow.runtime.node";
    /** 模块入口类（固定 FQCN）。 */
    public static final String NODE_ENTRY = "com.meow.runtime.node.RuntimeEntry";

    private RuntimeModuleHost() {
    }

    /** 模块是否已安装。 */
    public static boolean nodeInstalled(Context ctx) {
        try {
            return ctx.getPackageManager().getPackageInfo(NODE_PACKAGE, 0) != null;
        } catch (Throwable t) {
            return false;
        }
    }

    /** {@code ApplicationInfo.primaryCpuAbi} 是 @hide，反射读；失败返回空串。 */
    private static String primaryCpuAbi(android.content.pm.ApplicationInfo ai) {
        try {
            java.lang.reflect.Field f =
                    android.content.pm.ApplicationInfo.class.getField("primaryCpuAbi");
            Object v = f.get(ai);
            return v == null ? "" : String.valueOf(v);
        } catch (Throwable t) {
            return "";
        }
    }

    /** 已安装模块的版本名（诊断用）。 */
    public static String nodeVersion(Context ctx) {
        try {
            PackageInfo info = ctx.getPackageManager().getPackageInfo(NODE_PACKAGE, 0);
            return info == null ? "" : String.valueOf(info.versionName);
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 取得模块入口实例；未安装/加载失败返回 null（**不抛**，调用方按"不可用"处理）。
     */
    public static NodeRuntimeApi nodeEntry(Context ctx) {
        try {
            PackageInfo info = ctx.getPackageManager().getPackageInfo(NODE_PACKAGE, 0);
            if (info == null || info.applicationInfo == null) return null;
            String apk = info.applicationInfo.sourceDir;
            // 模块里 so 的实际 ABI：优先读 ApplicationInfo.primaryCpuAbi
            // （@hide 字段，反射拿；读不到就退回本机首选 ABI —— 试点场景两者一致）
            String abi = primaryCpuAbi(info.applicationInfo);
            if (abi == null || abi.isEmpty()) {
                String[] abis = android.os.Build.SUPPORTED_ABIS;
                abi = abis != null && abis.length > 0 ? abis[0] : "arm64-v8a";
            }
            File odex = new File(ctx.getCodeCacheDir(), "runtime-node");
            if (!odex.isDirectory() && !odex.mkdirs() && !odex.isDirectory()) {
                return null;
            }
            String nativePath = apk + "!/lib/" + abi;
            DexClassLoader loader = new DexClassLoader(
                    apk, odex.getAbsolutePath(), nativePath, ctx.getClassLoader());
            Class<?> impl = Class.forName(NODE_ENTRY, true, loader);
            return (NodeRuntimeApi) impl.getConstructor().newInstance();
        } catch (Throwable t) {
            android.util.Log.w("MeowNode", "load module failed: " + t);
            return null;
        }
    }
}
