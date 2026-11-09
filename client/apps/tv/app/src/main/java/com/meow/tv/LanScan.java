package com.meow.tv;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 在局域网里找正在跑的猫窝后端。
 *
 * <p><b>为什么需要它</b>：电视上没有好用的输入法，让用户用遥控器敲
 * {@code http://192.168.1.10:30010} 是最劝退的一步。自动扫一遍局域网，
 * 把找到的服务列出来点一下就连上，这才是 TV 该有的配置方式。
 *
 * <p><b>为什么扫网段而不是 mDNS</b>：我们的后端没有广播 mDNS 服务，
 * 加一套 mDNS 要动后端且只在同一网段有效；而扫 254 个地址 + 并发探测
 * 实测只要 3-5 秒，比让用户打字快得多。
 *
 * <p><b>判据是 `/api/health` 返回的 version</b>，不是端口能连上——
 * 同一个网段里跑着别的服务（路由器、NAS 面板、别的影视后端）时，
 * 只看端口会列出一堆假目标。响应里有我们认得的字段才算命中。
 */
final class LanScan {

    private LanScan() {
    }

    /** 一个找到的服务。 */
    static final class Found {
        String host = "";
        int port;
        String version = "";
        String label = "";
        /** 这个端口是否同时提供网页（根路径返回 HTML）。false = 纯后端，不能当网页地址用。 */
        boolean hasWeb;
    }

    /** 常扫端口。30010 是 Docker 默认，9979-9985 是 PC 插件协商区间。 */
    private static final int[] PORTS = {30010, 9979, 9980, 9981, 9982, 30011};

    /**
     * 兜底网段：当本机所在网段一个后端都没扫到时才试。
     *
     * <p>顺序有讲究——192.168.1 与 192.168.2 是家用路由器最常见的前缀
     * （本仓库的开发环境就是 192.168.1.x），放最前面能让绝大多数人
     * 在第一段就命中，不必等全部扫完。
     */
    private static final String[] COMMON_PREFIXES = {
            "192.168.1", "192.168.0", "192.168.2", "192.168.31", "10.0.0",
    };

    /**
     * 扫描本机所在网段。
     *
     * @param onProgress 每找到一个回调一次（用于边扫边显示）
     * @param timeoutMs  总超时
     */
    static List<Found> scan(Progress onProgress, int timeoutMs) {
        List<Found> results = Collections.synchronizedList(new ArrayList<Found>());
        List<String> prefixes = localPrefixes();
        if (prefixes.isEmpty()) return results;

        // 阶段一：本网段 + 网关所在段。这是"正常情况"，绝大多数用户的
        // 后端就在自己网段里，用最短时间出结果。
        //
        // 为什么要带上网关段：NAT 环境（MuMu/AVD 是 10.0.2.x，应用宝 VM 是
        // 172.28.x）下本机被放在独立网段，后端却在真实局域网的 192.168.1.x。
        // 只扫自己那一段会永远扫不到，用户看到"没找到"——即使网络其实是通的
        // （实测 MuMu 里 ping 192.168.1.10 与 nc 30010 都成功）。
        long deadline = System.currentTimeMillis() + timeoutMs;
        List<String> stage1 = new ArrayList<>(prefixes);
        for (String gwPrefix : gatewayPrefixes()) {
            if (!stage1.contains(gwPrefix)) stage1.add(gwPrefix);
        }
        scanPrefixes(stage1, results, onProgress, deadline);

        // 阶段二：兜底。只有阶段一颗粒无收才走——否则每次配置页打开都要
        // 多扫 5 个网段（约 7600 个探测），把"约 5 秒"变成十几秒。
        if (results.isEmpty()) {
            // 已经扫过的本机段不再重复；兜底段里也跳过网关段
            List<String> stage2 = new ArrayList<>();
            for (String p : COMMON_PREFIXES) {
                if (!stage1.contains(p) && !stage2.contains(p)) stage2.add(p);
            }
            if (!stage2.isEmpty()) {
                // 兜底阶段再给一份预算：阶段一可能已经把时间用完了，
                // 不给就等于"永远扫不到远端"。
                long more = Math.max(3000, timeoutMs / 2);
                scanPrefixes(stage2, results, onProgress, System.currentTimeMillis() + more);
            }
        }
        return results;
    }

    /**
     * 扫描若干 /24 网段，命中写进 {@code out}。
     *
     * <p>抽出这个方法是必要的：阶段一和阶段二的目标数量差 5 倍，
     * 内联两份循环很容易只改一处（漏掉 deadline 或 pending 计数）。
     */
    private static void scanPrefixes(List<String> prefixes, List<Found> out,
                                     Progress onProgress, long deadline) {
        long budget = deadline - System.currentTimeMillis();
        if (budget <= 0 || prefixes.isEmpty()) return;

        // 线程数随目标量放大：一个网段是 254×6=1524 个探测，
        // 固定 48 会让多网段扫描线性变慢。
        ExecutorService pool = Executors.newFixedThreadPool(
                Math.min(128, Math.max(32, 24 * prefixes.size())));
        final AtomicInteger pending = new AtomicInteger(prefixes.size() * 254 * PORTS.length);
        final CountDownLatch done = new CountDownLatch(1);

        for (final String prefix : prefixes) {
            for (int i = 1; i <= 254; i++) {
                final String ip = prefix + "." + i;
                for (final int port : PORTS) {
                    pool.execute(() -> {
                        try {
                            if (System.currentTimeMillis() > deadline) return;
                            Found f = probe(ip, port);
                            if (f != null) {
                                out.add(f);
                                if (onProgress != null) onProgress.onFound(f, out.size());
                            }
                        } finally {
                            if (pending.decrementAndGet() == 0) done.countDown();
                        }
                    });
                }
            }
        }
        try {
            done.await(Math.max(1000, budget), TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {
        }
        pool.shutdownNow();
    }

    /** 探测一个地址；是猫窝后端就返回它，否则 null。 */
    private static Found probe(String ip, int port) {
        HttpURLConnection c = null;
        try {
            URL u = new URL("http://" + ip + ":" + port + "/api/health");
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(500);
            c.setReadTimeout(700);
            c.setRequestMethod("GET");
            if (c.getResponseCode() != 200) return null;
            String text;
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[4096];
                int n = in.read(buf);
                text = n <= 0 ? "" : new String(buf, 0, n, "UTF-8");
            }
            JSONObject o = new JSONObject(text);
            // 必须同时有 ok 与 version：只看其中一个会和别的服务撞
            if (!o.has("ok") || !o.has("version")) return null;
            Found f = new Found();
            f.host = ip;
            f.port = port;
            f.version = o.optString("version", "");
            // 同时探一次根路径：只有返回 HTML 才能当网页地址填。
            // 9979 这类纯后端端口根路径是 {"code":-1,"msg":"not found"}，
            // 填进 WebView 就是一片 JSON，用户看到的是"打开了但是空的"。
            f.hasWeb = rootIsHtml(ip, port);
            int sites = o.optInt("sites", 0);
            f.label = ip + ":" + port
                    + (sites > 0 ? "（" + sites + " 源）" : "")
                    // 内置前端后不再区分后端/网页端口，两者都能直接用
                    ;
            return f;
        } catch (Throwable t) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 根路径是否返回 HTML（能不能当网页地址用）。 */
    private static boolean rootIsHtml(String ip, int port) {
        HttpURLConnection c = null;
        try {
            URL u = new URL("http://" + ip + ":" + port + "/");
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(500);
            c.setReadTimeout(700);
            c.setRequestMethod("GET");
            int code = c.getResponseCode();
            if (code != 200) return false;
            String ct = c.getContentType();
            return ct != null && ct.toLowerCase().contains("text/html");
        } catch (Throwable t) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 本机的 IPv4 网段前缀（去掉最后一段），只取私有网段。 */
    private static List<String> localPrefixes() {
        List<String> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!(a instanceof Inet4Address)) continue;
                    String ip = a.getHostAddress();
                    if (ip == null || !ip.contains(".")) continue;
                    // 只扫私有网段：公网地址扫了也没用，还会造成外部请求
                    if (!(ip.startsWith("192.168.") || ip.startsWith("10.")
                            || ip.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*"))) {
                        continue;
                    }
                    String prefix = ip.substring(0, ip.lastIndexOf('.'));
                    // /24 网段；192.168.1.x 这种最常见的家用网段
                    if (!out.contains(prefix)) out.add(prefix);
                }
            }
        } catch (Throwable ignored) {
        }
        return out;
    }

    /**
     * 默认网关所在的 /24 前缀。
     *
     * <p>NAT 环境里本机在 10.0.2.x / 172.28.x，网关背后才是真实局域网。
     * 网关自己一般不是后端（它是路由器/宿主），但它的网段常与真实局域网同段，
     * 所以值得单独扫一段。
     */
    private static List<String> gatewayPrefixes() {
        List<String> out = new ArrayList<>();
        for (String gw : defaultGateways()) {
            if (!isPrivate(gw)) continue;
            String prefix = gw.substring(0, gw.lastIndexOf('.'));
            if (!out.contains(prefix)) out.add(prefix);
        }
        return out;
    }

    /**
     * 默认网关地址列表。
     *
     * <p>不走 {@code ConnectivityManager}：那需要 ACCESS_NETWORK_STATE 权限，
     * 而本应用只申请了 INTERNET。直接读 {@code /proc/net/route} 是 Android 上
     * 不需要权限的传统做法，读不到就返回空（不可用时不要让整次扫描失败）。
     */
    private static List<String> defaultGateways() {
        List<String> out = new ArrayList<>();
        java.io.BufferedReader br = null;
        try {
            br = new java.io.BufferedReader(new java.io.FileReader("/proc/net/route"));
            String line;
            // 表头：Iface Destination Gateway Flags RefCnt Use Metric Mask ...
            // Destination/Gateway 是**小端十六进制**（0100007F = 127.0.0.1），
            // 直接按十进制字符串读会得到一串看不懂的数字。
            while ((line = br.readLine()) != null) {
                String[] f = line.trim().split("\\s+");
                if (f.length < 3) continue;
                if (!"00000000".equals(f[1])) continue; // Destination=0 → 默认路由
                long v;
                try {
                    v = Long.parseLong(f[2], 16);
                } catch (NumberFormatException e) {
                    continue;
                }
                // 小端还原：字节序是 A B C D → D C B A
                String ip = (v & 0xFF) + "." + ((v >> 8) & 0xFF) + "."
                        + ((v >> 16) & 0xFF) + "." + ((v >> 24) & 0xFF);
                if (!"0.0.0.0".equals(ip) && !out.contains(ip)) out.add(ip);
            }
        } catch (Throwable ignored) {
        } finally {
            if (br != null) {
                try {
                    br.close();
                } catch (Throwable ignored) {
                }
            }
        }
        return out;
    }

    private static boolean isPrivate(String ip) {
        return ip.startsWith("192.168.")
                || ip.startsWith("10.")
                || ip.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*");
    }

    static JSONArray toJson(List<Found> list) {
        JSONArray arr = new JSONArray();
        for (Found f : list) {
            JSONObject o = new JSONObject();
            try {
                o.put("url", "http://" + f.host + ":" + f.port);
                o.put("label", f.label);
                o.put("version", f.version);
                o.put("hasWeb", f.hasWeb);
                o.put("url", "http://" + f.host + ":" + f.port);
            } catch (Throwable ignored) {
            }
            arr.put(o);
        }
        return arr;
    }

    interface Progress {
        void onFound(Found f, int count);
    }
}
