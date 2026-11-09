mod appupdate;
mod installer;
mod mcp;
mod plugins;
mod proc;
mod single_instance;
mod tray;

use installer::{Index, Installer, Progress, SourceList};
use plugins::{Phase, PluginManager, PluginState};
use std::path::PathBuf;
use std::sync::Arc;

/// 插件目录位置。
///
/// **插件全部外置下载**（v0.7.0 起），安装包里不带 plugins/。
/// 只有两个可能的位置：
/// 1. `MEOW_PLUGINS` 环境变量 —— 开发调试，显式指定
/// 2. `%APPDATA%/com.meow.player/plugins` —— 下载安装的唯一主位置
///
/// 为什么去掉了 `resource_dir()/plugins` 兼容分支：
/// dev 模式下 resource_dir 就是 `target/.../debug/`，而旧版 tauri.conf
/// 配过 `resources`，会在那里留一份 plugins/。保留这个分支会让
/// 「已清空 %APPDATA% 的裸安装」仍然"发现有插件"，掩盖真实状态，
/// 排查时会怀疑人生。既然确定走全外置，就不留这条路径。
///
/// 为什么主位置必须是 %APPDATA% 而不是安装目录：
/// 实测 `C:\Program Files` 不可写，装进安装目录的话下载完没法解压。
fn resolve_plugins_root(app_data: &PathBuf) -> PathBuf {
    if let Ok(p) = std::env::var("MEOW_PLUGINS") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return pb;
        }
    }
    app_data.join("plugins")
}

/// 数据目录：Windows 用 %APPDATA%\<identifier>，由 Tauri 的 app_data_dir 决定。
fn resolve_app_data(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    if let Ok(d) = app.path().app_data_dir() {
        return d;
    }
    PathBuf::from(".")
}

/// 把主窗口从托盘/最小化状态拉回前台。
///
/// 单实例的第二实例、托盘「显示主窗口」、托盘双击三处共用，避免三份
/// show/unminimize/set_focus 各自漏一步。
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        #[cfg(windows)]
        force_foreground(&w);
    }
}

/// 在 Windows 上强制把窗口拉到前台。
///
/// 只靠 tauri 的 `set_focus()` 会被前台锁（foreground lock）拦住：
/// 第二个实例如果没有前台权限（例如从后台脚本启动），
/// `AllowSetForegroundWindow` 也授权不了首实例。
/// AttachThreadInput 先附到当前前台线程的输入队列，再 SetForegroundWindow，
/// 是 Win32 下绕开该限制的常用做法；失败也只是窗口不抢焦点，不崩。
#[cfg(windows)]
fn force_foreground(w: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        SetWindowPos, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };

    if let Ok(hwnd) = w.hwnd() {
        let raw = hwnd.0 as HWND;
        unsafe {
            let fg = GetForegroundWindow();
            let mut fg_pid = 0u32;
            let fg_thread = if fg.is_null() {
                0
            } else {
                GetWindowThreadProcessId(fg, &mut fg_pid)
            };
            let this_thread = GetCurrentThreadId();
            let attached = if fg_thread != 0 && fg_thread != this_thread {
                AttachThreadInput(this_thread, fg_thread, 1)
            } else {
                0
            };
            let _ = BringWindowToTop(raw);
            // topmost 脉冲是 SetForegroundWindow 被前台锁拒绝时的兜底：
            // 即使拿不到焦点，也先把窗口压到最上层，用户能看见它被唤出。
            let _ = SetWindowPos(
                raw,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            );
            let _ = SetForegroundWindow(raw);
            let _ = SetWindowPos(
                raw,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE,
            );
            if attached != 0 {
                let _ = AttachThreadInput(this_thread, fg_thread, 0);
            }
        }
    }
}

#[tauri::command]
fn plugin_list(mgr: tauri::State<'_, Arc<PluginManager>>) -> Vec<PluginState> {
    mgr.discover()
}

#[tauri::command]
fn plugin_start(
    mgr: tauri::State<'_, Arc<PluginManager>>,
    id: String,
) -> Result<PluginState, String> {
    mgr.start(&id)
}

#[tauri::command]
fn plugin_stop(mgr: tauri::State<'_, Arc<PluginManager>>, id: String) -> Result<(), String> {
    mgr.stop(&id)
}

