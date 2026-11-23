# 倒计时电源动作（关机 / 休眠 / 退出应用）

> **状态：设计稿（2026-11-23）。**
> 已落地：PC 的「倒计时 → 系统睡眠」（`system_sleep` + `VideoPlayer.vue` 的 `setSleep()`）。
> 未实现：PC 关机、TV/投影仪关机、手机退出应用、原生层定时器、动作选择菜单。
>
> 本文只给方案与落点，改代码前读 [端与尺寸适配](./device-adaptive.md) 的 §1 与 §5。

## 0. 一句话现状

播放页的「睡眠定时」只有一条分支：到点 `pause()`，PC 再尝试 `systemSleep()`；**没有"关机""退出应用"两个动作**，定时器还挂在 WebView 的 `setInterval` 上，TV/手机切原生播放器后会被后台节流。

## 1. 三类语义，别混成一个

「倒计时」在产品上是三种需求，落到系统动作完全不同：

| 产品语义 | 目标动作 | 典型设备 |
|---|---|---|
| 睡前看片，到点让机器休息 | **休眠 / 睡眠** | PC |
| 客厅看完自动关设备 | **整机关机** | TV、投影仪 |
| 手机上到点收工 | **退出应用**（回桌面） | 手机 |

再加一条永远可用的兜底：**仅暂停播放**（Web 端唯一能做的那一档）。

当前代码把四者压成了两个状态（`sleepAt` 有值 / 无值），到点只走"暂停 + 可能睡眠"。所以这不是补一个 `if`，而是要把「动作」抽成独立维度。

## 2. 目标模型

### 2.1 动作枚举

```ts
export type PowerAction = 'shutdown' | 'sleep' | 'quit' | 'pause'
```

- `shutdown`：整机关机（PC / root 后的 TV、手机）
- `sleep`：系统睡眠/休眠（仅 PC）
- `quit`：退出应用进程（PC / Android）
- `pause`：只暂停播放，不动系统（所有端）

### 2.2 端 × 动作能力矩阵

| 动作 | PC（Tauri） | TV / 投影仪 | 手机（同一 TV APK） | Web |
|---|---|---|---|---|
| `shutdown` | ✅ `shutdown /s /t 0`（新增） | `probe`（需 root） | `probe`（需 root，不推荐） | ❌ |
| `sleep` | ✅ `system_sleep`（已有） | ❌ | ❌ | ❌ |
| `quit` | ✅ `desktop_quit`（已有） | ✅ 新增 `quitApp` | ✅ 新增 `quitApp` | ❌ |
| `pause` | ✅ | ✅ | ✅ | ✅ |

`probe` 的含义：**调用时才知道能不能做**（root 授权无法静默探测，见 §6.3）。

### 2.3 默认动作（只影响预选，不影响可用性）

| 端 | 默认动作 | 判据 |
|---|---|---|
| PC | `sleep` | `shell === 'tauri'` |
| TV / 投影仪 | `shutdown` | `form === 'tv-large'` |
| 手机 | `quit` | `form === 'phone' \| 'tablet'` |
| Web | `pause` | 其余 |

> 默认项是"用户意图的预选"，不保证成功：TV 没 root 时 `shutdown` 到点会失败并降级（§7）。

## 3. 判据：能力靠桥，默认项靠形态

这是本方案最容易写错的地方，先把边界钉死：

- **能不能做 = 能力探测**（`compat/shell.ts` 的 `hasTvBridge()` / `isTauriRuntime()`、桥方法存在性；Tauri 只能判运行时，判不了具体命令是否注册，见 §5.1）。
- **默认选哪个 = 身份 + 形态**（`currentShell()` / `formOf()`），**只用于排序与预选**。

> 不要把 `form === 'tv-large'` 拿去决定"显示不显示关机"。形态只影响布局密度，这条红线写在
> [device-adaptive.md](./device-adaptive.md) §5.2 / §5.3；电源动作的可用性必须走能力探测。

### 3.1 新增纯函数 `utils/powerActions.ts`

```ts
import { currentShell } from '@/compat/shell'
import { formOf } from '@/compat/deviceProfile'
import { hasSystemSleep, hasSystemShutdown, hasDesktopQuit } from '@/api/nativeBridge'
import { tvPowerCaps } from '@/api/nativeBridge'   // TV 壳能力，见 §5.2

export interface PowerCaps {
  shutdown: 'yes' | 'probe' | 'no'
  sleep: boolean
  quit: boolean
  pause: true
}

export function resolvePowerCaps(): PowerCaps { /* 组合 §4.1 的能力函数 + tvPowerCaps() */ }

export function powerActionsFor(caps: PowerCaps): PowerAction[] {
  // 只返回"有真实行为"的项；probe 保留（点击后会得到真实结果）
}

export function defaultPowerAction(shell: Shell, form: Form): PowerAction { /* §2.3 */ }
```

