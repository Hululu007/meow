package com.meow.tv.runtime;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

import com.meow.runtime.NodeRuntimeApi;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;

/**
 * node 运行时的宿主进程（{@code android:process=":node"}）。
 *
 * <p><b>为什么必须独立进程</b>：这台投影仪的 32 位 ART 在聚合搜索时已经在崩
 * （见 GatewayServer 的注释）；node 崩是 **native 级**（libnode + V8），
 * 主进程/网关进程绝不能被它带走。
 *
 * <p><b>端口是探出来的，不是常量</b>：19341 被占（另一个 danmu_api、上一次没退干净的
 * 进程）时，写死的端口会让 node 在 listen 阶段抛 EADDRINUSE 直接退出 ——
 * 界面只看到"没弹幕"，没有任何线索。这里按 PC 侧 sidecar 的做法
 * （{@code pick_port}）从 19341 起顺延，实际端口写进状态文件供网关/设置页读取。
 *
 * <p><b>代理端口关掉</b>：danmu_api 内部还有一个写死 5321 的代理服务，TV 上没人用，
 * 却同样会撞端口把整个 node 带走。载荷已打成"可配，0 = 关"。
 */
public class NodeService extends Service {

    /** 端口探测区间：19341 起，最多试 20 个。 */
    private static final int PORT_MIN = RuntimeModuleState.DEFAULT_PORT;
    private static final int PORT_TRIES = 20;