/// 切换"随应用启动"并持久化到 {appData}/enabled.json。
#[tauri::command]
fn plugin_set_enabled(
    mgr: tauri::State<'_, Arc<PluginManager>>,
    id: String,
    enabled: bool,
) -> Result<bool, String> {
    mgr.set_enabled(&id, enabled)
}

/// 前端启动时拿后端基地址；None 表示本地没起后端（可能用远端地址）。
#[tauri::command]
fn backend_base(mgr: tauri::State<'_, Arc<PluginManager>>) -> Option<String> {
    mgr.backend_base()
}

// ---------------------------------------------------------------- 桌面端行为（托盘 / 关闭）
//
// 关闭窗口的判据由 Rust 在 CloseRequested 里同步读取，所以偏好必须落到
// 应用数据目录（不能只存在 WebView 的 localStorage）。前端在启动时和
// `meow:prefs` 变更时调用 `desktop_set_close_to_tray` 把值递过来。

/// 写入「关闭窗口时隐藏到托盘」偏好（{appData}/desktop-prefs.json）。
#[tauri::command]
fn desktop_set_close_to_tray(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    tray::set_close_to_tray(&app, enabled)
}

/// 首次关闭提示里的「隐藏到托盘」按钮。
#[tauri::command]
fn desktop_hide_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    // 实测 WebView2 在 hide() 后仍报 visibilityState=visible，visibilitychange
    // 不会触发；先让前端把媒体暂停，再收窗口。
    let _ = w.eval("window.__meowPauseMedia?.()");
    w.hide().map_err(|e| format!("隐藏主窗口失败: {e}"))
}

/// 首次关闭提示里的「退出应用」按钮，以及后续「真正退出」的统一入口。
///
/// 必须走 `app.exit(0)` 而不是 `std::process::exit`：前者会触发
/// `RunEvent::ExitRequested`，lib.rs 末尾的 `shutdown_all()` 才会执行。
#[tauri::command]
fn desktop_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// 首次关闭提示真的显示出来了（前端弹层 onMounted 调用）。
///
/// 不在 CloseRequested 里提前写标记：页面钩子可能还没就绪，
/// 那样会写下一个"已提示"但其实从没弹过，用户永远看不到这个提示。
#[tauri::command]
fn desktop_tray_hint_shown(app: tauri::AppHandle) {
    tray::mark_hint_seen(&app);
}

/// 设置页「再次显示关闭提示」：只删 `tray-hint-seen`，不动 closeToTray。
#[tauri::command]
fn desktop_reset_tray_hint(app: tauri::AppHandle) -> Result<(), String> {
    tray::reset_hint(&app)
}

/// 播放页恢复全屏用的**窗口级**开关（2026-11-09）。
///
/// WebView2 的 HTML 全屏由 Tauri 运行时翻译成窗口全屏；播放器元素离开 DOM
/// 时运行时会自动把窗口退回窗口态，而重建后的 `requestFullscreen` 没有
/// 用户手势必被拒。这个命令让前端在重建后无手势恢复真全屏（伪全屏只能
/// 撑满 WebView，补不回标题栏）。只由播放器的伪全屏路径调用；真全屏
/// 仍由运行时管理，两边不要同时设置。
#[tauri::command]
fn desktop_set_fullscreen(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri::Manager;
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    w.set_fullscreen(enabled)
        .map_err(|e| format!("切换全屏失败: {e}"))
}

/// 把 Web 当前主题底色同步到原生窗口。
///
/// 为什么需要：窗口在 WebView 首帧之前、以及拖拽缩放时会露出原生底色。
/// `tauri.conf.json` 里写死 `#12141d`（猫窝深色底），用户切到浅色/暖纸主题后
/// 这里会闪一块深 navy。命令只接受 `#rrggbb`，非法输入直接拒绝，
/// 避免把窗口刷成透明/黑色导致更难看。
#[tauri::command]
fn desktop_set_window_bg(app: tauri::AppHandle, color: String) -> Result<(), String> {
    use tauri::Manager;
    let hex = color.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("颜色必须是 #rrggbb：{color}"));
    }
    let channel = |i: usize| {
        u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| "非法颜色".to_string())
    };
    let (r, g, b) = (channel(0)?, channel(2)?, channel(4)?);
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    w.set_background_color(Some(tauri::window::Color(r, g, b, 255)))
        .map_err(|e| format!("设置窗口底色失败: {e}"))
}

