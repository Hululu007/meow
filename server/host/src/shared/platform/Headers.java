package platform;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 大小写不敏感的 header 表，行为对齐 {@code com.sun.net.httpserver.Headers}
 * 在本项目里被用到的那一部分。
 *
 * <p><b>只有 4 个方法</b>：全仓对 Header 的调用实测只有 {@code set} / {@code add} /
 * {@code getFirst} / {@code remove}。JDK 的 Headers 是 {@code Map<String,List<String>>}
 * 的子类，但没有一处把它当 Map 遍历或赋值，所以不需要继承 Map——那会把
 * 两端实现都拖进 {@code entrySet}/{@code keySet} 的兼容问题里。
 *
 * <p><b>为什么用 LinkedHashMap 而不是 TreeMap</b>：头的输出顺序影响不到语义，
 * 但保持写入顺序能让抓包对比更省事（改动前后 diff 最小）。
 */
public final class Headers {

    private final Map<String, List<String>> map = new LinkedHashMap<>();

    /** 覆盖：同名头整体替换。 */
    public void set(String name, String value) {
        if (name == null) return;
        List<String> list = new ArrayList<>(1);
        list.add(value);
        map.put(key(name), list);
    }

    /** 追加：同名头保留多条（{@code Vary} / {@code Access-Control-*} 会用到）。 */
    public void add(String name, String value) {
        if (name == null) return;
        String k = key(name);
        List<String> list = map.get(k);
        if (list == null) {
            list = new ArrayList<>(1);
            map.put(k, list);
        }
        list.add(value);
    }

    /** 取第一条；不存在返回 null（与 JDK 一致，不返回空串）。 */
    public String getFirst(String name) {
        if (name == null) return null;
        List<String> list = map.get(key(name));
        return list == null || list.isEmpty() ? null : list.get(0);
    }

    public void remove(String name) {
        if (name == null) return;
        map.remove(key(name));
    }

    /** 所有条目，供两端实现把响应头真正写出去。 */
    public Map<String, List<String>> asMap() {
        return map;
    }

    private static String key(String name) {
        return name.toLowerCase(java.util.Locale.ROOT);
    }
}
