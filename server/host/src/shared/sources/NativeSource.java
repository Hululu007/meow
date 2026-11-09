package sources;

import org.json.JSONObject;

/**
 * 原生源：宿主自己实现的一类站点（**不依赖 spider.jar**）。
 *
 * <p>为什么要有这一层：我们的站点实现几乎全在第三方 jar 里
 * （默认配置 40 站里 39 个是 `csp_*`）。一旦不内置 jar，首页/榜单/详情
 * 全空。凡是"公开 JSON 接口 + 不涉及播放"的站点（豆瓣就是典型），
 * 都可以在这层用几十到一百多行自己实现，从而让壳在**没有 jar**时
 * 仍然有内容可看。
 *
 * <p>返回的必须是 CatVod 契约的 JSON 字符串（与 jar 源完全同形），
 * 这样前端和 `emptyFallback` 都不用改。
 */
public interface NativeSource {

    /** 首页分类：{@code {"class":[{"type_id","type_name"}],"filters":{}}} */
    String home();

    /**
     * 分类列表（含榜单）。
     *
     * @param id      分类 id（如 {@code tv_hot}）
     * @param page    页码，从 1 开始
     * @param filters 前端传的筛选条件（可空）
     */
    String category(String id, String page, JSONObject filters);

    /** 详情：至少给名称/海报/简介；不提供播放地址时返回空 play_from */
    default String detail(String id) {
        return "{\"list\":[]}";
    }

    /**
     * 搜索。
     *
     * <p><b>返回 {@code null} 表示"本源不实现这个动作"</b>：有 jar 时交给 jar
     * （豆瓣的 jar 实现只有搜索可用），没 jar 时上层给空结构，
     * 不会变成 500。空列表请显式返回 {@code {"list":[]}}——两者语义不同。
     */
    default String search(String wd, String page) {
        return null;
    }
}
