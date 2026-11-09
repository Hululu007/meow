package com.github.catvod.utils;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Base64;

import com.github.catvod.Runtime;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.Enumeration;
import java.util.Locale;

import okhttp3.OkHttp;

public class Util {

    public static final String OKHTTP = "okhttp/" + OkHttp.VERSION;
    public static final String CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
    public static final int URL_SAFE = Base64.DEFAULT | Base64.URL_SAFE | Base64.NO_WRAP;

    public static String base64(String s) {
        return base64(s.getBytes());
    }

    public static String base64(byte[] bytes) {
        return base64(bytes, Base64.DEFAULT | Base64.NO_WRAP);
    }

    public static String base64(String s, int flags) {
        return base64(s.getBytes(), flags);
    }

    public static String base64(byte[] bytes, int flags) {
        return Base64.encodeToString(bytes, flags);
    }

    public static byte[] decode(String s) {
        return decode(s, Base64.DEFAULT | Base64.NO_WRAP);
    }

    public static byte[] decode(String s, int flags) {
        return Base64.decode(s, flags);
    }

    public static byte[] hex2byte(String s) {
        byte[] bytes = new byte[s.length() / 2];
        for (int i = 0; i < bytes.length; i++) bytes[i] = Integer.valueOf(s.substring(i * 2, i * 2 + 2), 16).byteValue();
        return bytes;
    }

    public static boolean containOrMatch(String text, String regex) {
        try {
            return text.contains(regex) || text.matches(regex);
        } catch (Exception e) {
            return false;
        }
    }

    public static String substring(String text) {
        return substring(text, 1);
    }

    /**
     * 从 HTML 里抠 JS 变量值：{@code var name = "..."} / {@code name: '...'}。
     *
     * <p><b>为什么加在宿主而不是 jar 里</b>：外部 jar 是 {@code DexClassLoader}
     * 加载的，委派顺序是**父加载器优先**——jar 里再打一份 {@code Util} 也不会生效，
     * 运行时永远用这里这份。社区 spider（如 Jable）直接调 {@code Util.getVar}，
     * 缺这个方法就是 {@code NoSuchMethodError}，且报错发生在 Class 已加载之后，
     * 看起来像"源站解析失败"。
     *
     * <p>找不到返回空串，不抛异常：单站解析失败不该把整轮搜索拖垮。
     */
    public static String getVar(String html, String name) {
        if (html == null || name == null || name.isEmpty()) return "";
        String n = java.util.regex.Pattern.quote(name);
        java.util.regex.Pattern[] ps = {
                java.util.regex.Pattern.compile(n + "\\s*[=:]\\s*[\"']([^\"']+)[\"']"),
                java.util.regex.Pattern.compile("[\"']" + n + "[\"']\\s*[:=]\\s*[\"']([^\"']+)[\"']"),
        };
        for (java.util.regex.Pattern p : ps) {
            java.util.regex.Matcher m = p.matcher(html);
            if (m.find()) return m.group(1);
        }
        return "";
    }

    public static String substring(String text, int num) {
        if (text != null && text.length() > num) return text.substring(0, text.length() - num);
        return text;
    }

    public static String getIp() {
        try {
            String ip = getHostAddress("wlan");
            if (!ip.isEmpty()) return ip;
            ip = getHostAddress("eth");
            if (!ip.isEmpty()) return ip;
            ip = getWifiAddress();
            if (!ip.isEmpty()) return ip;
            return getHostAddress("");
        } catch (Exception e) {
            return "";
        }
    }

    private static String getWifiAddress() {
        WifiManager manager = (WifiManager) Runtime.context().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        int ip = manager.getConnectionInfo().getIpAddress();
        return ip == 0 ? "" : String.format(Locale.getDefault(), "%d.%d.%d.%d", ip & 0xFF, (ip >> 8) & 0xFF, (ip >> 16) & 0xFF, (ip >> 24) & 0xFF);
    }

    private static String getHostAddress(String keyword) throws SocketException {
        for (Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces(); en.hasMoreElements(); ) {
            NetworkInterface nif = en.nextElement();
            if (!keyword.isEmpty() && !nif.getName().startsWith(keyword)) continue;
            for (Enumeration<InetAddress> addresses = nif.getInetAddresses(); addresses.hasMoreElements(); ) {
                InetAddress addr = addresses.nextElement();
                if (!addr.isLoopbackAddress() && addr instanceof Inet4Address) return addr.getHostAddress();
            }
        }
        return "";
    }
}
