package sources;

import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 原生源注册表 + 统一分发。
 *
 * <p>挂载点只有一处：{@code ApiServer.call()} 的最前面（在 js / jar 两个分支之前）。
 * 这样"站点由谁实现"对一个站点是确定的，不用在 jar 里猜有没有对应 class。
 *
 * <p>分发规则：
 * <ul>
 *   <li>{@code home} / {@code category} / {@code detail}：原生源必须实现</li>
 *   <li>{@code search}：原生源可返回 {@code null} 表示不实现 → 交给 jar（若有）</li>
 *   <li>{@code play} / {@code live} / {@code action}：原生源不实现 → 一律交给 jar</li>
 * </ul>
 */
public final class NativeSources {

    /**
     * site → 实现。key 必须与 `SITES` 里的站点名完全一致（前端按站点名调用）。
     *
     * <p>LinkedHashMap 只为了 /api/health 与日志里顺序稳定，不影响行为。
     */
    private static final Map<String, NativeSource> MAP = new LinkedHashMap<>();

    static {
        MAP.put("Douban", new DoubanSource());
    }

    private NativeSources() {
    }

    public static NativeSource get(String site) {
        return site == null ? null : MAP.get(site);
    }

    public static int size() {
        return MAP.size();
    }

    /**
     * 分发一次调用。
     *
     * @return 响应体；{@code null} 表示"本源不实现这个 action"，调用方应继续走 jar，
     *         若连 jar 也没有就回空结构（不能抛，否则前端看到 500）
     */
    public static String invoke(NativeSource ns, String action, String body) {
        if (ns == null || action == null) return null;
        JSONObject b = new JSONObject();
        if (body != null && !body.trim().isEmpty()) {
            try {
                b = new JSONObject(body);
            } catch (Throwable ignored) {
                // 坏 body 不能把整条链路打挂：按"没传参数"处理，源自己会退回默认值
            }
        }
        switch (action) {
            case "home":
                return ns.home();
            case "category": {
                String id = b.optString("id", b.optString("tid", ""));
                String page = b.optString("page", b.optString("pg", "1"));
                return ns.category(id, page, b.optJSONObject("filters"));
            }
            case "detail": {
                String id = b.optString("id", b.optString("ids", ""));
                return ns.detail(firstId(id));
            }
            case "search": {
                String wd = b.optString("wd", b.optString("key", ""));
                String pg = b.optString("pg", b.optString("page", "1"));
                return ns.search(wd, pg);
            }
            default:
                return null;
        }
    }

    /** 详情可能是逗号分隔的批量 id；原生源只做单片，取第一个。 */
    private static String firstId(String ids) {
        if (ids == null) return "";
        int i = ids.indexOf(',');
        return (i < 0 ? ids : ids.substring(0, i)).trim();
    }
}
