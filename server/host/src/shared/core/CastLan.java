package core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Random;

/**
 * 投屏专用局域网通道：选地址、发令牌、判断白名单。
 *
 * <p><b>为什么需要它</b>：投出去的 URL 必须让电视能访问，但 PC/TV 的主 API 绑的是
 * 127.0.0.1。把整个 API 放开到 0.0.0.0 会顺带暴露配置/导入/文件写入等写端点；
 * 这里只开一个 **白名单 + 一次性令牌** 的旁路：媒体流、弹幕、转码、缓存、
 * 会话控制，别的路径一律 404。
 *
 * <p><b>什么时候启动</b>：`GET /api/cast/base` 第一次被调用时（用户打开投屏面板），
 * 不投屏就完全不监听。端口由系统分配，实际端口写进返回的 `base`。
 *
 * <p>本类不持有 HTTP 服务器：默认包里的 {@code ApiServer} 负责创建并回调
 * {@code handleLan}（Java 不允许命名包反向引用默认包，所以拆分在这里）。
 */
public final class CastLan {

    private CastLan() {
    }

    /** 每次进程启动随机一次：同一网络里别的设备不该复用上个月的 URL。 */
    private static final String TOKEN = randomToken();

    private static volatile int port = 0;

    private static final String[] ALLOW_PREFIX = {
            "/api/proxy/stream",
            "/api/proxy/danmaku",
            "/api/transcode",
            "/api/cache/",
            "/api/cast/session",
            "/api/cast/command",
            "/api/cast/progress",
            "/api/cast/transfer",
    };

    public static String token() {
        return TOKEN;
    }

    public static int port() {
        return port;
    }

    /** 由 ApiServer 在监听成功后回填实际端口。 */
    public static void setPort(int p) {
        port = p;
    }

    /** 白名单：只有这些前缀能通过局域网旁路。 */
    public static boolean allowed(String path) {
        if (path == null) return false;
        if ("/api/cast/health".equals(path)) return true;
        for (String p : ALLOW_PREFIX) {
            if (path.startsWith(p)) return true;
        }
        return false;
    }

    public static boolean tokenOk(String got) {
        if (got == null) return false;
        return constantTimeEquals(got, TOKEN);
    }

    // ------------------------------------------------------------ 地址

    /** 所有可用于局域网的 IPv4（去掉回环/链路本地/未启用）。 */
    public static List<String> localIps() {
        List<String> out = new ArrayList<>();
        for (Nic nic : nics()) out.add(nic.addr.getHostAddress());
        return out;
    }

    /**
     * 选一个接收端能访问的地址。
     *
     * <p>优先与接收端同 /24 的网卡（多网卡机器上唯一可靠的判据）；否则取第一张
     * 非虚拟的局域网网卡。选不出就返回空串，由调用方报"没有局域网地址"。
     */
    public static String pickIp(String peerHost) {
        List<Nic> list = nics();
        if (list.isEmpty()) return "";
        String peerPrefix = prefix24(peerHost);
        if (!peerPrefix.isEmpty()) {
            for (Nic nic : list) {
                if (prefix24(nic.addr.getHostAddress()).equals(peerPrefix)) {
                    return nic.addr.getHostAddress();
                }
            }
        }
        // 没有同网段线索：非虚拟网卡优先，其次默认路由，最后兜底
        for (Nic nic : list) {
            if (!nic.virtual) return nic.addr.getHostAddress();
        }
        String def = defaultRouteIp();
        if (!def.isEmpty()) {
            for (Nic nic : list) {
                if (nic.addr.getHostAddress().equals(def)) return def;
            }
        }
        return list.get(0).addr.getHostAddress();
    }

    private static volatile String defaultRoute;

    /**
     * 默认路由所在网卡的 IPv4。
     *
     * <p>UDP `connect` 只做一次路由查找，不发任何包；离线也能拿到本机出口地址。
     * 多网卡（Hyper-V/WSL/Docker）时这是唯一可靠的"真实网卡"判据。
     */
    public static String defaultRouteIp() {
        if (defaultRoute != null) return defaultRoute;
        String ip = "";
        java.net.DatagramSocket s = null;
        try {
            s = new java.net.DatagramSocket();
            s.connect(InetAddress.getByName("223.5.5.5"), 53);
            InetAddress a = s.getLocalAddress();
            if (a != null && !a.isAnyLocalAddress() && !a.isLoopbackAddress()) {
                ip = a.getHostAddress();
            }
        } catch (Exception ignored) {
        } finally {
            if (s != null) {
                try {
                    s.close();
                } catch (Exception ignored) {
                }
            }
        }
        defaultRoute = ip;
        return ip;
    }

    /** `http://<ip>:<port>`；端口还没起来时返回空串。 */
    public static String baseFor(String peerHost) {
        int p = port;
        String ip = pickIp(peerHost);
        if (p <= 0 || ip.isEmpty()) return "";
        return "http://" + ip + ":" + p;
    }

    /**
     * 把回环/相对媒体地址改写成局域网绝对地址。
     *
     * <p>只改 host 是回环或 `localhost` 的 URL；已经是局域网/公网绝对地址的原样返回。
     * 改写后如果 query 里没有 `ct`，补上本进程令牌。
     *
     * @return 改写后的 URL；无法改写（解析失败、没有局域网地址）返回空串。
     */
    public static String rewriteLoopback(String url, String peerHost) {
        if (url == null || url.trim().isEmpty()) return "";
        URI u;
        try {
            u = URI.create(url.trim());
        } catch (Exception e) {
            return "";
        }
        String host = u.getHost();
        if (host == null || host.isEmpty()) return "";
        if (!isLoopbackHost(host)) return url;
        String base = baseFor(peerHost);
        if (base.isEmpty()) return "";
        String path = u.getRawPath() == null ? "" : u.getRawPath();
        String query = u.getRawQuery() == null ? "" : u.getRawQuery();
        if (!hasParam(query, "ct")) {
            query = query.isEmpty() ? ("ct=" + TOKEN) : (query + "&ct=" + TOKEN);
        }
        return base + path + (query.isEmpty() ? "" : "?" + query);
    }

