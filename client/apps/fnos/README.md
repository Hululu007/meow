# 飞牛 fnOS 套件（fpk）

把 Meow 打成 fnOS 原生应用：`meowd`（Rust 静态二进制）托管 Web 静态文件，
并把 `/api/**` 反代到本机 JVM 后端（默认 `127.0.0.1:30011`）。
应用入口是 `/app/meow/`，不是站点根。

## 构建

```bash
# 在 Linux（fnOS 机器 / CI ubuntu）执行；SRC 是含 web/dist 与 server/host/libs 的仓库副本
SRC=/tmp/meow-src OUT=/tmp/meow-out bash client/apps/fnos/build-fpk.sh
PLATFORM=arm SRC=/tmp/meow-src OUT=/tmp/meow-out-arm bash client/apps/fnos/build-fpk.sh
```

- `apiserver.jar` 默认由脚本自己编；复用旧产物必须 `SKIP_JAR_BUILD=1`，且版本不符直接失败。
- `spider.jar` / `node-payload-danmu.zip` 都可选：缺了只告警，打出来是**纯壳**，
  用户导入源包后恢复 jar 站；弹幕退回内置官方源。
- 包内**不允许**出现 node 可执行文件（node 由应用中心依赖 `nodejs_v22` 提供）。

## 安装 / 升级

- **首次安装**：`appcenter-cli install-fpk meow_x.y.z_x86.fpk`。
- **已安装应用**：`install-fpk` 是 no-op（报告成功但版本不变，实测）。
  走应用内升级（设置 → 应用更新，填 fpk 索引），或应用中心的上传升级。
- 纯壳首次启动只有 44 个静态站；在应用内导入源包后 jar 站才出现。

## 应用中心详情页：`manifest` 的 desc 是 HTML

`desc` 会被应用中心**当 HTML 渲染**（米恋泥 fndesk 就是这么用的：`<br>` 分条 +
`<a>` 下载按钮 + `<img>` 海报）。我们用它做「四条卖点 + 使用说明/项目主页链接」，
比一整行纯文本好读得多。改的时候注意：

- 整行必须**单行**（`key = value` 格式，不能换行）；
- **`desc` 整行必须 < 600 字节**（源文件里 < 576）。fnpack 1.2.3 会把超长值折行，
  折出来的续行以 `#` 开头（HTML 里正好有 `color:#2dd4bf`），飞牛按注释忽略 →
  描述从折行处被静默截断。**1.2.17 / 1.2.18 的「使用说明 / 项目主页」链接就是
  这样丢的**：FnDepot 详情页只显示 4 条 bullet，看起来像"简介没更新"。
  `build-fpk.sh` 现在有长度闸门 + 打包后逐字比对 `desc`，超长直接构建失败。
- 链接带 `target='_blank' rel='noopener'`（字节不够时先省行内 `style=`）；
- 不要引第三方统计/追踪资源。
- **两处文案要一起改**：真正显示在商店详情页的是**包内 manifest** 的 `desc`；
  `FnDepot/fnpack.json` 的 `desc` 是索引侧文案（列表/其它消费方用），发布脚本
  只写 `releases[]`，**不会同步 desc**。改一处必须顺手改另一处。

## FnDepot 的来源归属：`distributor`

FnDepot 判断一个已安装应用属于哪个源，看的是它自己库里的
`installed_app_meta.distributor`，而这一行在安装时来自**包内 manifest 的
`distributor`**（2026-11-20 实测：只改 `maintainer` 不生效，`distributor` 为空就
永远算 manual；大小写不敏感，`chrplus` 能匹配 `CHRPLUS`）。

所以 fpk 里必须写：

```
distributor=CHRPLUS
distributor_url=https://github.com/upchr/FnDepot
```

否则即使通过 FnDepot 安装，也会被归成「手动安装」，永远不进「可更新」列表。
注意：应用内自更新走 app-center 的 `packageSourceType=file`，**不经过 FnDepot**，
装完仍会失去归属（见 EWEDLCM/FnDepot#53）。

