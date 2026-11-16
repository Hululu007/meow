package core;

import org.json.JSONObject;

import platform.HttpExchange;
import platform.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 自有投屏接收端（B 类）：让"装了我们的设备"能被别的端投中。
 *
 * <p><b>为什么不直接做 DLNA MediaRenderer</b>：DLNA 需要 SSDP + 描述 XML + SCPD +
 * AVTransport 一整套，才能让第三方 App 投进来（那是可选项）。我们自己的发送端
 * 只要一个**会话 API**：推媒体、报状态、遥控。先用自定义 SSDP 服务类型把
 * "自家设备"识别出来，成本低得多；后续要接第三方再升级成标准 MediaRenderer。
 *
 * <p><b>播放由宿主的 {@link Player} 实现</b>：
 * TV 侧桥到 WebView 播放页（保留弹幕/跳片头），PC 侧由网页轮询 {@code pending}
 * 会话后播放。本类不依赖 Android，所以能在 JVM 上编译与单测。
 *
 * <p><b>SSDP 回应</b>：只回 {@code urn:meow:device:Cast:1} 的 M-SEARCH（以及
 * {@code ssdp:all}）。LOCATION 指向 {@code /api/cast/desc}（JSON，不是 XML）。
 */
public final class CastReceiver {

    private CastReceiver() {
    }

    private static final CastReceiver INSTANCE = new CastReceiver();

    public static CastReceiver get() {
        return INSTANCE;
    }

    /** 设备侧播放器桥。返回值表示"接住了"，失败由会话 API 回给发送端。 */
    public interface Player {
        /** 打开/切换媒体。position 单位**秒**。 */
        boolean open(JSONObject media, int position);

        void pause();

        void play();

        void seek(int position);

        void stop();

        /** 首投确认；默认放行。TV 侧可弹窗，PC 侧返回 true。 */
        default boolean confirm(String senderName) {
            return true;
        }
    }

    private volatile HttpServer server;
    private volatile int port;
    private volatile boolean running;
    private volatile Player player;
    private volatile Thread ssdpThread;
    private volatile MulticastSocket ssdpSocket;
    private volatile Runnable lockAcquire;
    private volatile Runnable lockRelease;

    // ---- 会话状态（接收端是权威） ----
    private volatile String sessionId = "";
    private volatile JSONObject media = new JSONObject();
    private volatile String state = "idle";
    private volatile int position;
    private volatile int duration;
    private volatile String senderName = "";
    private volatile String senderKind = "";
    private volatile String senderModel = "";
    private volatile String senderHost = "";
    private volatile boolean takenOver;
    private volatile String error = "";
    /** 命令优先窗口：这之前忽略播放器回报的 position/state（防反馈环互相覆盖）。 */
    private volatile long commandUntil;
    private volatile long seekUntil;

    public void setPlayer(Player p) {
        this.player = p;
    }

    /** Android 侧注入 MulticastLock；JVM 不设置即可。 */
    public void setMulticastLock(Runnable acquire, Runnable release) {
        this.lockAcquire = acquire;
        this.lockRelease = release;
    }

    public boolean isRunning() {
        return running;
    }

    public String sessionId() {
        return sessionId;
    }

    /**
     * 本地播放器回报（进程内直调，走 HTTP 的版本见 {@link #handleProgress}）。
     * 单位秒；只有存在会话时才更新。
     */
    public void report(String st, int posSec, int durSec) {
        if (sessionId.isEmpty()) return;
        applyProgress(st, posSec, durSec);
    }

    /**
     * 合并播放器回报。命令（play/pause/seek）之后的短窗口内，回报不能覆盖命令：
     * 否则会出现"遥控 seek 到 120s → 页面还没跳，2s 后回报 31s 把它盖回去"
     * 和"遥控 play → 页面回报 paused 把状态盖回去"（真机实测）。
     */
    private void applyProgress(String st, int posSec, int durSec) {
        long now = System.currentTimeMillis();
        if (st != null && !st.isEmpty()) {
            // ended 是事实，不受命令窗口限制
            if ("ended".equals(st) || now >= commandUntil) state = st;
        }
        if (posSec >= 0 && now >= seekUntil) position = posSec;
        if (durSec > 0) duration = durSec;
    }

