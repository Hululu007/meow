# 自建插件源

插件源是一份 JSON 清单，列出可下载的插件（id、版本、地址、SHA256）。
宿主只认清单，不关心它托管在哪。

## 文件位置与命名

通常叫 `fnpack.json`，也接受 `index.json`。

支持三种源地址写法：

```
http://host:8099/                                 → 自动拼 index.json
http://host:8099/fnpack.json                      → 直接用
https://example.com/path/fnpack.json              → 直接用
```

末尾是否带斜杠：**以 `.json` 结尾时不补斜杠**，否则会拼成
`xxx.json/index.json` 而 404；其他情况自动补 `/`。

## 完整结构

```json
{
  "schema_version": 1,
  "generated_at": "2026-10-22T03:20:15Z",
  "author": { "name": "your-name", "url": "https://github.com/your-name" },
  "min_app_version": "0.6.0",
  "packages": {
    "apiserver": {
      "display_name": "影视后端",
      "version": "1.1.6",
      "platform": ["windows-x64"],
      "desc": "宿主后端：搜索 / 详情 / 播放 / 弹幕代理",
      "author": "your-name",
      "homepage": "",
      "size": 38843935,
      "sha256": "0f8a60aafa93…",
      "url": "apiserver-1.1.6.zip",
      "requires": [],
      "hidden": false,
      "lasttime": "2026-10-22",
      "api_version": 1,
      "min_app_version": "0.6.0"
    }
  }
}
```

### 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema_version` | ✅ | 固定 `1`；其他值应用直接拒绝并提示升级 |
| `packages` | ✅ | **对象**，key 就是插件 id |
| `generated_at` | | 生成时间，仅展示 |
| `author` | | `{name, url}`，显示在连通性测试结果里 |
| `min_app_version` | | 整份清单的最低应用版本要求 |

`packages` 用对象而不是数组：手写时一眼能看出装了哪个，也少一个括号错就整份废掉的风险。

### packages 每项

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | ✅ | 语义化版本，用于判断有无更新 |
| `url` | ✅ | zip 地址；相对路径相对于清单所在目录 |
| `sha256` | ✅ | zip 的小写 hex 摘要，不匹配拒绝安装 |
| `size` | ✅ | 字节数，用于进度显示 |
| `display_name` | | 展示名，缺省用 id |
| `desc` | | 一句话说明 |
| `author` / `homepage` | | 作者与主页 |
| `requires` | | 依赖的插件 id 数组，安装时级联下载 |
| `hidden` | | `true` 时不在列表单独展示，只作为依赖被拉起 |
| `platform` | | 如 `["windows-x64"]`，当前不做强制过滤 |
| `api_version` | | manifest 结构版本，固定 `1` |
| `min_app_version` | | 单个插件的最低应用版本 |
| `lasttime` | | 更新日期 |

## url 的四种写法

以源地址 `http://h:9000/plugins/fnpack.json` 为例：

| 写法 | 示例 | 解析结果 |
|---|---|---|
| 相对同级（推荐） | `"apiserver-1.1.6.zip"` | `http://h:9000/plugins/apiserver-1.1.6.zip` |
| 相对上跳 / 子目录 | `"../apiserver.zip"` | `http://h:9000/apiserver.zip` |
| 绝对地址 | `"https://cdn.example.com/x.zip"` | 原样使用 |
| 协议相对 | `"//cdn.example.com/x.zip"` | 补上源的协议 |

拼接基准是**用户填的源地址**（去掉文件名后的目录），不是重定向后的地址。
所以 GitHub Releases 的 302 跳到对象存储不影响解析。

::: tip 推荐相对同级
同一份清单放到 nginx、GitHub、对象存储都不用改。生产环境别依赖 `../` 上跳：
应用只做朴素拼接，`..` 交给 HTTP 客户端规范化，极少数老服务器会拒绝。
:::

## 托管方式

### 静态目录

把 `fnpack.json` 和所有 zip 放同一目录：

```
plugins/
├── fnpack.json
├── apiserver-1.1.6.zip
├── drpy-1.1.6.zip
└── danmu-api-1.0.0.zip
```

用任意静态服务器（nginx、Python `http.server`、Caddy）托管即可。

### GitHub Releases

插件 zip 作为 Release 资产，清单里的 `url` 写绝对地址。
注意 Release 资产会 302 到对象存储，不影响下载，但**私有仓需要 token**，
而客户端默认不带 `Authorization`——私有仓请走 API 资产地址或对象存储。

### 子目录部署

nginx 挂在 `/plugins/` 下时，清单里的相对路径仍然相对清单文件，不用改。
只要保证 zip 与清单在同一个可访问目录树里。

## 本地测试

```bash
cd plugins
python -m http.server 8099
```

应用里填 `http://127.0.0.1:8099/fnpack.json`，点「测试」应显示插件数与版本。

手机 / 电视测试时把 `127.0.0.1` 换成电脑的局域网 IP。

## 发新版流程

1. 改插件代码，升 `manifest.json` 里的 `version`
2. 重新打包，算新的 SHA256 与 size
3. 上传新 zip，覆盖 `fnpack.json`（旧 zip 可以保留）
4. 客户端列表里出现「可升级」

版本比较是逐段比数字。远端版本高于本地才提示升级，降级不会自动发生。

## 安全要求

- `sha256` 与 `size` 必填，别为了省事留空
- 清单里不要放 token、cookie 或内部地址
- 插件是本地可执行程序，**谁控制清单谁就能在你的机器上跑代码**——只信自己的源

## 相关文档

- manifest 字段：[插件 manifest 规范](/ecosystem/plugin-manifest)
- 插件机制与回滚：[插件生态与安装](/ecosystem/plugins)