## 应用中心「更新详情」：`manifest.changelog`

更新弹框里的「更新详情」读的是**包内 manifest 的 `changelog`**（FnDepot 调
app-center `/update/info?packageType=path`，返回 `wizardInfo.changeLog`），
**不是** `fnpack.json` 里 `releases[].changelog`。

`build-fpk.sh` 现在按版本从 `CHANGELOG.md` 取对应小节，用字面量 `\n` 连接后写进
manifest；打包后再逐字比对，折行/截断直接构建失败。FnDepot 的展示函数会把
`\n`（以及 `<br>`）还原成换行。

> 实测（2026-11-20）：6 条中文 changelog ≈ 500 字节可以完整进包；
> 但 `desc`（HTML）超过 ~600 字节会被 fnpack 折行截断——两者不要混为一谈。

## 日志：用户能在共享目录里看到（2026-11-18）

排障最痛的是「用户拿不到日志」。fnOS 的应用数据在 `@appdata/<app>/logs`（0700，
普通用户进不去），所以额外在 **`@appshare/<app>/logs/`** 放一份**硬链**：

- **建目录要 root**：`@appshare/<app>` 是 fnOS 建的 `root:root 000`，应用跑在
  `package` 账号（meow）连写都写不进去 → 由 `cmd/log_share_setup` 在安装/升级
  回调（root）里建好：父目录 **0711**（可穿不可列，保护同级的 `library`），
  `logs` **0755**。
- **写链在 main**：每次 `start` 把 `$TRIM_PKGVAR/logs/*.log` 硬链进去并 `chmod 0644`
  （同卷硬链不占双份空间）。
- **启动前裁剪**：单文件超 `MEOW_LOG_MAX_MB`（默认 4MB）就保留最后
  `MEOW_LOG_KEEP_LINES`（默认 2000）行。★ 只能在启动前做——`sed -i` 换 inode，
  运行中裁会把正在写的内容丢掉。
- **不用软链**：万一 fnOS 把 `@appshare` 权限重置回 000，软链会让应用自己也写不进
  日志；硬链最坏只是"用户那边看不见"。

## 桌面图标是「扫光动图」（2026-11-18）

飞牛的桌面/应用中心图标是静态文件直出，**不能靠 CSS**做扫光——唯一办法是让图标
文件本身是动图。做得跟米恋泥 fndesk 1.2.1010.1 一致（解包确认：其 `ICON.PNG` 内容是
35 帧动画 WebP，安装时 cp 覆盖根目录图标）。

- **生成**：`python client/apps/fnos/tools/gen-icon-anim.py`
  → `fpk/app/ui/images/icon_anim.webp`（256×256、35 帧、1s 停顿 + 33×20ms 扫光 + 5s 停顿、无限循环）
- **通用生成器**：`python client/apps/fnos/tools/gen-icon-anim.py [--src X --out Y --size 512 --loop 1]`
  —— 应用内顶栏 logo（`web/public/logo-anim.webp`，64×64）和 FnDepot 源里的
  `meow/ICON.PNG`（512×512）都是它生成的；`--loop 1` 是"只扫一次"的静默版。
- **落位**：包根 `ICON.PNG` / `ICON_256.PNG` 仍是**静态 PNG**（应用中心列表、未安装状态、
  按扩展名解码的原生端都要它兜底）；动图由 `cmd/icon_setup` 在**安装与升级后**覆盖到
  4 个位置：`$TRIM_APPDEST/ui/images/icon_{64,256}.png` + 根目录 `ICON{,_256}.PNG`。
- **为什么升级也要跑**：升级会把载荷整目录换掉、根图标也可能被包里的静态图重置。
  fndesk 只做了 install、`upgrade_callback` 是空 `exit 0`，所以它升级后扫光会消失。
- **文件名与 MIME 都不影响播放**：实测 Chromium 按字节内容嗅探，`.PNG` 后缀 +
  `Content-Type: image/png` 的动画 WebP 照样播（Edge 实测 48 次采样 7 个不同帧）。
  ★ 验证时**必须覆盖完整 6.66s 周期**：只采两次会同时落在 5s 停顿段里，误判成「不播」。

