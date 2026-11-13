package com.meow.tv.runtime;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 弹幕载荷（danmu_api）的下载落盘与选版。
 *
 * <p><b>为什么载荷要和运行时模块分开</b>：模块是"通用 node 运行时"（~50MB，按 ABI），
 * 载荷是可替换的业务代码（~10MB，与 PC 的 danmu-api 插件同一份）。分开之后：
 * <ul>
 *   <li>换弹幕逻辑不用重装 50MB 的模块；</li>
 *   <li>壳的 APK 也不必再内嵌这 10MB（下个版本会从 assets 删掉）。</li>
 * </ul>
 *
 * <p><b>目录约定</b>：{@code files/danmu-payload/<version>/} + 一个 {@code current}
 * 文本指针。选版只认指针，不扫目录 —— 扫目录在"两个版本同时存在"时会选错。
 *
 * <p><b>为什么解压要先落 tmp 再改名</b>：解压中断（TV 断电/进程被杀）会留下半个目录，
 * 直接当版本目录用会让 node 起不来且看起来像"载荷坏了"。先解到 {@code <ver>.tmp}，
 * 校验入口文件齐全后再原子改名。
 */
public final class RuntimePayloadHost {

    /** packages.json 里 TV 载荷的条目 id。与 PC 的 danmu-api 是同一个资产。 */
    public static final String PKG_ID = "danmu-payload";

    /** 载荷里的入口（与 fpk 打包脚本的校验同款判据）。 */
    private static final String ENTRY = "danmu_api/server.js";

    private RuntimePayloadHost() {
    }

    public static File root(Context ctx) {
        return new File(ctx.getFilesDir(), "danmu-payload");
    }

    /** 已安装版本；没有/不完整返回空串。 */
    public static String installedVersion(Context ctx) {
        File dir = currentDir(ctx);
        if (dir == null) return "";
        return dir.getName();
    }

    /** 当前版本的载荷目录；未安装或入口缺失返回 null（调用方按"回退 assets"处理）。 */
    public static File currentDir(Context ctx) {
        try {
            File cur = new File(root(ctx), "current");
            if (!cur.isFile()) return null;
            byte[] b = new byte[(int) Math.min(cur.length(), 64)];
            try (InputStream in = new FileInputStream(cur)) {
                int n = in.read(b);
                if (n <= 0) return null;
            }
            String ver = new String(b, 0, b.length, "UTF-8").trim();
            if (ver.isEmpty() || ver.contains("/") || ver.contains("..")) return null;
            File dir = new File(root(ctx), ver);
            if (!new File(dir, ENTRY).isFile()) return null;
            return dir;
        } catch (Throwable t) {
            android.util.Log.w("MeowNode", "payload currentDir failed: " + t);
            return null;
        }
    }

    /**
     * 从 packages.json 里挑载荷条目。
     *
     * <p>platform 必须含 {@code android}（不带 ABI：载荷是纯 JS，与架构无关）。
     * 缺 platform 一律不放行 —— 与模块同一套"宁可报错也不装错包"的口径。
     */
    public static JSONObject pick(String packagesJson) throws Exception {
        JSONObject root = new JSONObject(packagesJson);
        JSONObject pkgs = root.optJSONObject("packages");
        if (pkgs == null) throw new Exception("清单里没有 packages");
        JSONObject o = pkgs.optJSONObject(PKG_ID);
        if (o == null) throw new Exception("清单里没有 " + PKG_ID + "（请先更新应用）");
        JSONArray arr = o.optJSONArray("platform");
        boolean android = false;
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                if ("android".equalsIgnoreCase(arr.optString(i, ""))) { android = true; break; }
            }
        }
        if (!android) throw new Exception("清单里的 " + PKG_ID + " 不含 android 平台");
        if (o.optString("url", "").isEmpty() || o.optString("sha256", "").isEmpty()) {
            throw new Exception("清单该条目缺 url/sha256");
        }
        JSONObject out = new JSONObject(o.toString());
        out.put("id", PKG_ID);
        return out;
    }

    /**
     * 把已下载且已通过 sha256 校验的 zip 装成当前版本。
     *
     * @return 装好的版本号；失败抛异常（消息直接给用户看）
     */
    public static String apply(Context ctx, File zip, String version) throws Exception {
        if (zip == null || !zip.isFile()) throw new Exception("下载文件不存在");
        String ver = version == null ? "" : version.trim();
        if (ver.isEmpty() || ver.contains("/") || ver.contains("..")) throw new Exception("版本号非法");

        File rootDir = root(ctx);
        if (!rootDir.isDirectory() && !rootDir.mkdirs() && !rootDir.isDirectory()) {
            throw new Exception("无法创建载荷目录");
        }
        File tmp = new File(rootDir, ver + ".tmp");
        deleteTree(tmp);
        if (!tmp.mkdirs() && !tmp.isDirectory()) throw new Exception("无法创建临时目录");

        try {
            unzip(zip, tmp);
            if (!new File(tmp, ENTRY).isFile()) {
                throw new Exception("载荷不完整（缺 " + ENTRY + "）");
            }
            File dst = new File(rootDir, ver);
            deleteTree(dst);
            if (!tmp.renameTo(dst)) throw new Exception("落位失败（rename）");
            writeText(new File(rootDir, "current"), ver);
            prune(rootDir, ver);
            return ver;
        } finally {
            deleteTree(tmp);
        }
    }

    // ---------------------------------------------------------------- 内部

    /** 解压；拒绝 `../` 之类的越界条目（zip slip）。 */
    private static void unzip(File zip, File dst) throws Exception {
        String base = dst.getCanonicalPath() + File.separator;
        try (ZipFile zf = new ZipFile(zip)) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            byte[] buf = new byte[8192];
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                String name = e.getName();
                if (name == null || name.isEmpty()) continue;
                File out = new File(dst, name);
                String canon = out.getCanonicalPath();
                if (!canon.startsWith(base)) throw new Exception("载荷里有越界路径：" + name);
                if (e.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new Exception("无法创建目录：" + parent.getName());
                }
                try (InputStream in = zf.getInputStream(e);
                     FileOutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
        }
    }

    private static void writeText(File f, String text) throws Exception {
        try (FileOutputStream os = new FileOutputStream(f)) {
            os.write(text.getBytes("UTF-8"));
        }
    }

    /** 只留当前版本（10MB/版，没必要留历史；旧版本由 next 下载重新拉）。 */
    private static void prune(File rootDir, String keep) {
        File[] fs = rootDir.listFiles();
        if (fs == null) return;
        for (File f : fs) {
            if (!f.isDirectory()) continue;
            if (keep.equals(f.getName())) continue;
            deleteTree(f);
        }
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] fs = f.listFiles();
            if (fs != null) for (File c : fs) deleteTree(c);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
