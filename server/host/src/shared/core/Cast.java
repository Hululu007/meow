package core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * DLNA 投屏：把播放地址推给局域网里的电视/盒子。
 *
 * <p><b>为什么只做 AVTransport，不做完整 UPnP</b>：投屏实际只需要四件事——
 * 发现渲染器、拿它的事件控制地址、SetAVTransportURI、Play。
 * 完整的 UPnP 栈（设备树、服务描述、GENA 订阅）对"把视频推上去"没有额外价值。
 *
 * <p><b>为什么不引第三方库</b>：Cling 需要 Android 依赖，jUPnP 体积偏大且
 * 我们只用其中很小一块。这里手写 SSDP + SOAP，代码量约 300 行但零依赖，
 * 对容器/PC/TV 三端一致。
 *
 * <p><b>已知限制</b>：
 * <ul>
 *   <li>只推 HLS/MP4 直链。需要转码的片必须先转好——电视端的 DLNA 渲染器
 *       大多不支持 MKV，也没有转码能力。</li>
 *   <li>不做进度同步（电视上暂停了，这边不知道）。要做得订阅 AVTransport
 *       事件，成本高于收益。</li>
 *   <li>设备列表不缓存。SSDP 发现本身几百毫秒，缓存反而会让"电视刚开机"时找不到。</li>
 * </ul>
 */
public final class Cast {

    private Cast() {
    }

    private static final String SSDP_ADDR = "239.255.255.250";
    private static final int SSDP_PORT = 1900;

    /** 一个可投屏的目标设备。 */
    public static final class Device {
        public String name = "";
        public String host = "";
        public String location = "";
        /** AVTransport 控制地址（SOAP 用）。 */
        public String controlUrl = "";
        public String type = "";
    }

