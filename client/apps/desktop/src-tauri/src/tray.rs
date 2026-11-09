//! 托盘图标、关闭到托盘偏好、一次性关闭提示标记。
//!
//! 关闭行为的三段判据（顺序不能换）：
//! 1. 首次关闭：`tray-hint-seen` 不存在 → 不隐藏，`eval` 前端钩子弹一次提示
//! 2. 之后看 `desktop-prefs.json` 的 `closeToTray`（缺省 true）→ 隐藏 / 真退出
//! 3. 真退出统一走 `app.exit(0)`，保证 `RunEvent::ExitRequested` 里的
//!    `shutdown_all()` 仍然执行（见 lib.rs）
//!
//! 偏好文件为什么不直接读 WebView 的 localStorage：
//! 那是页面上下文里的东西，Rust 在 `CloseRequested` 里拿不到。
//! 前端启动时和 `meow:prefs` 变更时把值通过 IPC 写到这里，Rust 只认文件。

use crate::resolve_app_data;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

/// 桌面端行为偏好。只放 Rust 在关窗时需要同步读到的字段。
const PREFS_FILE: &str = "desktop-prefs.json";
/// 首次关闭提示是否已经展示过。存在即已展示。
const HINT_FILE: &str = "tray-hint-seen";

#[derive(serde::Serialize, serde::Deserialize)]
struct DesktopPrefs {
    /// 关闭窗口时隐藏到托盘（默认开）。
    #[serde(rename = "closeToTray", default = "default_true")]
    close_to_tray: bool,
}

fn default_true() -> bool {
    true
}

/// 读「关闭窗口时隐藏到托盘」。文件缺失/损坏都按默认开处理。
pub fn close_to_tray(app: &tauri::AppHandle) -> bool {
    let path = resolve_app_data(app).join(PREFS_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<DesktopPrefs>(&text)
            .map(|p| p.close_to_tray)
            .unwrap_or(true),
        Err(_) => true,
    }
}

/// 前端 IPC 写入偏好（`desktop_set_close_to_tray` 命令调用）。
pub fn set_close_to_tray(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let dir = resolve_app_data(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建应用数据目录失败: {e}"))?;
    let text = serde_json::to_string_pretty(&DesktopPrefs {
        close_to_tray: enabled,
    })
    .map_err(|e| format!("序列化桌面偏好失败: {e}"))?;
    std::fs::write(dir.join(PREFS_FILE), text).map_err(|e| format!("写桌面偏好失败: {e}"))
}

/// 首次关闭提示是否已展示过。
pub fn hint_seen(app: &tauri::AppHandle) -> bool {
    resolve_app_data(app).join(HINT_FILE).exists()
}

/// 记下「已展示」。由前端弹层的 `onMounted` 调用，而不是 Rust 在 eval 前写：
/// 只有弹层真的挂载出来才算展示过；页面钩子还没就绪时提前写，会让提示永久消失。
pub fn mark_hint_seen(app: &tauri::AppHandle) {
    let dir = resolve_app_data(app);
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(HINT_FILE), "1");
}

/// 设置页「再次显示关闭提示」：只删标记，`desktop-prefs.json` 一个字不动。
pub fn reset_hint(app: &tauri::AppHandle) -> Result<(), String> {
    match std::fs::remove_file(resolve_app_data(app).join(HINT_FILE)) {
        Ok(()) => Ok(()),
        // 本来就没有 = 下次关闭本来就会弹，不算失败。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清除首次关闭提示标记失败: {e}")),
    }
}

/// 创建托盘图标与右键菜单。
///
/// 图标直接复用 `app.default_window_icon()`（tauri.conf 里配的 icon.ico），
/// 不新增图片资源。
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "应用没有默认窗口图标，无法创建托盘".to_string())?;

    let show = MenuItemBuilder::with_id("show", "显示主窗口")
        .build(app)
        .map_err(|e| format!("创建托盘菜单项失败: {e}"))?;
    let logs = MenuItemBuilder::with_id("logs", "查看日志")
        .build(app)
        .map_err(|e| format!("创建托盘菜单项失败: {e}"))?;
    let quit = MenuItemBuilder::with_id("quit", "退出")
        .build(app)
        .map_err(|e| format!("创建托盘菜单项失败: {e}"))?;

    let menu = MenuBuilder::new(app)
        .items(&[&show, &logs, &quit])
        .build()
        .map_err(|e| format!("创建托盘菜单失败: {e}"))?;

    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        // 左键不弹菜单：单击/双击都还原窗口，右键才出菜单。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => crate::show_main_window(app),
            "logs" => show_logs(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Windows 双击会先发一次 Click 再发 DoubleClick；两者都走同一个
            // 带 250ms 去抖的入口，避免连续 show/focus 抢前台时闪一下。
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => show_from_tray(tray.app_handle()),
                _ => {}
            }
        })
        .build(app)
        .map_err(|e| format!("创建托盘图标失败: {e}"))?;

    // TrayIcon 被 Drop 时会移除图标；build 时资源表里已经存了一份 clone，
    // 这里丢掉局部句柄不会让图标消失，保留变量只为可读性。
    let _ = tray;
    Ok(())
}

/// 托盘「显示主窗口」/单击/双击共用。250ms 去抖挡住 Windows 双击自带的
/// 那一次 Click，`show_main_window` 内部的抢前台就不会连续跑两遍。
fn show_from_tray(app: &tauri::AppHandle) {
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    let last = LAST.get_or_init(|| Mutex::new(None));
    {
        let mut g = last.lock().unwrap();
        if let Some(t) = *g {
            if t.elapsed() < Duration::from_millis(250) {
                return;
            }
        }
        *g = Some(Instant::now());
    }
    crate::show_main_window(app);
}

/// 托盘「查看日志」：先把窗口拉回前台，再切到前端日志页。
///
/// 前端是 hash 路由（`createWebHashHistory`），日志页的 path 是 `/logs`
/// （router/index.ts 的 `{ path: '/logs', name: 'logs' }`）。直接改
/// `location.hash` 会触发 vue-router 的 hashchange，不用引入额外命令。
fn show_logs(app: &tauri::AppHandle) {
    crate::show_main_window(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval("location.hash = '#/logs'");
    }
}
