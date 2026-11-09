use std::time::Duration;

use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, HeaderName, Request, StatusCode},
    response::{IntoResponse, Response},
};
use reqwest::redirect::Policy;
use tracing::warn;

use crate::http::AppState;

/// 插件/片库上传会走 /api/**，2MB 的 axum 默认 BodyLimit 不够。
const BODY_LIMIT: usize = 256 * 1024 * 1024;

fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

pub fn build_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        // 不跟随重定向：后端有 3xx 语义（片库/转码入口），要原样交给浏览器
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .build()?)
}

pub async fn forward(State(st): State<AppState>, req: Request<Body>) -> Response {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = format!("{}{}", st.cfg.upstream_base(), path_and_query);

    let method = req.method().clone();
    let headers = req.headers().clone();
    let body = req.into_body();
    let bytes = match to_bytes(body, BODY_LIMIT).await {
        Ok(b) => b,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("request body unreadable: {e}"))
                .into_response()
        }
    };

    let mut builder = st.client.request(method, &url);
    for (name, value) in headers.iter() {
        if name == header::HOST || is_hop_by_hop(name) {
            continue;
        }
        builder = builder.header(name, value);
    }
    // ★ 必须把客户端原始 Host（含 30010 端口）带给后端：后端用它拼 m3u8 分片和
    //   /spider-latest.jar 的绝对地址，丢了端口会变成 http://127.0.0.1/api/...
    if let Some(host) = headers.get(header::HOST) {
        builder = builder.header(header::HOST, host);
    }
    if !bytes.is_empty() {
        builder = builder.body(bytes);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            warn!("upstream {url} failed: {e}");
            return (
                StatusCode::BAD_GATEWAY,
                format!("upstream unreachable: {e}"),
            )
                .into_response();
        }
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let upstream_headers = resp.headers().clone();
    let mut out = Response::builder().status(status);
    if let Some(map) = out.headers_mut() {
        for (name, value) in upstream_headers.iter() {
            if is_hop_by_hop(name) {
                continue;
            }
            map.insert(name, value.clone());
        }
    }

    let stream_body = Body::from_stream(resp.bytes_stream());
    out.body(stream_body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
