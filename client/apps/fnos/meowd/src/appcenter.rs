//! 应用中心（fnOS）本机查询：补齐 `app/installed` 缺失的卷号字段。
//!
//! ## 为什么需要这个端点
//!
//! `/app-center/v1/app/installed`（HTTP，浏览器同源可调）返回的条目里**没有**
//! `installVolumeID` / `installType` / `volumeID` —— 三个版本实测都一样
//! （1.1.2 与 1.1.3 的字段集完全相同，20 个键里一个卷相关字段都没有），
//! 这是该接口的固定形状，不是暂时现象。而 `update/task` 的
//! `systemParameters.installVolumeID` / `dataVolumeId` 必须是真实卷号，
//! 拿 0 顶替等于让应用中心把第三方应用装到系统分区。
//!
//! ## 两条取数路径（顺序不能反）
//!
//! 1. unix socket RPC `GET /rpc/v1/app/detail?appName=…` —— 权威来源，
//!    带 `appDetail.installVolumeID/installType`。浏览器够不到 unix socket，只能由壳代查。
//! 2. **兜底**：启动环境变量 `TRIM_APPDEST_VOL`（如 `/vol1`）。
//!
//! 为什么必须有第 2 条：实测 fnOS 1.2.1000 的 socket 权限是
//! `srw-rw----+ root:root`，ACL 只给 `group:OfficialAppUsers:rw-`、`other::---`；
//! 而微应用以独立用户 `meow` 运行（`Uid: 993 / Gid: 987`，附加组只有 987），
//! 不在 `OfficialAppUsers`（gid 992，且组内无成员）里 —— 直接
//! `Permission denied (os error 13)`。这是系统侧的准入策略，不是我们的配置错误，
//! 跨版本稳定存在，所以不能只依赖 socket。
//!
//! 环境变量同样由应用中心在启动时注入（`TRIM_APPDEST` 就是应用安装目录），
//! 应用装在哪个卷，`TRIM_APPDEST_VOL` 就是哪个卷，与 socket 里的 `installVolumeID`
//! 实测一致（1.1.3：`/vol1` ↔ `1`）。
//!
//! ## 为什么手搓 HTTP/1.1 而不引 hyper client
//!
//! `reqwest` 不支持 unix socket，为它单独开 `hyper/client` feature 会明显撑大
//! 静态二进制。这条请求是固定形状（无 body、`Connection: close`），
//! 手写几十行比引入客户端栈更划算。

use std::time::Duration;

use axum::{
    extract::Query,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

/// 应用中心 RPC 的 unix socket（与 `appcenter-cli` 用的是同一个）。
const SOCK: &str = "/var/run/com.trim.app.center.sock";

/// socket 只给 3 秒：拿不到就走环境变量兜底，不能让设置页的检查卡住。
const RPC_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Deserialize)]
pub struct DetailQuery {
    #[serde(default)]
    app: Option<String>,
}

/// `GET /api/_shell/app/detail?app=meow` → 卷号与安装类型。
pub async fn detail(Query(q): Query<DetailQuery>) -> Response {
    let app = q
        .app
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "meow".to_string());
    // 只允许应用名字符，避免把路径参数注入到 RPC 请求行
    if !app
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return fail(StatusCode::BAD_REQUEST, "应用名不合法");
    }
    match resolve(&app).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            tracing::warn!(app = %app, error = %e, "app detail failed");
            fail(
                StatusCode::BAD_GATEWAY,
                "读不到应用中心详情（本机 RPC 与环境变量都不可用）",
            )
        }
    }
}

fn fail(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({ "ok": false, "error": msg }))).into_response()
}

/// 先 socket、后环境变量。任一路径拿到卷号即可。
async fn resolve(app: &str) -> anyhow::Result<serde_json::Value> {
    match tokio::time::timeout(RPC_TIMEOUT, rpc_detail(app)).await {
        Ok(Ok(v)) => return Ok(v),
        Ok(Err(e)) => tracing::warn!(error = %e, "app detail rpc failed, fallback to env"),
        Err(_) => tracing::warn!("app detail rpc timeout, fallback to env"),
    }
    env_detail(app)
}

