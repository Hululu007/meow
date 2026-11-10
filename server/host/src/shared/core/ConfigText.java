package core;

import java.net.IDN;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 配置文本的跨端预处理（JVM 与 Android 共用）。
 *
 * <p>为什么放在 shared：PC 后端的 {@code ApiServer.fetchText} 与 TV 壳的
 * {@code TvBridge.fetch} 是两套 HTTP 栈，但“中文域名、2423、base64 伪装”
 * 是配置格式本身的事，不应该各写一份。这里只做纯字符串/加密处理，不发请求。
 */
public final class ConfigText {

    private static final Pattern BASE64_PREFIX =
            Pattern.compile("^[A-Za-z0-9]{8}\\*\\*(.+)$", Pattern.DOTALL);

    private ConfigText() {
    }

    /** Unicode 域名 → punycode；Java 的 URL 不会自动做 IDN。 */
    public static String idnUrl(String url) {
        if (url == null || url.isEmpty()) return url;
        /*
         * 不用 java.net.URI：Android 的 libcore 与桌面 JDK 对 Unicode
         * authority 的接受度不完全一致；这里只解析 URI 里最小的一段
         * ——scheme://authority/path?query#fragment——既够处理配置地址，
         * 也避免重建 URL 时把 path/query 重新编码。
         */
        int scheme = url.indexOf("://");
        if (scheme <= 0) return url;
        int authStart = scheme + 3;
        int authEnd = url.length();
        for (int i = authStart; i < url.length(); i++) {
            char c = url.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                authEnd = i;
                break;
            }
        }
        if (authEnd <= authStart) return url;

        String auth = url.substring(authStart, authEnd);
        String userInfo = "";
        int at = auth.lastIndexOf('@');
        if (at >= 0) {
            userInfo = auth.substring(0, at + 1);
            auth = auth.substring(at + 1);
        }
        if (auth.startsWith("[")) return url; // IPv6

        String host = auth;
        String port = "";
        int colon = auth.lastIndexOf(':');
        if (colon > 0) {
            boolean digits = true;
            for (int i = colon + 1; i < auth.length(); i++) {
                if (!Character.isDigit(auth.charAt(i))) {
                    digits = false;
                    break;
                }
            }
            if (digits) {
                host = auth.substring(0, colon);
                port = auth.substring(colon);
            }
        }
        if (host.isEmpty()) return url;
        try {
            String ascii = IDN.toASCII(host);
            if (ascii.equalsIgnoreCase(host)) return url;
            return url.substring(0, authStart) + userInfo + ascii + port + url.substring(authEnd);
        } catch (Throwable t) {
            return url;
        }
    }

    /** 解 2423 Hex+AES / 8 位前缀 + ** base64；不认识的原文返回。 */
    public static String decode(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.startsWith("2423")) {
            try {
                return cbc(s.replaceAll("\\s+", ""));
            } catch (Throwable ignored) {
                return raw;
            }
        }
        Matcher m = BASE64_PREFIX.matcher(s);
        if (m.find()) {
            try {
                byte[] b = Base64.getDecoder().decode(m.group(1).replaceAll("\\s+", ""));
                return new String(b, StandardCharsets.UTF_8);
            } catch (Throwable ignored) {
            }
        }
        return raw;
    }

    public static boolean looksJson(String s) {
        if (s == null) return false;
        String t = s.trim();
        if (t.startsWith("\uFEFF")) t = t.substring(1).trim();
        return t.startsWith("{") || t.startsWith("[");
    }

    private static String cbc(String hex) throws Exception {
        byte[] head = hex2byte(hex);
        String decoded = new String(head, StandardCharsets.UTF_8).toLowerCase(Locale.ROOT);
        int a = decoded.indexOf("$#");
        int b = decoded.indexOf("#$");
        if (a < 0 || b <= a + 2) throw new IllegalArgumentException("2423 markers");
        String key = pad16(decoded.substring(a + 2, b));
        String iv = pad16(decoded.substring(decoded.length() - 13));
        int marker = hex.indexOf("2324");
        if (marker < 0 || hex.length() <= marker + 4 + 26) {
            throw new IllegalArgumentException("2423 payload");
        }
        byte[] payload = hex2byte(hex.substring(marker + 4, hex.length() - 26));
        javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(javax.crypto.Cipher.DECRYPT_MODE,
                new javax.crypto.spec.SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "AES"),
                new javax.crypto.spec.IvParameterSpec(iv.getBytes(StandardCharsets.UTF_8)));
        return new String(c.doFinal(payload), StandardCharsets.UTF_8);
    }

    private static String pad16(String s) {
        return s + "0000000000000000".substring(s.length());
    }

    private static byte[] hex2byte(String s) {
        if (s.length() % 2 != 0) throw new IllegalArgumentException("odd hex");
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}