组件只调这三个函数，**不要**在 `VideoPlayer.vue` 里再写 `innerWidth` / UA / `platform === 'tv'`。

### 3.2 为什么手机和 TV 要靠 `formOf()` 区分

`TvBridge.platform()` 固定返回 `"tv"`（TV APK 本来就同时装在手机和电视上，`setOrientation()` 的注释明确提到"手机竖屏上播"）。所以：

- 身份层：手机和电视**都是 `shell === 'tv'`**，不能用来区分。
- 形态层：`formOf()` 在手机竖屏返回 `phone`、横屏短边 <480 返回 `tablet`；投影仪/电视横屏且无精确指针返回 `tv-large`（`resolveForm()` 的既有逻辑）。
- 用途：**只决定默认动作**。手机上"关机"仍然可以出现在菜单里（`probe`），只是不预选。

## 4. 接口设计

### 4.1 前端能力探测（新增到 `api/nativeBridge.ts`）

```ts
/** PC：关机命令是否可用（老安装包没有时 invoke 会 reject）。 */
export function hasSystemShutdown(): boolean

/** PC：桌面端退出应用命令是否存在。 */
export function hasDesktopQuit(): boolean

/** PC：请求关机。返回 false 表示不可用或调用失败。 */
export async function systemShutdown(): Promise<boolean>

/** PC：退出应用（封装 `desktop_quit`；`TrayHintDialog.vue` 目前直接 invoke，可迁过来）。 */
export async function desktopQuit(): Promise<boolean>

/** Android 壳：一次性读取电源能力（不触发授权弹窗）。 */
export function tvPowerCaps(): { shutdown: 'probe' | 'no'; quit: boolean }
```

PC 侧的 `systemSleep()` / `hasSystemSleep()` 已存在，不改语义。

### 4.2 Android 桥（新增到 `TvBridge.java`）

```java
/** 电源能力。只报静态事实，不探测 root（探测会弹 Magisk 授权框）。 */
@JavascriptInterface
public String powerCaps()   // {"shutdown":"probe","quit":true}

/** 关机。内部固定命令 + 白名单，不接受任意 shell。 */
@JavascriptInterface
public String shutdownSystem()   // {"ok":true} / {"ok":false,"reason":"NO_ROOT|DENIED|TIMEOUT|FAILED"}

/** 退出应用。finishAffinity；运行时模块在跑时一并停 NodeService（非前台）。 */
@JavascriptInterface
public boolean quitApp()

/** 原生层定时器：到点执行动作。action = shutdown|quit|pause */
@JavascriptInterface
public boolean startPowerTimer(long delayMs, String action)

@JavascriptInterface
public void cancelPowerTimer()

/** {"active":true,"action":"shutdown","remainingMs":812345} */
@JavascriptInterface
public String powerTimerState()
```

> 命名注意：前端 `TrayHintDialog.vue` 已有一个本地 `quitApp()`（内部调 `desktop_quit`），与本桥方法不同层、不冲突；若嫌混淆，桥方法可叫 `quitApplication`。

### 4.3 Tauri 命令（新增到 `lib.rs`，仅 Windows）

```rust
/// 整机关机（Windows）。延迟交给调用方，命令本身立即返回。
#[tauri::command]
fn system_shutdown() -> Result<(), String>
// 实现：std::process::Command::new("shutdown").args(["/s", "/t", "0"])
```

`desktop_quit` 与 `system_sleep` 已注册，无需改动。

### 4.4 定时器状态（新增 `stores/powerTimer.ts`）

只放**展示态**（剩余时间、动作、是否激活），真正的计时：
- PC：可以先用前端 `setInterval`（窗口在前台时可靠），托盘最小化时标注可能延迟；后续可选下沉到 Rust。
- Android：**必须**在原生层（§6）。

## 5. 各端实现要点

### 5.1 PC（Tauri）

- 到点顺序：`v.pause()` → 对应命令（`systemShutdown` / `systemSleep` / `desktopQuit`）。
- `shutdown` 需要**二次确认，且在设置定时时就确认**（到点再弹窗没人点，TV/全屏下更不可行）；`sleep` / `quit` 不确认（用户已选时间）。
- 失败降级：`shutdown` 失败 → `quit` → `pause`；`sleep` 失败 → `pause`。
- 老安装包：`hasSystemSleep()` / `hasSystemShutdown()` 只判"是不是 Tauri 运行时 + `invoke` 在不在"，**判不了命令是否真的注册**（现有 `hasSystemSleep()` 的注释已写明）。所以老包上菜单照样显示，调用时 `invoke` reject 被吞成 `false`，再走降级链。

### 5.2 TV / 投影仪