/// 从启动环境变量推导：`TRIM_APPDEST_VOL=/vol1` → 卷 1。
///
/// 推不出卷号就报错，**不要猜**：猜错会把第三方应用装到系统分区。
fn env_detail(app: &str) -> anyhow::Result<serde_json::Value> {
    let vol = std::env::var("TRIM_APPDEST_VOL").unwrap_or_default();
    let dest = std::env::var("TRIM_APPDEST").unwrap_or_default();
    let id = volume_no(&vol).or_else(|| volume_no_of_path(&dest));
    let id = id.ok_or_else(|| {
        anyhow::anyhow!("TRIM_APPDEST_VOL/TRIM_APPDEST 都不是 /volN 形式（vol={vol} dest={dest}）")
    })?;
    Ok(json!({
        "ok": true,
        "appName": app,
        "version": std::env::var("TRIM_APPVER").unwrap_or_default(),
        "status": std::env::var("TRIM_APP_STATUS").unwrap_or_default(),
        "installVolumeID": id,
        "installType": "volume",
        "source": "env",
    }))
}

/// `/vol1` → `1`。只接受完整匹配，避免把 `/vol1/@appcenter` 当成别的意思。
fn volume_no(s: &str) -> Option<u64> {
    let n = s.strip_prefix("/vol")?;
    if n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    n.parse().ok().filter(|v| *v > 0)
}

/// `/vol1/@appcenter/meow` → `1`（`TRIM_APPDEST_VOL` missing 时的二级判据）
fn volume_no_of_path(p: &str) -> Option<u64> {
    let rest = p.strip_prefix("/vol")?;
    let (n, _tail) = rest.split_once('/')?;
    if n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    n.parse().ok().filter(|v| *v > 0)
}

#[cfg(unix)]
async fn rpc_detail(app: &str) -> anyhow::Result<serde_json::Value> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let path = format!("/rpc/v1/app/detail?appName={app}");
    let mut s = tokio::net::UnixStream::connect(SOCK).await?;
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes()).await?;
    let mut buf = Vec::with_capacity(4096);
    s.read_to_end(&mut buf).await?;

    // 头/体分隔；socket 上的响应是 `Connection: close`，读到 EOF 即为完整响应
    let pos = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| anyhow::anyhow!("响应没有 HTTP 头"))?;
    let head = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
    if !head.starts_with("http/1.1 200") && !head.starts_with("http/1.0 200") {
        anyhow::bail!("应用中心返回非 200");
    }
    let body = &buf[pos + 4..];
    let v: serde_json::Value = serde_json::from_slice(body)?;
    // 兼容 `{code:0,data:{…}}` 与直接对象两种形状
    let inner = v.get("data").cloned().unwrap_or(v);
    // 真机形状：卷号嵌在 `data.appDetail` 里，不在顶层（实测 1.2.1000）
    let detail = inner.get("appDetail").cloned().unwrap_or_else(|| inner.clone());
    Ok(json!({
        "ok": true,
        "appName": app,
        "version": inner.get("version").and_then(|x| x.as_str()).unwrap_or(""),
        "status": inner.get("status").and_then(|x| x.as_str()).unwrap_or(""),
        "installVolumeID": detail.get("installVolumeID").cloned().unwrap_or(json!(null)),
        "installType": detail.get("installType").and_then(|x| x.as_str()).unwrap_or(""),
        "source": "app-detail",
    }))
}

/// 非 fnOS（Windows 开发机构建）没有 unix socket，直接明确报不可用。
#[cfg(not(unix))]
async fn rpc_detail(_app: &str) -> anyhow::Result<serde_json::Value> {
    anyhow::bail!("非 fnOS 环境没有应用中心 socket")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_no_accepts_exact_vol_paths() {
        assert_eq!(volume_no("/vol1"), Some(1));
        assert_eq!(volume_no("/vol12"), Some(12));
        assert_eq!(volume_no("/vol1/"), None);
        assert_eq!(volume_no("/vol0"), None);
        assert_eq!(volume_no("/volX"), None);
        assert_eq!(volume_no(""), None);
    }

    #[test]
    fn volume_no_of_path_reads_install_dir() {
        assert_eq!(volume_no_of_path("/vol1/@appcenter/meow"), Some(1));
        assert_eq!(volume_no_of_path("/vol2/@appcenter/meow"), Some(2));
        assert_eq!(volume_no_of_path("/usr/local/meow"), None);
    }
}
