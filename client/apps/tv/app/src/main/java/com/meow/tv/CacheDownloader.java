package com.meow.tv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;

import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 把缓存导出到 U 盘 / 外接存储。
 *
 * <p><b>为什么用 SAF 而不是直接写 /storage/xxxx</b>：targetSdk 34 下分区存储
 * 生效，直接按路径写外部存储需要 MANAGE_EXTERNAL_STORAGE（敏感权限，且
 * 应用商店会拦）。SAF 让用户点一次目录授权，之后靠持久化的 tree URI 写，
 * 不需要任何权限声明，Android 9 到 14 行为一致。
 *
 * <p><b>为什么下载放在原生而不是 WebView</b>：Chrome 66 不支持
 * File System Access API / OPFS，网页侧没有能力把大文件写到 U 盘。
 *
 * <p>线程模型：下载跑在独立线程，进度写静态字段供 JS 轮询（WebView 的
 * evaluateJavascript 是单次的，没有回调通道）。
 */
public final class CacheDownloader {

    private static final String PREF = "meow_tv";
    private static final String K_TREE = "cache_tree_uri";
    private static final int REQ_TREE = 0x4D01;

    /** 当前进度（一次只跑一个：TV 上并发写同一目录没有意义，也更容易触发限流） */
    static final AtomicInteger percent = new AtomicInteger(0);
    static volatile String state = "idle";   // idle|running|done|failed
    static volatile String message = "";
    static volatile String lastFile = "";

    private CacheDownloader() {
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    /** 已授权的目录描述；没授权返回空串。 */
    public static String dirLabel(Context c) {
        String s = prefs(c).getString(K_TREE, "");
        if (s == null || s.isEmpty()) return "";
        try {
            Uri tree = Uri.parse(s);
            String docId = DocumentsContract.getTreeDocumentId(tree);
            // docId 形如 "primary:Movies" / "1A2B-3C4D:影视"，去掉卷标前缀更可读
            int colon = docId.indexOf(':');
            String tail = colon >= 0 ? docId.substring(colon + 1) : docId;
            return tail.isEmpty() ? docId : tail;
        } catch (Throwable t) {
            return s;
        }
    }

    /** 打开系统文件选择器让用户选一个目录（U 盘 / 内置存储均可）。 */
    public static boolean pickDir(Activity a) {
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            a.startActivityForResult(i, REQ_TREE);
            return true;
        } catch (Throwable t) {
            message = "这台设备没有系统文件选择器，无法授权 U 盘目录：" + t.getMessage();
            state = "failed";
            return false;
        }
    }

    /** MainActivity.onActivityResult 转发进来；返回 true 表示已处理。 */
    public static boolean handleResult(Activity a, int reqCode, int resultCode, Intent data) {
        if (reqCode != REQ_TREE) return false;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            message = "已取消目录授权";
            state = "idle";
            return true;
        }
        Uri tree = data.getData();
        try {
            // 必须持久化，否则重启后 URI 失效，用户每次都要重选
            a.getContentResolver().takePersistableUriPermission(tree,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Throwable ignored) {
        }
        prefs(a).edit().putString(K_TREE, tree.toString()).apply();
        message = "已授权目录：" + dirLabel(a);
        state = "idle";
        return true;
    }

