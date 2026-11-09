//! 随包插件层：清单解析、端口协商、健康检查、policy 注入、进程守护。
//!
//! 清单字段与 PC 侧**同一份契约**（`client/apps/desktop/src-tauri/src/plugins.rs`），
//! 不另造字段。差异只有两点，都写在设计文档 §3：
//!   1. `{pkgVar}` 占位（PC 没有，fpk 展开成 `$TRIM_PKGVAR`）；
//!   2. `autostart` 不参与判断——随包分发的插件都是"应当启动"的，fpk 没有开关 UI。
//!
//! ★ 插件崩溃绝不能牵动 Java：两者是各自独立的重启循环（见 supervisor.rs）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::process::Child;
use tokio::sync::watch;
use tracing::{info, warn};

use crate::{config::Config, deps::Deps};

/// 连续稳定这么久就认为这次启动是健康的，退避计数归零
const MIN_STABLE: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const MAX_RAPID_FAILURES: u32 = 5;
/// 依赖可能稍后才被装上（先装应用、再去应用中心补依赖），定期重探
const RUNTIME_RETRY: Duration = Duration::from_secs(15);

/// manifest.json 的结构。`rename_all = "camelCase"` 不能漏：
/// 清单是 `portFallback` / `healthTimeoutMs` 这类驼峰键，漏了会被静默忽略。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub capability: Option<String>,
    /// 工具型插件只提供文件（如运行库），不作为进程启动
    #[serde(default)]
    pub tool: bool,
    pub exec: String,
    #[serde(default)]
    pub exec_fallback: Vec<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// 0 = 不监听端口
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub port_fallback: Vec<u16>,
    #[serde(default)]
    pub health: String,
    #[serde(default)]
    pub health_expect: String,
    #[serde(default = "default_health_timeout")]
    pub health_timeout_ms: u64,
    #[serde(default = "default_health_interval")]
    pub health_interval_ms: u64,
    #[serde(default)]
    pub data_dir: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub inject: Option<Inject>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Inject {
    pub target: String,
    pub key: String,
    pub value: String,
}

fn default_health_timeout() -> u64 {
    45_000
}
fn default_health_interval() -> u64 {
    500
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub dir: PathBuf,
    pub manifest: Option<Manifest>,
    pub load_error: Option<String>,
}

/// 对外的状态快照（`/healthz` 的 `plugins` 段）。phase 取值：
/// `starting` / `ready` / `failed` / `stopped` / `missing-payload` / `missing-runtime`。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub name: String,
    pub phase: String,
    pub port: Option<u16>,
    pub version: String,
    pub capability: Option<String>,
    pub restarts: u32,
    pub error: Option<String>,
}

pub type Registry = Arc<RwLock<Vec<Status>>>;

pub fn new_registry() -> Registry {
    Arc::new(RwLock::new(Vec::new()))
}

pub fn json(reg: &Registry) -> Value {
    let list = reg.read().unwrap();
    json!(list.iter().collect::<Vec<_>>())
}

fn publish(
    reg: &Registry,
    id: &str,
    name: &str,
    version: &str,
    capability: Option<&str>,
    phase: &str,
    port: Option<u16>,
    restarts: u32,
    error: Option<String>,
) {
    let st = Status {
        id: id.to_string(),
        name: name.to_string(),
        phase: phase.to_string(),
        port,
        version: version.to_string(),
        capability: capability.map(|s| s.to_string()),
        restarts,
        error,
    };
    let mut list = reg.write().unwrap();
    match list.iter_mut().find(|s| s.id == st.id) {
        Some(slot) => *slot = st,
        None => list.push(st),
    }
    list.sort_by(|a, b| a.id.cmp(&b.id));
}

/// 扫描 `$TRIM_APPDEST/plugins/*/manifest.json`。
///
/// 目录不存在 = 包内没带插件（降级为空列表，不是错误）。
pub fn discover(root: &Path) -> Vec<Entry> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        Err(_) => return out,
    };
    for e in rd.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let file = dir.join("manifest.json");
        match std::fs::read_to_string(&file) {
            Ok(text) => match serde_json::from_str::<Manifest>(&text) {
                Ok(m) => out.push(Entry {
                    dir,
                    manifest: Some(m),
                    load_error: None,
                }),
                Err(err) => out.push(Entry {
                    dir,
                    manifest: None,
                    load_error: Some(format!("manifest.json 解析失败: {err}")),
                }),
            },
            Err(err) => out.push(Entry {
                dir,
                manifest: None,
                load_error: Some(format!("缺少 manifest.json: {err}")),
            }),
        }
    }
    out.sort_by(|a, b| a.dir.cmp(&b.dir));
    out
}