    public static JSONObject info(String peerHost) throws Exception {
        JSONObject o = new JSONObject();
        String base = baseFor(peerHost);
        JSONArray ips = new JSONArray();
        for (String ip : localIps()) ips.put(ip);
        o.put("port", port);
        o.put("token", TOKEN);
        o.put("ips", ips);
        if (base.isEmpty()) {
            o.put("ok", false);
            o.put("msg", "没有局域网地址：请确认设备连在 Wi-Fi/网线上（仅回环不可投屏）");
        } else {
            o.put("ok", true);
            o.put("base", base);
        }
        return o;
    }

    // ------------------------------------------------------------ 内部

    private static final class Nic {
        final InetAddress addr;
        final NetworkInterface nic;
        final boolean virtual;

        Nic(InetAddress addr, NetworkInterface nic, boolean virtual) {
            this.addr = addr;
            this.nic = nic;
            this.virtual = virtual;
        }
    }

    /** 所有有 IPv4 的网卡（去重），供 SSDP 在多网卡上都 join 多播组。 */
    public static List<NetworkInterface> interfaces() {
        List<NetworkInterface> out = new ArrayList<>();
        for (Nic n : nics()) {
            if (!out.contains(n.nic)) out.add(n.nic);
        }
        return out;
    }

    /** 这个 IP 是否属于一张"非虚拟"的本机网卡（用于多网卡去重）。 */
    public static boolean isNonVirtualLocal(String ip) {
        if (ip == null || ip.isEmpty()) return false;
        for (Nic n : nics()) {
            if (n.addr.getHostAddress().equals(ip) && !n.virtual) return true;
        }
        return false;
    }

    private static List<Nic> nics() {
        List<Nic> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> all = NetworkInterface.getNetworkInterfaces();
            while (all != null && all.hasMoreElements()) {
                NetworkInterface ni = all.nextElement();
                try {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                } catch (Exception ignored) {
                    continue;
                }
                boolean virtual = false;
                try {
                    virtual = ni.isVirtual();
                } catch (Exception ignored) {
                }
                if (!virtual) {
                    // Java 在 Windows 上认不出 Hyper-V/WSL/Docker 的 vEthernet，只能按名字兜底
                    String nm = (ni.getName() == null ? "" : ni.getName()).toLowerCase();
                    try {
                        if (ni.getDisplayName() != null) nm += " " + ni.getDisplayName().toLowerCase();
                    } catch (Exception ignored) {
                    }
                    virtual = nm.matches(".*(vethernet|vmware|virtualbox|docker|wsl|hyper-v|tap|tun|tailscale|zerotier|utun).*");
                }
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!(a instanceof Inet4Address)) continue;
                    if (a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress()) continue;
                    out.add(new Nic(a, ni, virtual));
                }
            }
        } catch (Exception ignored) {
        }
        // 排序让默认选择更靠谱：192.168 家用网优先，其次 10.x，再 172.16/12；
        // 虚拟网卡（WSL/Hyper-V/Docker）整体降级。
        Collections.sort(out, (x, y) -> {
            int rx = rank(x);
            int ry = rank(y);
            if (rx != ry) return rx - ry;
            return x.addr.getHostAddress().compareTo(y.addr.getHostAddress());
        });
        return out;
    }

    private static int rank(Nic nic) {
        String ip = nic.addr.getHostAddress();
        int base;
        if (ip.startsWith("192.168.")) base = 0;
        else if (ip.startsWith("10.")) base = 1;
        else if (is172Private(ip)) base = 2;
        else base = 3;
        return nic.virtual ? base + 10 : base;
    }

    private static boolean is172Private(String ip) {
        if (!ip.startsWith("172.")) return false;
        String[] p = ip.split("\\.");
        if (p.length < 2) return false;
        try {
            int second = Integer.parseInt(p[1]);
            return second >= 16 && second <= 31;
        } catch (Exception e) {
            return false;
        }
    }

    private static String prefix24(String host) {
        if (host == null) return "";
        String[] p = host.split("\\.");
        if (p.length != 4) return "";
        return p[0] + "." + p[1] + "." + p[2];
    }

    private static boolean isLoopbackHost(String host) {
        String h = host.toLowerCase();
        return "localhost".equals(h) || h.startsWith("127.") || "::1".equals(h) || "[::1]".equals(h);
    }

    private static boolean hasParam(String query, String name) {
        if (query == null || query.isEmpty()) return false;
        for (String kv : query.split("&")) {
            int eq = kv.indexOf('=');
            String k = eq < 0 ? kv : kv.substring(0, eq);
            if (k.equals(name)) return true;
        }
        return false;
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) return false;
        if (a.length() != b.length()) return false;
        int diff = 0;
        for (int i = 0; i < a.length(); i++) diff |= a.charAt(i) ^ b.charAt(i);
        return diff == 0;
    }

    private static String randomToken() {
        byte[] buf = new byte[12];
        new Random().nextBytes(buf);
        StringBuilder sb = new StringBuilder();
        for (byte b : buf) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
