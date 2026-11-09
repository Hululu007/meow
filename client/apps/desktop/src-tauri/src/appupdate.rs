//! 应用自身的在线更新（PC 侧原生实现）。
//!
//! ## 为什么下载和取清单都在原生做，而不是页面里 XHR
//!
//! 三条实测约束，任何一条都足以否决"页面 XHR"这条路：
//!
//! 1. **GitHub Release 资产没有 CORS 头**。实测响应头里完全没有
//!    `Access-Control-Allow-Origin`（302 跳转到 `release-assets.githubusercontent.com`，
//!    最终 200 也不带）。页面对它发 XHR 必被浏览器拦。
//! 2. **私有仓要带 Authorization**。`raw.githubusercontent.com` 的
//!    CORS 预检对 `access-control-request-headers: authorization` 回 403
//!    且不带 `Access-Control-Allow-Headers` —— 浏览器不允许带 token 发请求。
//! 3. **整包经 JS 桥要 base64**。11MB 的 apk 变成约 15MB 字符串，
//!    TV 上实测过很勉强，PC 上也没必要付出这个代价。
//!
//! 所以：清单读取、下载、校验全在原生。页面只负责"比版本 + 展示 + 点按钮"。
//!
//! ## 为什么复用 curl.exe 而不是引 reqwest
//!
//! 与 `installer.rs` 同一理由：`curl.exe` 是 Win10 1803+ 系统自带，
//! 支持 `-L` 跟随重定向（GitHub 会 302）、`-C -` 断点续传、`--fail`；
//! 引 reqwest 要拉整个 tokio 异步栈，编译时间换不来任何本功能需要的东西。
//! sha256 用 `sha2`（已在依赖树，`installer.rs` 同源）。
//!
//! ## 进度模型：轮询，不是回调
//!
//! Tauri 的 `invoke` 是一次性调用，没有回调通道。所以与插件安装相同：
//! 下载跑在后台线程，进度写进 `Mutex<UpdateProgress>`，前端定时 `app_update_state` 读。
//! 这样也顺带支持"下载到一半切页面再回来还能看到进度"。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// 清单里的单个包。只声明本模块用到的字段，其余忽略。
///
/// 为什么不复用 `installer::PackageInfo`：那个的字段是插件语义
/// （`requires` / `hidden` / `api_version`）。这里只要"版本 + 地址 + 校验值"，
/// 少依赖一点，将来清单格式演进时互不影响。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UpdateEntry {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub platform: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(default)]
    packages: std::collections::HashMap<String, UpdateEntry>,
}

/// 下载进度（前端轮询）。
#[derive(Debug, Clone, Serialize, Default)]
pub struct UpdateProgress {
    /// idle | downloading | verifying | ready | failed | cancelled
    pub stage: String,
    /// 0-100；未知总量时为 0
    pub percent: f64,
    pub received: u64,
    pub total: u64,
    pub message: String,
    /// stage=ready 时是落盘的绝对路径（供日志/排查，不交给前端读文件）
    pub path: String,
}

struct Active {
    cancel: Arc<AtomicBool>,
    child: Option<Child>,
}

pub struct AppUpdater {
    /// 下载缓存目录（放 app_data 下，与插件缓存并列）
    cache_dir: PathBuf,
    progress: Arc<Mutex<UpdateProgress>>,
    active: Arc<Mutex<Option<Active>>>,
}

impl AppUpdater {
    pub fn new(app_data: &Path) -> Self {
        let cache_dir = app_data.join("updates");
        std::fs::create_dir_all(&cache_dir).ok();
        Self {
            cache_dir,
            progress: Arc::new(Mutex::new(UpdateProgress {
                stage: "idle".into(),
                ..Default::default()
            })),
            active: Arc::new(Mutex::new(None)),
        }
    }

    pub fn state(&self) -> UpdateProgress {
        self.progress.lock().unwrap().clone()
    }

    fn set(&self, p: UpdateProgress) {
        *self.progress.lock().unwrap() = p;
    }

    /// 读清单原文（JSON 文本）。前端自己 parse，因为它可能要先看旧格式的 `app` 条目。
    ///
    /// <p>★ 支持 GitHub release 端点（`.../releases/latest` 或 `.../releases/tags/<tag>`）：
    /// 那类地址返回的是**描述 release 的 JSON**，清单是其中一个叫
    /// `packages.json` 的资产，要再取一层。
    ///
    /// <p>踩过：Release 端点这层解析只写在了前端 `fetchManifestText` 和
    /// `installer.rs` 里，Rust 这边没做——结果插件源能连通但"0 个插件"，
    /// 因为拿回来的是 release 描述 JSON（没有 `packages` 字段）。
    /// 判断逻辑必须三处一致，收口在 `github_manifest_asset`。
    pub fn manifest_text(&self, url: &str, token: &str) -> Result<String, String> {
        if !is_http(url) {
            return Err(format!("清单地址必须是 http(s)：{url}"));
        }
        /*
         * ★ 这里**只做单次 GET，不做 release 端点解析**。
         *
         * 踩过（2026-10-30，PC 端设置页报「release release-v0.9.37 里没有
         * packages.json 资产」而资产明明在）：一开始这层也做了
         * 「release 端点 → 拉列表挑 tag → 找 packages.json → 拉内容」的解析，
         * 结果与前端 `fetchManifestText` 的解析**叠了两层** ——
         * Rust 已经把清单内容返回了，前端拿到后又把它当成 release JSON
         * 去里面找 `assets`，找不到就报错。错误信息完全误导（看着像清单没上传）。
         *
         * 解析路径只能有一处：**前端**（`isReleaseEndpoint` /
         * `pickManifestRelease` / `manifestAssetUrlFrom`）。原生只负责
         * "把这段地址的字节取回来"。
         *
         * TV 端 AppUpdater.java 早就这么改了（2026-10-29），当时只修了 Java
         * 没修 Rust —— 同一条规则在两个原生实现里各写一遍，漏一个就复发。
         */
        self.http_get(url, token)
    }