## 两处端口约束（改之前先看，别简化回去）

1. **网关会丢端口**。fnOS 网关用 `Host: <NAS>`（无 `:5666`）转发到 unix socket，
   后端 `baseUrlFor()` 若直接拿 Host 拼 m3u8 分片，会得到
   `http://<NAS>/app/meow/...` → 打到 80 端口变成登录页 302，播放永远起不来。
   现在优先用 `X-Forwarded-Host` / `Origin` / `Referer` 的 authority（带回端口），
   路径前缀仍用 `X-Forwarded-Prefix`。
2. **jar 的 Proxy 只扫 9978–9999**。混淆 jar 的 `Proxy.a()` 写死这个范围，
   而 fpk 的 Java 在 30011 → Bili/Hxq 的 play 返回 `http://127.0.0.1:-1/proxy?...`。
   `Jars.pinProxyPort(port)` 在 jar 加载后反射写私有静态字段 `a`；启动和导入后各调一次。

## 硬件转码要 root 开设备权限（RK 设备，如 OEC）

片库转码在 Rockchip 上走 MPP/RGA 硬解硬编（详见
[site/docs/dev/library-cache.md §1.9.1](../../../site/docs/dev/library-cache.md)），
需要 `/dev/mpp_service`、`/dev/dri/card0|renderD128`、`/dev/rga`。
fnOS 上这些节点是 `root:root 0600` / `root:video|render 0660`，而本 fpk 的 java 以
`meow` 用户运行——**生命周期脚本也是 meow，改不了权限**，所以只能在设备上由 root
一次性处理（加组 + udev 规则，命令见上面那份文档）。

没做这一步不会崩，只是硬解报 `Generic error in an external library` 并自动回退软解：
4K HEVC 首片会从 ~15 秒变成 ~100 秒，且持续速率只有 0.025x（播不流畅）。

## 进程管理：pid/log 必须落在 `$TRIM_PKGVAR`

`meowd` 的 `pkg_var` = `$TRIM_PKGVAR`，`run/`、`logs/` 都在它下面；`cmd/main` 的
`status` / `stop` 只认 `$TRIM_PKGVAR/run/meowd.pid`。三条别删：

1. **没有 `TRIM_PKGVAR` 的手工启动**：`meowd` 把 `pkg_var` 退回 `--data` 的父目录
   （`resolve_pkg_var`，要求绝对路径且父目录不是 `/`），保证 pid/log 仍落在同一处。
   否则 stop 找不到进程、端口一直被占：2026-11-16 OECT 实测「停不掉 → 新实例
   `bind 30010` 失败 → 应用中心启动一下又停用」。
2. **`cmd/main start` 先探端口再启动**：同版本实例 → 补写 pid 文件收养；旧版本 →
   先停掉再起新的。身份校验 = exe（或 cmdline）含 `/bin/meowd` + `--port` + `--data`
   全部对上，端口被别的应用占用时不会误杀。这段同时兜住「升级时旧进程没被 stop 杀掉」。
3. **`meowd` 的 supervisor 不能二次 poll `JoinHandle`**：`select!` 里已经消费过的句柄，
   再 `timeout(..., &mut task)` 会 panic `JoinHandle polled after completion`；
   release 是 `panic = "abort"`，会带走整个进程，并掩盖真正的 `bind` 错误。

## 2026-11-09 实装记录

- NAS 1.1.7 → 1.1.8 纯壳升级成功；`seed/apiserver/` 只有 `apiserver.jar`。
- 导入源包后 56 站 / 28 ext；搜索「庆余年」171 条；咕噜详情 8 线路 / 46 集。
- 为撤掉测试 HTTP，`spider` 落到应用数据目录的 `spider.jar`（本地绝对路径），
  重启后仍 56 站、Bili 搜索 20 条。
- 详细证据与两处端口修复的验证见
  `tmp/2026-11-09-public-shell/剥离验证报告.md` §7.5。
