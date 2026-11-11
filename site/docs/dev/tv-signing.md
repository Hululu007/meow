# TV 打包与签名（★ 密钥备份说明）

> 面向：所有可能碰到 TV 打包的人。
> 相关：[部署与发版](https://github.com/upchr/meow/blob/main/deploy/README.md)（发版规范）、[部署与发版](https://github.com/upchr/meow/blob/main/deploy/README.md)（CI 触发）。

---

## 零、一句话

TV APK **必须用固定的一份 keystore 签名**，否则用户装不上更新。
这份 keystore **只存在于本机和 GitHub Secrets，绝不能进 git**，
**丢了就永远发不出可覆盖升级的包**。

---

## 一、为什么需要签名

Android 强制要求每个 APK 有数字签名。签名有两个作用：

1. **完整性**：系统验证包没被篡改，改一个字节就拒绝安装。
2. **身份**：系统用它判断"能不能覆盖升级"。
   手机已装 A 签名的 App，**只能装 A 签名的更新**；换成 B 签名会被拒绝，
   必须卸载重装——而卸载会清掉全部数据（登录态、播放记录、收藏、片库配置）。

所以**签名身份必须永久固定**。这是本项目最不可替代的资产之一。

---

## 二、我们用的是哪份签名

| 项 | 值 |
|---|---|
| 文件 | `client/apps/tv/meow-release.jks`（2708 字节） |
| 配置 | `client/apps/tv/keystore.properties` |
| 别名 | `meow` |
| 所有者 | `CN=Meow TV, OU=Meow, O=Meow, L=Local, ST=Local, C=CN` |
| 有效期 | **2026-10-23 → 2054-03-10**（28 年） |
| 算法 | SHA256withRSA / 2048 位 |
| SHA-256 指纹 | `AD:D7:2E:8D:06:62:DC:BB:EA:D6:9B:7B:B7:04:05:D3:CA:FA:6D:51:2D:44:9E:1D:DE:95:0A:95:1E:8E:CC:83` |

> 查指纹的命令（验证签名身份时用）：
> ```bash
> keytool -list -v -keystore client/apps/tv/meow-release.jks -alias meow
> ```
> 也可以直接验已构建的 APK：
> ```bash
> /c/Android/build-tools/34.0.0/apksigner.bat verify --print-certs \
>   client/apps/tv/app/build/outputs/apk/release/app-release.apk
> ```

---

## 三、★★ 备份（最重要的一节）

### 3.1 现状

这份 keystore **只存在于两个地方**：

1. 本机 `client/apps/tv/meow-release.jks` + `keystore.properties`
2. GitHub Secrets（`TV_KEYSTORE_B64` + 三个密码字段）

两处都属于"同一套账号体系"。**如果本机磁盘挂了、GitHub 账号丢了，
签名能力就永久消失**——所有已安装用户再也收不到能覆盖升级的版本。

### 3.2 必须做的备份

把这两个文件复制到**与电脑和 GitHub 都无关**的地方：

- ✅ 密码管理器（1Password / Bitwarden 的附件功能）
- ✅ 离线介质（U 盘 / 移动硬盘，放在与电脑不同的物理位置）
- ✅ 加密压缩包 + 密码单独保存（如 `7z a -p meow-release.jks.7z meow-release.jks`）

**备份时必须一起存 `keystore.properties`**——只有 `.jks` 没有密码，
等于有保险箱没钥匙。

建议同时把本文件 §二 的表格（别名、指纹、有效期）抄一份存进去，
将来验证"手上这份是不是原件"要看指纹。

### 3.3 丢了会怎样（不是危言耸听）

| 场景 | 后果 |
|---|---|
| keystore 丢失 | 新包签名不同 → 用户必须**卸载重装**，数据全丢 |
| 密码丢失（只有 jks） | 同上（无法用该 jks 签名） |
| keystore 泄露 | 别人能签**冒名更新包**，诱导用户安装 → 需要立即换新 keystore 并公告 |

---

## 四、★ 绝不能进 git

### 4.1 当前状态（正确，请保持）

```
client/apps/tv/keystore.properties   → .gitignore 已排除
client/apps/tv/meow-release.jks      → .gitignore 已排除
```

验证方式（三个都应返回空）：

```bash
git ls-files client/apps/tv/ | grep -iE 'jks|keystore'        # 当前跟踪的文件
git log --all --oneline -- '*meow-release.jks'                # 历史里有没有提交过
git check-ignore client/apps/tv/meow-release.jks              # 是否被忽略
```

### 4.2 为什么不能进

- 进了 git 就等于**永久留在历史里**——即使后续删掉，`git log` 仍能捞出来
- 仓库一旦转公开或被人克隆，签名能力直接泄露
- GitHub 会扫描公开仓库的密钥并告警；私有仓库虽不扫描，但风险一样

### 4.3 如果哪天不小心提交了

```bash
# 1. 立刻认定为泄露，生成新 keystore（代价：用户需卸载重装一次）
# 2. 从历史里彻底清除（需要 rewrite history，会影响所有协作者）
git filter-repo --path client/apps/tv/meow-release.jks --invert-paths
# 3. 强制推送 + 通知所有克隆过的人重新 clone
```

**所以：宁可不提交。** 加文件前先看 `git status` 里有没有 `.jks`。

---

## 五、两种打包方式各自的签名行为

### 5.1 本地打包（`build-apk.ps1` / `release-apk`）

`client/apps/tv/app/build.gradle` 的关键一行：

```gradle
signingConfig ksProps.exists() ? signingConfigs.release : signingConfigs.debug
```

- `keystore.properties` 存在 → **release 签名**（正式包）
- 不存在 → **静默退回 debug 签名**（不报错，只是打 warning）

`build-apk.ps1` 在 release 模式下会**硬校验**这个文件存在，缺失直接抛错，
不让你无意中发出 debug 包：

```
✗ 找不到 keystore.properties：gradle 会静默退回 debug 签名，
  用户将无法覆盖安装正式版。确认后用 -Variant debug 明确表达意图。
```

### 5.2 CI 打包（`_tv.yml`）

CI 是全新 runner，**git 里没有这两个文件**，所以工作流做了三件事：

1. **还原 keystore**：`echo "$TV_KEYSTORE_B64" | base64 -d > client/apps/tv/meow-release.jks`
2. **现造 keystore.properties**：用三个密码 secret 拼出来
3. 之后 gradle 看到文件存在 → 自动用 release 签名

缺 secret 时会打 `::warning::` 并出 debug 包（不阻断发版）。

### 5.3 已配置的 GitHub Secrets（2026-10-26 配好）

| Secret | 内容 |
|---|---|
| `TV_KEYSTORE_B64` | `meow-release.jks` 的 base64（3612 字符） |
| `TV_STORE_PASSWORD` | `keystore.properties` 的 `storePassword` |
| `TV_KEY_ALIAS` | `keyAlias`（`meow`） |
| `TV_KEY_PASSWORD` | `keyPassword` |

**这些是加密存储**：写入后无法再读出（只能覆盖），日志里自动打码成 `***`。

### 5.4 已实测验证：CI 与本地签名一致（2026-10-26）

配好 secrets 后跑了一次单链路 `tv-v*`（run 40274970696），下载 CI 产物用
apksigner 比对：

| | 证书 DN | SHA-256 指纹 |
|---|---|---|
| **CI 产物** `meow-TV-0.9.15.apk` | `CN=Meow TV, OU=Meow, O=Meow, L=Local, ST=Local, C=CN` | `add72e8d0662dcbbead69b7bb70405d3cafa6d512d449e1dde950a951e8ecc83` |
| **本地产物** `app-release.apk` | 同左 | 同左 |

**结论**：两边完全一致，用户从任一渠道安装都能覆盖升级。

> **踩过的坑（首次配置时必看）**：CI 里生成 `keystore.properties` 时
> `storeFile` 写成了 `meow-release.jks`，gradle 报
> `Keystore file '.../client/apps/tv/app/meow-release.jks' not found`。
>
> 原因是 **`storeFile` 相对 `app/build.gradle` 所在目录（`app/`）解析**，
> 必须写 `../meow-release.jks`。本地 properties 里本来就是这条，CI 抄漏了。
> 这类"本地能过、CI 不能过"的问题，根因常是相对路径的基准不同。

---

## 六、验证签名是否一致（发版前必做）

```bash
# 1. 看本地 APK 的签名指纹
/c/Android/build-tools/34.0.0/apksigner.bat verify --print-certs \
  client/apps/tv/app/build/outputs/apk/release/app-release.apk | head -3

# 2. 与 §二 表格里的 SHA-256 指纹比对
#    一致 = 能覆盖升级；不一致 = 用户装不上
```

CI 出的包同理：从 Release 下载后用 apksigner 验一次，
**首次配好 secrets 后务必验一次**，确认 CI 真的走了 release 签名。

---

## 七、更换 keystore 的代价（决策参考）

只有在"泄露"或"彻底丢失"时才该换。更换后的影响：

| 影响 | 说明 |
|---|---|
| 所有已安装用户 | 必须**卸载重装**，数据全丢 |
| 应用商店/分发渠道 | 需重新提交，旧版本无法再更新 |
| 建议做法 | 换之前先发一版"导出数据"的引导，或接受数据丢失 |

**结论：把现有这份备份好，比任何技术优化都重要。**

---

## 八、检查清单（每次碰 TV 打包前）

- [ ] `keystore.properties` 与 `meow-release.jks` 都在本地
- [ ] 两者都**没有**出现在 `git status` 的待提交列表里
- [ ] `git ls-files` 查不到 `.jks`
- [ ] 打出的 APK 用 apksigner 验过，指纹与 §二 一致
- [ ] 备份是最新的（换过 keystore 的话要更新备份）
