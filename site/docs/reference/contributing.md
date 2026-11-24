# 反馈与贡献

## 提 Issue

仓库有三个模板，按类型选，别都塞进一个：

| 模板 | 什么时候用 | 必填的关键信息 |
|---|---|---|
| **客户端 Bug** | 白屏、崩溃、播放 / 弹幕 / 片库行为不对 | 端 + 版本 + 复现步骤 + `/api/health` + 脱敏日志 |
| **源与站点** | 搜索为空、详情空白、取不到播放地址 | 站点名 + 症状 + **同一配置在其它客户端是否正常** |
| **功能请求** | 想要新能力或体验改进 | 要解决什么问题 + 现在怎么绕 + 能否帮测 |

先做三件事，能省掉一轮来回：

1. 按 [常见问题](/guide/faq) 的症状索引查一遍；
2. 功能请求先看 [应用计划](/reference/roadmap)，避免和已在做的重复；
3. 分清是不是源站问题——同一站点在 TVBox / Fongmi 里也失效，就是上游，别当成客户端 bug。

完整清单见 [诊断手册 · 提 Issue 要带什么](/reference/diagnostics#提-issue-要带什么)。

**处理节奏**：不承诺时间。被反复提到、且有人能帮忙实测的会往前排；
状态看 [应用计划](/reference/roadmap)，修完写在 [更新日志](/reference/changelog)。

::: warning 不要贴源包
spider jar、站点配置、真实域名与 token 都不要贴。它们可能涉及第三方授权，
而且对排查没有帮助。
:::

## 什么会被关掉

| 类型 | 原因 |
|---|---|
| 「求源包 / 求配置」 | 项目不分发源 |
| 「某站看不了」且其它客户端同样失效 | 上游失效，不是客户端问题；换源或等上游恢复 |
| 破解、去限制、绕过付费 | 与项目无关 |
| 商业使用咨询 | 许可不允许 |

## 代码贡献

### 许可约束

本项目是 **source-available**，不是 OSI 开源：允许个人学习、研究、自用与修改，
**禁止商业使用**。

提交代码即视为同意以同一许可分发你的贡献。

### 提交前

```bash
# 后端能编译、前端能构建
cd server/host && ./build.bat
cd client && pnpm build

# 如果改了版本号、compose、清单，跑一遍自检
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/verify.ps1
```

### 不要提交

- spider jar、真实站点配置、任何 token
- `client/apps/tv/*.jks` 与 `keystore.properties`
- `data/`、`release/`、`tmp/` 等本地产物
- 大体积二进制（走 Release 资产）

### 改文档

技术文档在 `site/docs/dev/`（手写，与 GitHub 共用同一份文件，直接改这份）；
唯一构建时自动生成的是 `docs/reference/changelog.md`——由根 `CHANGELOG.md`
经 `scripts/sync-docs.mjs` 生成，**不要手改**。

用户指南在 `site/docs/guide/` 下，改之前看一眼 [site/README 的同步清单](https://github.com/upchr/meow/blob/main/site/README.md)。

## 反馈质量

有效的报告长这样：

```
端：PC 1.1.5
现象：导入源包后站点全红，搜索无结果
health：ok=false, sites=0, spiderJar=false, configLoaded=false
操作：设置 → 配置源 → 填 URL → 追加导入
日志：ClassNotFoundException: com.example.Spider
补充：同一份配置在 TV 上正常
```

「不能用」「打不开」这种描述无法定位。

## 相关

- 排障证据：[诊断手册](/reference/diagnostics)
- 已知边界：[已知限制](/reference/limits)
- 许可全文：[许可与免责](/reference/license)
