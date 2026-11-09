//! PC 单实例锁 + 「第二个实例把第一个唤到前台」。
//!
//! 为什么必须在 [`crate::plugins::PluginManager::new`] 之前调用：
//! `PluginManager::new` 会扫插件目录并杀掉所有不属于本实例的 sidecar
//! （见 plugins.rs 的 `kill_orphans_in` 注释）。第二个实例一旦走到那里，
//! 就会把第一个实例正在运行的 Java 后端当成孤儿杀掉——用户看到的是
//! 「再开一次应用，正在播放的后端突然没了」。
//!
//! 实现只用 Windows 命名内核对象，不引入新 crate：
//! - `Local\...` 互斥体：同一登录会话内唯一，进程死亡时由内核自动释放
//! - `Local\...` 事件：第二个实例 `SetEvent`，第一个实例的等待线程
//!   `WaitForSingleObject` 返回后把主窗口显示出来
//!
//! ★ 事件必须先于互斥体创建：第二个实例只有「看到互斥体已存在」才会去
//!   `OpenEventW`；如果第一个实例还在「已建互斥体、未建事件」的窗口期，
//!   第二个会打开失败、白启动一次。先建事件让这个窗口期不存在。

#[cfg(windows)]
pub fn ensure(app: &tauri::AppHandle) -> bool {
    win::ensure(app)
}

#[cfg(not(windows))]
pub fn ensure(_app: &tauri::AppHandle) -> bool {
    // 桌面端目前只发 Windows 包；其他平台不拦启动。
    true
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, HANDLE, ERROR_ALREADY_EXISTS, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE,
        INFINITE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;

    /// 同一会话内唯一。用 `Local\` 而不是 `Global\`：多用户/多 RDP 会话
    /// 各自可以有自己的一份猫窝，互不打扰。
    const MUTEX_NAME: &str = "Local\\com.meow.player.single-instance";
    const EVENT_NAME: &str = "Local\\com.meow.player.show-window";
    /// 首实例 pid。第二个实例需要它来调用 AllowSetForegroundWindow：
    /// 第二个实例通常刚被用户双击启动、拥有前台权限，由它授权首实例
    /// 抢前台，比首实例自己 SetForegroundWindow 可靠。
    const PID_FILE: &str = "single-instance.pid";

    fn pid_path(app: &tauri::AppHandle) -> std::path::PathBuf {
        crate::resolve_app_data(app).join(PID_FILE)
    }

    fn wide(s: &str) -> Vec<u16> {
        let mut out: Vec<u16> = s.encode_utf16().collect();
        out.push(0);
        out
    }

    pub fn ensure(app: &tauri::AppHandle) -> bool {
        let mname = wide(MUTEX_NAME);
        let ename = wide(EVENT_NAME);
        unsafe {
            // 先建事件：即使已存在，拿到的也是同一个对象的句柄。
            let event = CreateEventW(std::ptr::null(), 0, 0, ename.as_ptr());
            if event.is_null() {
                // 创建失败就放行，不要因为单实例机制把应用卡死。
                eprintln!("[single-instance] CreateEventW failed");
                return true;
            }

            // 不要求初始所有权：这里只用「对象是否存在」做判据。
            let mutex = CreateMutexW(std::ptr::null(), 0, mname.as_ptr());
            if mutex.is_null() {
                eprintln!("[single-instance] CreateMutexW failed");
                let _ = CloseHandle(event);
                return true;
            }

            if GetLastError() == ERROR_ALREADY_EXISTS {
                // 第二个实例：先把第一个喊出来，再干净退出。
                let _ = CloseHandle(mutex);

                // 读首实例 pid 并授权它抢前台。首实例可能在「已建互斥体、
                // 还没写 pid」的瞬间，短暂重试即可（最多 1 秒）。
                for _ in 0..20 {
                    if let Ok(text) = std::fs::read_to_string(pid_path(app)) {
                        if let Ok(pid) = text.trim().parse::<u32>() {
                            let _ = AllowSetForegroundWindow(pid);
                            break;
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }

                let found = OpenEventW(EVENT_MODIFY_STATE, 0, ename.as_ptr());
                if !found.is_null() {
                    let _ = SetEvent(found);
                    let _ = CloseHandle(found);
                } else {
                    eprintln!("[single-instance] OpenEventW failed");
                }
                let _ = CloseHandle(event);
                return false;
            }

            // 第一个实例：把 pid 落盘供第二个实例授权抢前台用。
            // 写失败不致命——最坏情况就是第二次启动只显示窗口、不抢焦点。
            let dir = crate::resolve_app_data(app);
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join(PID_FILE), std::process::id().to_string());

            // 第一个实例：起一个后台线程长期等事件。
            // 线程随进程退出而结束，不需要额外停止信号。
            //
            // HANDLE 是 *mut c_void，不实现 Send；转成 usize 跨线程传递，
            // 句柄生命周期由当前进程持有（线程只读它）。
            let event_addr = event as usize;
            let app = app.clone();
            if let Err(e) = std::thread::Builder::new()
                .name("meow-single-instance".into())
                .spawn(move || loop {
                    if WaitForSingleObject(event_addr as HANDLE, INFINITE) != WAIT_OBJECT_0 {
                        break;
                    }
                    crate::show_main_window(&app);
                })
            {
                eprintln!("[single-instance] spawn waiter failed: {e}");
            }

            // mutex 句柄故意不关：它就是「首实例存在」的凭据，
            // 进程退出时内核会自动回收。
            true
        }
    }
}
