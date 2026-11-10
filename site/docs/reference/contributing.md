# 反馈与贡献

## 提 Issue

先说清楚三件事，能省掉一轮来回：

1. **哪个端**（Web / PC / TV / fnOS）+ 版本号
2. **复现步骤**：从哪个页面、点了什么
3. **证据**：错误类型、日志片段、`/api/health` 返回

完整清单见 [诊断手册 · 提 Issue 要带什么](/reference/diagnostics#提-issue-要带什么)。

::: warning 不要贴源包
spider jar、站点配置、真实域名与 token 都不要贴。它们可能涉及第三方授权，
而且对排查没有帮助。
:::

## 什么会被关掉

| 类型 | 原因 |
|---|---|
| 「求源包 / 求配置」 | 项目不分发源 |
| 「某站看不了」 | 上游失效，不是客户端问题 |
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

技术文档是 `docs/*.md`，站点里的 `dev/` 是构建时自动同步的，**不要手改**。

用户指南在 `site/docs/` 下，改之前看一眼 [site/README 的同步清单](https://github.com/upchr/meow/blob/main/site/README.md)。

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