- 桥能力：`powerCaps()` 返回 `{shutdown:'probe', quit:true}`。
- 关机实现（`shutdownSystem()`，Java 侧）：
  1. 探测 `su` 绝对路径（`/system/bin/su`、`/sbin/su`、`which su`）；
  2. 执行 `su -c "setprop sys.powerctl shutdown"`，`waitFor(timeout)` 3 秒；
  3. 失败再试 `su -c "reboot -p"`；
  4. 返回结构化错误码，**不要**抛异常到 Web。
- 无 root：返回 `NO_ROOT`，前端提示"需要 root 授权"，自动降级到 `quit` 或 `pause`。
- **不要**把 `execRoot(String cmd)` 暴露给 Web：源站内容不可信，任意 root 命令等于提权面。只暴露固定动作。
- 新增的桥方法一律先过 `trustedOrigin()`（现有桥方法都这么做）：它只认 `http://meow.local/`，防止外部页面调到电源动作。
- `quitApp()`：调用 `finishAffinity()` 清掉整个 task（`NativePlayerActivity` 未声明 `launchMode` / `taskAffinity`，默认与 `MainActivity` 同 task，会被一并关掉）；若运行时模块正在跑，再 `stopService(NodeService)`——它的 `onDestroy()` 会连带杀掉 `:node` 进程（非前台服务）。

### 5.3 手机（同一个 TV APK）

- 与 TV 共用桥；默认动作由 `formOf()` 选 `quit`。
- `quit` 用 `finishAffinity()`（清整个 task，进程通常被回收），不用 `finish()`（只关当前 Activity，回不到"退出应用"语义）也不建议 `killProcess`（WebView 状态可能没落盘）。
- 手机上"关机"仍可显示（`probe`），但排在最后且标注风险。

### 5.4 Web

- 只有 `pause`；菜单显示"仅暂停播放"，不显示其他动作（遵循"控件要么有真实行为要么删掉"）。

## 6. 定时器必须下沉原生层

### 6.1 问题

`VideoPlayer.vue` 的 `setSleep()` 用 `window.setInterval(..., 10_000)`。TV/手机走 `openNative`（独立 `NativePlayerActivity`）时，`MainActivity.onPause()` 只调了 `window.__meowWebviewPause()`（暂停 Web 播放器），**没有**调 `WebView.pauseTimers()`——所以定时器不会被完全冻结，但 Android WebView 退后台后的 timer throttling 程度随系统与厂商，15 分钟的定时可能延后且不可控。这是"倒计时不准"的根因，不是精度问题。

### 6.2 方案

- Android：`startPowerTimer()` 用 `Handler.postDelayed`（或 `CountDownTimer`）；到点：
  - `shutdown` / `quit`：直接在 Java 侧执行，不依赖 WebView；
  - `pause`：分两条路——
    - Web 播放页在前台：`evaluateJavascript("window.__meowPowerFire('pause')")` 回通知 Web 暂停；
    - 原生播放页（`NativePlayerActivity`）在前台：`evaluateJavascript` 打到的是 `MainActivity` 的 WebView，管不到 ExoPlayer。需要 `NativePlayerActivity` 暴露静态弱引用（如 `pauseForPowerTimer()`，内部 `setPlayWhenReady(false)`），或直接 `finish()` 退回 Web 再暂停。
- PC：保留前端定时器（窗口在前台时可靠）；托盘最小化时的节流程度未实测，按分钟级误差估计，标注为已知边界。
- 跨页面：定时器状态在原生层/全局 store，离开播放页再回来用 `powerTimerState()` 恢复显示。当前 `sleepAt` 是组件内 `ref`，离开播放页就丢——这是一个独立缺陷，顺带在本方案修掉。

### 6.3 root 探测不能静默

`su -c true` 首次会弹 Magisk 授权框，TV 上没有鼠标，没人点就卡住。所以：

- `powerCaps()` **不探测 root**，只报 `shutdown:'probe'`；
- 用户**第一次选"关机"动作时就立即探测一次 `su -c true`**，不是到点才弹——到点没人点授权框，关机必失败；
- 授权成功：记内存标记，开始倒计时；授权失败/超时：当场提示"未获得 root 授权"，本次定时改用 `quit`；
- 量产建议：装机时把 APK 预授权进 Magisk 的 `policies`，避免每台机器手点。

## 7. 失败与降级

统一降级链：

```
shutdown 失败(NO_ROOT / DENIED / TIMEOUT)
    → quit（退出应用，用户至少不用看黑屏）
    → pause（兜底）

sleep 失败
    → pause

quit 失败
    → pause
```

每一档都用 `VideoPlayer.vue` 现有的 `flashMarks()` 给用户一句话，不弹新框（播放页弹框会打断全屏/TV 焦点）。定时器在原生层时，Java 执行完 `shutdown`/`quit` 的失败分支要 `evaluateJavascript` 回推一条结果，Web 才能 `flashMarks`。

