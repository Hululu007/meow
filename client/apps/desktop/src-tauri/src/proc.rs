//! 子进程的窗口抑制。
//!
//! ## 为什么需要这个模块
//!
//! Windows 上 `std::process::Command` 启动**控制台程序**（curl.exe、tar.exe、
//! cmd.exe）时会附带控制台 —— 用户看到的是屏幕上一个黑框/终端标签闪一下。
//!
//! 实测（2026-10-29，用户反馈原话"一进设置页就出现 2、3 次 curl 命令弹框"）：
//!
//! - 进设置页 → `loadIndex()` → `plugin_index` → `fetch_index()`
//!   → `fetch_manifest_text()` → 每个候选地址各起一个 `curl.exe`，
//!   失败还会 `http_get_text_retry` 退避重试 —— 一次进页面好几个黑框。
//! - 启动应用 → 5 秒后的静默检查 → `app_update_manifest_text` → 同样起 curl。
//!
//! ## 为什么是 DETACHED_PROCESS 而不是 CREATE_NO_WINDOW
//!
//! 这条结论花了三轮实测才定下来（2026-10-30）：
//!
//! | 手段 | Win11 + Windows Terminal 上的效果 |
//! |---|---|
//! | 什么都不加 | 弹终端窗口（类名 `CASCADIA_HOSTING_WINDOW_CLASS`） |
//! | `CREATE_NO_WINDOW` | **照样弹** |
//! | `DETACHED_PROCESS` | 不弹 |
//!
//! 原因：`CREATE_NO_WINDOW` 的语义是"创建控制台但隐藏窗口"。Win11 的默认
//! 终端处理器（`HKCU\Console\%%Startup` 的 `DelegationConsole` /
//! `DelegationTerminal`）接管**每一个新控制台**时会新开 Terminal 窗口或
//! 标签页 —— 那个窗口属于 Terminal 进程，不受"隐藏控制台窗口"约束。
//! `DETACHED_PROCESS` 是"**根本不创建控制台**"，没有控制台就没有接管，
//! 从源头解决。
//!
//! 反例验证：把本函数临时改成空操作后重建，同一套检测脚本能抓到
//! `CASCADIA_HOSTING_WINDOW_CLASS` 窗口；改回 `DETACHED_PROCESS` 后抓到 0 个。
//!
//! ## ★ 验证必须用 release 包，debug 包测不出来
//!
//! `main.rs` 第一行是
//! ```ignore
//! #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! ```
//! 也就是说 **debug 构建是 Console 子系统（PE subsystem = 3）**，
//! 它自己就会开一个控制台窗口。用 debug 包测"有没有黑框"，那个窗口
//! 永远在，根本分不清是应用自己的还是 curl 的 —— 实测在这上面浪费了三轮。
//!
//! 正确做法：
//! ```powershell
//! npx tauri build --no-bundle        # release，subsystem=2
//! # 判定：python 读 PE 头 0x5c 处的 subsystem，必须是 2
//! ```
//!
//! 另外检测脚本也要注意：Win11 默认终端下，控制台窗口类名是
//! `CASCADIA_HOSTING_WINDOW_CLASS` 而不是 `ConsoleWindowClass`，
//! 按后者数会永远得 0（假绿）。
//!
//! ## 对子进程有影响吗
//!
//! 没有。curl / tar 都不需要控制台，且它们的 stdout/stderr 已经被
//! `Command::output()` 或 `.stdout(Stdio::null())` 重定向到管道/空设备，
//! 不依赖控制台句柄。`cmd /C start` 那个更特殊：`start` 会另起进程
//! 显示安装向导（那个必须可见），DETACHED 只影响 cmd.exe 自己的控制台。
//!
//! ## 为什么单独一个模块而不是各处内联 `#[cfg(windows)]`
//!
//! 原来只有 `plugins.rs` 一处写了这段（长驻插件进程，闪窗最显眼），
//! 而 `installer.rs` / `appupdate.rs` 的 curl 全部漏了 —— 正是"抄一次就不管"的后果。
//! 收口成一个函数，新加子进程调用时不容易忘。

use std::process::Command;

/// `DETACHED_PROCESS`（winbase.h）。值 0x00000008。
///
/// 不给子进程创建控制台。与 `CREATE_NEW_CONSOLE` 互斥（MSDN 明确说明）。
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// `CREATE_NO_WINDOW`（winbase.h）。值 0x08000000。
///
/// 语义是"创建隐藏的控制台"。**在 Win11 + Windows Terminal 上不足以阻止
/// 终端窗口弹出**（见模块注释的实测表），这里保留只为老系统兜底。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 抑制这个子进程的窗口（Windows 上生效，其它平台是空操作）。
///
/// 用法：构造完 `Command`、`.spawn()`/`.output()` 之前调用一次。
///
/// ```ignore
/// let mut cmd = Command::new(&curl);
/// cmd.args(["-s", "-L", ...]);
/// quiet(&mut cmd);
/// let out = cmd.output()?;
/// ```
pub fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS 是根治手段；CREATE_NO_WINDOW 作老系统兜底。
        // 两者同时传没有副作用（有控制台就藏、没控制台就无所谓）。
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_is_chainable() {
        // 只需要证明调用不 panic 且返回同一个 &mut Command
        let mut c = Command::new("cmd");
        let p: *const Command = &*quiet(&mut c).stdout(std::process::Stdio::null());
        assert_eq!(p, &c as *const Command);
    }

    #[cfg(windows)]
    #[test]
    fn detached_flag_is_set() {
        // 0x00000008 —— 不创建控制台。改回只有 CREATE_NO_WINDOW 会让这条红，
        // 提醒"Win11 上那样不够"（见模块注释的实测表）。
        assert_eq!(DETACHED_PROCESS, 0x0000_0008);
    }
}
