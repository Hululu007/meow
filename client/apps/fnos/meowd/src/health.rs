use std::time::Duration;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use tracing::warn;

use crate::{http::AppState, plugins};

/// `plugins` 段是插件存活状态的唯一判据：`/api/health` 的 `danmakuApi: configured`
/// 只表示"配置里有地址"，不代表弹幕服务活着（见设计文档 §6）。
pub async fn healthz(State(st): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "role": "web",
        "version": env!("CARGO_PKG_VERSION"),
        "deps": st.deps.json(),
        "plugins": plugins::json(&st.plugins),
    }))
}

pub async fn shell_info(State(st): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "app": "meow",
        "role": "shell",
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "port": st.cfg.shell_port,
        "apiPort": st.cfg.api_port,
        // fpk 自更新要按架构挑包（索引里 x86 / arm 是两套）。浏览器在别的设备上，
        // 不能靠 navigator 猜 NAS 的架构。
        "arch": std::env::consts::ARCH,
        "deps": st.deps.json(),
    }))
}

/// 后端不可达时也返回 200 + ok:false：TV 发现只看 `ok`/`version` 两个键是否存在，
/// 500 会让"应用活着但后端没起来"这种状态无法在 UI 上表达。
pub async fn api_health(State(st): State<AppState>) -> Response {
    let mut value = match backend_health(&st).await {
        Ok(v) => v,
        Err(e) => {
            warn!("backend health probe failed: {e}");
            json!({
                "ok": false,
                "version": env!("CARGO_PKG_VERSION"),
                "sites": 0,
                "ext": 0,
                "error": format!("backend unreachable: {e}"),
            })
        }
    };

    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "shell".to_string(),
            json!({
                "version": env!("CARGO_PKG_VERSION"),
                "pid": std::process::id(),
                "port": st.cfg.shell_port,
            }),
        );
        obj.insert("deps".to_string(), st.deps.json());
    }
    (StatusCode::OK, Json(value)).into_response()
}

async fn backend_health(st: &AppState) -> anyhow::Result<Value> {
    let url = format!("{}/api/health", st.cfg.upstream_base());
    let resp = st
        .client
        .get(&url)
        .timeout(Duration::from_secs(3))
        .send()
        .await?
        .error_for_status()?;
    let body = resp.text().await?;
    Ok(serde_json::from_str(&body)?)
}
