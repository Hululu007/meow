use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde_json::{json, Value};

/// 飞牛官方运行时依赖（developer.fnnas.com/docs/core-concepts/runtime）：
/// java-21-openjdk / nodejs_v22 / python312，bin 目录统一在 `<dep>/target/bin`。
/// 顺序：MEOW_* 环境变量 → 同卷依赖目录 → /var/apps 包装目录 → PATH。
const JAVA_DEPS: &[&str] = &["java-21-openjdk", "java-17-openjdk"];
const NODE_DEPS: &[&str] = &["nodejs_v22", "nodejs_v24"];
/// python312 官方示例的 bin 是 `python3`；自编译/别家包可能只给 `python`。
const PYTHON_DEPS: &[&str] = &["python312", "python311", "python310", "python3"];
const PYTHON_BINS: &[&str] = &["python3", "python"];

#[derive(Clone, Debug, Default)]
pub struct BinInfo {
    pub ok: bool,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub source: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Deps {
    java: Arc<RwLock<BinInfo>>,
    node: Arc<RwLock<BinInfo>>,
    python: Arc<RwLock<BinInfo>>,
}

impl Deps {
    pub fn probe(app_dest: &Path) -> Self {
        let deps = Deps {
            java: Arc::new(RwLock::new(BinInfo::default())),
            node: Arc::new(RwLock::new(BinInfo::default())),
            python: Arc::new(RwLock::new(BinInfo::default())),
        };
        deps.rescan(app_dest);
        deps
    }

    /// 依赖可能在我们启动之后才被装上（用户先装应用、再去应用中心补依赖），
    /// 所以探测要可重复调用。
    pub fn rescan(&self, app_dest: &Path) {
        let java = resolve(&["java"], "MEOW_JAVA", app_dest, JAVA_DEPS, &["--version"]);
        let node = resolve(&["node"], "MEOW_NODE", app_dest, NODE_DEPS, &["-v"]);
        let python = resolve(PYTHON_BINS, "MEOW_PYTHON", app_dest, PYTHON_DEPS, &["--version"]);
        *self.java.write().unwrap() = java;
        *self.node.write().unwrap() = node;
        *self.python.write().unwrap() = python;
    }

    pub fn java_path(&self) -> Option<PathBuf> {
        let j = self.java.read().unwrap();
        if j.ok {
            j.path.clone()
        } else {
            None
        }
    }

    /// 随包弹幕插件的运行时。`manifest` 只写裸名 `node`，实际解析到依赖目录
    /// （`dirname $TRIM_APPDEST/nodejs_v22/bin/node`），不依赖 PATH。
    pub fn node_path(&self) -> Option<PathBuf> {
        let n = self.node.read().unwrap();
        if n.ok {
            n.path.clone()
        } else {
            None
        }
    }

    /// `.py` 源的运行时。缺它时 pyrt 插件起不来，但 jar/CMS 源不受影响。
    pub fn python_path(&self) -> Option<PathBuf> {
        let p = self.python.read().unwrap();
        if p.ok {
            p.path.clone()
        } else {
            None
        }
    }

    pub fn json(&self) -> Value {
        json!({
            "java": bin_json(&self.java.read().unwrap()),
            "node": bin_json(&self.node.read().unwrap()),
            "python": bin_json(&self.python.read().unwrap()),
        })
    }
}

fn bin_json(info: &BinInfo) -> Value {
    json!({
        "ok": info.ok,
        "path": info.path.as_ref().map(|p| p.display().to_string()),
        "version": info.version,
        "source": info.source,
    })
}

/// `bins` 是多候选可执行名（python 在部分包里只有 `python` 没有 `python3`），
/// 按给定顺序试；第一个能执行的就胜出，与依赖目录的优先级无关。
fn resolve(
    bins: &[&str],
    env_key: &str,
    app_dest: &Path,
    deps: &[&str],
    version_args: &[&str],
) -> BinInfo {
    let mut candidates: Vec<(PathBuf, String)> = Vec::new();

    if let Ok(v) = std::env::var(env_key) {
        let v = v.trim().to_string();
        if !v.is_empty() {
            candidates.push((PathBuf::from(v), format!("env:{env_key}")));
        }
    }

    for bin in bins {
        // dirname($TRIM_APPDEST) 就是 @appcenter 所在目录，依赖与应用同卷
        if let Some(center) = app_dest.parent() {
            for dep in deps {
                candidates.push((center.join(dep).join("bin").join(bin), format!("dep:{dep}")));
            }
        }
        // /var/apps/<dep>/target 是指向 @appcenter/<dep> 的软链，等价但更稳定
        for dep in deps {
            candidates.push((
                PathBuf::from("/var/apps").join(dep).join("target").join("bin").join(bin),
                format!("varapp:{dep}"),
            ));
        }
        /*
         * 系统路径直接拼：飞牛用应用中心拉起服务时 **PATH 很精简**，
         * 实测 `/usr/bin/python3` 存在但 `path_lookup` 摸不到（deps.python 报 ok:false）。
         * 手工 ssh 跑同一个二进制时又能探测到 —— 差别只在 PATH，
         * 所以不能只靠末尾的 PATH 兜底。
         */
        for dir in ["/usr/bin", "/usr/local/bin", "/bin"] {
            candidates.push((
                PathBuf::from(dir).join(bin),
                format!("path:{dir}"),
            ));
        }
    }

    for (path, source) in candidates {
        if is_executable(&path) {
            return BinInfo {
                ok: true,
                version: detect_version(&path, version_args),
                path: Some(path),
                source: Some(source),
            };
        }
    }

    // 最后看 PATH：fnOS 实测不会给应用脚本注入依赖 bin，这条只是兜底
    for bin in bins {
        if let Some(path) = path_lookup(bin) {
            return BinInfo {
                ok: true,
                version: detect_version(&path, version_args),
                path: Some(path),
                source: Some("path".to_string()),
            };
        }
    }

    BinInfo::default()
}

fn is_executable(path: &Path) -> bool {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
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

fn path_lookup(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn detect_version(path: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(path).args(args).output().ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.trim().is_empty() {
        // java -version 走 stderr
        text = String::from_utf8_lossy(&out.stderr).to_string();
    }
    for token in text.split_whitespace() {
        let t = token.trim_start_matches('v');
        if t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) && t.contains('.') {
            let clean: String = t
                .trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.')
                .to_string();
            if !clean.is_empty() {
                return Some(clean);
            }
        }
    }
    None
}