/// 单个插件的守护循环。随 `shutdown` 变 true 退出（由 supervisor 先于 Java 广播）。
pub async fn run_one(
    cfg: Config,
    deps: Deps,
    reg: Registry,
    client: reqwest::Client,
    entry: Entry,
    mut shutdown: watch::Receiver<bool>,
) {
    let fallback_id = entry
        .dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    if let Some(err) = entry.load_error.clone() {
        publish(&reg, &fallback_id, &fallback_id, "", None, "failed", None, 0, Some(err));
        idle(shutdown).await;
        return;
    }
    let m = entry.manifest.clone().expect("manifest present");
    let dir = entry.dir.clone();

    if m.tool {
        // 工具型插件只提供文件，不启动
        publish(&reg, &m.id, &m.name, &m.version, m.capability.as_deref(), "stopped", None, 0, None);
        idle(shutdown).await;
        return;
    }

    #[cfg(unix)]
    kill_orphans(&dir);

    let mut restarts = 0u32;
    let mut backoff = Duration::from_secs(1);
    let mut rapid = 0u32;
    // 已经写进 policy.json 的地址；进程退出时按"等于自己"规则清理
    let mut injected: Option<(PathBuf, String, String)> = None;

    loop {
        if *shutdown.borrow() {
            break;
        }

        let exe = match resolve_exec(&m, &dir, &deps) {
            Ok(p) => p,
            Err(err) => {
                publish(
                    &reg,
                    &m.id,
                    &m.name,
                    &m.version,
                    m.capability.as_deref(),
                    "missing-runtime",
                    None,
                    restarts,
                    Some(err),
                );
                // 依赖目录可能稍后才出现，定期重探而不是永久放弃
                deps.rescan(&cfg.app_dest);
                if wait_or_shutdown(&mut shutdown, RUNTIME_RETRY).await {
                    break;
                }
                continue;
            }
        };

        let port = if m.port == 0 {
            None
        } else {
            match pick_port(m.port, &m.port_fallback) {
                Some(p) => Some(p),
                None => {
                    let msg = format!("端口 {} 及备用端口全部被占用", m.port);
                    publish(
                        &reg,
                        &m.id,
                        &m.name,
                        &m.version,
                        m.capability.as_deref(),
                        "failed",
                        None,
                        restarts,
                        Some(msg),
                    );
                    if wait_or_shutdown(&mut shutdown, backoff).await {
                        break;
                    }
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    continue;
                }
            }
        };

        let data_dir = resolve_data_dir(&m, &cfg, port);
        let _ = std::fs::create_dir_all(&data_dir);

        let mut child = match spawn(&cfg, &m, &dir, &exe, port, &data_dir) {
            Ok(c) => c,
            Err(err) => {
                let msg = format!("启动失败: {err}");
                publish(
                    &reg,
                    &m.id,
                    &m.name,
                    &m.version,
                    m.capability.as_deref(),
                    "failed",
                    port,
                    restarts,
                    Some(msg),
                );
                if wait_or_shutdown(&mut shutdown, backoff).await {
                    break;
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
        };
        let pid = child.id().unwrap_or(0);
        info!(plugin = %m.id, pid, exec = %exe.display(), port = port.unwrap_or(0), "plugin started");
        publish(
            &reg,
            &m.id,
            &m.name,
            &m.version,
            m.capability.as_deref(),
            "starting",
            port,
            restarts,
            None,
        );

        let started = Instant::now();
        let ready = wait_ready(&mut child, &m, port, &client, &mut shutdown).await;

        match ready {
            Ready::Shutdown => {
                stop_child(&mut child, &m.id).await;
                clear_injected(&mut injected);
                publish(
                    &reg,
                    &m.id,
                    &m.name,
                    &m.version,
                    m.capability.as_deref(),
                    "stopped",
                    port,
                    restarts,
                    None,
                );
                break;
            }
            Ready::Ready => {
                publish(
                    &reg,
                    &m.id,
                    &m.name,
                    &m.version,
                    m.capability.as_deref(),
                    "ready",
                    port,
                    restarts,
                    None,
                );
                let inject_err = match &m.inject {
                    Some(inj) => {
                        let target = expand(&inj.target, port, &data_dir, &cfg);
                        let value = expand(&inj.value, port, &data_dir, &cfg);
                        let path = PathBuf::from(&target);
                        // "自己上一轮写的值"：端口从 9321 协商到 9322 时要跟着改，
                        // 但用户手填的值永远不动
                        let own = injected.as_ref().map(|(_, _, v)| v.clone());
                        match inject_value(&path, &inj.key, &value, own.as_deref()) {
                            Ok(true) => {
                                injected = Some((path, inj.key.clone(), value));
                                None
                            }
                            Ok(false) => {
                                // 值是用户填的：不接管，退出时也不要清理它
                                injected = None;
                                None
                            }
                            Err(err) => Some(format!("已启动，但写配置失败: {err}")),
                        }
                    }
                    None => None,
                };
                if let Some(err) = inject_err {
                    let mut list = reg.write().unwrap();
                    if let Some(slot) = list.iter_mut().find(|s| s.id == m.id) {
                        slot.error = Some(err);
                    }
                }

                // 就绪后只监视线程存活；插件崩溃不重启 Java，只重启自己
                let exit = tokio::select! {
                    _ = shutdown.changed() => None,
                    st = child.wait() => Some(st),
                };
                match exit {
                    None => {
                        stop_child(&mut child, &m.id).await;
                        clear_injected(&mut injected);
                        publish(
                            &reg,
                            &m.id,
                            &m.name,
                            &m.version,
                            m.capability.as_deref(),
                            "stopped",
                            port,
                            restarts,
                            None,
                        );
                        break;
                    }
                    Some(st) => {
                        clear_injected(&mut injected);
                        publish(
                            &reg,
                            &m.id,
                            &m.name,
                            &m.version,
                            m.capability.as_deref(),
                            "failed",
                            port,
                            restarts,
                            Some(format!("进程退出: {}", exit_text(st))),
                        );
                    }
                }
            }
            Ready::Timeout => {
                stop_child(&mut child, &m.id).await;
                clear_injected(&mut injected);
                publish(
                    &reg,
                    &m.id,
                    &m.name,
                    &m.version,
                    m.capability.as_deref(),
                    "failed",
                    port,
                    restarts,
                    Some(format!("启动超时：{} 内未通过健康检查", m.health_timeout_ms)),
                );
            }
            Ready::Exited(text) => {
                clear_injected(&mut injected);
                publish(
                    &reg,
                    &m.id,
                    &m.name,
                    &m.version,
                    m.capability.as_deref(),
                    "failed",
                    port,
                    restarts,
                    Some(format!("进程退出: {text}")),
                );
            }
        }

        restarts += 1;
        if started.elapsed() >= MIN_STABLE {
            rapid = 0;
            backoff = Duration::from_secs(1);
        }
        rapid += 1;
        let wait = if rapid > MAX_RAPID_FAILURES {
            warn!(plugin = %m.id, "failed {rapid} times in a row; cooling down");
            rapid = 0;
            MAX_BACKOFF
        } else {
            let cur = backoff;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            cur
        };
        if wait_or_shutdown(&mut shutdown, wait).await {
            break;
        }
    }

    info!(plugin = %m.id, "plugin supervisor exited");
}

async fn idle(mut shutdown: watch::Receiver<bool>) {
    loop {
        if *shutdown.borrow() {
            return;
        }
        if shutdown.changed().await.is_err() {
            return;
        }
        if *shutdown.borrow() {
            return;
        }
    }
}

/// 等一段时间；返回 true 表示期间收到了停止信号。
async fn wait_or_shutdown(shutdown: &mut watch::Receiver<bool>, dur: Duration) -> bool {
    if *shutdown.borrow() {
        return true;
    }
    tokio::select! {
        _ = shutdown.changed() => true,
        _ = tokio::time::sleep(dur) => false,
    }
}

enum Ready {
    Ready,
    Timeout,
    Exited(String),
    Shutdown,
}

async fn wait_ready(
    child: &mut Child,
    m: &Manifest,
    port: Option<u16>,
    client: &reqwest::Client,
    shutdown: &mut watch::Receiver<bool>,
) -> Ready {
    if m.health.is_empty() || port.is_none() {
        // 没有健康端点：给一个固定的暖机时间（对齐 PC 侧 1500ms）
        tokio::select! {
            _ = shutdown.changed() => Ready::Shutdown,
            st = child.wait() => Ready::Exited(exit_text(st)),
            _ = tokio::time::sleep(Duration::from_millis(1500)) => Ready::Ready,
        }
    } else {
        let port = port.unwrap();
        let deadline = Instant::now() + Duration::from_millis(m.health_timeout_ms);
        let interval = Duration::from_millis(m.health_interval_ms.max(100));
        loop {
            tokio::select! {
                _ = shutdown.changed() => return Ready::Shutdown,
                st = child.wait() => return Ready::Exited(exit_text(st)),
                body = probe(client, port, &m.health) => {
                    if let Some(body) = body {
                        if m.health_expect.is_empty() || body.contains(&m.health_expect) {
                            return Ready::Ready;
                        }
                    }
                }
            }
            if Instant::now() >= deadline {
                return Ready::Timeout;
            }
            tokio::select! {
                _ = shutdown.changed() => return Ready::Shutdown,
                st = child.wait() => return Ready::Exited(exit_text(st)),
                _ = tokio::time::sleep(interval) => {}
            }
        }
    }
}

async fn probe(client: &reqwest::Client, port: u16, path: &str) -> Option<String> {
    let p = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let url = format!("http://127.0.0.1:{port}{p}");
    let resp = client
        .get(&url)
        .timeout(Duration::from_millis(1200))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.text().await.ok()
}

fn exit_text(st: std::io::Result<std::process::ExitStatus>) -> String {
    match st {
        Ok(s) => format!("code={}", s.code().unwrap_or(-1)),
        Err(e) => format!("wait 失败: {e}"),
    }
}

fn resolve_data_dir(m: &Manifest, cfg: &Config, port: Option<u16>) -> PathBuf {
    let default = cfg.pkg_var.join("plugins").join(&m.id);
    match &m.data_dir {
        Some(v) if !v.trim().is_empty() => PathBuf::from(expand(v, port, &default, cfg)),
        _ => default,
    }
}

/// 占位符展开。fpk 只有 `{pkgVar}` 是 PC 没有的（扩展位见设计 §7）。
fn expand(s: &str, port: Option<u16>, data_dir: &Path, cfg: &Config) -> String {
    let mut out = s
        .replace("{pkgVar}", &cfg.pkg_var.to_string_lossy())
        .replace("{appData}", &cfg.pkg_var.to_string_lossy())
        .replace("{dataDir}", &data_dir.to_string_lossy());
    if let Some(p) = port {
        out = out.replace("{port}", &p.to_string());
    }
    out
}

fn pick_port(primary: u16, fallback: &[u16]) -> Option<u16> {
    let mut cands = vec![primary];
    cands.extend_from_slice(fallback);
    for p in cands {
        if std::net::TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return Some(p);
        }
    }
    None
}

/// 解析可执行文件。顺序与 PC 侧一致：插件目录（含 fallback）→ 内置运行时 → PATH。
///
/// fpk 的 node 来自应用中心依赖（`dirname $TRIM_APPDEST/nodejs_v22/bin/node`），
/// 不在 PATH 里，所以"内置运行时"这一档必须排在 PATH 之前。
fn resolve_exec(m: &Manifest, dir: &Path, deps: &Deps) -> Result<PathBuf, String> {
    if let Some(p) = look_local(dir, &m.exec) {
        return Ok(p);
    }
    for f in &m.exec_fallback {
        if let Some(p) = look_local(dir, f) {
            return Ok(p);
        }
    }
    for cand in std::iter::once(&m.exec).chain(m.exec_fallback.iter()) {
        if cand.contains('/') || cand.contains('\\') {
            continue;
        }
        match cand.as_str() {
            "node" => {
                if let Some(p) = deps.node_path() {
                    return Ok(p);
                }
            }
            "java" => {
                if let Some(p) = deps.java_path() {
                    return Ok(p);
                }
            }
            _ => {}
        }
        if let Some(p) = which(cand) {
            return Ok(p);
        }
    }
    Err(format!("missing-runtime: {}", m.exec))
}

/// 只在插件目录（及其相对路径）里找，**绝不查 PATH**。
fn look_local(dir: &Path, rel: &str) -> Option<PathBuf> {
    let raw = dir.join(rel);
    if raw.is_file() {
        return Some(raw);
    }
    if Path::new(rel).extension().is_none() {
        for ext in ["exe", "bat", "cmd"] {
            let with_ext = raw.with_extension(ext);
            if with_ext.is_file() {
                return Some(with_ext);
            }
        }
    }
    None
}

fn which(cmd: &str) -> Option<PathBuf> {
    if cmd.contains('/') || cmd.contains('\\') {
        return None;
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in ["", ".exe", ".bat", ".cmd"] {
            let cand = dir.join(format!("{cmd}{ext}"));
            if is_exec(&cand) {
                return Some(cand);
            }
        }
    }
    None
}

fn is_exec(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn spawn(
    cfg: &Config,
    m: &Manifest,
    dir: &Path,
    exe: &Path,
    port: Option<u16>,
    data_dir: &Path,
) -> anyhow::Result<Child> {
    std::fs::create_dir_all(&cfg.log_dir)?;
    let log_path = cfg.log_dir.join(format!("plugin-{}.log", m.id));
    let out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let err = out.try_clone()?;

    let args: Vec<String> = m
        .args
        .iter()
        .map(|a| expand(a, port, data_dir, cfg))
        .collect();

    let work_dir = match &m.cwd {
        Some(c) if c != "." => dir.join(c),
        _ => dir.to_path_buf(),
    };

    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(&args)
        .current_dir(&work_dir)
        .env("MEOW_INSTANCE_ID", format!("meow@{}", cfg.pkg_var.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    for (k, v) in &m.env {
        cmd.env(k, expand(v, port, data_dir, cfg));
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 独立进程组：停止时按组收，node 拉起的孙进程不会变孤儿
        cmd.as_std_mut().process_group(0);
    }

    Ok(cmd.spawn()?)
}

async fn stop_child(child: &mut Child, id: &str) {
    let pid = child.id().unwrap_or(0);
    #[cfg(unix)]
    {
        if pid > 0 {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        let _ = child.start_kill();
    }

    match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
        Ok(_) => info!(plugin = %id, "plugin stopped"),
        Err(_) => {
            #[cfg(unix)]
            {
                if pid > 0 {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                }
            }
            #[cfg(not(unix))]
            {
                let _ = child.kill().await;
            }
            let _ = child.wait().await;
            warn!(plugin = %id, "plugin killed after 10s timeout");
        }
    }
}

/// 启动前清掉占着插件目录的孤儿（上一实例遗留）。
///
/// 不清的后果很隐蔽：孤儿占着 9321，端口协商顺延到 9322，新实例和旧进程各跑一个弹幕服务。
/// 范围**只能是自己这个插件目录**——`Path::starts_with` 是按路径分量比较，
/// 不会把 `danmu-api2` 误判成 `danmu-api`（PC 侧裸 `starts_with` 踩过）。
#[cfg(unix)]
fn kill_orphans(dir: &Path) {
    let target = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let Ok(rd) = std::fs::read_dir("/proc") else {
        return;
    };
    for e in rd.flatten() {
        let Ok(pid) = e.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        if pid <= 0 || pid == std::process::id() as i32 {
            continue;
        }
        let Ok(cwd) = std::fs::read_link(e.path().join("cwd")) else {
            continue;
        };
        if cwd.starts_with(&target) {
            warn!(pid, cwd = %cwd.display(), "killing orphan plugin process");
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }
}

#[cfg(not(unix))]
#[cfg_attr(not(unix), allow(dead_code))]
fn kill_orphans(_dir: &Path) {}

/// 把 key=value 写进 policy.json（读-改-写，保留其它字段）。返回是否真的写了。
///
/// 语义与 PC 侧 `inject_value` 一致，另外补上"自己的值"这一档：
/// - 已有非空值、不等于新值、也不是自己上一轮写的 → 尊重用户（可能是远端地址），**不写**；
/// - 已有值等于自己上一轮写的 → 允许更新（端口从 9321 协商到 9322 时地址要跟着变）；
/// - 空值 → 写。
fn inject_value(
    target: &Path,
    key: &str,
    value: &str,
    own: Option<&str>,
) -> Result<bool, String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut obj: Map<String, Value> = if target.exists() {
        match std::fs::read_to_string(target) {
            Ok(t) if !t.trim().is_empty() => serde_json::from_str(&t).unwrap_or_default(),
            _ => Map::new(),
        }
    } else {
        Map::new()
    };

    if let Some(existing) = obj.get(key).and_then(|v| v.as_str()) {
        let existing = existing.trim();
        if !existing.is_empty() && existing != value && Some(existing) != own {
            return Ok(false);
        }
    }

    obj.insert(key.to_string(), Value::String(value.to_string()));
    let out = serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?;
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, target).map_err(|e| e.to_string())?;
    Ok(true)
}

/// 退出时清理自己写进去的值：只有当前值**等于自己**才删。
fn clear_injected(slot: &mut Option<(PathBuf, String, String)>) {
    let Some((target, key, value)) = slot.take() else {
        return;
    };
    let mut obj: Map<String, Value> = match std::fs::read_to_string(&target) {
        Ok(t) if !t.trim().is_empty() => match serde_json::from_str(&t) {
            Ok(v) => v,
            Err(_) => return,
        },
        _ => return,
    };
    let is_ours = obj
        .get(&key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim() == value)
        .unwrap_or(false);
    if !is_ours {
        return;
    }
    obj.remove(&key);
    if let Ok(text) = serde_json::to_string_pretty(&obj) {
        let tmp = target.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &target);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn manifest_uses_pc_contract_field_names() {
        let text = r#"{
          "id": "danmu-api", "name": "弹幕聚合服务", "capability": "danmaku",
          "exec": "node", "execFallback": ["../node/node"], "args": ["danmu_api/server.js"],
          "cwd": ".", "port": 9321, "portFallback": [9322, 9323],
          "health": "/api/v2/fongmi/danmaku?name=test",
          "healthTimeoutMs": 90000, "healthIntervalMs": 800,
          "env": {"DANMU_API_PORT": "{port}"},
          "inject": {"target": "{appData}/data/policy.json", "key": "danmakuApi", "value": "http://127.0.0.1:{port}"}
        }"#;
        let m: Manifest = serde_json::from_str(text).unwrap();
        assert_eq!(m.id, "danmu-api");
        assert_eq!(m.port, 9321);
        assert_eq!(m.port_fallback, vec![9322, 9323]);
        assert_eq!(m.health_timeout_ms, 90000);
        assert_eq!(m.health_interval_ms, 800);
        assert_eq!(m.exec_fallback, vec!["../node/node"]);
        assert_eq!(m.inject.as_ref().unwrap().key, "danmakuApi");
    }

    #[test]
    fn inject_respects_user_value_and_updates_own_value() {
        let dir = test_dir("inject");
        let target = dir.join("policy.json");
        let _ = std::fs::remove_file(&target);

        // 用户手填远端地址：不覆盖（也没有"自己的旧值"）
        std::fs::write(&target, r#"{"danmakuApi":"http://192.168.1.9:9321"}"#).unwrap();
        assert!(!inject_value(&target, "danmakuApi", "http://127.0.0.1:9321", None).unwrap());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(v["danmakuApi"], "http://192.168.1.9:9321");

        // 空值可以写；等于自己上一轮写的值可以更新（端口变化）
        std::fs::write(&target, r#"{"danmakuApi":""}"#).unwrap();
        assert!(inject_value(&target, "danmakuApi", "http://127.0.0.1:9321", None).unwrap());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(v["danmakuApi"], "http://127.0.0.1:9321");
        assert!(inject_value(
            &target,
            "danmakuApi",
            "http://127.0.0.1:9322",
            Some("http://127.0.0.1:9321")
        )
        .unwrap());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(v["danmakuApi"], "http://127.0.0.1:9322");

        // 退出清理：等于自己才删，别的字段保留
        std::fs::write(&target, r#"{"danmakuApi":"http://127.0.0.1:9322","cacheTtl":9}"#).unwrap();
        let mut slot = Some((target.clone(), "danmakuApi".to_string(), "http://127.0.0.1:9322".to_string()));
        clear_injected(&mut slot);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert!(v.get("danmakuApi").is_none());
        assert_eq!(v["cacheTtl"], 9);

        // 用户的值不会被清理
        std::fs::write(&target, r#"{"danmakuApi":"http://192.168.1.9:9321"}"#).unwrap();
        let mut slot = Some((target.clone(), "danmakuApi".to_string(), "http://127.0.0.1:9321".to_string()));
        clear_injected(&mut slot);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(v["danmakuApi"], "http://192.168.1.9:9321");
    }

    #[test]
    fn placeholders_expand_to_pkgvar() {
        let cfg = Config::load();
        let data = PathBuf::from("/tmp/meow-test/plugins/danmu-api");
        let out = expand("{appData}/data/policy.json", Some(9324), &data, &cfg);
        assert_eq!(
            out,
            format!("{}/data/policy.json", cfg.pkg_var.display())
        );
        let out = expand("http://127.0.0.1:{port}", Some(9324), &data, &cfg);
        assert_eq!(out, "http://127.0.0.1:9324");
    }
}
