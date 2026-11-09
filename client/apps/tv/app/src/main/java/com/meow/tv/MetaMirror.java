package com.meow.tv;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 片库元数据与海报的**本地只读副本**。
 *
 * <p><b>为什么需要</b>：TV 的片库数据全部来自后端（{@code /api/library} 与
 * {@code /api/proxy/image}）。后端在 NAS 上，局域网断网、或者 NAS 重启的那几分钟里，
 * 用户看到的是一面灰色空墙——而"用 NAS 库就是为了局域网脱网访问"。
 *
 * <p><b>为什么是"只读副本"而不是独立数据源</b>：TV 不实现刮削、不直连 SMB。
 * 它只做一件事：**后端给出的数据顺手存一份，后端不可达时拿出来用**。
 * 这样不存在"两份数据谁覆盖谁"的问题——永远是后端优先。
 *
 * <p><b>存哪</b>：{@code filesDir/library/}（应用私有，免权限、卸载自动清理，
 * 不会被系统当缓存清掉）。目录布局与后端一致：
 * <pre>
 *   files/library/meta.json         元数据（片名 → 海报 URL）
 *   files/library/posters/&lt;hash&gt;.jpg
 * </pre>
 *
 * <p><b>为什么海报要单独存文件</b>：WebView 的 HTTP 缓存会被系统清理（尤其
 * 低内存的电视盒子），而且清理时不通知应用。自己存文件才可控。
 */
final class MetaMirror {

    private MetaMirror() {
    }

    /** 单张上限：防止把视频/畸形响应当图片存进来。 */
    private static final int MAX_ONE = 4 * 1024 * 1024;
    /** 整体配额：电视盒子存储小，200MB 已能存上千张。 */
    private static final long MAX_TOTAL = 200L * 1024 * 1024;

    static File dir(Context c) {
        File d = new File(c.getFilesDir(), "library");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    static File posterDir(Context c) {
        File d = new File(dir(c), "posters");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    static File metaFile(Context c) {
        return new File(dir(c), "meta.json");
    }

    /** 文件名：URL 的 SHA-1 前 32 位。与后端 PosterStore 同一套算法。 */
    static String hashOf(String url) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-1");
            byte[] d = md.digest(url.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 16; i++) {
                String h = Integer.toHexString(d[i] & 0xFF);
                if (h.length() == 1) sb.append('0');
                sb.append(h);
            }
            return sb.toString();
        } catch (Throwable t) {
            return Integer.toHexString(url.hashCode());
        }
    }

    /** 读元数据 JSON 文本；没有返回空串。 */
    static String readMeta(Context c) {
        try {
            File f = metaFile(c);
            if (!f.isFile() || f.length() == 0) return "";
            byte[] buf = new byte[(int) f.length()];
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n <= 0) break;
                    off += n;
                }
            }
            return new String(buf, "UTF-8");
        } catch (Throwable t) {
            return "";
        }
    }

    /** 写元数据 JSON 文本。 */
    static boolean writeMeta(Context c, String json) {
        if (json == null || json.isEmpty()) return false;
        try {
            File f = metaFile(c);
            File tmp = new File(f.getAbsolutePath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(json.getBytes("UTF-8"));
            }
            // 先写临时文件再 rename：写一半被杀不会留下半个 JSON
            return tmp.renameTo(f) || f.exists();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 下载一张海报到本地。
     *
     * @return 本地文件名；失败返回空串
     */
    static String fetchPoster(Context c, String url) {
        if (url == null || url.isEmpty()) return "";
        String name = hashOf(url) + ".jpg";
        File out = new File(posterDir(c), name);
        if (out.isFile() && out.length() > 0) return name;   // 已有就不重下
        HttpURLConnection conn = null;
        try {
            URL u = new URL(url);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            // 豆瓣图床有防盗链（不带 Referer 返回 418/403）
            conn.setRequestProperty("Referer", "https://movie.douban.com/");
            conn.setRequestProperty("User-Agent", "Mozilla/5.0");
            if (conn.getResponseCode() != 200) return "";
            int len = conn.getContentLength();
            if (len > MAX_ONE) return "";
            File tmp = new File(posterDir(c), name + ".tmp");
            long total = 0;
            try (InputStream in = conn.getInputStream();
                 FileOutputStream fos = new FileOutputStream(tmp)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > MAX_ONE) {
                        tmp.delete();
                        return "";
                    }
                    fos.write(buf, 0, n);
                }
            }
            if (!tmp.renameTo(out)) {
                tmp.delete();
                return "";
            }
            trimIfNeeded(c);
            return name;
        } catch (Throwable t) {
            return "";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 超配额时按修改时间删最旧的，降到 90%。 */
    private static void trimIfNeeded(Context c) {
        try {
            File[] files = posterDir(c).listFiles();
            if (files == null) return;
            long total = 0;
            for (File f : files) total += f.length();
            if (total <= MAX_TOTAL) return;
            java.util.Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            long target = (long) (MAX_TOTAL * 0.9);
            for (File f : files) {
                if (total <= target) break;
                long sz = f.length();
                if (f.delete()) total -= sz;
            }
        } catch (Throwable ignored) {
        }
    }

    /** 统计：{count, bytes}（设置页/诊断用）。 */
    static String stats(Context c) {
        try {
            File[] files = posterDir(c).listFiles();
            int n = 0;
            long bytes = 0;
            if (files != null) {
                for (File f : files) {
                    if (!f.isFile()) continue;
                    n++;
                    bytes += f.length();
                }
            }
            File m = metaFile(c);
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("posters", n);
            o.put("bytes", bytes);
            o.put("metaBytes", m.isFile() ? m.length() : 0);
            return o.toString();
        } catch (Throwable t) {
            return "{\"ok\":false}";
        }
    }

    /** 清空（设置页"清空本地缓存"用）。 */
    static boolean clear(Context c) {
        try {
            File[] files = posterDir(c).listFiles();
            if (files != null) for (File f : files) f.delete();
            metaFile(c).delete();
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
