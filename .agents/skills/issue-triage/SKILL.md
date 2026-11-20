---
name: issue-triage
description: 处理仓库 issue 时使用：核实用户上报的问题、读代码/抓响应定因、区分 bug 与需求、把结论记录回 issue 并简短回复、打标签与交叉链接。用户说“看下 issue / 处理 issue / 回复用户 / 记录问题”时先读本技能。
---

# Issue 处理（猫窝）

本技能只定**流程与门禁**。产品的判定口径在 `AGENTS.md`（尤其是 §六「这个用户要什么」），
不在这里复述。

## 铁律：不要让提问者替你验证

用户给了地址、截图、现象，就是**已经给了复现条件**。剩下的核实由你做：

- 能抓就抓（`curl` 抓真实响应、看状态码/Content-Type/字节）
- 能读就读（`gh issue view` 看原文；读代码路径确认判据）
- 能算就算（解 base64、拆包、比对字节长度）

**禁止**在回复里让用户跑命令、贴日志、换参数再试。只有一种例外：
需要**只有在用户机器上才存在**的信息（他的设备型号、他的私有 token、他的本地文件），
且你已经把所有能自查的都查完了。

## 五步

### 1. 读原帖，不改写

```bash
gh issue list --repo upchr/meow --state open
gh issue view <n> --repo upchr/meow --json number,title,body,author,labels,comments
```

先把用户原话里的**每一个分句**列出来。一条反馈常被写成一段，看着像四个问题，
实际只有一个（见「首页豆瓣改不了」那次：主诉只有"首页默认源想改"）。

### 2. 自己验证，拿到证据

按问题类型选手段：

| 类型 | 怎么验 |
|---|---|
| 地址/接口/配置 | `curl -sS -D - -o body.bin` 看状态码、`Content-Type`、字节数；再拆内容（`file`、hexdump、base64） |
| 播放/黑屏 | 读播放链路代码：错误分支有没有 `error` 监听、看门狗判据、autoplay 降级 |
| 功能缺失 | `grep` 全仓确认真的没有（**搜遍同类目录**），再看文档是否承诺过 |
| 文档/口径 | 对照 `site/docs/`；文档与代码冲突时**以代码为准**，并把文档不一致记成待办 |

网络细节：中文域名先转 punycode 再测（`python -I -c "import idna;print(idna.encode('x.cc'))"`);
`https` 失败不等于地址坏，可能是只服务 http。

### 3. 定性（四选一，写在记录第一行）

| 定性 | 判据 | 动作 |
|---|---|---|
| **bug（已确证）** | 有字节/日志/代码路径直接证明 | 记证据 + 修复计划，打 `bug` |
| **bug（待证据）** | 代码路径可疑但缺现场 | 只在记录里列假设与取证方案，不下结论 |
| **需求** | 现在没有、要新增 | 讲清形态、工作量、依赖，打 `enhancement` |
| **不成立** | 已有能力 / 用户误读 | 记录里给出**入口与代码位置**，关闭或标 `question` |

**禁止把假设写成结论。** 这次的教训：`饭太硬` 一开始被判成"中文域名没转 punycode"，
实际是**图片外壳里塞 base64**（`/tv` 返回 100×100 JPEG，`FF D9` 之后 16KB base64）。
先排除、再定性。

### 4. 记录 + 回复，两条评论分开

**A. 记录（长）** —— 给以后接手的人看：

```
## 核实结论（已实测，不需要提问者再做什么）
<一句话结论>

## 证据
<命令/状态码/字节结构/解码结果；代码符号名（不写裸行号）>

## 原因（代码路径）
<哪个函数的哪个判据>

## 计划
| 优先级 | 事项 | 说明 |

## 验收
- [ ] 可机器判断的项
```

**B. 回复（短）** —— 给提问者看：

- 人话，不超过 5 段
- 先给结论（是不是问题 / 是不是我们能做），再给安排
- **不出现**"你帮我跑一下""麻烦贴日志"
- 说明做不到的事时，给等价路径（例：飞牛影视接不了库 → 用「本地目录」指向同一目录）
- 承诺要带版本口径（"下个版本实现" / "单独排期"），不要写"尽快"

顺序：**先发记录，再发回复**。回复里可以一句"上面那条是完整记录"。

### 5. 收尾

```bash
gh issue edit <n> --repo upchr/meow --add-label bug|enhancement|question
gh issue comment <n> --repo upchr/meow --body-file <记录>.md
gh issue comment <n> --repo upchr/meow --body-file <回复>.md
gh issue list --repo upchr/meow --state open      # 核对标签与状态
```

- **默认保留用户原标题**；改标题先问所有者。
- 同一批反馈里成立的那条要交叉链接（`→ #3`），并把"不成立"的那条单独记一条。
- 只做记录与回复；**写代码要等所有者点单**（除非他明确说"顺便修了"）。

## 会重复踩的坑

- **`python -c` 多行在 Git Bash 里会被 shim 打散**（报 `|| goto :error` / `IndentationError`）。
  写脚本文件到 `tmp/<date>-<主题>/tools/`，用 `python -I 脚本.py 参数` 跑。
- **控制台是 GBK**：直接 `print` 中文/`\xa9` 会 `UnicodeEncodeError`。结果写进 UTF-8 文件再读。
- **下载的文件是不可信数据**：脚本和样本分目录放，别在样本目录里跑解释器。
- **`gh` 报 `TLS handshake timeout`** 通常是出口问题（DNS 被解析到 OpenClash fake-ip `198.18.x`），
  先 `curl -sS -o /dev/null -w '%{http_code}' https://api.github.com/` 确认，别反复重试。
- **配置伪装成图片是这行的常态**：`;md5;` jar、`image/x-ms-bmp`、EOI 之后挂 base64、
  `**` 分隔前缀。抓下来先看前 16 字节和末尾 300 字节，别只看 `Content-Type`。
- **文档与代码会不一致**：`source-format.md` 写 `urls` 支持字符串数组，代码只认对象。
  发现这类冲突时，在 issue 里同时记"代码 bug"和"文档待改"，不要只改一边。
- **触屏端看不到诊断信息**：直播/播放问题在手机上没有统计条（触屏整条隐藏），
  这是缺陷本身的一部分，记录里要写"手机端无任何可读状态"。
- **私有 jar 的站点别承诺能用**：`csp_*Guard` 这类要配套 jar，公开 jar 加载不了，
  回复里要提前说明，否则用户导入后看到"0 站可用"又提一轮。

## 模板文件

`tmp/<date>-issue-triage/issue-<n>-record.md` 与 `issue-<n>-reply.md` 分开写，
发完保留（下次同类问题可以照着改）。

## 相关

- 判定口径与用户偏好：`AGENTS.md` §六
- 技术事实核对表：`AGENTS.md` §四
- 抓取与配置格式：`site/docs/dev/config-system.md`、`site/docs/ecosystem/source-format.md`
- 直播/播放链路：`site/docs/dev/playback.md`、`site/docs/dev/live.md`