    /// 单次 HTTP GET，返回正文。
    fn http_get(&self, url: &str, token: &str) -> Result<String, String> {
        Self::http_get_static(url, token)
    }

    /// 单次 HTTP GET（不依赖 &self，供上面的自由函数用）。
    /// 带重试的 GET。
    ///
    /// <p><b>为什么需要</b>：实测本机到 `api.github.com` 的 TLS 握手抖动频繁
    /// （`curl: (35) schannel: failed to receive handshake`），
    /// 同一请求连试 5 次才通是常态。没有重试会表现成"更新源时好时坏"。
    fn http_get_retry(url: &str, token: &str) -> Result<String, String> {
        let mut last = String::new();
        for i in 1..=5 {
            match Self::http_get_static(url, token) {
                Ok(t) => return Ok(t),
                Err(e) => {
                    last = e;
                    if i < 5 {
                        std::thread::sleep(std::time::Duration::from_secs(i as u64));
                    }
                }
            }
        }
        Err(last)
    }

    fn http_get_static(url: &str, token: &str) -> Result<String, String> {
        let curl = find_curl()?;
        let mut cmd = Command::new(&curl);
        // -s 静默（不要进度条污染 JSON）、-L 跟随重定向、--fail 让 404 变成退出码
        cmd.args(["-s", "-L", "--fail", "--max-time", "30"]);
        // ★ 不压窗口的话，每次检查更新都会在屏幕上闪一个黑框（curl 是控制台程序）
        crate::proc::quiet(&mut cmd);
        apply_github_headers(&mut cmd, url, token);
        if !token.trim().is_empty() && token_allowed_for(url) {
            cmd.arg("-H").arg(format!("Authorization: Bearer {}", token.trim()));
        }
        cmd.arg(url);

        let out = cmd.output().map_err(|e| format!("无法启动 curl：{e}"))?;
        if !out.status.success() {
            let code = out.status.code().unwrap_or(-1);
            // curl --fail 把 HTTP 4xx/5xx 统一变成退出码 22，所以这里给的是组合提示
            let hint = match code {
                22 => "（HTTP 4xx/5xx：地址不存在，或私有仓需要访问令牌）",
                28 => "（超时：网络不通或服务器无响应）",
                _ => "",
            };
            return Err(format!("拉取清单失败（curl 退出码 {code}）{hint}"));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /// 读清单并取出指定 id 的条目。
    ///
    /// `token` 非空时带 `Authorization: Bearer`（私有仓）。用 curl 而不是
    /// 自己开 socket：TLS 在 Windows 上要么引 rustls/native-tls，要么自己接
    /// SChannel。curl 已经把这两条都解决了。
    pub fn read_manifest(
        &self,
        url: &str,
        token: &str,
        package_id: &str,
    ) -> Result<UpdateEntry, String> {
        let text = self.manifest_text(url, token)?;
        let manifest: Manifest = serde_json::from_str(&text)
            .map_err(|e| format!("清单不是合法 JSON：{e}"))?;
        manifest
            .packages
            .get(package_id)
            .cloned()
            .ok_or_else(|| format!("清单里没有 {package_id} 条目"))
    }

    /// 启动下载（立即返回，进度靠 `state()` 轮询）。
    ///
    /// 与插件下载一致：下载完**不自动安装**。安装是用户的点击，
    /// 静默替换应用自身等于把远端变成任意代码执行入口。
    pub fn start_download(
        self: &Arc<Self>,
        urls: &[String],
        sha256: &str,
        size: u64,
        token: &str,
        file_name: &str,
    ) -> Result<(), String> {
        if urls.is_empty() {
            return Err("下载地址为空".into());
        }
        for u in urls {
            if !is_http(u) {
                return Err(format!("下载地址必须是 http(s)：{u}"));
            }
        }
        if sha256.trim().is_empty() {
            return Err("清单缺 sha256，拒绝下载（无法校验的安装包不该落盘）".into());
        }
        {
            let g = self.active.lock().unwrap();
            if g.is_some() {
                return Err("已有下载在进行".into());
            }
        }

        // 文件名只用 basename 并过滤可疑字符：清单来自网络，
        // 不能让 `../../x` 这种把文件写到缓存目录之外。
        // 用第一个候选地址兜底取文件名（正常会给 file_name）。
        let safe = safe_file_name(file_name, urls.first().map(|s| s.as_str()).unwrap_or(""));
        let out_path = self.cache_dir.join(&safe);
        let _ = std::fs::remove_file(&out_path);

        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut g = self.active.lock().unwrap();
            *g = Some(Active {
                cancel: cancel.clone(),
                child: None,
            });
        }
        self.set(UpdateProgress {
            stage: "downloading".into(),
            percent: 0.0,
            received: 0,
            total: size,
            message: "下载中 0%".into(),
            path: String::new(),
        });

        let me = self.clone();
        let urls = urls.to_vec();
        let sha = sha256.trim().to_ascii_lowercase();
        let token = token.trim().to_string();
        std::thread::spawn(move || {
            let r = me.download_with_fallback(&urls, &sha, size, &token, &out_path, &cancel);
            {
                let mut g = me.active.lock().unwrap();
                *g = None;
            }
            match r {
                Ok(()) => me.set(UpdateProgress {
                    stage: "ready".into(),
                    percent: 100.0,
                    received: size,
                    total: size,
                    message: "下载完成，校验通过".into(),
                    path: out_path.to_string_lossy().to_string(),
                }),
                Err(e) => {
                    if cancel.load(Ordering::SeqCst) {
                        let _ = std::fs::remove_file(&out_path);
                        me.set(UpdateProgress {
                            stage: "cancelled".into(),
                            percent: 0.0,
                            message: "已取消".into(),
                            ..Default::default()
                        });
                    } else {
                        let _ = std::fs::remove_file(&out_path);
                        me.set(UpdateProgress {
                            stage: "failed".into(),
                            percent: 0.0,
                            message: e,
                            ..Default::default()
                        });
                    }
                }
            }
        });
        Ok(())
    }

    /// 按候选顺序逐个尝试下载，第一个成功（且 sha256 通过）的胜出。
    ///
    /// <p><b>为什么需要回退</b>：从本机到 `github.com` 的 TLS 握手经常超时
    /// （实测 `gh` 命令连续两次 `net/http: TLS handshake timeout`）。
    /// 前端会给出「直连 + 若干加速代理」的候选列表，这里按顺序试。
    ///
    /// <p>两种情况不继续试下一个候选：
    /// - 用户取消（再试只会拖长取消时间）
    /// - **sha256 不匹配**（内容错了，换个地址下同一份也是错的；
    ///   而且这可能是投毒，必须硬失败）
    fn download_with_fallback(
        &self,
        urls: &[String],
        sha256: &str,
        size: u64,
        token: &str,
        out: &Path,
        cancel: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mut last_err = String::from("没有可用的下载地址");
        for (i, url) in urls.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                return Err("已取消".into());
            }
            if i > 0 {
                // 让用户知道在换线路，而不是看着进度条卡住
                self.set(UpdateProgress {
                    stage: "downloading".into(),
                    percent: 0.0,
                    received: 0,
                    total: size,
                    message: format!("换线路重试（{} / {}）…", i + 1, urls.len()),
                    path: String::new(),
                });
            }
            // 换地址前先清掉半截文件，否则 -C - 会对新地址做续传而拼错内容
            let _ = std::fs::remove_file(out);
            match self.download_blocking(url, sha256, size, token, out, cancel) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    if cancel.load(Ordering::SeqCst) {
                        return Err("已取消".into());
                    }
                    // 校验失败是内容问题，换线路没有意义，也可能意味着被投毒
                    if e.contains("校验失败") {
                        return Err(e);
                    }
                    last_err = e;
                }
            }
        }
        Err(format!("{last_err}（已尝试 {} 个地址）", urls.len()))
    }

    fn download_blocking(
        &self,
        url: &str,
        sha256: &str,
        size: u64,
        token: &str,
        out: &Path,
        cancel: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        let curl = find_curl()?;
        let mut cmd = Command::new(&curl);
        cmd.args(["-L", "--fail", "-C", "-", "--progress-bar", "-o"])
            .arg(out)
            .arg(url)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        // 下载可能持续几十秒，黑框会一直挂在屏幕上挡住应用界面
        crate::proc::quiet(&mut cmd);
        apply_github_headers(&mut cmd, url, token);
        // 同 http_get_static：令牌只发给 api.github.com（自建源不该收到 PAT）
        if !token.is_empty() && token_allowed_for(url) {
            cmd.arg("-H").arg(format!("Authorization: Bearer {token}"));
        }
        let mut child = cmd.spawn().map_err(|e| format!("无法启动 curl：{e}"))?;

        if let Some(se) = child.stderr.take() {
            let me = self.progress.clone();
            let canc = cancel.clone();
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(se).lines().map_while(Result::ok) {
                    if canc.load(Ordering::SeqCst) {
                        break;
                    }
                    if let Some(pct) = parse_curl_percent(&line) {
                        let received = if size > 0 {
                            ((pct / 100.0) * size as f64) as u64
                        } else {
                            0
                        };
                        *me.lock().unwrap() = UpdateProgress {
                            stage: "downloading".into(),
                            percent: pct,
                            received,
                            total: size,
                            message: format!("下载中 {pct:.0}%"),
                            path: String::new(),
                        };
                    }
                }
            });
        }

        {
            let mut g = self.active.lock().unwrap();
            if let Some(a) = g.as_mut() {
                a.child = Some(child);
            }
        }

        loop {
            let status = {
                let mut g = self.active.lock().unwrap();
                match g.as_mut().and_then(|a| a.child.as_mut()) {
                    Some(c) => match c.try_wait() {
                        Ok(Some(st)) => Some(st),
                        Ok(None) => None,
                        Err(e) => return Err(format!("等待 curl 失败：{e}")),
                    },
                    None => None,
                }
            };
            if let Some(st) = status {
                if cancel.load(Ordering::SeqCst) {
                    return Err("已取消".into());
                }
                if !st.success() {
                    return Err(format!("下载失败（curl 退出码 {}）", st.code().unwrap_or(-1)));
                }
                break;
            }
            if cancel.load(Ordering::SeqCst) {
                // 取消时杀掉 curl，否则它会继续把包下完
                if let Some(mut c) = self.active.lock().unwrap().as_mut().and_then(|a| a.child.take()) {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                return Err("已取消".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        // ---- 校验。不匹配必须失败，且文件要删掉 ----
        self.set(UpdateProgress {
            stage: "verifying".into(),
            percent: 100.0,
            received: size,
            total: size,
            message: "校验中…".into(),
            path: String::new(),
        });
        let got = sha256_file(out)?;
        if !got.eq_ignore_ascii_case(sha256) {
            return Err(format!(
                "校验失败：期望 {}… 实际 {}…",
                &sha256[..sha256.len().min(12)],
                &got[..got.len().min(12)]
            ));
        }
        Ok(())
    }

    pub fn cancel(&self) -> bool {
        let g = self.active.lock().unwrap();
        match g.as_ref() {
            Some(a) => {
                a.cancel.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// 把已下载并校验过的包交给系统安装器。
    ///
    /// 只接受 `self.cache_dir` 里的路径：这个函数的能力是"运行一个 exe"，
    /// 不能让它变成"运行任意路径的 exe"（那等于把 invoke 暴露成本地代码执行）。
    pub fn install(&self, path: &str) -> Result<String, String> {
        let p = std::fs::canonicalize(path)
            .map_err(|e| format!("安装包不存在或不可读：{e}"))?;
        let dir = std::fs::canonicalize(&self.cache_dir)
            .map_err(|e| format!("缓存目录不可读：{e}"))?;
        if !p.starts_with(&dir) {
            return Err("只允许安装下载缓存里的包".into());
        }
        if !p.is_file() {
            return Err("安装包不是文件".into());
        }
        if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) < 1024 {
            return Err("安装包过小，可能下载失败".into());
        }

        // ★ canonicalize 的返回值在 Windows 上带 `\\?\` verbatim 前缀
        //   （`\\?\C:\Users\...`），而 `cmd /C start` **不认这个前缀**：
        //   用户会看到一个"Windows 找不到文件"的错误弹窗，标题栏里
        //   赫然是 `\\?\C:\...`。实测踩过。
        //
        //   校验用带前缀的（它是最规整的形式，比对不会被 `..` 绕过），
        //   但**交给外部程序之前必须去掉前缀**。
        let launch = strip_verbatim(&p);

        // 用 shell open 而不是直接执行：更接近用户双击的行为
        // （直接 Command::new(exe) 在某些环境缺工作目录/参数会异常）。
        #[cfg(target_os = "windows")]
        {
            let mut c = Command::new("cmd");
            c.args(["/C", "start", "", &launch.to_string_lossy()]);
            /*
             * ★ 这里压的是 **cmd.exe 自己的控制台**，不是安装器的界面。
             *
             * `start` 会另起一个进程显示安装向导（那个必须可见，否则用户不知道
             * 该点下一步）。但如果不压窗口，cmd.exe 会先闪一个黑框 ——
             * 用户看到的是"点安装，先黑闪一下，再出安装向导"，很像出错。
             */
            crate::proc::quiet(&mut c);
            c.spawn().map_err(|e| format!("启动安装程序失败：{e}"))?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            Command::new("open")
                .arg(&launch)
                .spawn()
                .map_err(|e| format!("启动安装程序失败：{e}"))?;
        }
        Ok("已启动安装程序，请按提示完成安装".into())
    }

    /// 清掉**下载缓存**（只删 `{app_data}/updates/` 里的文件）。
    ///
    /// <p><b>边界必须写死在这里</b>：这个方法的能力是"删文件"，一旦哪天
    /// 有人把 `cache_dir` 改成 `app_data` 本身，就会连设置、插件、片库
    /// 一起删掉。所以显式断言目录名，改错了直接报错而不是静默误删。
    ///
    /// <p>不删的东西（都在别的目录）：`prefs` / `history` / `favorites`
    /// （localStorage）、`plugins/`、`library/`、海报缓存。
    pub fn clear_cache(&self) -> Result<u64, String> {
        // 只允许清名为 `updates` 的目录
        if !is_updates_dir(&self.cache_dir) {
            return Err(format!(
                "拒绝清理：目标目录不是下载缓存（{}），避免误删用户数据",
                self.cache_dir.display()
            ));
        }
        let mut freed = 0u64;
        let rd = std::fs::read_dir(&self.cache_dir).map_err(|e| e.to_string())?;
        for e in rd.flatten() {
            let p = e.path();
            // 只删文件，不递归进子目录（万一下面被塞了别的东西）
            if p.is_file() {
                freed += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(&p);
            }
        }
        Ok(freed)
    }
}

// ---------------------------------------------------------------- 工具

/// 是不是 GitHub 的 release 端点（`.../releases/latest` 或 `.../releases/tags/<tag>`）。
///
/// <p>这三处必须认同一种地址：前端 `isReleaseEndpoint`、安装器
/// `is_github_release_endpoint`、这里。语义完全一致。
fn is_github_release_endpoint(u: &str) -> bool {
    let s = u.trim().trim_end_matches('/').to_ascii_lowercase();
    if !s.starts_with("https://api.github.com/repos/") {
        return false;
    }
    match s.rfind("/releases/") {
        Some(pos) => {
            let tail = &s[pos + "/releases/".len()..];
            tail == "latest" || tail.starts_with("tags/")
        }
        None => false,
    }
}

/// 若地址是 release 端点，返回里面 `packages.json` 资产的下载地址。
///
/// <p>返回 `Ok(None)` 表示"不是 release 端点，按原地址用"；
/// `Ok(Some(url))` 表示"换成这个地址"；`Err` 是取到了 release 但没找到清单资产。
///
/// <p>★ **当前没有生产调用点，故意保留**（`allow(dead_code)`）。
/// 2026-10-30 起 release 端点解析**统一收口到前端**（见 `manifest_text`
/// 的注释：两层解析会让前端把已取回的清单当成 release JSON 再解析一遍，
/// 报"该 release 里没有 packages.json 资产"）。这里保留是因为：
///   · `pick_release_with_manifest` / `repo_and_tail` / `tag_version`
///     仍有单元测试覆盖，是"挑 release"规则的参考实现；
///   · 将来若要把解析搬回原生（TV 端就是这么做的），直接启用即可。
#[allow(dead_code)]
fn github_manifest_asset(url: &str, token: &str) -> Result<Option<String>, String> {
    if !is_github_release_endpoint(url) {
        return Ok(None);
    }
    let (repo, tail) = repo_and_tail(url).ok_or_else(|| format!("看不懂的 release 端点：{url}"))?;

    // ★ 加固（2026-10-29）：`latest` 不直接用，改拉列表自己挑。
    //   坑见 `pick_release_with_manifest` 的注释。
    let real_url = if tail == "latest" {
        let list = AppUpdater::http_get_retry(
            &format!("https://api.github.com/repos/{repo}/releases?per_page=30"),
            token,
        )?;
        let v: serde_json::Value =
            serde_json::from_str(&list).map_err(|e| format!("release 列表不是合法 JSON：{e}"))?;
        let tag = pick_release_with_manifest(&v).ok_or_else(|| {
            "没有可用的 release：需要「已发布 + 含 packages.json 资产」的版本（发版时 sync-packages 负责上传）".to_string()
        })?;
        format!("https://api.github.com/repos/{repo}/releases/tags/{tag}")
    } else {
        url.to_string()
    };

    let u = AppUpdater::http_get_retry(&real_url, token)?;
    let v: serde_json::Value =
        serde_json::from_str(&u).map_err(|e| format!("release 响应不是合法 JSON：{e}"))?;
    for a in v.get("assets").and_then(|x| x.as_array()).into_iter().flatten() {
        if a.get("name").and_then(|x| x.as_str()) == Some("packages.json") {
            if let Some(id) = a.get("id").and_then(|x| x.as_u64()) {
                return Ok(Some(format!(
                    "https://api.github.com/repos/{repo}/releases/assets/{id}"
                )));
            }
            if let Some(dl) = a.get("browser_download_url").and_then(|x| x.as_str()) {
                return Ok(Some(dl.to_string()));
            }
        }
    }
    Err(format!(
        "该 release 里没有 packages.json 资产（发版时 sync-packages 应上传它）：{real_url}"
    ))
}

/// 从 release 端点 URL 里拆出 `(owner/repo, tail)`，tail 是 `latest` 或 `tags/<tag>`。
fn repo_and_tail(url: &str) -> Option<(String, String)> {
    let s = url.trim().trim_end_matches('/');
    let rest = s.strip_prefix("https://api.github.com/repos/")?;
    let idx = rest.find("/releases/")?;
    let repo = rest[..idx].to_string();
    let tail = rest[idx + "/releases/".len()..].to_string();
    Some((repo, tail))
}

/// 从 `/releases` 列表里挑「已发布 + 含 packages.json 资产 + 版本号最大」的那个 tag。
///
/// <p><b>为什么不用 `/releases/latest`</b>（2026-10-29 加固），四个坑：
/// 1. 按**发布时间**挑，不按版本号 → 给旧版补 hotfix 会让客户端"降级"
/// 2. **draft 不参与** → `release.yml` 建的是 draft，忘了 Publish 就永远看不到
/// 3. **不检查有没有清单** → 落到没有 `packages.json` 的 release 上，
///    客户端报"该 release 里没有清单"，**整个更新链路瘫痪**（不只是插件没了）
/// 4. 私有仓 + 网络抖动时 latest 端点偶发 5xx
fn pick_release_with_manifest(list: &serde_json::Value) -> Option<String> {
    let arr = list.as_array()?;
    let mut best: Option<(Vec<i64>, &str)> = None;
    for r in arr {
        if r.get("draft").and_then(|x| x.as_bool()).unwrap_or(false) {
            continue;
        }
        if r.get("prerelease").and_then(|x| x.as_bool()).unwrap_or(false) {
            continue;
        }
        let tag = match r.get("tag_name").and_then(|x| x.as_str()) {
            Some(t) => t,
            None => continue,
        };
        let has_manifest = r
            .get("assets")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .any(|x| x.get("name").and_then(|n| n.as_str()) == Some("packages.json"))
            })
            .unwrap_or(false);
        if !has_manifest {
            continue;
        }
        let ver = tag_version(tag);
        if best.as_ref().map(|(b, _)| ver > *b).unwrap_or(true) {
            best = Some((ver, tag));
        }
    }
    best.map(|(_, t)| t.to_string())
}

/// 从 tag 里抽出数字段（`release-v0.9.35` → [0,9,35]），用于比大小。
fn tag_version(tag: &str) -> Vec<i64> {
    tag.split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<i64>().ok())
        .collect()
}

/// 这个目录是不是"下载缓存"（`.../updates`）。
///
/// <p>从 `clear_cache` 里抽出来单独成函数，是为了能**不构造 AppUpdater**
/// 就测它 —— AppUpdater 会拉起 Tauri 相关的链接期依赖，测试二进制在某些
/// 环境加载不起来（STATUS_ENTRYPOINT_NOT_FOUND）。纯函数没有这个问题。
fn is_updates_dir(p: &Path) -> bool {
    p.file_name().and_then(|s| s.to_str()) == Some("updates")
}

fn is_http(u: &str) -> bool {
    let l = u.trim().to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://")
}

/// 去掉 Windows 的 `\\?\` verbatim 前缀，让路径能被 `cmd /C start` 等外部程序接受。
///
/// <p><b>为什么必须去掉</b>（实测踩过）：`std::fs::canonicalize` 在 Windows 上
/// 一律返回 `\\?\C:\Users\...` 形式。这个前缀对 Win32 API 合法（绕过长路径限制），
/// 但 `cmd.exe`、`start` 命令、以及很多老程序**都不认**——传进去会得到
/// 「Windows 找不到文件 `\\?\C:\...`」的弹窗，文件名看着完全正确，
/// 非常容易误判成"文件被删了"。
///
/// <p>UNC 形式 `\\?\UNC\server\share` 要去成 `\\server\share`，
/// 不能简单砍前 4 个字符就完事。
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    p.to_path_buf()
}

