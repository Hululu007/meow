package core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * DLNA 投屏：把播放地址推给局域网里的电视/盒子。
 *
 * <p><b>为什么只做 AVTransport，不做完整 UPnP</b>：投屏实际只需要四件事——
 * 发现渲染器、拿它的控制地址、SetAVTransportURI、Play。
 * 完整的 UPnP 栈（设备树、GENA 订阅）对"把视频推上去"没有额外价值；
 * 进度改用 {@code GetTransportInfo}/{@code GetPositionInfo} 轮询（见 {@link #status}）。
 *
 * <p><b>为什么不引第三方库</b>：Cling 需要 Android 依赖，jUPnP 体积偏大且
 * 我们只用其中很小一块。这里手写 SSDP + SOAP，代码量可控但零依赖，
 * 对容器/PC/TV 三端一致。
 *
 * <p><b>多网卡（实测）</b>：开发机常有 Hyper-V/WSL/Docker 一堆虚拟网卡，
 * 不绑网卡时 SSDP 只从默认路由出去，可能永远发现不了真实局域网里的电视。
 * 这里对每张有 IPv4 的网卡各开一个 socket、各发两轮。
 *
 * <p><b>已知限制</b>：
 * <ul>
 *   <li>只推 HLS/MP4 直链。需要转码的片必须先转好——电视端渲染器大多不支持 MKV，
 *       也没有转码能力。</li>
 *   <li>不做 GENA 事件订阅（轮询够用，且 TV 的 Chrome 66 长连接会被固件杀）。</li>
 *   <li>设备列表不缓存。SSDP 本身几百毫秒，缓存反而会让"电视刚开机"时找不到。</li>
 * </ul>
 */
public final class Cast {

    private Cast() {
    }

    private static final String SSDP_ADDR = "239.255.255.250";
    private static final int SSDP_PORT = 1900;

    /** 发两轮 M-SEARCH：单轮会漏掉慢设备（实测电视刚唤醒时首轮常不回）。 */
    private static final int SEND_ROUNDS = 2;
    private static final long SEND_GAP_MS = 600;

    /**
     * 最近一次 SOAP 失败的 UPnPError code（按线程隔离）。
     *
     * <p>不同错误处置完全不同（701 过渡中 / 402 参数错 / 710-711 Seek 相关），
     * 上层要把 code 透给前端做"人话"，不能一律"设备没有响应"。
     */
    private static final ThreadLocal<String> LAST_ERROR = new ThreadLocal<>();

    /** 一个可投屏的目标设备。 */
    public static final class Device {
        public String name = "";
        public String host = "";
        public String location = "";
        /** AVTransport 控制地址（SOAP 用）。 */
        public String controlUrl = "";
        /** ConnectionManager 控制地址（查 GetProtocolInfo；有些设备没有）。 */
        public String connControlUrl = "";
        /** 设备稳定标识；controlUrl 跨重启会变，UDN 不会。 */
        public String udn = "";
        public String type = "";
        /** dlna=标准渲染器；meow=装了我们的设备（走会话 API）。 */
        public String kind = "dlna";
        /** meow 设备的基地址（http://ip:port）。 */
        public String base = "";
        /** meow 设备的一次性令牌。 */
        public String token = "";
        /** 收到响应的本机网卡地址（仅用于去重，不序列化）。 */
        public String localAddr = "";
    }

    /**
     * SSDP 发现局域网里的 MediaRenderer。
     *
     * @param timeoutMs 收集时长。太短会漏掉慢设备，太长用户等待。默认 2.5 秒。
     */
    public static List<Device> discover(int timeoutMs) {
        final int budget = timeoutMs <= 0 ? 2500 : timeoutMs;
        final List<LocalNic> nics = localIpv4();
        final List<MulticastSocket> socks = new ArrayList<>();
        final List<Thread> readers = new ArrayList<>();
        final Map<String, Device> seen = Collections.synchronizedMap(new LinkedHashMap<String, Device>());
        final long deadline = System.currentTimeMillis() + budget;

        try {
            // 没有局域网网卡时退回通配 socket：至少别让 discover 直接空手。
            if (nics.isEmpty()) {
                MulticastSocket s = open(null);
                if (s != null) socks.add(s);
            } else {
                for (LocalNic nic : nics) {
                    MulticastSocket s = open(nic);
                    if (s != null) socks.add(s);
                }
            }
            for (final MulticastSocket s : socks) {
                Thread t = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        receiveLoop(s, seen, deadline);
                    }
                }, "cast-ssdp-rx");
                t.setDaemon(true);
                t.start();
                readers.add(t);
            }

            final byte[] dlnaMsg = msearch("urn:schemas-upnp-org:device:MediaRenderer:1")
                    .getBytes(StandardCharsets.UTF_8);
            final byte[] meowMsg = msearch("urn:meow:device:Cast:1")
                    .getBytes(StandardCharsets.UTF_8);
            for (int round = 0; round < SEND_ROUNDS && System.currentTimeMillis() < deadline; round++) {
                for (MulticastSocket s : socks) {
                    try {
                        s.send(new DatagramPacket(dlnaMsg, dlnaMsg.length,
                                InetAddress.getByName(SSDP_ADDR), SSDP_PORT));
                        s.send(new DatagramPacket(meowMsg, meowMsg.length,
                                InetAddress.getByName(SSDP_ADDR), SSDP_PORT));
                    } catch (Exception ignored) {
                        // 单张网卡发不出去不影响其他网卡
                    }
                }
                sleep(SEND_GAP_MS);
            }
            long left;
            while ((left = deadline - System.currentTimeMillis()) > 0) {
                sleep(Math.min(left, 200));
            }
        } catch (Exception e) {
            System.out.println("[cast] discover failed: " + e.getMessage());
        } finally {
            for (MulticastSocket s : socks) {
                try {
                    s.close();
                } catch (Exception ignored) {
                }
            }
            for (Thread t : readers) {
                try {
                    t.join(300);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
        }

        List<Device> out = new ArrayList<>(seen.values());
        // 描述 XML 并发抓：串行时每台 4s 超时会把发现预算吃光。
        fillDescriptions(out);
        dedupeMeow(out);
        return out;
    }

    /**
     * 同一台 meow 设备会从每张网卡各回一次（LOCATION 里的 IP 不同）。
     * 按 UDN 合并，优先保留"与默认路由同 /24"的那条，避免选到 Hyper-V 虚拟网卡地址。
     */
    private static void dedupeMeow(List<Device> list) {
        String pref = prefix24(CastLan.defaultRouteIp());
        Map<String, Device> byUdn = new LinkedHashMap<String, Device>();
        List<Device> others = new ArrayList<Device>();
        for (Device d : list) {
            if (!"meow".equals(d.kind) || d.udn.isEmpty()) {
                others.add(d);
                continue;
            }
            Device prev = byUdn.get(d.udn);
            if (prev == null || betterMeow(d, prev, pref)) byUdn.put(d.udn, d);
        }
        list.clear();
        list.addAll(byUdn.values());
        list.addAll(others);
    }

    /** 优先"从真实网卡收到"的那条；其次与默认路由同 /24。 */
    private static boolean betterMeow(Device a, Device b, String pref) {
        boolean an = CastLan.isNonVirtualLocal(a.localAddr);
        boolean bn = CastLan.isNonVirtualLocal(b.localAddr);
        if (an != bn) return an;
        if (!pref.isEmpty()) {
            boolean ap = prefix24(a.host).equals(pref);
            boolean bp = prefix24(b.host).equals(pref);
            if (ap != bp) return ap;
        }
        return false;
    }

    private static String prefix24(String ip) {
        if (ip == null) return "";
        String[] p = ip.split("\\.");
        return p.length == 4 ? (p[0] + "." + p[1] + "." + p[2]) : "";
    }

    private static String msearch(String st) {
        return "M-SEARCH * HTTP/1.1\r\n"
                + "HOST: " + SSDP_ADDR + ":" + SSDP_PORT + "\r\n"
                + "MAN: \"ssdp:discover\"\r\n"
                + "MX: 2\r\n"
                + "ST: " + st + "\r\n"
                + "\r\n";
    }

    /** 一张网卡 + 它的 IPv4。 */
    private static final class LocalNic {
        final InetAddress addr;
        final NetworkInterface nic;

        LocalNic(InetAddress addr, NetworkInterface nic) {
            this.addr = addr;
            this.nic = nic;
        }
    }

    /** 所有 up、非回环、非链路本地的 IPv4 网卡。 */
    private static List<LocalNic> localIpv4() {
        List<LocalNic> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> nics = NetworkInterface.getNetworkInterfaces();
            while (nics != null && nics.hasMoreElements()) {
                NetworkInterface nic = nics.nextElement();
                try {
                    if (!nic.isUp() || nic.isLoopback()) continue;
                } catch (Exception ignored) {
                    continue;
                }
                Enumeration<InetAddress> addrs = nic.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!(a instanceof java.net.Inet4Address)) continue;
                    if (a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress()) continue;
                    out.add(new LocalNic(a, nic));
                }
            }
        } catch (Exception e) {
            System.out.println("[cast] enumerate nics failed: " + e.getMessage());
        }
        return out;
    }

    private static MulticastSocket open(LocalNic nic) {
        try {
            MulticastSocket s = nic == null
                    ? new MulticastSocket()
                    : new MulticastSocket(new InetSocketAddress(nic.addr, 0));
            s.setSoTimeout(300);
            s.setTimeToLive(2);
            if (nic != null) {
                try {
                    s.setNetworkInterface(nic.nic);
                } catch (Exception ignored) {
                    // 有的虚拟网卡不允许设置出口；绑定地址已经足够
                }
            }
            return s;
        } catch (Exception e) {
            System.out.println("[cast] open nic failed: " + e.getMessage());
            return null;
        }
    }

    /** 每个 socket 一个读线程：只收集 LOCATION，不在这里抓描述（避免阻塞收包）。 */
    private static void receiveLoop(MulticastSocket sock, Map<String, Device> seen, long deadline) {
        byte[] buf = new byte[4096];
        while (System.currentTimeMillis() < deadline) {
            try {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                sock.receive(p);
                String text = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                String loc = header(text, "location");
                if (loc.isEmpty() || seen.containsKey(loc)) continue;
                Device d = new Device();
                d.location = loc;
                d.host = p.getAddress().getHostAddress();
                d.localAddr = sock.getLocalAddress() == null ? "" : sock.getLocalAddress().getHostAddress();
                String st = header(text, "st");
                d.kind = st.contains("urn:meow:device:Cast:1") ? "meow" : "dlna";
                seen.put(loc, d);
            } catch (SocketTimeoutException ignored) {
                // 继续等 deadline
            } catch (Exception e) {
                // socket 被主线程关掉时会抛，正常退出
                return;
            }
        }
    }

    private static void fillDescriptions(List<Device> list) {
        if (list.isEmpty()) return;
        ExecutorService pool = Executors.newFixedThreadPool(Math.min(6, list.size()));
        List<Future<?>> futures = new ArrayList<>();
        for (final Device d : list) {
            futures.add(pool.submit(new Callable<Void>() {
                @Override
                public Void call() {
                    fillFromDescription(d);
                    return null;
                }
            }));
        }
        try {
            for (Future<?> f : futures) {
                try {
                    f.get(5, TimeUnit.SECONDS);
                } catch (Exception ignored) {
                }
            }
        } finally {
            pool.shutdownNow();
        }
        list.removeIf(d -> d.controlUrl.isEmpty());
    }

    /**
     * 抓设备描述 XML，取 friendlyName / UDN / AVTransport 与 ConnectionManager 的 controlURL。
     *
     * <p>ConnectionManager 不是所有设备都有；没有就留空，能力预判时降级为"按扩展名猜"。
     */
    private static void fillFromDescription(Device d) {
        if ("meow".equals(d.kind)) {
            fillFromMeow(d);
            return;
        }
        try {
            String xml = httpGet(d.location, 4000);
            if (xml.isEmpty()) return;
            d.name = between(xml, "<friendlyName>", "</friendlyName>");
            d.udn = between(xml, "<UDN>", "</UDN>");
            d.controlUrl = serviceControlUrl(xml, d.location, "urn:schemas-upnp-org:service:AVTransport:");
            d.connControlUrl = serviceControlUrl(xml, d.location, "urn:schemas-upnp-org:service:ConnectionManager:");
            d.type = "AVTransport";
        } catch (Exception ignored) {
        }
    }

    /** meow 设备的 LOCATION 是 JSON 描述，不是 UPnP XML。 */
    private static void fillFromMeow(Device d) {
        try {
            String json = httpGet(d.location, 4000);
            if (json.isEmpty()) return;
            JSONObject o = new JSONObject(json);
            d.name = o.optString("name", d.host);
            d.udn = o.optString("udn", "");
            d.token = o.optString("token", "");
            int p = o.optInt("port", 0);
            if (p <= 0) return;
            d.base = "http://" + d.host + ":" + p;
            d.controlUrl = d.base + "/api/cast/session";
            d.type = "MeowCast";
        } catch (Exception ignored) {
        }
    }

    /** 在 description 的 serviceList 里找指定 serviceType，返回它 block 内的绝对 controlURL。 */
    private static String serviceControlUrl(String xml, String location, String serviceType) {
        int at = xml.indexOf(serviceType);
        if (at < 0) return "";
        int end = xml.indexOf("</service>", at);
        if (end < 0) end = xml.length();
        String block = xml.substring(at, end);
        return absUrl(location, between(block, "<controlURL>", "</controlURL>"));
    }

    /**
     * 让设备播放指定地址。
     *
     * <p>先 SetAVTransportURI 再 Play：只发 Play 的话，多数渲染器会播它自己
     * 队列里原来那条（或什么都不播）。
     */
    public static JSONObject play(Device d, String mediaUrl, String title) throws Exception {
        String meta = didl(mediaUrl, title);
        JSONObject r = new JSONObject();
        LAST_ERROR.remove();
        String setBody = soapEnvelope("AVTransport", "SetAVTransportURI",
                "<InstanceID>0</InstanceID>"
                        + "<CurrentURI>" + xmlEscape(mediaUrl) + "</CurrentURI>"
                        + "<CurrentURIMetaData>" + xmlEscape(meta) + "</CurrentURIMetaData>");
        String setResp = soap(d, d.controlUrl, setBody);
        if (setResp == null) {
            r.put("ok", false).put("msg", "设备没有响应 SetAVTransportURI");
            String code = LAST_ERROR.get();
            if (code != null && !code.isEmpty()) r.put("code", code);
            return r;
        }
        String playBody = soapEnvelope("AVTransport", "Play",
                "<InstanceID>0</InstanceID><Speed>1</Speed>");
        String playResp = soap(d, d.controlUrl, playBody);
        boolean ok = playResp != null;
        r.put("ok", ok);
        if (!ok) {
            r.put("msg", "设备没有响应 Play");
            String code = LAST_ERROR.get();
            if (code != null && !code.isEmpty()) r.put("code", code);
        }
        return r;
    }

    public static JSONObject pause(Device d) throws Exception {
        String resp = soap(d, d.controlUrl,
                soapEnvelope("AVTransport", "Pause", "<InstanceID>0</InstanceID>"));
        return new JSONObject().put("ok", resp != null);
    }

    /**
     * 从暂停继续：只发 Play，**不要**再 SetAVTransportURI。
     *
     * <p>重新 Set 会把设备的位置打回 0 并重新缓冲（实测乐播：暂停/继续若走
     * "重推 URL" 会黑屏几秒）。前端暂停后发的是不带 url 的 `action=play`。
     */
    public static JSONObject resume(Device d) throws Exception {
        String resp = soap(d, d.controlUrl,
                soapEnvelope("AVTransport", "Play",
                        "<InstanceID>0</InstanceID><Speed>1</Speed>"));
        return new JSONObject().put("ok", resp != null);
    }

    public static JSONObject stop(Device d) throws Exception {
        String resp = soap(d, d.controlUrl,
                soapEnvelope("AVTransport", "Stop", "<InstanceID>0</InstanceID>"));
        return new JSONObject().put("ok", resp != null);
    }

    public static JSONObject seek(Device d, int seconds) throws Exception {
        String hms = hms(Math.max(0, seconds));
        String resp = soap(d, d.controlUrl, soapEnvelope("AVTransport", "Seek",
                "<InstanceID>0</InstanceID><Unit>REL_TIME</Unit>"
                        + "<Target>" + hms + "</Target>"));
        return new JSONObject().put("ok", resp != null);
    }

    /**
     * 读播放状态：transportState + position + duration。
     *
     * <p>position/duration 单位是**秒**；前端负责和 `PlayResult` 的毫秒换算。
     */
    public static JSONObject status(Device d) throws Exception {
        JSONObject out = new JSONObject();
        String info = soap(d, d.controlUrl,
                soapEnvelope("AVTransport", "GetTransportInfo", "<InstanceID>0</InstanceID>"));
        String state = between(info == null ? "" : info,
                "<CurrentTransportState>", "</CurrentTransportState>");
        out.put("ok", info != null);
        out.put("state", normalizeState(state));
        String pos = soap(d, d.controlUrl,
                soapEnvelope("AVTransport", "GetPositionInfo", "<InstanceID>0</InstanceID>"));
        if (pos != null) {
            out.put("position", hmsToSeconds(between(pos, "<RelTime>", "</RelTime>")));
            out.put("duration", hmsToSeconds(between(pos, "<TrackDuration>", "</TrackDuration>")));
        }
        return out;
    }

    /** 查接收端支持的 MIME（ConnectionManager.GetProtocolInfo）。设备没有该服务时返回空表。 */
    public static JSONArray protocols(Device d) throws Exception {
        JSONArray out = new JSONArray();
        if (d.connControlUrl == null || d.connControlUrl.isEmpty()) return out;
        String resp = soap(d, d.connControlUrl,
                soapEnvelope("ConnectionManager", "GetProtocolInfo", ""));
        if (resp == null) return out;
        String sink = between(resp, "<Sink>", "</Sink>");
        if (sink.isEmpty()) return out;
        for (String one : sink.split(",")) {
            String v = one.trim();
            if (!v.isEmpty()) out.put(v);
        }
        return out;
    }

    private static String normalizeState(String raw) {
        String s = raw == null ? "" : raw.trim().toUpperCase();
        if ("PLAYING".equals(s)) return "playing";
        if ("PAUSED_PLAYBACK".equals(s) || "PAUSED".equals(s)) return "paused";
        if ("STOPPED".equals(s) || "NO_MEDIA_PRESENT".equals(s)) return "stopped";
        if ("TRANSITIONING".equals(s)) return "buffering";
        return s.isEmpty() ? "unknown" : s.toLowerCase();
    }

    /** 把设备列表转成 JSON（controlUrl 要回给前端，后端不缓存设备表）。 */
    public static JSONArray toJson(List<Device> list) throws Exception {
        JSONArray out = new JSONArray();
        for (Device d : list) {
            JSONObject o = new JSONObject();
            o.put("name", d.name);
            o.put("host", d.host);
            o.put("location", d.location);
            o.put("controlUrl", d.controlUrl);
            if (!d.connControlUrl.isEmpty()) o.put("connControlUrl", d.connControlUrl);
            if (!d.udn.isEmpty()) o.put("udn", d.udn);
            o.put("type", d.type);
            o.put("kind", d.kind);
            if (!d.base.isEmpty()) o.put("base", d.base);
            if (!d.token.isEmpty()) o.put("token", d.token);
            out.put(o);
        }
        return out;
    }

    /** 从 JSON 还原设备（前端回传 controlUrl 时用）。 */
    public static Device fromJson(JSONObject o) {
        Device d = new Device();
        d.name = o.optString("name", "");
        d.host = o.optString("host", "");
        d.location = o.optString("location", "");
        d.controlUrl = o.optString("controlUrl", "");
        d.connControlUrl = o.optString("connControlUrl", "");
        d.udn = o.optString("udn", "");
        d.type = o.optString("type", "");
        d.kind = o.optString("kind", "dlna");
        d.base = o.optString("base", "");
        d.token = o.optString("token", "");
        return d;
    }

    // ------------------------------------------------------------ SOAP

    private static String soapEnvelope(String service, String action, String inner) {
        String ns = "urn:schemas-upnp-org:service:" + service + ":1";
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                + "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
                + "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">"
                + "<s:Body><u:" + action + " xmlns:u=\"" + ns + "\">"
                + inner
                + "</u:" + action + "></s:Body></s:Envelope>";
    }

    /** 发 SOAP 请求，成功返回响应体；失败返回 null（errorCode 会打日志）。 */
    private static String soap(Device d, String controlUrl, String body) {
        if (controlUrl == null || controlUrl.isEmpty()) return null;
        try {
            URL u = new URL(controlUrl);
            Socket s = new Socket();
            s.connect(new InetSocketAddress(u.getHost(), u.getPort() < 0 ? 80 : u.getPort()), 4000);
            s.setSoTimeout(4000);
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            String head = "POST " + u.getFile() + " HTTP/1.1\r\n"
                    + "Host: " + u.getHost() + ":" + (u.getPort() < 0 ? 80 : u.getPort()) + "\r\n"
                    + "Content-Type: text/xml; charset=\"utf-8\"\r\n"
                    + "SOAPACTION: \"" + namespaceOf(body) + "#" + actionName(body) + "\"\r\n"
                    + "Content-Length: " + payload.length + "\r\n"
                    + "Connection: close\r\n\r\n";
            OutputStream os = s.getOutputStream();
            os.write(head.getBytes(StandardCharsets.UTF_8));
            os.write(payload);
            os.flush();
            String resp = readHttpResponse(s.getInputStream());
            s.close();
            boolean ok = resp.startsWith("HTTP/1.1 200") || resp.startsWith("HTTP/1.0 200");
            if (ok) return resp;
            String code = between(resp, "<errorCode>", "</errorCode>");
            if (!code.isEmpty()) {
                LAST_ERROR.set(code);
                System.out.println("[cast] UPnPError " + code + " for " + actionName(body));
            }
            return null;
        } catch (Exception e) {
            System.out.println("[cast] soap " + actionName(body) + " failed: " + e);
            return null;
        }
    }

    private static String namespaceOf(String body) {
        int a = body.indexOf("xmlns:u=\"");
        if (a < 0) return "";
        int b = body.indexOf('"', a + 9);
        return b < 0 ? "" : body.substring(a + 9, b);
    }

    private static String actionName(String body) {
        int a = body.indexOf("<u:");
        if (a < 0) return "";
        int start = a + 3;
        int end = body.length();
        for (int i = start; i < body.length(); i++) {
            char c = body.charAt(i);
            // 属性（xmlns:u=...）跟在动作名后面，必须停在空白或 '>'
            if (c == '>' || Character.isWhitespace(c)) {
                end = i;
                break;
            }
        }
        return body.substring(start, end);
    }

    /** DIDL-Lite 元数据：不带它有些渲染器会拒绝播放（说"不是媒体"）。 */
    private static String didl(String url, String title) {
        String t = title == null ? "" : title;
        return "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" "
                + "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" "
                + "xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">"
                + "<item id=\"0\" parentID=\"-1\" restricted=\"1\">"
                + "<dc:title>" + xmlEscape(t) + "</dc:title>"
                + "<upnp:class>object.item.videoItem</upnp:class>"
                + "<res protocolInfo=\"http-get:*:video/*:*\">" + xmlEscape(url) + "</res>"
                + "</item></DIDL-Lite>";
    }

    // ------------------------------------------------------------ 工具

    private static void sleep(long ms) {
        try {
            Thread.sleep(Math.max(1, ms));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static String hms(int seconds) {
        return String.format("%02d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60);
    }

    private static int hmsToSeconds(String v) {
        if (v == null) return 0;
        String[] p = v.trim().split(":");
        try {
            if (p.length == 3) {
                return Integer.parseInt(p[0]) * 3600 + Integer.parseInt(p[1]) * 60
                        + (int) Double.parseDouble(p[2]);
            }
            if (p.length == 2) {
                return Integer.parseInt(p[0]) * 60 + (int) Double.parseDouble(p[1]);
            }
        } catch (Exception ignored) {
        }
        return 0;
    }

    private static String httpGet(String url, int timeoutMs) {
        try {
            URL u = new URL(url);
            Socket s = new Socket();
            s.connect(new InetSocketAddress(u.getHost(), u.getPort() < 0 ? 80 : u.getPort()), timeoutMs);
            s.setSoTimeout(timeoutMs);
            String head = "GET " + u.getFile() + " HTTP/1.1\r\nHost: " + u.getHost()
                    + "\r\nConnection: close\r\n\r\n";
            s.getOutputStream().write(head.getBytes(StandardCharsets.UTF_8));
            String resp = readHttpResponse(s.getInputStream());
            s.close();
            int at = resp.indexOf("\r\n\r\n");
            return at >= 0 ? resp.substring(at + 4) : "";
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * 读一个 HTTP 响应（含头）。
     *
     * <p><b>必须按 Content-Length / chunked 停，不能等 EOF</b>：实测 GUPnP 设备
     * 会忽略 `Connection: close` 保持连接，等 EOF 会撞 4s 读超时，并把已读的
     * 响应体整段丢掉（表现是 status 恒为 ok=false，设备其实回了 200）。
     */
    private static String readHttpResponse(InputStream in) {
        try (InputStream i = in) {            ByteArrayOutputStream head = new ByteArrayOutputStream();
            int state = 0;
            int b;
            while ((b = i.read()) != -1) {
                head.write(b);
                if ((state == 0 || state == 2) && b == '\r') state++;
                else if ((state == 1 || state == 3) && b == '\n') state++;
                else state = 0;
                if (state == 4) break;
                if (head.size() > 64 * 1024) break;
            }
            String headText = new String(head.toByteArray(), StandardCharsets.ISO_8859_1);
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            int len = headerInt(headText, "content-length");
            boolean chunked = headerContains(headText, "transfer-encoding", "chunked");
            if (len >= 0) {
                copyN(i, body, len);
            } else if (chunked) {
                readChunked(i, body);
            } else {
                byte[] buf = new byte[8192];
                int n;
                while ((n = i.read(buf)) != -1) body.write(buf, 0, n);
            }
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            all.write(head.toByteArray());
            all.write(body.toByteArray());
            return new String(all.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            System.out.println("[cast] read http failed: " + e);
            return "";
        }
    }

    private static void copyN(InputStream in, ByteArrayOutputStream out, int n) throws Exception {
        byte[] buf = new byte[8192];
        int left = n;
        while (left > 0) {
            int r = in.read(buf, 0, Math.min(buf.length, left));
            if (r < 0) break;
            out.write(buf, 0, r);
            left -= r;
        }
    }

    private static void readChunked(InputStream in, ByteArrayOutputStream out) throws Exception {
        while (true) {
            StringBuilder line = new StringBuilder();
            int b;
            while ((b = in.read()) != -1 && b != '\n') {
                if (b != '\r') line.append((char) b);
            }
            if (b == -1) return;
            int semi = line.indexOf(";");
            String hex = (semi >= 0 ? line.substring(0, semi) : line.toString()).trim();
            int size;
            try {
                size = Integer.parseInt(hex, 16);
            } catch (Exception e) {
                return;
            }
            if (size <= 0) return;
            copyN(in, out, size);
            // 尾随 CRLF
            in.read();
            in.read();
        }
    }

    private static int headerInt(String head, String name) {
        String v = header(head, name);
        try {
            return v.isEmpty() ? -1 : Integer.parseInt(v.trim());
        } catch (Exception e) {
            return -1;
        }
    }

    private static boolean headerContains(String head, String name, String needle) {
        return header(head, name).toLowerCase().contains(needle);
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

    private static String between(String s, String a, String b) {
        if (s == null) return "";
        int i = s.indexOf(a);
        if (i < 0) return "";
        i += a.length();
        int j = s.indexOf(b, i);
        return j < 0 ? "" : s.substring(i, j).trim();
    }

    private static String absUrl(String base, String rel) {
        if (rel.isEmpty()) return "";
        if (base == null || base.isEmpty()) return rel;
        /*
         * 实测（投屏电视V9，2026-11-16）：有些设备的 controlURL 是
         * `_urn:schemas-upnp-org:service:AVTransport_control` 这种相对路径。
         * `_` 不是合法 scheme 首字符，URI.create(rel) 会抛异常；直接 resolve
         * 也会落到 catch 里把相对地址原样返回，SOAP 于是打到一个没有 host 的
         * 地址。加 `./` 强制按相对路径解析，才能得到
         * `http://<host>:<port>/_urn:...`。
         */
        if (rel.startsWith("http://") || rel.startsWith("https://")) return rel;
        try {
            URI b = URI.create(base);
            if (rel.startsWith("/")) {
                return b.getScheme() + "://" + b.getRawAuthority() + rel;
            }
            return b.resolve("./" + rel).toString();
        } catch (Exception e) {
            return rel;
        }
    }

    private static String xmlEscape(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;");
    }
}
