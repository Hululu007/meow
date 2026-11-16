use std::path::{Path, PathBuf};

pub const DEFAULT_SHELL_PORT: u16 = 30010;
pub const DEFAULT_API_PORT: u16 = 30011;

/// 运行期配置。端口/目录全部来自 fnOS 注入的 `TRIM_*` 与命令行参数，
/// **不硬编码 `/vol1`**（安装卷由 `TRIM_APPDEST` 决定）。
#[derive(Clone, Debug)]
pub struct Config {
    /// 壳监听地址（manifest service_port 对应的入口）
    pub bind: String,
    pub shell_port: u16,
    /// 后端只允许回环，避免默认无鉴权的写接口暴露到局域网
    pub api_bind: String,
    pub api_port: u16,
    /// `$TRIM_APPDEST`：应用载荷目录（升级时整目录被替换）
    pub app_dest: PathBuf,
    /// 网关（micro_app）用的 unix socket，默认 `$TRIM_APPDEST/meow.sock`。
    ///
    /// 放 appdest 而不是 pkg_var：飞牛网关按 `ui/config.gatewaySocket` 在 appdest 里找文件；
    /// socket 是运行态不是数据，升级整目录替换后由进程启动时重建即可。
    pub gateway_socket: PathBuf,
    /// `$TRIM_PKGVAR`：唯一可持久写的数据目录
    pub pkg_var: PathBuf,
    pub web_dir: PathBuf,
    pub seed_dir: PathBuf,
    pub data_dir: PathBuf,
    pub run_dir: PathBuf,
    pub log_dir: PathBuf,
}

impl Config {
    pub fn load() -> Self {
        let app_dest = env_path("TRIM_APPDEST").unwrap_or_else(|| PathBuf::from("."));
        let trim_pkg_var = env_path("TRIM_PKGVAR");
        let pkg_var = trim_pkg_var
            .clone()
            .unwrap_or_else(|| app_dest.join("var"));
        let gateway_socket = env_path("MEOW_GATEWAY_SOCKET")
            .unwrap_or_else(|| app_dest.join("meow.sock"));

        let mut cfg = Config {
            bind: std::env::var("MEOW_SHELL_BIND").unwrap_or_else(|_| "0.0.0.0".to_string()),
            shell_port: std::env::var("MEOW_SHELL_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .or_else(|| {
                    std::env::var("TRIM_SERVICE_PORT")
                        .ok()
                        .and_then(|v| v.parse().ok())
                })
                .unwrap_or(DEFAULT_SHELL_PORT),
            api_bind: std::env::var("MEOW_API_BIND").unwrap_or_else(|_| "127.0.0.1".to_string()),
            api_port: std::env::var("MEOW_API_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_API_PORT),
            gateway_socket,
            web_dir: app_dest.join("web"),
            seed_dir: app_dest.join("seed"),
            data_dir: pkg_var.join("data"),
            run_dir: pkg_var.join("run"),
            log_dir: pkg_var.join("logs"),
            app_dest,
            pkg_var,
        };

        parse_args(&mut cfg);

        // ★ 手工启动（没走 cmd/main，TRIM_PKGVAR 缺失）时 `--data` 指向的是真实数据目录，
        //   但 pkg_var 还停在 app_dest/var —— pid/log 会落到另一个目录，cmd/main 的
        //   status/stop 永远看不到这个进程。2026-11-16 OECT 实测：stop 报成功却杀不掉，
        //   端口一直被占，应用中心点启动就是"启动一下又停用"。
        //   所以没有 TRIM_PKGVAR 时让 pkg_var 跟随 `--data` 的父目录，与 cmd/main 对齐。
        //   **TRIM_PKGVAR 存在时绝不覆盖**：否则测试实例会抢真实实例的 pid 文件。
        if trim_pkg_var.is_none() {
            let derived = resolve_pkg_var(&cfg.data_dir, &cfg.app_dest);
            if derived != cfg.pkg_var {
                cfg.pkg_var = derived;
                cfg.run_dir = cfg.pkg_var.join("run");
                cfg.log_dir = cfg.pkg_var.join("logs");
            }
        }
        cfg
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.pkg_var)?;
        std::fs::create_dir_all(&self.data_dir)?;
        std::fs::create_dir_all(&self.run_dir)?;
        std::fs::create_dir_all(&self.log_dir)?;
        Ok(())
    }

    pub fn upstream_base(&self) -> String {
        // 后端永远在本机；api_bind 只影响后端自己的监听地址（0.0.0.0 时不能拿来做客户端地址）。
        format!("http://127.0.0.1:{}", self.api_port)
    }
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn parse_args(cfg: &mut Config) {
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        let (key, inline) = match arg.split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (arg.clone(), None),
        };
        let needs_value = matches!(
            key.as_str(),
            "--port"
                | "--api-port"
                | "--bind"
                | "--api-bind"
                | "--web"
                | "--seed"
                | "--data"
                | "--gateway-socket"
        );
        let value = inline.or_else(|| if needs_value { iter.next() } else { None });

        match key.as_str() {
            "--port" => {
                if let Some(v) = value.and_then(|v| v.parse().ok()) {
                    cfg.shell_port = v;
                }
            }
            "--api-port" => {
                if let Some(v) = value.and_then(|v| v.parse().ok()) {
                    cfg.api_port = v;
                }
            }
            "--bind" => {
                if let Some(v) = value {
                    cfg.bind = v;
                }
            }
            "--api-bind" => {
                if let Some(v) = value {
                    cfg.api_bind = v;
                }
            }
            "--web" => {
                if let Some(v) = value {
                    cfg.web_dir = PathBuf::from(v);
                }
            }
            "--seed" => {
                if let Some(v) = value {
                    cfg.seed_dir = PathBuf::from(v);
                }
            }
            "--data" => {
                if let Some(v) = value {
                    cfg.data_dir = PathBuf::from(v);
                }
            }
            "--gateway-socket" => {
                if let Some(v) = value {
                    cfg.gateway_socket = PathBuf::from(v);
                }
            }
            "-h" | "--help" => {
                println!(
                    "meowd --port=<壳端口> --api-port=<后端端口> --bind=<监听地址> --api-bind=<后端监听地址> --data=<数据目录> --web=<静态目录> --seed=<种子插件目录> --gateway-socket=<网关 socket 路径>"
                );
                std::process::exit(0);
            }
            _ => {}
        }
    }
}