    public int port() {
        return port;
    }

    public String deviceName() {
        String v = DataPaths.read("cast.name");
        if (v != null && !v.trim().isEmpty()) return v.trim();
        return "猫窝";
    }

    public void setDeviceName(String name) {
        if (name == null) return;
        DataPaths.write("cast.name", name.trim());
    }

    /** 稳定设备标识；首次生成后落盘，重启不变。 */
    public String udn() {
        String v = DataPaths.read("cast.udn");
        if (v != null && v.trim().length() >= 8) return v.trim();
        String id = UUID.randomUUID().toString();
        DataPaths.write("cast.udn", id);
        return id;
    }

    private static final Object ALLOW_LOCK = new Object();

    /** 首次投屏确认后记住的来源 IP（`cast.allow`，一行一个）。 */
    private boolean isAllowed(String host) {
        synchronized (ALLOW_LOCK) {
            String raw = DataPaths.read("cast.allow");
            if (raw == null) return false;
            for (String line : raw.split("\\R")) {
                if (line.trim().equals(host)) return true;
            }
            return false;
        }
    }

    private void allowHost(String host) {
        synchronized (ALLOW_LOCK) {
            String raw = DataPaths.read("cast.allow");
            if (raw == null) raw = "";
            for (String line : raw.split("\\R")) {
                if (line.trim().equals(host)) return;
            }
            DataPaths.write("cast.allow", raw + (raw.isEmpty() || raw.endsWith("\n") ? "" : "\n") + host + "\n");
        }
    }

    public synchronized JSONObject start() {
        if (running) return info();
        try {
            platform.ServerProvider.autoDetect();
            HttpServer s = HttpServer.create(new InetSocketAddress("0.0.0.0", 0), 16);
            s.start(new HttpServer.Handler() {
                @Override
                public void handle(HttpExchange exchange) {
                    CastReceiver.this.handle(exchange);
                }
            }, 8);
            server = s;
            port = s.getPort();
            running = true;
            startSsdp();
            System.out.println("[cast] receiver on 0.0.0.0:" + port + " name=" + deviceName());
        } catch (Exception e) {
            error = "接收端启动失败: " + e.getMessage();
            System.out.println("[cast] receiver start failed: " + e);
        }
        return info();
    }

    public synchronized void stop() {
        running = false;
        stopSsdp();
        if (server != null) {
            try {
                server.stop();
            } catch (Exception ignored) {
            }
            server = null;
        }
        port = 0;
        clearSession();
    }