/// 手动/自动化触发「重启后端」，与托盘菜单共用 `PluginManager::restart_backend`。
///
/// 同步命令会跑在主线程，而 start 的健康检查最长 45 秒，所以这里必须
/// 用 spawn_blocking。返回 true 表示端口变了（已触发前端 reload）。
#[tauri::command]
async fn desktop_restart_backend(
    app: tauri::AppHandle,
    mgr: tauri::State<'_, Arc<PluginManager>>,
) -> Result<bool, String> {
    let mgr = mgr.inner().clone();
    let (old_port, new_port) = tauri::async_runtime::spawn_blocking(move || mgr.restart_backend())
        .await
        .map_err(|e| format!("重启任务异常: {e}"))??;
    let changed = old_port != new_port;
    if changed {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval("location.reload()");
        }
    }
    Ok(changed)
}

/// MCP 服务状态，供设置页「远程调试」分区展示。
///
/// 端口不落盘（见 mcp.rs 的 write_info_file 说明），但 UI 要知道
/// "现在能不能被外部工具连上、该给什么地址"，所以读进程内的静态值。
#[derive(serde::Serialize)]
struct McpStatus {
    /// 0 表示没起来
    port: u16,
    /// 给用户直接抄的完整地址；没起来时为空串
    url: String,
    /// 端口探测区间：客户端按这个范围找，不依赖任何文件
    port_range: [u16; 2],
}

#[tauri::command]
fn mcp_status() -> McpStatus {
    let port = mcp::active_port();
    McpStatus {
        port,
        url: if port == 0 {
            String::new()
        } else {
            format!("http://127.0.0.1:{port}/mcp")
        },
        port_range: [mcp::PORT_MIN, mcp::PORT_MIN + mcp::PORT_COUNT - 1],
    }
}

/// 一次性拿状态 + 基地址，减少前端启动时的 IPC 往返。
#[derive(serde::Serialize)]
struct BootInfo {
    backend_base: Option<String>,
    plugins: Vec<PluginState>,
    /// 本地后端是否就绪。false 不代表出错——用户可能配置了远端地址。
    ok: bool,
    /// 本应运行却没起来的原因（仅供提示，不阻止使用远端地址）
    fatal_reason: Option<String>,
    /// 应用版本，取自编译期的包版本。
    ///
    /// ★ 插件安装要用它做 `min_app_version` 校验，所以必须是**这个 exe 的真实版本**。
    /// 之前前端用的是 Vite 注入的 `__APP_VERSION__`，读的是 `apps/web/package.json`
    /// 里的 `0.2.0`（Web 应用自己的版本，与桌面端两个号），结果装 0.7.1 的插件时
    /// 报「需要应用 0.6.0 或更高（当前 0.2.0）」，明明版本是够的。
    /// 由 Rust 提供后只有一处来源，不会再有第二个号。
    app_version: String,
}