#[allow(dead_code)]
pub fn dirname(p: &Path) -> PathBuf {
    p.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."))
}

/// 没有 `TRIM_PKGVAR` 时的数据根：优先 `--data` 的父目录。
///
/// 只接受绝对路径，且父目录不能是 `/`（`--data=/data` 这种会把 run/log 写到根目录下）。
/// 其余情况退回老规则 `app_dest/var`，行为与历史一致。
fn resolve_pkg_var(data_dir: &Path, app_dest: &Path) -> PathBuf {
    if data_dir.is_absolute() {
        if let Some(parent) = data_dir.parent() {
            if !parent.as_os_str().is_empty() && parent != Path::new("/") {
                return parent.to_path_buf();
            }
        }
    }
    app_dest.join("var")
}

#[cfg(test)]
mod tests {
    use super::resolve_pkg_var;
    use std::path::Path;

    #[test]
    fn pkg_var_follows_data_parent_when_trim_absent() {
        // 手工启动 `--data=<appdata>/meow/data` → pid/log 必须回到 <appdata>/meow
        // （与 cmd/main 的 $TRIM_PKGVAR 同路径），否则 stop 杀不掉（OECT 实测）。
        // 用 temp_dir 造绝对路径，Windows/Unix 都能跑。
        let root = std::env::temp_dir().join("meow-appdata");
        let p = resolve_pkg_var(&root.join("data"), Path::new("app"));
        assert_eq!(p, root);
    }

    #[test]
    fn pkg_var_falls_back_for_relative_or_rootdata() {
        let app = Path::new("app");
        // 相对路径不可信（cwd 未知）
        assert_eq!(resolve_pkg_var(Path::new("data"), app), app.join("var"));
        // 父目录是 / 时不要把 run/log 写到根分区（Unix 下才判定为根）
        assert_eq!(resolve_pkg_var(Path::new("/data"), app), app.join("var"));
    }

    #[test]
    fn default_data_dir_keeps_legacy_location() {
        // 不传 --data：data_dir = <pkg_var>/data，推导结果与老行为完全一致
        let app = std::env::temp_dir().join("meow-appdest");
        assert_eq!(
            resolve_pkg_var(&app.join("var").join("data"), &app),
            app.join("var")
        );
    }
}
