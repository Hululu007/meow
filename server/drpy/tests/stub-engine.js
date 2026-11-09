/**
 * 测试用「引擎替身」：只验证运行时宿主提供的契约，不依赖外网。
 *
 * 为什么要替身：真实的 drpy2.min.js 有 64KB 且要连第三方 CDN 取模块，
 * 放进仓库既不合规也不可复现。这里把宿主必须满足的几条契约单独固化：
 *   1. ESM 的 `import x from "assets://..."`（CJS 无 default 也要能取到）
 *   2. `req()` 返回对象且 `.content` 是正文
 *   3. `String.prototype.rstrip` 存在
 *   4. `cheerio.jinja2` 能渲染 {{...}}
 *   5. `let d=[]` + 规则脚本里的 `var d` 不冲突（compatPatch）
 */
import cheerio from 'assets://js/lib/cheerio.min.js'

// 模拟引擎里的累加器：V8 下与 eval 里的 `var d` 冲突，compatPatch 会改成 var
let d = []

export default {
  init(ext) {
    this.host = String(ext || '').rstrip('/')
  },
  home() {
    // 引擎里写的是 `res.content || ""`，这里用同样的取法
    const res = req(this.host + '/api/home')
    const data = JSON.parse(res.content)
    return {
      class: data.classes.map((c) => ({ type_id: c.id, type_name: c.name })),
      // jinja2 用于拼带筛选参数的 URL
      filterUrl: cheerio.jinja2('area={{fl.area}}&page={{page}}', { fl: { area: '1' }, page: 2 }),
    }
  },
  category(tid, pg) {
    const res = req(this.host + '/api/list?type=' + tid + '&page=' + pg)
    const data = JSON.parse(res.content)
    // 规则脚本的典型写法：eval 里 var d=[]，再 push
    eval('var d = []; data.list.forEach(function(it){ d.push({title: it.name, url: it.id}) });')
    return { list: d.map((x) => ({ vod_id: x.url, vod_name: x.title })) }
  },
  search(wd) {
    const res = req(this.host + '/api/search?wd=' + encodeURIComponent(wd))
    return { list: JSON.parse(res.content).list.map((x) => ({ vod_id: x.id, vod_name: x.name })) }
  },
}
