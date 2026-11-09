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

## 两处端口约束（改之前先看，别简化回去）

1. **网关会丢端口**。fnOS 网关用 `Host: <NAS>`（无 `:5666`）转发到 unix socket，
   后端 `baseUrlFor()` 若直接拿 Host 拼 m3u8 分片，会得到
   `http://<NAS>/app/meow/...` → 打到 80 端口变成登录页 302，播放永远起不来。
   现在优先用 `X-Forwarded-Host` / `Origin` / `Referer` 的 authority（带回端口），
   路径前缀仍用 `X-Forwarded-Prefix`。
2. **jar 的 Proxy 只扫 9978–9999**。混淆 jar 的 `Proxy.a()` 写死这个范围，
   而 fpk 的 Java 在 30011 → Bili/Hxq 的 play 返回 `http://127.0.0.1:-1/proxy?...`。
   `Jars.pinProxyPort(port)` 在 jar 加载后反射写私有静态字段 `a`；启动和导入后各调一次。

## 2026-11-09 实装记录

- NAS 1.1.7 → 1.1.8 纯壳升级成功；`seed/apiserver/` 只有 `apiserver.jar`。
- 导入源包后 56 站 / 28 ext；搜索「庆余年」171 条；咕噜详情 8 线路 / 46 集。
- 为撤掉测试 HTTP，`spider` 落到应用数据目录的 `spider.jar`（本地绝对路径），
  重启后仍 56 站、Bili 搜索 20 条。
- 详细证据与两处端口修复的验证见
  `tmp/2026-11-09-public-shell/剥离验证报告.md` §7.5。