    private Thread worker;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (worker == null || !worker.isAlive()) {
            worker = new Thread(this::boot, "meow-node");
            worker.start();
        }
        return START_NOT_STICKY;
    }

    private void boot() {
        try {
            if (!RuntimeModuleState.enabled(this)) {
                // 用户关了：别起来，但把状态写清楚（设置页要显示"已关闭"而不是"未运行"）
                state(false, 0, "", "");
                android.util.Log.i("MeowNode", "module disabled by user");
                return;
            }
            if (!RuntimeModuleHost.nodeInstalled(getApplicationContext())) {
                state(false, 0, "", "运行时模块未安装");
                return;
            }
            String moduleVersion = RuntimeModuleHost.nodeVersion(getApplicationContext());
            NodeRuntimeApi api = RuntimeModuleHost.nodeEntry(getApplicationContext());
            if (api == null) {
                state(false, 0, moduleVersion, "模块加载失败（DexClassLoader 或 .so）");
                return;
            }

            int port = pickPort();
            if (port <= 0) {
                state(false, 0, moduleVersion, "没有可用端口（" + PORT_MIN + " 起 20 个都被占）");
                return;
            }

            // 载荷来源优先级（2026-11-13）：
            //   ① 下载目录 files/danmu-payload/<ver>（更新中心/运行时分区装的，可独立升级）
            //   ② 壳内 assets（兼容期兜底：老壳没有下载能力，新壳首次也可能还没网）
            //   ③ assets/node-payload 的 smoke stub
            File payload = RuntimePayloadHost.currentDir(getApplicationContext());
            if (payload != null) {
                android.util.Log.i("MeowNode", "payload: downloaded "
                        + payload.getName() + " @ " + payload.getAbsolutePath());
            } else {
                payload = unpackZip("node-payload-danmu.zip", "node-danmu");
                if (payload != null) {
                    android.util.Log.i("MeowNode", "payload: bundled assets（未下载或下载版不可用）");
                }
            }
            File script;
            if (payload != null) {
                // 真载荷：danmu_api（Node 服务，自带 /api/v2/fongmi/danmaku）
                writeEnv(payload, port);
                copyLauncher(payload);
                script = new File(payload, "launch.js");
            } else {
                payload = unpackPayload();
                if (payload == null) {
                    state(false, port, moduleVersion, "payload 解压失败");
                    return;
                }
                // smoke：assets/node-payload/server.js
                script = new File(payload, "server.js");
            }
            if (!script.isFile()) {
                state(false, port, moduleVersion, "启动脚本不存在: " + script.getName());
                return;
            }

            // node 的 argv[0] 是进程名，与命令行一致
            String[] argv = new String[]{"node", script.getAbsolutePath()};
            android.util.Log.i("MeowNode", "starting node: " + script
                    + " (module " + moduleVersion + ", port " + port + ")");
            state(true, port, moduleVersion, "");

            // 阻塞：node 的 event loop 就跑在本线程
            int code = api.startProcess(payload.getAbsolutePath(), argv);
            android.util.Log.i("MeowNode", "node exited: " + code);
            state(false, port, moduleVersion, code == 0 ? "" : "node 退出码 " + code);
        } catch (Throwable t) {
            // AbstractMethodError / NoSuchMethodError = 模块实现了旧版 plugin-api，
            // 与当前壳对不上。原文案（"AbstractMethodError: null"）用户看不懂，
            // 这里给一句能行动的。
            String msg;
            if (t instanceof AbstractMethodError || t instanceof NoSuchMethodError) {
                msg = "模块与当前应用不兼容（接口已变更），请更新运行时模块";
            } else {
                msg = t.getClass().getSimpleName() + ": " + t.getMessage();
            }
            state(false, 0, "", msg);
            android.util.Log.w("MeowNode", "node boot failed", t);
        }
    }

    /** 写运行状态（一次写全，避免读改写互相覆盖）。 */
    private void state(boolean running, int port, String version, String error) {
        try {
            JSONObject o = new JSONObject();
            o.put("running", running);
            if (port > 0) o.put("port", port);
            if (version != null && !version.isEmpty()) o.put("version", version);
            o.put("error", error == null ? "" : error);
            RuntimeModuleState.putAll(this, o);
        } catch (Throwable ignored) {
        }
    }

    /**
     * 找一个能绑 127.0.0.1 的端口。
     *
     * <p>只测 TCP 能不能 bind（和 PC 的 pick_port 同一判据）。探测与真正 listen 之间
     * 仍有微小竞态，但比起"写死端口必炸"，这个窗口可以接受。
     */
    private int pickPort() {
        for (int i = 0; i < PORT_TRIES; i++) {
            int p = PORT_MIN + i;
            try (ServerSocket s = new ServerSocket()) {
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress("127.0.0.1", p));
                return p;
            } catch (Throwable ignored) {
                // 被占，试下一个
            }
        }
        return 0;
    }

    /**
     * 从 assets 复制启动器到 payload 根。
     *
     * <p>为什么用 asset 文件而不是在 Java 里拼字符串：JS 里全是引号和换行，
     * 拼字符串会被转义/换行坑掉（踩过：heredoc 把 {@code \\n} 变成真换行，
     * 编译报"未结束的字符串文字"）。
     */
    private void copyLauncher(File payload) {
        File out = new File(payload, "launch.js");
        try (InputStream in = getAssets().open("launch.js");
             FileOutputStream fos = new FileOutputStream(out)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
        } catch (Throwable t) {
            android.util.Log.w("MeowNode", "copy launcher failed", t);
        }
    }

    /**
     * 把端口/绑定地址写进 {@code config/.env}，**保留 zip 里自带的其余配置**。
     *
     * <p>为什么要合并而不是覆盖：载荷自带 PC 那份 .env（SOURCE_ORDER、
     * VOD_SERVERS、超时……），覆盖掉等于把所有源都换成默认值。
     * dotenv 对同一文件内的重复键是后写覆盖，所以把我们的行追加到末尾即可。
     */
    private void writeEnv(File dir, int port) {
        try {
            // server.js: configDir = <payload>/config，envPath = configDir/.env
            File cfgDir = new File(dir, "config");
            if (!cfgDir.isDirectory() && !cfgDir.mkdirs() && !cfgDir.isDirectory()) {
                android.util.Log.w("MeowNode", "config dir unavailable: " + cfgDir);
            }
            File env = new File(cfgDir, ".env");
            // 我们的键：端口、绑定地址（回环，不对局域网暴露）、代理端口 0=关
            String[] ours = {
                    "DANMU_API_PORT=" + port,
                    "DANMU_API_BIND=127.0.0.1",
                    "DANMU_API_PROXY_PORT=0",
            };
            StringBuilder sb = new StringBuilder();
            if (env.isFile()) {
                try (java.io.BufferedReader r = new java.io.BufferedReader(
                        new java.io.InputStreamReader(
                                new java.io.FileInputStream(env), "UTF-8"))) {
                    String l;
                    while ((l = r.readLine()) != null) {
                        String t = l.trim();
                        // 丢掉旧的同名键，避免出现两个值
                        boolean skip = false;
                        for (String k : new String[]{"DANMU_API_PORT=", "DANMU_API_BIND=",
                                "DANMU_API_PROXY_PORT="}) {
                            if (t.startsWith(k)) {
                                skip = true;
                                break;
                            }
                        }
                        if (!skip) sb.append(l).append('\n');
                    }
                }
                if (sb.length() > 0 && sb.charAt(sb.length() - 1) != '\n') sb.append('\n');
            }
            for (String line : ours) sb.append(line).append('\n');
            try (FileOutputStream fos = new FileOutputStream(env)) {
                fos.write(sb.toString().getBytes("UTF-8"));
            }
            android.util.Log.i("MeowNode", "env -> " + env + " (port " + port + ", 回环绑定, 代理关闭)");
        } catch (Throwable t) {
            android.util.Log.w("MeowNode", "write .env failed", t);
        }
    }

    /**
     * 从 assets 解 zip 到 filesDir/<name>（幂等：有 .done 标记就跳过）。
     *
     * <p>为什么用 zip：danmu_api 载荷是 4000+ 个文件，逐个 asset 打开太慢，
     * 打包成一个 zip 一次解压完（也正好对应"下载一个包"的真实形态）。
     */
    private File unpackZip(String assetName, String dirName) {
        try {
            File dir = new File(getFilesDir(), dirName);
            File marker = new File(dir, ".done");
            if (marker.isFile()) return dir;
            if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) return null;
            try (java.util.zip.ZipInputStream zin =
                         new java.util.zip.ZipInputStream(getAssets().open(assetName))) {
                java.util.zip.ZipEntry e;
                byte[] buf = new byte[16384];
                int files = 0;
                while ((e = zin.getNextEntry()) != null) {
                    String name = e.getName();
                    // zip-slip 防护
                    if (name.contains("..")) continue;
                    File out = new File(dir, name);
                    if (e.isDirectory()) {
                        out.mkdirs();
                        continue;
                    }
                    File parent = out.getParentFile();
                    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) continue;
                    try (FileOutputStream fos = new FileOutputStream(out)) {
                        int n;
                        while ((n = zin.read(buf)) > 0) fos.write(buf, 0, n);
                    }
                    files++;
                }
                android.util.Log.i("MeowNode", "unpacked " + files + " files -> " + dir);
            }
            try (FileOutputStream fos = new FileOutputStream(marker)) {
                fos.write("1".getBytes("UTF-8"));
            }
            return dir;
        } catch (java.io.FileNotFoundException fnf) {
            // 没有真载荷是正常情况（走 smoke），不打 warn
            return null;
        } catch (Throwable t) {
            android.util.Log.w("MeowNode", "unpackZip failed", t);
            return null;
        }
    }

    /** 把 assets/node-payload 解到 filesDir/node-payload（幂等）。 */
    private File unpackPayload() {
        try {
            File dir = new File(getFilesDir(), "node-payload");
            if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) return null;
            String[] files = getAssets().list("node-payload");
            if (files == null || files.length == 0) return null;
            for (String name : files) {
                File out = new File(dir, name);
                if (out.isFile() && out.length() > 0) continue;
                try (InputStream in = getAssets().open("node-payload/" + name);
                     FileOutputStream fos = new FileOutputStream(out)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
                }
            }
            return dir;
        } catch (Throwable t) {
            android.util.Log.w("MeowNode", "unpack failed", t);
            return null;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /**
     * 关服务时把进程一起干掉。
     *
     * <p>踩过（2026-11-06）：`stopService` 只销毁 Service 对象，而 node 的
     * `node::Start()` 在 `meow-node` 线程里**永久阻塞** —— 线程不死，进程就不死，
     * 端口继续监听。表现是"设置页已显示已关闭，但弹幕还在走、端口还占着"。
     *
     * <p>这里自杀是唯一的办法：JNI 层没有给 node 一个能打断的句柄。
     * `:node` 是独立进程，杀掉不影响 UI 和网关。
     */
    @Override
    public void onDestroy() {
        android.util.Log.i("MeowNode", "NodeService destroyed, killing :node process");
        try {
            RuntimeModuleState.put(this, "running", false);
        } catch (Throwable ignored) {
        }
        super.onDestroy();
        android.os.Process.killProcess(android.os.Process.myPid());
    }
}
