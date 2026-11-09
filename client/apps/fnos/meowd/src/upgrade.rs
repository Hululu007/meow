//! fpk 自更新的落盘端：浏览器下载完安装包后，把字节交给壳保存。
//!
//! 为什么由壳落盘：应用中心 `download/task`（`packageSourceType:"file"`）
//! 要的是 **NAS 绝对路径**，浏览器拿不到这种路径；而且应用中心以 root 读，
//! 我们只能把包放进自己的 `$TRIM_PKGVAR/updates/`。
//!
//! 为什么不让壳自己下载：`reqwest` 没开 TLS feature（为体积），只能访问 http，
//! GitHub 是 https。浏览器侧下载还能顺手给进度条与 sha256 校验。

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json,
};
use serde_json::json;
use tracing::{info, warn};

use crate::http::AppState;

/// 64MB：1.1.x 的 fpk 约 12MB，留余量但不至于让一次误传吃光内存。
/// 网关（trim_http_cgi）可能另有更小的限制，超了会回落成 413，前端会翻成人话。
pub const MAX_FPK_BYTES: usize = 64 << 20;

pub fn route() -> axum::routing::MethodRouter<AppState> {
    post(save).layer(DefaultBodyLimit::max(MAX_FPK_BYTES))
}

async fn save(State(st): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    if body.len() < 512 {
        return fail(StatusCode::BAD_REQUEST, "安装包为空或过小");
    }
    // fpk 是 tar.gz。提前挡掉 HTML 错误页 / 代理提示页，否则应用中心只会
    // 报一个"安装失败"，用户看不到真正原因。
    if body[0] != 0x1f || body[1] != 0x8b {
        return fail(StatusCode::BAD_REQUEST, "不是合法的 fpk（缺少 gzip 头）");
    }

    let name = file_name(&headers);
    let dir = st.cfg.pkg_var.join("updates");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        warn!(dir = %dir.display(), error = %e, "create updates dir failed");
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "壳无法创建更新目录");
    }

    // 清掉旧包：没有理由在设备上留多个 12MB 的 fpk；同名文件也一并删，
    // 避免写入的是上一次的残留。读目录失败不阻断保存。
    if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            if entry.path().extension().map(|x| x == "fpk").unwrap_or(false) {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }

    let path = dir.join(&name);
    if let Err(e) = tokio::fs::write(&path, &body).await {
        warn!(path = %path.display(), error = %e, "write fpk failed");
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "壳写入安装包失败");
    }

    // 应用中心拿到的必须是绝对路径。pkg_var 在正常安装下就是绝对路径，
    // canonicalize 只是把符号链接/相对路径兜住。
    let abs = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    info!(path = %abs.display(), bytes = body.len(), "fpk saved");
    Json(json!({ "ok": true, "path": abs.to_string_lossy(), "size": body.len() })).into_response()
}

fn fail(code: StatusCode, error: &str) -> Response {
    (code, Json(json!({ "ok": false, "error": error }))).into_response()
}

/// 只允许 `[A-Za-z0-9._-]`：文件名会被拼进路径，不能给任何目录跳转的机会。
fn file_name(headers: &HeaderMap) -> String {
    let raw = headers
        .get("x-meow-filename")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let clean: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(120)
        .collect();
    let clean = clean.trim_start_matches('.').to_string();
    if clean.len() >= 5 && clean.ends_with(".fpk") {
        clean
    } else {
        "meow-update.fpk".to_string()
    }
}