## 8. 安全边界

| 风险 | 约束 |
|---|---|
| Web 层被注入执行任意 root 命令 | 只暴露固定动作（`shutdownSystem`），**不暴露** `execRoot(cmd)` |
| `su` 卡死 | `Process.waitFor(3, SECONDS)`，超时返回 `TIMEOUT` |
| 误触关机丢工作 | PC 关机二次确认；TV 默认预选关机，但必须用户在菜单里确认后才开始倒计时 |
| 老安装包没有命令 | 只判运行时判不出命令缺失；调用时 `invoke` reject 被吞成 `false`，走降级链、不 crash |

## 9. 验收断言

1. **PC 能力**：`hasSystemSleep()` / `hasSystemShutdown()` / `hasDesktopQuit()` 在 Tauri 运行时均为 `true`；Web 环境均为 `false`；老安装包上仍为 `true`（只判运行时，命令缺失靠调用时降级）。
2. **默认项**：`resolveForm()` 造 `phone` / `tv-large` 两态，`defaultPowerAction()` 分别返回 `quit` / `shutdown`。
3. **菜单渲染**：`caps.shutdown === 'no'` 时不出现关机项；`'probe'` 时出现并带"需要 root"标注。
4. **TV 无 root**：选"关机"动作时 `su -c true` 超时 → 当场 `flashMarks` 提示"未获得 root 授权" → 本次定时改用 `quit`（不是到点才失败）。
5. **TV 有 root**：`su -c setprop sys.powerctl shutdown` 真机执行，设备断电（需真机，本机不可断）。
6. **手机退出**：`finishAffinity()` 后 `dumpsys activity activities | grep meow` 无残留 Activity。
7. **后台定时**：TV 原生播放器播放 15 分钟，到点触发与设定偏差 < 30 秒（不是 16+ 分钟）。
8. **跨页面**：设 15 分钟 → 退出播放页 → 重进，菜单显示剩余 14 分。
9. **回归门禁**：`tests/device-profile.test.ts`、`tests/mobile-ux-polish.test.ts` 全过；新增 `tests/power-actions.test.ts` 覆盖能力矩阵与默认项。

## 10. 分阶段落地

| 阶段 | 内容 | 改动面 | 可独立验收 |
|---|---|---|---|
| P1 | `utils/powerActions.ts` + PC 关机命令 + 菜单动作/时间两级改造 | Web + Tauri | ✅ 纯 PC 可验 |
| P2 | Android `quitApp` + `powerCaps` + 原生定时器 | TV APK | ✅ 手机/TV 可验 |
| P3 | Android `shutdownSystem`（root） | TV APK | ⚠️ 需真机 root |
| P4 | 指南与能力卡同步 | `guide/playback.md`、`reference/compatibility.md` | ✅ 文档站构建 |

P1 不依赖 Android，先做；P3 在拿到 root 设备前不要动。

## 11. 开源参考

| 场景 | 项目 / API | 要点 |
|---|---|---|
| Android 退出应用 | Capacitor `AppPlugin.exitApp()` | `finishAffinity()`，清整个 task |
| Android 退出应用（对照） | Cordova `CoreAndroid.exitApp()` | `finish()`，只关当前 Activity，不结束进程 |
| Android 关机（系统签名） | `CarOS-Android/CarService-AOSP` 的 `PowerManagerHelper.shutdown()` | 需平台签名，三方反射过不了 Binder 校验 |
| Android 关机（root） | AOSP `system/core/reboot` | `setprop sys.powerctl shutdown` / `reboot -p` |
| Windows 休眠 | `ReneLergner/WPinternals` 的 `Win32.cs` | `SetSuspendState(false,…)`；与我们的 rundll32 等价 |
| Windows 电源动作 | `oliverschwendener/ueli` | 电源动作的命令封装参考 |

> 上表仓库名与 API 为调研线索，未在本机复现；Android 侧结论以 AOSP 公开行为为准。

## 12. 实现时要同步的页面

功能落地后（不是现在）按 [site/README.md](https://github.com/upchr/meow/blob/main/site/README.md) 的维护清单同步：

- `guide/playback.md`：睡眠定时那一行改成"到点可选关机 / 休眠 / 退出应用 / 仅暂停"。
- `dev/device-adaptive.md`：§1.4 的能力表补 `hasSystemShutdown()` / `powerCaps()` 两行（该表已有 `hasSystemSleep()`）。
- `dev/tv-integration.md`：桥能力清单补 `powerCaps` / `quitApp` / `shutdownSystem` / `startPowerTimer` / `cancelPowerTimer` / `powerTimerState`。
- `reference/compatibility.md` 的端支持：若关机仅在 root 设备可用，要写明前提。