    /**
     * 开始下载一个导出文件到已授权目录。
     *
     * @return 立即返回的一句话结果（真正的进度靠 cacheState 轮询）
     */
    public static String start(Activity a, String url, String name, String ep) {
        final String treeStr = prefs(a).getString(K_TREE, "");
        if (treeStr == null || treeStr.isEmpty()) {
            message = "还没有授权保存目录。先点「设置U盘目录」选一个位置。";
            state = "failed";
            return message;
        }
        if ("running".equals(state)) {
            return "已有下载在进行：" + message;
        }
        state = "running";
        percent.set(0);
        message = "准备下载…";
        final String base = safeName((name == null ? "" : name) + (ep == null || ep.isEmpty() ? "" : " - " + ep));

        new Thread(() -> {
            final OkHttpClient http = new OkHttpClient.Builder()
                    .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                    /*
                     * ★ 读超时必须有上限（原来是 0 = 永不超时）。
                     *
                     * OkHttp 的 readTimeout 是"两次读之间允许的空闲"，不是总时长：
                     * 慢速下载只要还在冒数据就不会超时。而 0 的代价是——网络中途
                     * 断掉（拔网线、代理死链）时线程**永远**等下去，任务卡在
                     * "进行中"，后续缓存下载全被 busy 标志挡住，用户看到的是
                     * "点了没反应"。60 秒一个字节都没有 = 确实死了。
                     */
                    .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                    .build();
            Response resp = null;
            try {
                Request req = new Request.Builder().url(url)
                        .header("User-Agent", "Mozilla/5.0").build();
                resp = http.newCall(req).execute();
                if (!resp.isSuccessful()) {
                    fail("HTTP " + resp.code());
                    return;
                }
                String fmt = resp.header("X-Meow-Export-Format", "ts");
                boolean mp4 = "mp4".equalsIgnoreCase(fmt);
                String mime = mp4 ? "video/mp4" : "video/mp2t";
                String fileName = base + (mp4 ? ".mp4" : ".ts");
                ResponseBody body = resp.body();
                long total = body == null ? -1 : body.contentLength();

                Uri tree = Uri.parse(treeStr);
                String docId = DocumentsContract.getTreeDocumentId(tree);
                Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
                Uri file = DocumentsContract.createDocument(
                        a.getContentResolver(), parent, mime, uniqueName(a, parent, fileName));
                if (file == null) {
                    fail("无法在所选目录创建文件（可能没有写权限）");
                    return;
                }
                long written = 0;
                try (InputStream in = body == null ? null : body.byteStream();
                     OutputStream out = a.getContentResolver().openOutputStream(file, "w")) {
                    if (in == null || out == null) {
                        fail("打开输出流失败");
                        return;
                    }
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        written += n;
                        if (total > 0) percent.set((int) Math.min(99, written * 100 / total));
                    }
                    out.flush();
                }
                percent.set(100);
                state = "done";
                lastFile = fileName;
                rememberSaved(a, file.toString(), fileName, written);
                message = "已保存：" + fileName + "（" + human(written) + (mp4 ? "，mp4" : "，.ts（未装 ffmpeg）") + "）";
            } catch (Throwable t) {
                fail("下载失败：" + t.getMessage());
            } finally {
                if (resp != null) resp.close();
            }
        }, "cache-save").start();
        return "已开始下载到 " + dirLabel(a);
    }

    /** JS 轮询用：一行 JSON。 */
    public static String stateJson() {
        return "{\"state\":\"" + state + "\",\"percent\":" + percent.get()
                + ",\"message\":\"" + escape(message) + "\",\"file\":\"" + escape(lastFile) + "\"}";
    }

    // ---------------------------------------------------------------- 已保存文件清单

    private static final String K_SAVED = "cache_saved";

    /**
     * 记一笔已保存文件。
     *
     * <p>为什么要记：文件在 U 盘上，应用的片库页读的是后端列表，看不到它。
     * 记下 content:// URI 后，应用内就能列出并直接交给 ExoPlayer 播放
     * （DefaultDataSource 原生支持 content://），不需要后端也不拷文件。
     */
    private static void rememberSaved(Activity a, String uri, String name, long bytes) {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(
                    prefs(a).getString(K_SAVED, "[]"));
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("uri", uri);
            o.put("name", name);
            o.put("bytes", bytes);
            o.put("at", System.currentTimeMillis());
            // 新的放最前，最多留 100 条（U 盘上的文件不会因为这里删记录而消失）
            org.json.JSONArray next = new org.json.JSONArray();
            next.put(o);
            for (int i = 0; i < arr.length() && i < 99; i++) next.put(arr.get(i));
            prefs(a).edit().putString(K_SAVED, next.toString()).apply();
        } catch (Throwable ignored) {
        }
    }

    /** 已保存文件清单（JSON 数组字符串，供 JS 直接 parse）。 */
    public static String savedJson(Context c) {
        return prefs(c).getString(K_SAVED, "[]");
    }

    /** 播放一个已保存到 U 盘的文件：交给原生 ExoPlayer（content:// 它能直接读）。 */
    public static boolean play(Activity a, String uri, String title) {
        if (uri == null || uri.isEmpty()) return false;
        try {
            return NativePlayerActivity.open(a, uri, title == null ? "" : title, "", 0);
        } catch (Throwable t) {
            return false;
        }
    }

    private static void fail(String msg) {
        state = "failed";
        message = msg;
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
    }

    private static String safeName(String raw) {
        if (raw == null) raw = "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length() && sb.length() < 100; i++) {
            char c = raw.charAt(i);
            if (c < 32 || c == '/' || c == '\\' || c == ':' || c == '*' || c == '?'
                    || c == '"' || c == '<' || c == '>' || c == '|') continue;
            sb.append(c);
        }
        String s = sb.toString().trim();
        return s.isEmpty() ? "meow" : s;
    }

    /**
     * 文件名去重交给系统：DocumentsContract.createDocument 遇到同名会自己加 (1)(2)，
     * 各厂商实现略有差异但都不会覆盖已有文件——比自己扫目录再拼后缀更稳，
     * 也避免在 SAF 上做一次可能很慢的目录查询。
     */
    private static String uniqueName(Context c, Uri parent, String fileName) {
        return fileName;
    }

    private static String human(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(java.util.Locale.US, "%.0f KB", bytes / 1024.0);
        if (bytes < 1024L * 1024 * 1024) return String.format(java.util.Locale.US, "%.1f MB", bytes / 1048576.0);
        return String.format(java.util.Locale.US, "%.2f GB", bytes / 1073741824.0);
    }
}
