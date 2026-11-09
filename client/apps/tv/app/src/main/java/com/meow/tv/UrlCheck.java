package com.meow.tv;

import java.net.InetAddress;
import java.net.URI;

/**
 * 代理目标的地址校验（SSRF 防护）。
 *
 * <p><b>为什么需要它</b>：{@code /api/proxy/image} 和 {@code /api/proxy/stream}
 * 接受调用方给的任意 URL。不校验就等于在局域网里开了一个开放代理——
 * 任何人都能用它访问内网设备（路由器后台、NAS 管理页、云元数据接口）。
 *
 * <p><b>为什么分两档</b>：两个端点的风险不一样。
 * <ul>
 *   <li>图片：允许局域网。自建图床、NAS 里的海报是合理场景，而且
 *       图片只读、无法构造带副作用的请求。</li>
 *   <li>视频流：拒绝私网与回环。它的响应体会被原样回传给调用方，
 *       等于把内网响应"搬运"出来，风险高一个量级。</li>
 * </ul>
 *
 * <p><b>已知取舍</b>：这里只查 URL 里的字面地址和 DNS 解析结果，解析之后
 * 到真正建连之间有一个 rebinding 时间窗（TOCTOU）。彻底的做法是在 DNS 层过滤，
 * 但那要自己实现 HostnameVerifier + 自定义 Socket 工厂，代价远大于收益；
 * 而 TV 上这个端口只监听 127.0.0.1，本来就只有本机页面能用。
 */
final class UrlCheck {

    private UrlCheck() {
    }

    /**
     * @param strict true = 拒绝私网/回环/链路本地（视频流用）
     *               false = 只拒绝回环与云元数据（图片用）
     */
    static boolean allowed(String url, boolean strict) {
        if (url == null || url.isEmpty()) return false;
        try {
            URI u = new URI(url);
            String scheme = u.getScheme();
            if (scheme == null) return false;
            String s = scheme.toLowerCase();
            if (!s.equals("http") && !s.equals("https")) return false;

            String host = u.getHost();
            if (host == null || host.isEmpty()) return false;
            // .internal / .local 这类内网后缀一律拒绝（都是明确的本地名字）
            String lower = host.toLowerCase();
            if (lower.endsWith(".internal") || lower.endsWith(".local")
                    || lower.equals("localhost")) {
                return false;
            }

            // 云元数据地址：任何档位都拒。这是最典型的 SSRF 目标。
            if (lower.equals("169.254.169.254") || lower.equals("metadata.google.internal")) {
                return false;
            }

            // 字面 IP 直接判；域名要解析出来再判
            InetAddress[] addrs;
            try {
                addrs = InetAddress.getAllByName(host);
            } catch (Throwable t) {
                return false; // 解析不了就不放行，别留给下游一个模糊失败
            }
            for (InetAddress a : addrs) {
                if (!allowedAddress(a, strict)) return false;
            }
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    private static boolean allowedAddress(InetAddress a, boolean strict) {
        if (a.isLoopbackAddress()) return false;        // 回环：两档都拒
        if (a.isAnyLocalAddress()) return false;        // 0.0.0.0
        if (a.isLinkLocalAddress()) return false;       // 169.254/16、fe80::/10
        if (a.isMulticastAddress()) return false;
        if (!strict) return true;                       // 图片档到此为止

        // 严格档：再拒私网
        if (a.isSiteLocalAddress()) return false;       // 10/8、172.16/12、192.168/16
        byte[] b = a.getAddress();
        if (b.length == 4) {
            int b0 = b[0] & 0xFF;
            int b1 = b[1] & 0xFF;
            // 100.64/10（CGNAT）
            if (b0 == 100 && b1 >= 64 && b1 <= 127) return false;
            // 198.18/15（benchmark）
            if (b0 == 198 && (b1 == 18 || b1 == 19)) return false;
        } else if (b.length == 16) {
            // fc00::/7（unique local）
            if ((b[0] & 0xFE) == 0xFC) return false;
            // NAT64 64:ff9b::/96 可能被用来绕过 IPv4 私有段检查
            if (b[0] == 0x00 && b[1] == 0x64 && b[2] == (byte) 0xFF && b[3] == (byte) 0x9B) {
                return false;
            }
        }
        return true;
    }
}