    /**
     * SSDP 发现局域网里的 MediaRenderer。
     *
     * @param timeoutMs 收集时长。太短会漏掉慢设备，太长用户等待。默认 2.5 秒。
     */
    public static List<Device> discover(int timeoutMs) {
        List<Device> out = new ArrayList<>();
        if (timeoutMs <= 0) timeoutMs = 2500;
        DatagramSocket sock = null;
        try {
            sock = new DatagramSocket();
            sock.setSoTimeout(400);
            String msg = "M-SEARCH * HTTP/1.1\r\n"
                    + "HOST: " + SSDP_ADDR + ":" + SSDP_PORT + "\r\n"
                    + "MAN: \"ssdp:discover\"\r\n"
                    + "MX: 2\r\n"
                    + "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n"
                    + "\r\n";
            byte[] data = msg.getBytes(StandardCharsets.UTF_8);
            sock.send(new DatagramPacket(data, data.length,
                    InetAddress.getByName(SSDP_ADDR), SSDP_PORT));

            long deadline = System.currentTimeMillis() + timeoutMs;
            Map<String, Device> seen = new LinkedHashMap<>();
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
                    // 名字与控制地址要再抓一次设备描述 XML
                    fillFromDescription(d);
                    if (d.controlUrl.isEmpty()) continue;
                    if (d.name.isEmpty()) d.name = d.host;
                    seen.put(loc, d);
                } catch (SocketTimeoutException ignored) {
                    // 继续等到 deadline
                }
            }
            out.addAll(seen.values());
        } catch (Exception e) {
            System.out.println("[cast] discover failed: " + e.getMessage());
        } finally {
            if (sock != null) sock.close();
        }
        return out;
    }

    /** 抓设备描述 XML，取 friendlyName 与 AVTransport 的 controlURL。 */
    private static void fillFromDescription(Device d) {
        try {
            String xml = httpGet(d.location, 4000);
            if (xml.isEmpty()) return;
            d.name = between(xml, "<friendlyName>", "</friendlyName>");
            // serviceList 里找 AVTransport，取它后面的 controlURL
            int at = xml.indexOf("urn:schemas-upnp-org:service:AVTransport:");
            if (at < 0) return;
            int end = xml.indexOf("</service>", at);
            if (end < 0) end = xml.length();
            String block = xml.substring(at, end);
            d.controlUrl = absUrl(d.location, between(block, "<controlURL>", "</controlURL>"));
            d.type = "AVTransport";
        } catch (Exception ignored) {
        }
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
        String setBody = soapEnvelope("SetAVTransportURI",
                "<InstanceID>0</InstanceID>"
                        + "<CurrentURI>" + xmlEscape(mediaUrl) + "</CurrentURI>"
                        + "<CurrentURIMetaData>" + xmlEscape(meta) + "</CurrentURIMetaData>");
        String setResp = soap(d, setBody);
        if (setResp == null) {
            r.put("ok", false).put("msg", "设备没有响应 SetAVTransportURI");
            return r;
        }
        String playBody = soapEnvelope("Play",
                "<InstanceID>0</InstanceID><Speed>1</Speed>");
        String playResp = soap(d, playBody);
        boolean ok = playResp != null;
        r.put("ok", ok);
        if (!ok) r.put("msg", "设备没有响应 Play");
        return r;
    }

    public static JSONObject pause(Device d) throws Exception {
        String resp = soap(d, soapEnvelope("Pause", "<InstanceID>0</InstanceID>"));
        return new JSONObject().put("ok", resp != null);
    }

    public static JSONObject stop(Device d) throws Exception {
        String resp = soap(d, soapEnvelope("Stop", "<InstanceID>0</InstanceID>"));
        return new JSONObject().put("ok", resp != null);
    }

    public static JSONObject seek(Device d, int seconds) throws Exception {
        String hms = String.format("%02d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60);
        String resp = soap(d, soapEnvelope("Seek",
                "<InstanceID>0</InstanceID><Unit>REL_TIME</Unit>"
                        + "<Target>" + hms + "</Target>"));
        return new JSONObject().put("ok", resp != null);
    }

    /** 把设备列表转成 JSON（控制地址不回给前端，它是内部字段）。 */
    public static JSONArray toJson(List<Device> list) throws Exception {
        JSONArray out = new JSONArray();
        for (Device d : list) {
            JSONObject o = new JSONObject();
            o.put("name", d.name);
            o.put("host", d.host);
            o.put("location", d.location);
            // controlUrl 要回给前端：后续 play/pause 请求要带上它来定位设备，
            // 后端不缓存设备表（缓存会让刚开机的电视找不到）。
            o.put("controlUrl", d.controlUrl);
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
        return d;
    }

    // ------------------------------------------------------------ SOAP

    private static String soapEnvelope(String action, String inner) {
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                + "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
                + "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">"
                + "<s:Body><u:" + action + " xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">"
                + inner
                + "</u:" + action + "></s:Body></s:Envelope>";
    }

    /** 发 SOAP 请求，返回响应体；失败返回 null。 */
    private static String soap(Device d, String body) {
        try {
            URL u = new URL(d.controlUrl);
            Socket s = new Socket();
            s.connect(new InetSocketAddress(u.getHost(), u.getPort() < 0 ? 80 : u.getPort()), 4000);
            s.setSoTimeout(4000);
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            String head = "POST " + u.getFile() + " HTTP/1.1\r\n"
                    + "Host: " + u.getHost() + ":" + (u.getPort() < 0 ? 80 : u.getPort()) + "\r\n"
                    + "Content-Type: text/xml; charset=\"utf-8\"\r\n"
                    + "SOAPACTION: \"urn:schemas-upnp-org:service:AVTransport:1#"
                    + actionOf(body) + "\"\r\n"
                    + "Content-Length: " + payload.length + "\r\n"
                    + "Connection: close\r\n\r\n";
            OutputStream os = s.getOutputStream();
            os.write(head.getBytes(StandardCharsets.UTF_8));
            os.write(payload);
            os.flush();
            String resp = readAll(s.getInputStream());
            s.close();
            // 200 = 成功；500 里也可能带 UPnPError，但对我们都是"没成功"
            return resp.startsWith("HTTP/1.1 200") || resp.startsWith("HTTP/1.0 200") ? resp : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String actionOf(String body) {
        int a = body.indexOf("<u:");
        if (a < 0) return "";
        int b = body.indexOf(' ', a);
        if (b < 0) return "";
        return body.substring(a + 3, b);
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

    private static String httpGet(String url, int timeoutMs) {
        try {
            URL u = new URL(url);
            Socket s = new Socket();
            s.connect(new InetSocketAddress(u.getHost(), u.getPort() < 0 ? 80 : u.getPort()), timeoutMs);
            s.setSoTimeout(timeoutMs);
            String head = "GET " + u.getFile() + " HTTP/1.1\r\nHost: " + u.getHost()
                    + "\r\nConnection: close\r\n\r\n";
            s.getOutputStream().write(head.getBytes(StandardCharsets.UTF_8));
            String resp = readAll(s.getInputStream());
            s.close();
            int at = resp.indexOf("\r\n\r\n");
            return at >= 0 ? resp.substring(at + 4) : "";
        } catch (Exception e) {
            return "";
        }
    }

    private static String readAll(InputStream in) {
        try (InputStream i = in) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = i.read(buf)) != -1) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
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
        int i = s.indexOf(a);
        if (i < 0) return "";
        i += a.length();
        int j = s.indexOf(b, i);
        return j < 0 ? "" : s.substring(i, j).trim();
    }

    private static String absUrl(String base, String rel) {
        if (rel.isEmpty()) return "";
        try {
            return URI.create(base).resolve(rel).toString();
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
