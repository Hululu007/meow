package com.meow.tv.runtime;

import android.os.Build;

import org.json.JSONObject;

/**
 * 运行时模块的清单来源：**复用 PC 插件的 packages.json**（唯一清单）。
 *
 * <p><b>为什么不另造一份清单</b>：PC 的插件早就用 packages.json 下发
 * （fnpack.json → sync-packages.ps1 汇总 → Release 资产），字段里本来就有
 * {@code platform} / {@code size} / {@code sha256} / {@code url}。
 * 再开一份 runtime-modules.json 等于把"版本+哈希+地址"维护两遍，必然漂移。
 *
 * <p><b>ABI 用 platform 表达</b>：每个 ABI 一条包，
 * {@code platform: ["android-arm64-v8a"]}。客户端必须**硬校验** platform ——
 * PC 那边踩过"platform 缺失就放行"，结果 PC 下了 TV 的 APK。
 */
public final class RuntimeModuleCatalog {

    /** 模块包名（固定）。装之前会校验，防止清单指错包。 */
    public static final String PACKAGE = RuntimeModuleHost.NODE_PACKAGE;

    /** 与 App 自身更新同源：GitHub latest release 的固定别名。 */
    public static final String SOURCE =
            "https://github.com/upchr/meow/releases/latest/download/packages.json";

    private RuntimeModuleCatalog() {
    }

    /** 本机主 ABI（安装时选中的那个）。 */
    public static String abi() {
        String[] a = Build.SUPPORTED_ABIS;
        return a != null && a.length > 0 ? a[0] : "";
    }

    /**
     * 从 packages.json 里挑出本机该装的模块包。
     *
     * <p>按 SUPPORTED_ABIS 顺序找，**platform 必须含 `android-<abi>`**；
     * 一条都不匹配就抛（宁可报错，也不能装个架构不对的包 —— 那种失败
     * 表现为"装上了但 .so 加载不了"，比不装更难查）。
     */
    public static JSONObject pick(String packagesJson) throws Exception {
        return pick(packagesJson, "tv-node");
    }

    /**
     * 按 id 前缀挑模块包：`tv-node` / `tv-python` 各自独立。
     *
     * <p>以前这里写死 {@code id.startsWith("tv-node")} —— 清单里就算有
     * tv-python 条目也永远选不中，TV 侧等于没有 Python 模块的安装入口。
     */
    public static JSONObject pick(String packagesJson, String idPrefix) throws Exception {
        JSONObject root = new JSONObject(packagesJson);
        JSONObject pkgs = root.optJSONObject("packages");
        if (pkgs == null) throw new Exception("清单里没有 packages");

        String[] abis = Build.SUPPORTED_ABIS;
        if (abis == null || abis.length == 0) throw new Exception("设备没有报告支持的 ABI");

        /*
         * 「清单里压根没有这个模块」和「有模块但没这个 ABI」必须分开报。
         * 合成一句会在发布空档期误导人：tv-python 的 CI 链路（构建 + 自检 +
         * upload-artifact）早就通了，但**只有发版后** packages.json 里才会出现
         * tv-python-*；这期间报「本机 ABI 不支持」会让 arm64 用户以为自己的
         * 设备不行，实际是还没有包可下（2026-11-26 在 .76 上实测到这句误导）。
         */
        boolean anyOfPrefix = false;

        for (String abi : abis) {
            String want = "android-" + abi;
            java.util.Iterator<String> it = pkgs.keys();
            while (it.hasNext()) {
                String id = it.next();
                JSONObject o = pkgs.optJSONObject(id);
                if (o == null) continue;
                // 只认本模块的包（id 前缀），避免误挑到别的插件
                if (!id.startsWith(idPrefix)) continue;
                anyOfPrefix = true;
                if (!hasPlatform(o, want)) continue;
                String url = o.optString("url", "");
                String sha = o.optString("sha256", "");
                if (url.isEmpty() || sha.isEmpty()) continue;
                JSONObject out = new JSONObject(o.toString());
                out.put("id", id);
                out.put("abi", abi);
                return out;
            }
        }
        if (!anyOfPrefix) {
            throw new Exception("清单里还没有 " + idPrefix + " 模块（要等发版后才有）");
        }
        throw new Exception("清单里没有适配 " + abi() + " 的模块包");
    }

    private static boolean hasPlatform(JSONObject o, String want) {
        org.json.JSONArray arr = o.optJSONArray("platform");
        if (arr == null) return false;   // 缺 platform = 不匹配（不能放行）
        for (int i = 0; i < arr.length(); i++) {
            if (want.equalsIgnoreCase(arr.optString(i, ""))) return true;
        }
        return false;
    }
}