#[tauri::command]
fn boot_info(mgr: tauri::State<'_, Arc<PluginManager>>) -> BootInfo {
    let plugins = mgr.discover();
    let backend_base = mgr.backend_base();
    // fatal_reason 只表达"本该跑却跑不起来"（真正的故障）。
    //
    // 不算故障的两种情况：
    //   - enabled=false：用户关掉了开关，想用远端地址
    //   - phase=Stopped：用户手动点了「停止」，是主动行为
    // 这两种如果也报错，用户每次主动操作都会看到红色告警，反而麻木了。
    let broken = plugins
        .iter()
        .find(|p| p.required && p.enabled && p.phase == Phase::Failed);
    BootInfo {
        ok: backend_base.is_some(),
        fatal_reason: broken.and_then(|p| {
            p.error
                .clone()
                .or_else(|| Some(format!("{} 启动失败", p.name)))
        }),
        backend_base,
        plugins,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// 触发系统睡眠（睡眠定时到点时的"系统级"收尾，前端 VideoPlayer 调用）。
///
/// 为什么走 rundll32 而不是直接链 powrprof：SetSuspendState 要引入
/// windows-sys 这类 crate（约定不新增依赖），rundll32.exe 是系统自带进程，
/// `std::process::Command` 调用零依赖。
///
/// ★ 已知边界：SetSuspendState(0,1,0) 的行为取决于系统电源选项——
/// **开了休眠(Hibernate)的机器会休眠而不是睡眠**（快照写盘再断电），
/// 这是 powrprof 的固有行为，参数关不掉；想要真睡眠需
/// `powercfg /hibernate off` 或在电源选项里关闭休眠。
///
/// 标 `(async)`：同步命令在 Tauri 里跑主线程，而 rundll32 会一直挂到机器
/// 真正醒来（或被拒）才退出；放主线程会把整个窗口卡住。异步只挪线程，
/// 不改变命令语义。
#[tauri::command(async)]
fn system_sleep() -> Result<(), String> {
    // args 必须是两段：`powrprof.dll,SetSuspendState` 是一个整体（逗号后不能有空格），
    // `0,1,0` 是传给入口点的参数（Hibernate=0, Force=1, DisableWake=0）
    let out = std::process::Command::new("rundll32.exe")
        .args(["powrprof.dll,SetSuspendState", "0,1,0"])
        .output()
        .map_err(|e| format!("启动 rundll32 失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "SetSuspendState 退出码 {:?} stderr={:?}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

// ---------------------------------------------------------------- 插件下载 / 更新

/// 当前插件源地址。
#[tauri::command]
fn plugin_source(inst: tauri::State<'_, Arc<Installer>>) -> String {
    inst.source()
}

/// 全部插件源 + 当前选中项。
#[tauri::command]
fn plugin_sources(inst: tauri::State<'_, Arc<Installer>>) -> SourceList {
    inst.sources()
}

// ---------------------------------------------------------------- 应用自身的在线更新
//
// 为什么整套都在原生做（清单、下载、校验、进度），而不是像早期版本那样
// 让前端 XHR 下载完再 base64 丢过来：
//   · GitHub Release 资产**不带 CORS 头** —— 页面 XHR 必被浏览器拦
//   · 私有仓要带 `Authorization`，而 raw 的 CORS 预检不放行该头（实测 403）
//   · 11MB 的包经 base64 过 JS 桥约 15MB 字符串，纯属无谓开销
// 详见 `appupdate.rs` 文件头。页面只负责比版本、展示、点按钮。

/// 插件源访问令牌文件的位置（私有仓用）。
///
/// <p>为什么单独一个文件而不是塞进 plugin-sources.json：那个结构会整体
/// 序列化后回传前端（`plugin_sources` 命令），token 混在里面容易被界面误显示。
///
/// <p>用 `OnceLock` 缓存：`source_token()` 每拉一次清单都会调，
/// 没必要每次都走一遍路径拼接。
pub(crate) fn installer_token_path() -> Option<std::path::PathBuf> {
    static P: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    P.get_or_init(|| {
        // 与 resolve_app_data 同源：%APPDATA%/com.meow.player
        std::env::var("APPDATA")
            .ok()
            .map(|d| {
                std::path::PathBuf::from(d)
                    .join("com.meow.player")
                    .join("plugin-token.txt")
            })
    })
    .clone()
}

/// 读插件源令牌（空串 = 匿名）。私有 GitHub 仓需要它才能读清单/下载。
#[tauri::command]
fn plugin_token_get() -> String {
    installer_token_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// 设插件源令牌（空串 = 清除）。
#[tauri::command]
fn plugin_token_set(token: String) -> Result<(), String> {
    let p = installer_token_path().ok_or("找不到应用数据目录")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let t = token.trim();
    if t.is_empty() {
        let _ = std::fs::remove_file(&p);
        return Ok(());
    }
    std::fs::write(&p, t).map_err(|e| format!("写令牌失败：{e}"))
}

/// 全局 GitHub 加速前缀文件（与 plugin-token.txt 同目录）
fn git_proxies_path() -> Option<std::path::PathBuf> {
    installer_token_path().and_then(|p| p.parent().map(|d| d.join("git-proxies.json")))
}

#[tauri::command]
fn git_proxies_get() -> Vec<String> {
    let Some(p) = git_proxies_path() else { return Vec::new() };
    let Ok(t) = std::fs::read_to_string(p) else { return Vec::new() };
    serde_json::from_str::<Vec<String>>(t.trim_start_matches('\u{feff}'))
        .unwrap_or_default()
        .into_iter()
        .map(|x| x.trim().to_string())
        .filter(|x| x.starts_with("https://") && !x.chars().any(|c| c.is_whitespace()))
        .collect()
}

#[tauri::command]
fn git_proxies_set(proxies: Vec<String>) -> Result<(), String> {
    let p = git_proxies_path().ok_or("找不到应用数据目录")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let list: Vec<String> = proxies
        .into_iter()
        .map(|x| x.trim().to_string())
        .filter(|x| x.starts_with("https://") && !x.chars().any(|c| c.is_whitespace()))
        .collect();
    if list.is_empty() {
        let _ = std::fs::remove_file(&p);
        return Ok(());
    }
    let out = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    std::fs::write(&p, out).map_err(|e| format!("写加速列表失败：{e}"))
}

/// 读清单原文（JSON 文本）。前端自己 parse —— 它要先按平台挑 `meow-pc`/`meow-tv`，
/// 再回退旧的单条 `app`，逻辑放在一处比在 Rust 里再实现一遍更不容易漂。
///
/// ★ **必须 async + spawn_blocking**：这里会 `Command::output()` 等 curl 跑完。
/// 同步 command 在 Tauri 里跑在**主线程**上，实测单次 ~380ms，而且三个并发
/// 请求要 1142ms（= 串行排队，UI 线程被占死）。改成 spawn_blocking 后
/// 不阻塞 UI，多个请求也能真并发。对齐 `plugin_install` 的写法。
#[tauri::command]
async fn app_update_manifest_text(
    upd: tauri::State<'_, Arc<appupdate::AppUpdater>>,
    url: String,
    token: String,
) -> Result<String, String> {
    let upd = upd.inner().clone();
    tauri::async_runtime::spawn_blocking(move || upd.manifest_text(&url, &token))
        .await
        .map_err(|e| format!("读清单任务失败：{e}"))?
}

/// 读清单并取出指定条目的信息（供前端比版本）。
///
/// 不返回整个 packages：前端只需要自己那一项，把未知插件条目也发过去
/// 只是增加泄漏面（清单里可能还有别人的名字/描述）。
#[tauri::command]
fn app_update_check(
    upd: tauri::State<'_, Arc<appupdate::AppUpdater>>,
    url: String,
    package_id: String,
    token: String,
) -> Result<appupdate::UpdateEntry, String> {
    upd.read_manifest(&url, &token, &package_id)
}

/// 开始下载（立即返回，进度用 `app_update_state` 轮询）。
///
/// 本身只是起线程（真正的下载在 spawn 出去的线程里），但仍然写成 async：
/// 与 Read 侧保持一致，也避免 future 里加阻塞代码时被埋雷。
#[tauri::command]
async fn app_update_download(
    upd: tauri::State<'_, Arc<appupdate::AppUpdater>>,
    urls: Vec<String>,
    sha256: String,
    size: u64,
    token: String,
    file_name: String,
) -> Result<(), String> {
    let u = upd.inner().clone();
    u.start_download(&urls, &sha256, size, &token, &file_name)
}

/// 当前下载进度。
#[tauri::command]
fn app_update_state(upd: tauri::State<'_, Arc<appupdate::AppUpdater>>) -> appupdate::UpdateProgress {
    upd.state()
}

/// 取消下载。
#[tauri::command]
fn app_update_cancel(upd: tauri::State<'_, Arc<appupdate::AppUpdater>>) -> bool {
    upd.cancel()
}

/// 把已下载并校验通过的包交给系统安装器。
///
/// 只接受下载缓存目录里的路径（`AppUpdater::install` 里校验）：
/// 这条命令的能力是"运行一个 exe"，不能让它变成运行任意路径。
#[tauri::command]
fn app_update_install(
    upd: tauri::State<'_, Arc<appupdate::AppUpdater>>,
    path: String,
) -> Result<String, String> {
    upd.install(&path)
}

/// 清掉更新下载缓存，返回释放的字节数。
#[tauri::command]
fn app_update_clear(upd: tauri::State<'_, Arc<appupdate::AppUpdater>>) -> Result<u64, String> {
    upd.clear_cache()
}

#[tauri::command]
fn plugin_add_source(
    inst: tauri::State<'_, Arc<Installer>>,
    url: String,
    name: String,
) -> Result<SourceList, String> {
    inst.add_source(&url, &name)
}

#[tauri::command]
fn plugin_update_source(
    inst: tauri::State<'_, Arc<Installer>>,
    id: String,
    url: String,
    name: String,
) -> Result<SourceList, String> {
    inst.update_source(&id, &url, &name)
}

#[tauri::command]
fn plugin_remove_source(
    inst: tauri::State<'_, Arc<Installer>>,
    id: String,
) -> Result<SourceList, String> {
    inst.remove_source(&id)
}

#[tauri::command]
fn plugin_select_source(
    inst: tauri::State<'_, Arc<Installer>>,
    id: String,
) -> Result<SourceList, String> {
    inst.select_source(&id)
}

/// 测试源连通性（拉一次清单回报包数）。
#[tauri::command]
async fn plugin_test_source(
    inst: tauri::State<'_, Arc<Installer>>,
    url: String,
) -> Result<String, String> {
    // 同 plugin_index：内部起 curl，同步命令会卡主线程
    let inst = inst.inner().clone();
    tauri::async_runtime::spawn_blocking(move || inst.test_source(&url))
        .await
        .map_err(|e| format!("测试源任务失败：{e}"))?
}

/// 直接导入一份清单 JSON 文本（没有服务器也能用）。
#[tauri::command]
fn plugin_import_manifest(
    inst: tauri::State<'_, Arc<Installer>>,
    text: String,
    name: String,
) -> Result<SourceList, String> {
    inst.import_manifest_text(&text, &name)
}

#[tauri::command]
fn plugin_set_source(inst: tauri::State<'_, Arc<Installer>>, url: String) -> Result<(), String> {
    inst.set_source(&url)
}

/// 拉远端索引，供 UI 显示"可下载/可更新"。
///
/// <p>★ **必须是 async + spawn_blocking**。内部走 curl 子进程，同步命令在
/// Tauri 里跑在**主线程**上 —— 用户看到的是"一进设置页整个应用卡死，
/// 黑框消失后才恢复"。实测最坏路径是 2 个候选地址 × 3 次重试 × 30s 超时，
/// 主线程能被占住几分钟。
#[tauri::command]
async fn plugin_index(inst: tauri::State<'_, Arc<Installer>>) -> Result<Index, String> {
    let inst = inst.inner().clone();
    tauri::async_runtime::spawn_blocking(move || inst.fetch_index())
        .await
        .map_err(|e| format!("拉取索引任务失败：{e}"))?
}

/// 已安装记录（版本号 / 安装时间），用于判断有无更新。
#[tauri::command]
fn plugin_installed(inst: tauri::State<'_, Arc<Installer>>) -> serde_json::Value {
    serde_json::to_value(inst.installed_map()).unwrap_or(serde_json::Value::Null)
}

/// 下载并安装/升级。**阻塞**，前端应在异步调用后轮询 `plugin_progress`。
#[tauri::command]
async fn plugin_install(
    inst: tauri::State<'_, Arc<Installer>>,
    mgr: tauri::State<'_, Arc<PluginManager>>,
    id: String,
    app_version: String,
) -> Result<serde_json::Value, String> {
    let inst = inst.inner().clone();
    let mgr = mgr.inner().clone();
    // 放到阻塞线程池：下载可能几分钟，不能占 async runtime
    let res = tauri::async_runtime::spawn_blocking(move || {
        // ★ 升级前必须先停掉旧进程。
        // Windows 下运行中的 exe/dll 会被锁住，rename 目录会报
        // "另一个程序正在使用此文件 (os error 32)"，
        // 表现为"点了升级但什么都没发生"。
        let was_running = mgr
            .discover()
            .iter()
            .any(|p| p.id == id && p.phase == plugins::Phase::Ready);
        if was_running {
            mgr.stop(&id).map_err(|e| format!("停止旧版本失败: {e}"))?;
            // 给 OS 一点时间释放文件句柄（进程 kill 后句柄不是瞬间消失）
            std::thread::sleep(std::time::Duration::from_millis(800));
        }
        // 再清一次：was_running 只看"本实例托管的"，而升级失败的真正常见原因
        // 是上一轮留下的孤儿（新实例的 child 是 None，stop 根本管不到它）
        mgr.kill_orphans(&id);

        let info = match inst.install(&id, &app_version) {
            Ok(v) => v,
            Err(e) => {
                // 安装失败：把旧版本拉起来，别让用户"升个级反而没后端了"
                if was_running {
                    let _ = mgr.start(&id);
                }
                /*
                 * 文件被占用是升级路径上最常见的一种失败，而 `os error 32` /
                 * "另一个程序正在使用此文件" 对用户没有意义。
                 * 翻译成「发生了什么 + 现在能做什么」，原始错误附在括号里
                 * 供反馈时粘贴（不能丢，否则排查又得复现一次）。
                 */
                let msg = if e.contains("os error 32")
                    || e.contains("另一个程序正在使用此文件")
                    || e.contains("being used by another process")
                {
                    format!(
                        "插件文件仍被占用，升级没完成。已尝试自动停止旧版本；\
                         若反复失败，请关闭猫窝后重新打开再试一次。\n（原始错误：{e}）"
                    )
                } else {
                    e
                };
                return Err(msg);
            }
        };

        // 装完立刻启用 + 启动验证，失败就回滚
        let _ = mgr.set_enabled(&id, true);
        let started = mgr.start(&id).is_ok();
        let finalize = inst.finalize(&id, started);
        if !started {
            return Err("新版本启动失败，已回滚".to_string());
        }
        // finalize 失败不影响安装结果（只是备份没删掉）
        let _ = finalize;
        serde_json::to_value(info).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("任务异常: {e}"))?;
    res
}

/// 轮询下载进度。
#[tauri::command]
fn plugin_progress(inst: tauri::State<'_, Arc<Installer>>) -> Progress {
    inst.progress()
}

#[tauri::command]
fn plugin_cancel(inst: tauri::State<'_, Arc<Installer>>) {
    inst.cancel()
}

/// 从本地 zip 导入（离线安装）。
///
/// <p>★ async：内部要 `extract_zip`（起 `tar.exe` 子进程解压），
/// 同步命令会把主线程占住到大包解压完 —— 用户看到"点导入后界面冻结"。
#[tauri::command]
async fn plugin_import(
    inst: tauri::State<'_, Arc<Installer>>,
    mgr: tauri::State<'_, Arc<PluginManager>>,
    path: String,
) -> Result<String, String> {
    let inst = inst.inner().clone();
    let mgr = mgr.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let id = inst.import_zip(std::path::Path::new(&path))?;
        let _ = mgr.start(&id);
        Ok(id)
    })
    .await
    .map_err(|e| format!("导入任务失败：{e}"))?
}

#[tauri::command]
async fn plugin_uninstall(
    inst: tauri::State<'_, Arc<Installer>>,
    mgr: tauri::State<'_, Arc<PluginManager>>,
    id: String,
) -> Result<(), String> {
    let inst = inst.inner().clone();
    let mgr = mgr.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 先停进程再删目录，否则 Windows 会锁文件
        let _ = mgr.stop(&id);
        inst.uninstall(&id)
    })
    .await
    .map_err(|e| format!("卸载任务失败：{e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;

            // ★ 单实例必须最先：PluginManager::new 会按插件目录清理孤儿进程，
            // 第二个实例走到那里就会把第一个实例的 Java 后端杀掉。
            // 第二实例在这里直接结束，连插件目录都不会碰。
            if !single_instance::ensure(app.handle()) {
                println!("[single-instance] 已有实例在运行，已唤到前台并退出");
                std::process::exit(0);
            }

            let handle = app.handle().clone();
            let app_data = resolve_app_data(&handle);
            let root = resolve_plugins_root(&app_data);
            println!("[plugin] root = {}", root.display());
            println!("[plugin] data = {}", app_data.display());

            let mgr = Arc::new(PluginManager::new(root.clone(), app_data.clone()));
            app.manage(mgr.clone());

            // 托盘图标 + 右键菜单。失败只记日志：托盘不是应用能否使用的
            // 前提，不能因为图标资源缺失就让整个窗口起不来。
            match tray::init(&handle) {
                Ok(()) => println!("[tray] ready"),
                Err(e) => eprintln!("[tray] init failed: {e}"),
            }

            // 插件安装器：负责下载/校验/解压/原子替换/回滚。
            // 插件源优先读上次保存的 plugin-source.txt，便于自建镜像。
            let inst = Arc::new(Installer::new(root, app_data.clone()));
            if let Ok(saved) = std::fs::read_to_string(app_data.join("plugin-source.txt")) {
                let s = saved.trim();
                if !s.is_empty() {
                    let _ = inst.set_source(s);
                }
            }
            println!("[plugin] source = {}", inst.source());
            app.manage(inst);

            // 应用自身在线更新：清单读取与安装包下载都在原生做。
            // GitHub Release 资产不带 CORS 头（页面 XHR 必被拦），私有仓还要带
            // Authorization（raw 的 CORS 预检不放行该头）。详见 appupdate.rs。
            app.manage(Arc::new(appupdate::AppUpdater::new(&app_data)));

            // MCP 服务：给自动化冒烟用（截图/DOM/点击/插件控制）。
            // CDP 端口由启动脚本通过 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 注入，
            // 这里读回来传给 MCP，让它能桥接到真实 WebView。
            let cdp_port = std::env::var("MEOW_CDP_PORT")
                .ok()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(9455);
            let mcp_state = Arc::new(mcp::McpState {
                cdp_port,
                plugins: mgr.clone(),
            });
            match mcp::start(mcp_state) {
                Ok(p) => println!("[mcp] listening on http://127.0.0.1:{p}/mcp (cdp={cdp_port})"),
                Err(e) => eprintln!("[mcp] start failed: {e}"),
            }

            // 自动启动「用户启用了」的插件。
            //
            // 注意不再无条件启动 required：用户可以把 apiserver 关掉、
            // 改连远端地址（NAS / 别人的服务器），这是合法形态。
            // 启没启用看 enabled.json（缺省取 manifest 的 autostart）。
            // 放在独立线程：JVM 启动要几秒，不能阻塞窗口显示。
            std::thread::spawn(move || {
                let list = mgr.discover();
                println!("[plugin] discovered {} plugin(s)", list.len());
                for p in &list {
                    println!(
                        "[plugin]   {} installed={} enabled={} required={} phase={:?}",
                        p.id, p.installed, p.enabled, p.required, p.phase
                    );
                }
                for p in list {
                    if !p.installed || !p.enabled {
                        continue;
                    }
                    println!("[plugin] starting {} ...", p.id);
                    // 注意：要用 start() 的返回值，不能用循环里 discover 出来的
                    // 旧 PluginState——那个的 port 还是 manifest 的默认值，
                    // 端口协商后的真实端口只在 start() 的返回里。
                    match mgr.start(&p.id) {
                        Err(e) => eprintln!("[plugin] start {} failed: {e}", p.id),
                        Ok(st) => println!("[plugin] {} ready on {}", st.id, st.port),
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            plugin_list,
            plugin_start,
            plugin_stop,
            plugin_set_enabled,
            backend_base,
            // 桌面端行为（托盘 / 关闭 / 重启后端）
            desktop_set_close_to_tray,
            desktop_hide_to_tray,
            desktop_quit,
            desktop_set_window_bg,
            desktop_tray_hint_shown,
            desktop_reset_tray_hint,
            desktop_set_fullscreen,
            desktop_restart_backend,
            boot_info,
            mcp_status,
            // 电源
            system_sleep,
            // 下载 / 更新 / 导入
            plugin_source,
            plugin_sources,
            // 私有仓令牌（插件源与应用更新共用 concept：都靠它读私有 GitHub）
            plugin_token_get,
            plugin_token_set,
            git_proxies_get,
            git_proxies_set,
            plugin_add_source,
            plugin_update_source,
            plugin_remove_source,
            plugin_select_source,
            plugin_test_source,
            plugin_import_manifest,
            plugin_set_source,
            plugin_index,
            plugin_installed,
            plugin_install,
            plugin_progress,
            plugin_cancel,
            plugin_import,
            plugin_uninstall,
            // 应用自身在线更新（清单/下载/校验/安装全在原生）
            app_update_manifest_text,
            app_update_check,
            app_update_download,
            app_update_state,
            app_update_cancel,
            app_update_install,
            app_update_clear
        ])
        .on_window_event(|window, event| {
            use tauri::Manager;
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let app = window.app_handle();

                if tray::hint_seen(app) {
                    if tray::close_to_tray(app) {
                        // 默认行为：关闭 = 隐藏到托盘。
                        api.prevent_close();
                        if let Some(w) = app.get_webview_window(window.label()) {
                            let _ = w.eval("window.__meowPauseMedia?.()");
                        }
                        let _ = window.hide();
                    } else {
                        // 用户关了「最小化到托盘」→ 点 X 就是真退出。
                        // 显式 exit 而不是放任窗口关闭，是为了确保
                        // ExitRequested 一定触发、shutdown_all() 一定执行。
                        api.prevent_close();
                        app.exit(0);
                    }
                    return;
                }

                // 首次关闭：不隐藏，弹一次提示。标记由弹层挂载后回写
                // （desktop_tray_hint_shown）——先 eval，弹出来了才算展示过。
                api.prevent_close();
                if let Some(w) = app.get_webview_window(window.label()) {
                    let _ = w.eval("window.__meowTrayHint?.()");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 退出时杀掉所有 sidecar，避免留孤儿 Java 进程
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                if let Some(mgr) = app_handle.try_state::<Arc<PluginManager>>() {
                    mgr.shutdown_all();
                }
            }
        });
}
