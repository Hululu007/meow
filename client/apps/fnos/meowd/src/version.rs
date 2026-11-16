//! 应用版本号（`/api/health` 等对外可见的 version）。
//!
//! ## 为什么不用 `env!("CARGO_PKG_VERSION")`
//!
//! 那个值来自 Cargo.toml 的 version，参与编译：每发一版都要重编整个 meowd crate
//! （实测两腿各 33-35s，占 fpk 单腿一半以上），而版本号本质上只是元数据。
//!
//! 现在改成**运行时**读 `<可执行文件目录>/VERSION`（由 build-fpk.sh 写成 manifest
//! 里的版本）。Cargo.toml 的 version 因此可以冻结，换版本不再触发重编。
//!
//! 代价：打包时必须把 VERSION 一起打进去。build-fpk.sh 的静态校验会断言
//! `app/bin/VERSION` 存在且等于 manifest version，缺了直接失败——不允许出现
//! "装的是 1.2.9、health 报别的版本"这种只有用户能看见的漂移。
//!
//! 本地 `cargo run`（没有 VERSION 文件）回落到编译期版本，便于开发。

use std::sync::OnceLock;

static VERSION: OnceLock<String> = OnceLock::new();

/// 当前应用版本。首次调用时解析并缓存。
pub fn get() -> &'static str {
    VERSION.get_or_init(|| {
        read_version_file().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
    })
}

fn read_version_file() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    read_version_from(exe.parent()?)
}

/// 抽出来便于单测：读 dir/VERSION，去掉首尾空白；空文件视为不存在。
fn read_version_from(dir: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join("VERSION")).ok()?;
    let v = raw.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::read_version_from;

    #[test]
    fn reads_version_file_and_trims_newline() {
        let dir = std::env::temp_dir().join(format!("meow-version-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("VERSION"), "1.2.9\n").unwrap();
        assert_eq!(read_version_from(&dir).as_deref(), Some("1.2.9"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_or_missing_file_falls_back() {
        let dir = std::env::temp_dir().join(format!("meow-version-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("VERSION"), "  \n").unwrap();
        assert_eq!(read_version_from(&dir), None);
        assert_eq!(read_version_from(&dir.join("nope")), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
