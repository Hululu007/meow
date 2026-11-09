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
        let pkg_var = env_path("TRIM_PKGVAR").unwrap_or_else(|| app_dest.join("var"));
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