/// 给 GitHub API 的请求补必要的头。
///
/// <p><b>为什么私有仓必须走 API 端点</b>（实测 2026-10-29，仓库 upchr/meow 为 private）：
///
/// | 地址 | 匿名 | 带 token |
/// |---|---|---|
/// | `github.com/.../releases/download/<tag>/<file>` | 404 | **404** |
/// | `api.github.com/repos/.../releases/assets/<id>` | 404 | **200** |
///
/// 也就是**标准下载链接对私有仓根本不工作**，即便带 token。
/// 所以私有仓只能在清单里写 API 资产地址（`…/releases/assets/<id>`）。
///
/// <p>★ `Accept: application/octet-stream` **只给资产端点加**。
/// 踩过：无差别地给所有 `api.github.com` 加这个头，会让
/// `/releases/tags/<tag>`、`/releases/latest` 这类**元数据端点**也去要
/// 二进制流，GitHub 直接回 4xx（curl 退出码 22），表现为
/// "拉清单失败：HTTP 4xx" 而实际是 Accept 头用错了。
/// 这个地址能不能收到访问令牌。
///
/// ★ **只发给 `api.github.com`**，别的地址一律不发。
///
/// <p>为什么必须限域（安全 + 功能双重原因）：
/// - 用户在设置页填的是 GitHub PAT，但它同时用于「更新源」和「插件源」。
///   一旦把源换成自建文件服务器（NAS / 内网 nginx），无条件的
///   `Authorization` 会把 PAT 明文送过去 —— 对方的 access log 里就有了。
/// - 很多简易静态服务器（Python http.server 的某些中间件、部分对象存储）
///   遇到未知的 `Authorization` 头会直接 401，表现为"自建源怎么都连不上"。
///
/// <p>私有仓的下载地址在 `toDownloadableUrl` 里已经转成
/// `api.github.com/repos/.../releases/assets/<id>`，所以公开仓/私有仓
/// 都只需要对 api.github.com 发令牌。
fn token_allowed_for(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.starts_with("https://api.github.com/") || u == "https://api.github.com"
}