    public JSONObject info() {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", running);
            o.put("running", running);
            o.put("port", port);
            o.put("name", deviceName());
            o.put("udn", udn());
            o.put("token", CastLan.token());
            o.put("state", state);
            o.put("sessionId", sessionId);
            if (!error.isEmpty()) o.put("msg", error);
        } catch (Exception ignored) {
        }
        return o;
    }

    private JSONObject desc() {
        JSONObject o = new JSONObject();
        try {
            o.put("kind", "meow");
            o.put("name", deviceName());
            o.put("udn", udn());
            o.put("token", CastLan.token());
            o.put("port", port);
            String base = CastLan.baseFor("");
            if (!base.isEmpty()) o.put("base", base);
            JSONObject caps = new JSONObject();
            caps.put("codecs", "hls,mp4");
            caps.put("danmaku", true);
            caps.put("canReceive", true);
            o.put("caps", caps);
            JSONObject api = new JSONObject();
            api.put("session", "/api/cast/session");
            api.put("command", "/api/cast/command");
            api.put("progress", "/api/cast/progress");
            o.put("api", api);
        } catch (Exception ignored) {
        }
        return o;
    }

    // ------------------------------------------------------------ HTTP

    private void handle(HttpExchange ex) {
        try {
            String method = ex.getRequestMethod();
            // WebView 页面在 http://meow.local，接收端在 127.0.0.1:port —— 跨源
            if ("OPTIONS".equalsIgnoreCase(method)) {
                cors(ex);
                ex.sendResponseHeaders(204, -1);
                ex.close();
                return;
            }
            String path = ex.getRequestURI().getPath();
            Map<String, String> q = query(ex.getRequestURI().getRawQuery());
            if ("/api/cast/desc".equals(path)) {
                sendJson(ex, 200, desc().toString());
                return;
            }
            if (!CastLan.tokenOk(q.get("ct"))) {
                sendJson(ex, 403, "{\"ok\":false,\"msg\":\"bad cast token\"}");
                return;
            }
            if ("/api/cast/session".equals(path)) {
                if ("POST".equalsIgnoreCase(ex.getRequestMethod())) handleSession(ex);
                else handleStatus(ex);
            } else if ("/api/cast/command".equals(path)) {
                handleCommand(ex);
            } else if ("/api/cast/progress".equals(path)) {
                handleProgress(ex);
            } else {
                sendJson(ex, 404, "{\"ok\":false,\"msg\":\"not found\"}");
            }
        } catch (Exception e) {
            try {
                sendJson(ex, 500, "{\"ok\":false,\"msg\":\"internal error\"}");
            } catch (Exception ignored) {
            }
        }
    }

    /** 首投弹框里显示的来源：名称（PC · 192.168.1.2）。名称优先，其次型号/端类型。 */
    private static String senderLabel(String name, String kind, String model, String host) {
        String label = name == null ? "" : name.trim();
        if (label.isEmpty() && model != null) label = model.trim();
        String kindLabel = "pc".equals(kind) ? "PC"
                : "tv".equals(kind) ? "TV"
                : "web".equals(kind) ? "Web" : "";
        if (label.isEmpty()) label = kindLabel.isEmpty() ? "局域网设备" : kindLabel;
        StringBuilder extra = new StringBuilder();
        if (!kindLabel.isEmpty() && !label.toUpperCase().contains(kindLabel.toUpperCase())) {
            extra.append(kindLabel);
        }
        if (host != null && !host.isEmpty()) {
            if (extra.length() > 0) extra.append(" · ");
            extra.append(host);
        }
        return extra.length() == 0 ? label : label + "（" + extra + "）";
    }

    /** POST /api/cast/session：建/换会话，并让宿主播放器打开媒体。 */
    public void handleSession(HttpExchange ex) throws Exception {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            sendJson(ex, 405, "{\"ok\":false,\"msg\":\"method not allowed\"}");
            return;
        }
        JSONObject in = new JSONObject(readBody(ex));
        JSONObject m = in.optJSONObject("media");
        if (m == null) {
            sendJson(ex, 400, "{\"ok\":false,\"msg\":\"media required\"}");
            return;
        }
        String url = m.optString("url", "");
        if (url.isEmpty()) {
            sendJson(ex, 400, "{\"ok\":false,\"msg\":\"media.url required\"}");
            return;
        }
        // 接收端也要校验 URL：不做的话我们成了"让电视访问任意地址"的跳板
        if (!UrlSafety.isSafeMediaUrl(url)) {
            sendJson(ex, 403, "{\"ok\":false,\"msg\":\"url not allowed\"}");
            return;
        }
        JSONObject se = in.optJSONObject("sender");
        String from = se == null ? "" : se.optString("name", "");
        String kind = se == null ? "" : se.optString("kind", "");
        String model = se == null ? "" : se.optString("model", "");
        String host = ex.getRemoteAddress() == null ? "" : ex.getRemoteAddress().getAddress().getHostAddress();
        if (!sessionId.isEmpty() && !sessionId.equals(in.optString("sessionId", ""))) {
            takenOver = true;
        }
        Player p = player;
        boolean trusted = !host.isEmpty() && isAllowed(host);
        if (!trusted && p != null && !p.confirm(senderLabel(from, kind, model, host))) {
            sendJson(ex, 403, "{\"ok\":false,\"msg\":\"rejected by receiver\"}");
            return;
        }
        if (!host.isEmpty()) allowHost(host);
        sessionId = UUID.randomUUID().toString();
        media = m;
        senderName = from;
        senderKind = kind;
        senderModel = model;
        senderHost = host;
        takenOver = false;
        error = "";
        position = Math.max(0, m.optInt("position", 0));
        duration = Math.max(0, m.optInt("duration", 0));
        if (p == null) {
            // PC 等"页面还没接手"的形态：挂起，等网页轮询到后播放
            state = "pending";
        } else {
            boolean ok = p.open(m, position);
            state = ok ? "playing" : "failed";
            if (!ok) error = "接收端打开媒体失败";
        }
        JSONObject out = new JSONObject();
        out.put("ok", !"failed".equals(state));
        out.put("sessionId", sessionId);
        out.put("state", state);
        sendJson(ex, 200, out.toString());
    }

    /** GET /api/cast/session：状态快照（发送端与本地页面都轮询它）。 */
    public void handleStatus(HttpExchange ex) throws Exception {
        String id = query(ex.getRequestURI().getRawQuery()).get("id");
        JSONObject o = new JSONObject();
        o.put("ok", !sessionId.isEmpty() && (id == null || id.isEmpty() || id.equals(sessionId)));
        o.put("sessionId", sessionId);
        o.put("state", sessionId.isEmpty() ? "idle" : state);
        o.put("position", position);
        o.put("duration", duration);
        o.put("media", media);
        o.put("sender", senderName);
        o.put("senderKind", senderKind);
        o.put("senderModel", senderModel);
        o.put("senderHost", senderHost);
        o.put("takenOver", takenOver);
        if (!error.isEmpty()) o.put("msg", error);
        sendJson(ex, 200, o.toString());
    }

    /** POST /api/cast/command：遥控。 */
    public void handleCommand(HttpExchange ex) throws Exception {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            sendJson(ex, 405, "{\"ok\":false,\"msg\":\"method not allowed\"}");
            return;
        }
        JSONObject in = new JSONObject(readBody(ex));
        String id = in.optString("sessionId", "");
        if (!sessionId.isEmpty() && !id.isEmpty() && !id.equals(sessionId)) {
            sendJson(ex, 409, "{\"ok\":false,\"msg\":\"stale session\"}");
            return;
        }
        String action = in.optString("action", "");
        Player p = player;
        long now = System.currentTimeMillis();
        switch (action) {
            case "play":
                state = "playing";
                commandUntil = now + 2500;
                if (p != null) p.play();
                break;
            case "pause":
                state = "paused";
                commandUntil = now + 2500;
                if (p != null) p.pause();
                break;
            case "seek":
                position = Math.max(0, in.optInt("value", 0));
                seekUntil = now + 3000;
                if (p != null) p.seek(position);
                break;
            case "stop":
                if (p != null) p.stop();
                clearSession();
                break;
            case "next":
            case "prev":
                // 剧集表在发送端；接收端只回报，由发送端重推新 media
                break;
            default:
                sendJson(ex, 400, "{\"ok\":false,\"msg\":\"unknown action\"}");
                return;
        }
        sendJson(ex, 200, "{\"ok\":true,\"state\":\"" + state + "\"}");
    }

    /** POST /api/cast/progress：本地播放器回报（网页/原生播放器调用）。 */
    public void handleProgress(HttpExchange ex) throws Exception {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            sendJson(ex, 405, "{\"ok\":false,\"msg\":\"method not allowed\"}");
            return;
        }
        JSONObject in = new JSONObject(readBody(ex));
        String id = in.optString("sessionId", "");
        if (!sessionId.isEmpty() && !id.isEmpty() && !id.equals(sessionId)) {
            sendJson(ex, 409, "{\"ok\":false,\"msg\":\"stale session\"}");
            return;
        }
        String st = in.optString("state", "");
        applyProgress(st,
                in.has("position") ? Math.max(0, in.optInt("position", position)) : -1,
                in.has("duration") ? Math.max(0, in.optInt("duration", duration)) : 0);
        sendJson(ex, 200, "{\"ok\":true}");
    }

    /** 供 PC 网页轮询：当前是否有待接手的会话。 */
    public JSONObject pending() throws Exception {
        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("sessionId", sessionId);
        o.put("state", state);
        o.put("media", media);
        o.put("position", position);
        o.put("duration", duration);
        o.put("sender", senderName);
        o.put("senderKind", senderKind);
        o.put("senderModel", senderModel);
        o.put("senderHost", senderHost);
        return o;
    }

    private void clearSession() {
        sessionId = "";
        media = new JSONObject();
        state = "idle";
        position = 0;
        duration = 0;
        senderName = "";
        senderKind = "";
        senderModel = "";
        senderHost = "";
        takenOver = false;
        error = "";
        commandUntil = 0;
        seekUntil = 0;
    }

    // ------------------------------------------------------------ SSDP

    private void startSsdp() {
        if (ssdpThread != null) return;
        final Runnable acquire = lockAcquire;
        if (acquire != null) {
            try {
                acquire.run();
            } catch (Exception ignored) {
            }
        }
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                MulticastSocket sock = null;
                try {
                    // 先 unbound 再 setReuseAddress，避免和系统 SSDP 服务抢端口直接失败
                    sock = new MulticastSocket(null);
                    sock.setReuseAddress(true);
                    sock.bind(new InetSocketAddress(1900));
                    /*
                     * 每张有 IPv4 的网卡都 join 一次。
                     * 只 join 默认网卡时，别的网段发来的 M-SEARCH 收不到（实测本机
                     * 默认路由在 VMware 虚拟网卡上，真实以太网那侧完全收不到）。
                     */
                    InetSocketAddress group = new InetSocketAddress("239.255.255.250", 1900);
                    java.util.List<NetworkInterface> nics = CastLan.interfaces();
                    if (nics.isEmpty()) {
                        sock.joinGroup(group, null);
                    } else {
                        for (NetworkInterface ni : nics) {
                            try {
                                sock.joinGroup(group, ni);
                            } catch (Exception ignored) {
                            }
                        }
                    }
                    ssdpSocket = sock;
                    byte[] buf = new byte[2048];
                    while (running) {
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        sock.receive(p);
                        String msg = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                        if (!msg.startsWith("M-SEARCH")) continue;
                        String st = header(msg, "st");
                        if (!"ssdp:all".equals(st) && !st.contains("urn:meow:device:Cast:1")) continue;
                        String ip = CastLan.pickIp(p.getAddress().getHostAddress());
                        if (ip.isEmpty()) continue;
                        String loc = "http://" + ip + ":" + port + "/api/cast/desc";
                        String resp = "HTTP/1.1 200 OK\r\n"
                                + "CACHE-CONTROL: max-age=1800\r\n"
                                + "EXT:\r\n"
                                + "LOCATION: " + loc + "\r\n"
                                + "SERVER: Linux UPnP/1.0 Meow/1.0\r\n"
                                + "ST: urn:meow:device:Cast:1\r\n"
                                + "USN: uuid:" + udn() + "::urn:meow:device:Cast:1\r\n"
                                + "\r\n";
                        byte[] out = resp.getBytes(StandardCharsets.UTF_8);
                        sock.send(new DatagramPacket(out, out.length, p.getAddress(), p.getPort()));
                    }
                } catch (Exception e) {
                    if (running) System.out.println("[cast] ssdp responder failed: " + e);
                } finally {
                    if (sock != null) {
                        try {
                            sock.close();
                        } catch (Exception ignored) {
                        }
                    }
                }
            }
        }, "cast-ssdp-responder");
        t.setDaemon(true);
        t.start();
        ssdpThread = t;
    }

    private void stopSsdp() {
        MulticastSocket s = ssdpSocket;
        ssdpSocket = null;
        if (s != null) {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
        ssdpThread = null;
        Runnable release = lockRelease;
        if (release != null) {
            try {
                release.run();
            } catch (Exception ignored) {
            }
        }
    }

    // ------------------------------------------------------------ 工具

    private static String readBody(HttpExchange ex) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        InputStream in = ex.getRequestBody();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void sendJson(HttpExchange ex, int code, String body) throws Exception {
        cors(ex);
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static void cors(HttpExchange ex) {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> out = new LinkedHashMap<>();
        if (raw == null || raw.isEmpty()) return out;
        for (String kv : raw.split("&")) {
            int eq = kv.indexOf('=');
            String k = eq < 0 ? kv : kv.substring(0, eq);
            String v = eq < 0 ? "" : kv.substring(eq + 1);
            try {
                out.put(java.net.URLDecoder.decode(k, "UTF-8"),
                        java.net.URLDecoder.decode(v, "UTF-8"));
            } catch (Exception ignored) {
                out.put(k, v);
            }
        }
        return out;
    }

    private static String header(String text, String name) {
        for (String line : text.split("\r\n")) {
            int c = line.indexOf(':');
            if (c > 0 && line.substring(0, c).trim().equalsIgnoreCase(name)) {
                return line.substring(c + 1).trim();
            }
        }
        return "";
    }
}
