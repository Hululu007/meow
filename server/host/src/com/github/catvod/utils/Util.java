package com.github.catvod.utils;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 最小 Util 垫片。
 *
 * <p><b>为什么自己写</b>：社区 spider 源码只用到 {@code Util.CHROME} 与
 * {@code Util.getVar(html, name)} 两个成员，而官方 {@code catvod-api.jar} 是
 * Java 21 字节码（class 65），我们的宿主编译/运行都在 17 上——直接引那个 jar
 * 会报 "类文件具有错误的版本 65.0"。为了两个成员去拉整套 API 源码不划算，
 * 这里只补齐被用到的语义。
 *
 * <p>只要以后有 spider 用到其它 Util 方法，就按同样方式补在这里，
 * 不要改成依赖 catvod-api.jar（会把 Android 依赖引进来）。
 */
public final class Util {

    /** 社区 spider 普遍用这个 UA 走移动/宽松版页面 */
    public static final String CHROME =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    private Util() {
    }

    /**
     * 去掉拼参数时多出来的尾部 {@code &}。
     *
     * <p>唯一调用点是 {@code OkRequest.setParams()}：它把 params 逐个拼成
     * {@code url?k=v&k=v&}，最后用这个方法收尾。名字叫 substring 但语义就是
     * "截掉最后一个字符"，照这个语义实现即可——别改成截断长字符串，
     * 那会把 URL 弄坏。
     */
    public static String substring(String s) {
        if (s == null) return "";
        return s.endsWith("&") ? s.substring(0, s.length() - 1) : s;
    }

    /**
     * 从 HTML 里抠 JS 变量值：{@code var name = "..."} / {@code name: '...'}。
     *
     * <p>返回值不含引号；找不到返回空串（调用方按"没有播放地址"处理，
     * 不要抛异常——单个站点解析失败不该把整轮搜索拖垮）。
     */
    public static String getVar(String html, String name) {
        if (html == null || name == null || name.isEmpty()) return "";
        String n = Pattern.quote(name);
        Pattern[] ps = {
                Pattern.compile(n + "\\s*[=:]\\s*[\"']([^\"']+)[\"']"),
                Pattern.compile("[\"']" + n + "[\"']\\s*[:=]\\s*[\"']([^\"']+)[\"']"),
        };
        for (Pattern p : ps) {
            Matcher m = p.matcher(html);
            if (m.find()) return m.group(1);
        }
        return "";
    }
}