fn apply_github_headers(cmd: &mut Command, url: &str, token: &str) {
    let u = url.trim();
    if !u.starts_with("https://api.github.com/") {
        return;
    }
    // 只对「资产内容」端点要二进制；元数据端点保持默认（JSON）
    if u.contains("/releases/assets/") {
        cmd.arg("-H").arg("Accept: application/octet-stream");
    }
    if !token.trim().is_empty() {
        // 顺带钉住 API 版本，避免将来默认值变化导致行为漂移
        cmd.arg("-H").arg("X-GitHub-Api-Version: 2022-11-28");
    }
}

/// 从清单给的 url / 文件名里取一个安全的本地文件名。
fn safe_file_name(hint: &str, url: &str) -> String {
    // 优先用 hint，没有就取 url 的最后一段
    let raw = if hint.trim().is_empty() {
        url.split('?').next().unwrap_or(url).rsplit('/').next().unwrap_or("update.bin")
    } else {
        hint.trim()
    };
    // 只保留 basename 的合法字符：清单来自网络，不能信任
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("update.bin");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let cleaned = cleaned.trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "update.bin".into()
    } else {
        cleaned
    }
}

fn sha256_file(p: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(p).map_err(|e| format!("打不开下载文件：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn find_curl() -> Result<PathBuf, String> {
    let sys = PathBuf::from(r"C:\Windows\System32\curl.exe");
    if sys.is_file() {
        return Ok(sys);
    }
    if let Ok(p) = std::env::var("PATH") {
        for dir in p.split(';') {
            let c = PathBuf::from(dir).join("curl.exe");
            if c.is_file() {
                return Ok(c);
            }
        }
    }
    if cfg!(not(target_os = "windows")) {
        return Ok(PathBuf::from("curl"));
    }
    Err("找不到 curl.exe（需要 Windows 10 1803+，或把 curl 放进 PATH）".into())
}

/// 解析 `curl --progress-bar` 的输出行，取百分比。
///
/// 形如 `####  45.2% 12.3M 5s`。只认第一个 `%` 前面的数字：
/// 后面的速度/剩余时间在小数点上会干扰，取最后一个 % 会拿到错的段。
fn parse_curl_percent(line: &str) -> Option<f64> {
    let idx = line.find('%')?;
    let before = &line[..idx];
    let start = before
        .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|i| i + 1)
        .unwrap_or(0);
    before[start..].parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 百分比解析取第一个百分号前的数字() {
        assert_eq!(parse_curl_percent("####  45.2% 12.3M 5s"), Some(45.2));
        assert_eq!(parse_curl_percent(" 100.0%"), Some(100.0));
        // 没有百分号的行（curl 的告警/错误）不能误判成进度
        assert_eq!(parse_curl_percent("curl: (22) The requested URL returned error: 404"), None);
    }

    #[test]
    fn 文件名净化挡住目录穿越() {
        // 清单来自网络：`../../evil.exe` 绝不能写到缓存目录之外
        assert_eq!(safe_file_name("../../evil.exe", ""), "evil.exe");
        assert_eq!(safe_file_name("", "https://x/y/app.exe?token=1"), "app.exe");
        // 中文/shell 元字符一律替换
        assert_eq!(safe_file_name("猫窝.apk", ""), "__.apk");
        assert_eq!(safe_file_name("a b&c.exe", ""), "a_b_c.exe");
        assert_eq!(safe_file_name("", ""), "update.bin");
    }

    #[test]
    fn 只接受_http_地址() {
        assert!(is_http("https://github.com/x"));
        assert!(is_http("HTTP://127.0.0.1:8099/x"));
        assert!(!is_http("file:///C:/x"));
        assert!(!is_http("javascript:alert(1)"));
        assert!(!is_http(""));
    }

    /// `\\?\` 前缀必须去掉才能交给 cmd/start。
    ///
    /// 踩过（2026-10-29 用户截图）：安装时弹出
    /// 「Windows 找不到文件 '\\?\C:\Users\...\meow-setup-0.9.32.exe'」。
    /// 文件明明在，是这个前缀让 cmd 认不出来。
    #[test]
    fn 去掉_windows_verbatim_前缀() {
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\C:\Users\x\a.exe")),
            PathBuf::from(r"C:\Users\x\a.exe")
        );
        // UNC 不能简单砍 4 个字符，否则变成 `UNC\server\share`
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\server\share\a.exe")),
            PathBuf::from(r"\\server\share\a.exe")
        );
        // 没有前缀的原样返回，不要自作聪明改写
        assert_eq!(
            strip_verbatim(Path::new(r"C:\Users\x\a.exe")),
            PathBuf::from(r"C:\Users\x\a.exe")
        );
    }

    /// Release 端点判定必须与 installer.rs / 前端三处同源。
    ///
    /// 踩过：Release 端点这层解析只写在前端，Rust 没做，
    /// 结果插件源"能连通但 0 个插件"（拿回来的是 release 描述 JSON）。
    #[test]
    fn 识别_github_release_端点() {
        assert!(is_github_release_endpoint(
            "https://api.github.com/repos/upchr/meow/releases/latest"
        ));
        assert!(is_github_release_endpoint(
            "https://api.github.com/repos/upchr/meow/releases/tags/release-v0.9.34"
        ));
        assert!(!is_github_release_endpoint(
            "https://api.github.com/repos/upchr/meow/releases/assets/1"
        ));
        assert!(!is_github_release_endpoint(
            "https://github.com/upchr/meow/releases/download/v1/a.exe"
        ));
        assert!(!is_github_release_endpoint("http://127.0.0.1:8099/packages.json"));
    }

    /// 列表挑选：必须跳过 draft / prerelease / 无清单的，按**版本号**取最大。
    ///
    /// 踩过（2026-10-29 加固）：直接用 `/releases/latest` 有三个致命问题：
    /// 按发布时间挑（补 hotfix 会降级）、draft 不参与、不检查有没有清单
    /// （落到没清单的 release 会让整个更新链路瘫痪）。所以自己挑。
    #[test]
    fn 从列表挑出含清单的最新版本() {
        let list = serde_json::json!([
            // 0.9.37 是 draft，不能选
            {"tag_name": "release-v0.9.37", "draft": true, "prerelease": false,
             "assets": [{"name": "packages.json", "id": 1}]},
            // 0.9.36 没清单，不能选（选它客户端会报"没有 packages.json"）
            {"tag_name": "release-v0.9.36", "draft": false, "prerelease": false,
             "assets": [{"name": "meow-setup-0.9.36.exe", "id": 2}]},
            // 0.9.35 有清单 → 应该选它
            {"tag_name": "release-v0.9.35", "draft": false, "prerelease": false,
             "assets": [{"name": "packages.json", "id": 3}]},
            // 0.9.34 有清单但版本更小，不选
            {"tag_name": "release-v0.9.34", "draft": false, "prerelease": false,
             "assets": [{"name": "packages.json", "id": 4}]}
        ]);
        assert_eq!(
            pick_release_with_manifest(&list).as_deref(),
            Some("release-v0.9.35")
        );
    }

    /// 补发旧版 hotfix 不能让结果"降级"——这正是 latest 的坑。
    #[test]
    fn 补发旧版不会让客户端降级() {
        let list = serde_json::json!([
            // 0.9.29 hotfix 发布更晚，但版本号更小
            {"tag_name": "release-v0.9.29", "draft": false, "prerelease": false,
             "assets": [{"name": "packages.json", "id": 1}]},
            {"tag_name": "release-v0.9.35", "draft": false, "prerelease": false,
             "assets": [{"name": "packages.json", "id": 2}]}
        ]);
        assert_eq!(
            pick_release_with_manifest(&list).as_deref(),
            Some("release-v0.9.35")
        );
    }

    #[test]
    fn 挑不出可用_release_时返回_none() {
        let none = serde_json::json!([
            {"tag_name": "release-v1.0.0", "draft": true, "assets": [{"name":"packages.json"}]},
            {"tag_name": "release-v0.9.0", "draft": false, "assets": [{"name":"a.exe"}]}
        ]);
        assert!(pick_release_with_manifest(&none).is_none());
        assert!(pick_release_with_manifest(&serde_json::json!([])).is_none());
        assert!(pick_release_with_manifest(&serde_json::json!("not array")).is_none());
    }

    #[test]
    fn tag_里的数字段用于比大小() {
        assert_eq!(tag_version("release-v0.9.35"), vec![0, 9, 35]);
        assert_eq!(tag_version("v1.0.0"), vec![1, 0, 0]);
        assert_eq!(tag_version("no-digits"), Vec::<i64>::new());
    }

    #[test]
    fn 拆出_repo_与_tail() {
        let (r, t) = repo_and_tail("https://api.github.com/repos/upchr/meow/releases/latest").unwrap();
        assert_eq!(r, "upchr/meow");
        assert_eq!(t, "latest");
        let (r2, t2) =
            repo_and_tail("https://api.github.com/repos/upchr/meow/releases/tags/release-v0.9.35/").unwrap();
        assert_eq!(r2, "upchr/meow");
        assert_eq!(t2, "tags/release-v0.9.35");
        assert!(repo_and_tail("https://example.com/x").is_none());
    }

    /// 清理缓存只允许动 `.../updates` 目录。
    ///
    /// 用户明确担心过："安装完不能删缓存，设置配置信息、海报什么的都有用呢"。
    /// 这个判据钉死"清理范围"：改错了（比如把 cache_dir 换成 app_data）
    /// 会直接拒绝执行而不是误删。
    ///
    /// 只测纯函数：AppUpdater 会带 Tauri 链接期依赖，测试二进制在某些环境
    /// 加载不起来（STATUS_ENTRYPOINT_NOT_FOUND），纯函数没这个问题。
    #[test]
    fn 只允许清理_updates_目录() {
        // 正常：下载缓存
        assert!(is_updates_dir(Path::new("C:/Users/x/AppData/Roaming/com.meow.player/updates")));
        assert!(is_updates_dir(Path::new("/data/user/0/com.meow.tv/cache/updates")));

        // 危险：这些是用户数据目录，必须拒绝
        assert!(!is_updates_dir(Path::new("C:/Users/x/AppData/Roaming/com.meow.player")));
        assert!(!is_updates_dir(Path::new("/data/data/com.meow.tv/files")));
        assert!(!is_updates_dir(Path::new("/data/data/com.meow.tv/cache")));
        assert!(!is_updates_dir(Path::new("C:/")));
        assert!(!is_updates_dir(Path::new("")));
    }
}
