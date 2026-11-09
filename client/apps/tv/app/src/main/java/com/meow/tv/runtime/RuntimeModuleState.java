package com.meow.tv.runtime;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;

/**
 * 运行时模块的状态文件（`files/runtime-module.json`）。
 *
 * <p><b>为什么不用 SharedPreferences</b>：模块跑在 `:node` 独立进程，状态由它写、
 * 由主进程（网关/设置页）读。SharedPreferences 在每个进程里各有一份内存缓存，
 * 跨进程写入不会让另一边失效 —— 实测表现是"模块起来了，设置页一直显示未运行"。
 * 换成一个几百字节的 JSON 文件，读一次就是最新值。
 *
 * <p>字段：
 * <pre>
 *   enabled  用户开关（默认 true：装了就该能用）
 *   running  进程是否在跑
 *   port     实际监听端口（探测得来，不是常量）
 *   version  模块版本名
 *   error    最近一次失败原因（空 = 正常）
 * </pre>
 */
public final class RuntimeModuleState {

    private static final String FILE = "runtime-module.json";

    /** 首选端口；被占用则顺延（见 NodeService.pickPort）。 */
    public static final int DEFAULT_PORT = 19341;

    private RuntimeModuleState() {
    }

    private static File file(Context ctx) {
        return new File(ctx.getFilesDir(), FILE);
    }

    /** 读全量；文件不存在/损坏返回空对象（调用方按默认值处理）。 */
    public static JSONObject read(Context ctx) {
        try {
            File f = file(ctx);
            if (!f.isFile()) return new JSONObject();
            byte[] buf = new byte[(int) f.length()];
            try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
                raf.readFully(buf);
            }
            String text = new String(buf, "UTF-8").trim();
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } catch (Throwable t) {
            return new JSONObject();
        }
    }

    /** 合并写一个字段（读-改-写，串行化）。 */
    public static void put(Context ctx, String key, Object value) {
        synchronized (RuntimeModuleState.class) {
            try {
                JSONObject o = read(ctx);
                o.put(key, value);
                o.put("updatedAt", System.currentTimeMillis());
                write(ctx, o);
            } catch (Throwable ignored) {
            }
        }
    }

    /** 一次写多个字段（避免多次读改写互相覆盖）。 */
    public static void putAll(Context ctx, JSONObject patch) {
        synchronized (RuntimeModuleState.class) {
            try {
                JSONObject o = read(ctx);
                java.util.Iterator<String> it = patch.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    o.put(k, patch.get(k));
                }
                o.put("updatedAt", System.currentTimeMillis());
                write(ctx, o);
            } catch (Throwable ignored) {
            }
        }
    }

    private static void write(Context ctx, JSONObject o) {
        try (FileOutputStream fos = new FileOutputStream(file(ctx))) {
            fos.write(o.toString().getBytes("UTF-8"));
        } catch (Throwable t) {
            android.util.Log.w("MeowNode", "write state failed", t);
        }
    }

    /** 用户开关；没写过 = 开（装了模块就默认启用）。 */
    public static boolean enabled(Context ctx) {
        return read(ctx).optBoolean("enabled", true);
    }

    /** 当前端口；没记录时用默认值。 */
    public static int port(Context ctx) {
        int p = read(ctx).optInt("port", DEFAULT_PORT);
        return p > 0 ? p : DEFAULT_PORT;
    }

    /** 正在跑且用户没关。 */
    public static boolean active(Context ctx) {
        JSONObject o = read(ctx);
        return o.optBoolean("running", false) && o.optBoolean("enabled", true);
    }
}
