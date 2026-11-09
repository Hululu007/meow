//! 内置 MCP（Model Context Protocol）服务，用于自动化冒烟测试。
//!
//! 为什么放在应用里而不是外置脚本：
//!   1. 它要驱动的是**真实 WebView2 窗口**，外部脚本拿不到窗口句柄与 CDP 端口
//!   2. 应用退出时服务应一起消失，不留孤儿
//!   3. 冒烟要覆盖"插件是否真的起来了"，这只有进程内部知道
//!
//! 传输层用 **Streamable HTTP**（MCP 2024-11-05 规范），单端点 POST /mcp。
//! 选 HTTP 而不是 stdio：MCP 客户端只需要一个 URL，不用管理子进程生命周期，
//! 也不会出现"应用没启动时客户端报子进程崩溃"的噪音。
//!
//! 实现是零依赖的：手写 HTTP/1.1 + JSON-RPC 2.0。原因是 Tauri 已经带进来
//! 不少 crate，再加 hyper/axum 会让编译时间和产物体积都明显变大，
//! 而 MCP 的报文结构很简单（见 handle_rpc）。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

/// MCP 服务与 CDP 桥的共享状态
pub struct McpState {
    /// WebView2 的 CDP 端口（启动时由 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 注入）
    pub cdp_port: u16,
    /// 插件管理器句柄，供 plugins 工具读取/启停
    pub plugins: Arc<crate::plugins::PluginManager>,
}

/// 探测区间起点。客户端在这一段里逐个探 `/health` 来发现服务。
pub const PORT_MIN: u16 = 9339;

/// 探测区间长度。8 个足够容纳多个实例并存，又不至于让探测变长。
pub const PORT_COUNT: u16 = 8;

/// 实际监听端口，供前端展示（设置页「远程调试」分区）。
///
/// 不落盘（原因见 `write_info_file`），但要能被同一个进程里的 UI 读到，
/// 所以用静态值。0 表示没起来。
static ACTIVE_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

/// 当前 MCP 端口；0 表示服务没起来。
pub fn active_port() -> u16 {
    ACTIVE_PORT.load(std::sync::atomic::Ordering::Relaxed)
}

/// 启动 MCP 服务（阻塞在独立线程里）。
///
/// 端口从 9339 起找，被占用就顺延。**实际端口不落盘**——客户端
/// 应在 9339–9346 里逐个探测 `/health`，看谁自报 `server: "meow-player"`。
pub fn start(state: Arc<McpState>) -> std::io::Result<u16> {
    let listener = bind_first_free(PORT_MIN, PORT_COUNT)?;
    let port = listener.local_addr()?.port();
    ACTIVE_PORT.store(port, std::sync::atomic::Ordering::Relaxed);
    write_info_file(state.cdp_port);

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let st = state.clone();
            std::thread::spawn(move || {
                let _ = serve_one(stream, st);
            });
        }
    });
    Ok(port)
}

fn bind_first_free(from: u16, count: u16) -> std::io::Result<TcpListener> {
    let mut last = None;
    for p in from..from + count {
        match TcpListener::bind(("127.0.0.1", p)) {
            Ok(l) => return Ok(l),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "no free port")))
}

/// 把进程信息写到固定位置，供外部工具读 pid / 版本 / CDP 端口。
///
/// **这里刻意不写 mcp_port**：客户端应在 {@link PORT_RANGE} 里主动探测，
/// 而不是相信一个静态文件。踩过的坑——文件里的端口是上次运行留下的，
/// 进程早没了却看起来"还活着"；而且端口本就可能因顺延而变化，
/// 把易变的量写进文件等于制造一份随时会过期的副本。
fn write_info_file(cdp_port: u16) {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return;
    };
    let dir = std::path::PathBuf::from(home).join(".zcode");
    let _ = std::fs::create_dir_all(&dir);
    let info = json!({
        "cdp_port": cdp_port,
        "pid": std::process::id(),
        "app": "meow-player",
        "version": env!("CARGO_PKG_VERSION"),
        // 给客户端一个范围提示，省得去猜；真正的端口仍以探测结果为准
        "mcp_port_range": [PORT_MIN, PORT_MIN + PORT_COUNT - 1],
    });
    let _ = std::fs::write(dir.join("meow-mcp.json"), info.to_string());
}

/// 处理单个 HTTP 连接。
fn serve_one(mut stream: TcpStream, state: Arc<McpState>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(60)))?;

    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();

    // 读头，取出 Content-Length / Origin / Content-Type
    let mut content_length = 0usize;
    let mut origin_header = String::new();
    let mut ctype_header = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            } else if k.eq_ignore_ascii_case("origin") {
                origin_header = v.trim().to_string();
            } else if k.eq_ignore_ascii_case("content-type") {
                ctype_header = v.trim().to_ascii_lowercase();
            }
        }
    }
    /*
     * Origin 不在受信任名单里就**直接拒绝**（2026-10-30 安全审计 C2）。
     *
     * 只"不下发 CORS 头"是不够的：那样攻击页面读不到响应，但请求照样
     * 被执行（pc_eval 已经跑完、副作用已经产生）。这里在入口就挡掉。
     *
     * 空 Origin 放行：curl / 本地脚本 / smoke 脚本都不带 Origin，
     * 而浏览器发起的跨源请求**一定**带 Origin，所以这个判据不会误伤工具链。
     */
    if !origin_header.is_empty() && !origin_trusted(&origin_header) {
        return write_response_with_origin(
            &mut stream, 403, "application/json",
            "{\"error\":\"origin not allowed\"}", &origin_header,
        );
    }
    /*
     * 强制 JSON Content-Type（同 C2）。
     *
     * `text/plain` 属 CORS 简单请求、**不触发预检**，所以哪怕 Origin 校验
     * 写在上面，攻击者仍可能用简单请求把 body 送进来。要求 application/json
     * 会让浏览器先发 OPTIONS 预检，而预检里我们不给它 CORS 头 → 请求被拦。
     */
    if method == "POST" && !ctype_header.is_empty() && !ctype_header.starts_with("application/json") {
        return write_response_with_origin(
            &mut stream, 415, "application/json",
            "{\"error\":\"Content-Type must be application/json\"}", &origin_header,
        );
    }

    // CORS 预检。只有受信任 Origin 才会拿到 CORS 头，其它来源的预检"通过"
    // 但后续真实请求会被浏览器拒绝（因为响应里没有 allow-origin）。
    if method == "OPTIONS" {
        return write_response_with_origin(&mut stream, 204, "text/plain", "", &origin_header);
    }

    // 健康检查端点，便于确认服务活着
    if path == "/health" {
        // 顺带探一次 CDP：客户端可以先查这里，避免对假死的端点发起调用后干等。
        let cdp_ok = cdp::probe(state.cdp_port);
        let body = json!({
            // server 是端口探测的判据：区间里可能跑着别的东西，
            // 只看"能连上"会认错服务
            "server": "meow-player",
            "platform": "pc",
            "ok": true,
            "port": stream.local_addr().map(|a| a.port()).unwrap_or(0),
            "cdp": state.cdp_port,
            "cdp_ready": cdp_ok,
            "hint": if cdp_ok { Value::Null } else { json!("CDP 无响应，重启应用可恢复") },
            "plugins": state.plugins.discover(),
        })
        .to_string();
        return write_response_with_origin(&mut stream, 200, "application/json", &body, &origin_header);
    }

    if path != "/mcp" {
        return write_response(&mut stream, 404, "text/plain", "not found");
    }
    if method != "POST" {
        return write_response(&mut stream, 405, "text/plain", "use POST");
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    let text = String::from_utf8_lossy(&body).to_string();

    // MCP 允许批量请求，也允许单条
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            let err = json!({"jsonrpc":"2.0","id":null,
                "error":{"code":-32700,"message":format!("parse error: {e}")}});
            return write_response_with_origin(
                &mut stream, 200, "application/json", &err.to_string(), &origin_header);
        }
    };

    let response = if let Some(arr) = parsed.as_array() {
        let out: Vec<Value> = arr
            .iter()
            .filter_map(|req| handle_rpc(req, &state))
            .collect();
        Value::Array(out)
    } else {
        match handle_rpc(&parsed, &state) {
            Some(v) => v,
            // 通知（无 id）不需要响应
            None => {
                return write_response_with_origin(&mut stream, 202, "application/json", "", &origin_header)
            }
        }
    };

    write_response_with_origin(
        &mut stream, 200, "application/json", &response.to_string(), &origin_header)
}

/**
 * 这个 Origin 是不是应用自己。
 *
 * <p>只认 Tauri 的两个内建 origin。`http://localhost:*` 之类也**不认**：
 * 本地开发服务器同样可能是被攻击者控制的页面（端口撞车、恶意 npm 包启的静态站）。
 */
fn origin_trusted(origin: &str) -> bool {
    matches!(origin, "tauri://localhost" | "http://tauri.localhost")
}

fn write_response(stream: &mut TcpStream, code: u16, ctype: &str, body: &str) -> std::io::Result<()> {
    write_response_with_origin(stream, code, ctype, body, "")
}

/**
 * 写响应，并只为受信任的 Origin 下发 CORS 头。
 *
 * <p>无条件下发 `Access-Control-Allow-Origin: *` 会让任意网站都能读取
 * `/mcp` 的响应 —— 配合 `pc_eval` 等于把 localStorage 里的所有凭据交出去
 * （2026-10-30 安全审计 C2）。现在：Origin 受信任时回显它，否则不下发。
 */
fn write_response_with_origin(
    stream: &mut TcpStream,
    code: u16,
    ctype: &str,
    body: &str,
    origin: &str,
) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        415 => "Unsupported Media Type",
        _ => "OK",
    };
    let allow_origin = if origin_trusted(origin) {
        format!("Access-Control-Allow-Origin: {origin}\r\n")
    } else {
        String::new()
    };
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\n\
         Content-Type: {ctype}\r\n\
         Content-Length: {}\r\n\
         {allow_origin}\
         Access-Control-Allow-Headers: Content-Type, X-Meow-Token\r\n\
         Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n\
         Connection: close\r\n\r\n",
        body.as_bytes().len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

// ---------------------------------------------------------------- JSON-RPC

fn handle_rpc(req: &Value, state: &Arc<McpState>) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!({}));

    // 通知（无 id）不回复
    let is_notification = id.is_none() || id == Some(Value::Null);
    let ok = |result: Value| {
        if is_notification {
            None
        } else {
            Some(json!({"jsonrpc":"2.0","id":id.clone(),"result":result}))
        }
    };
    let err = |code: i64, msg: String| {
        if is_notification {
            None
        } else {
            Some(json!({"jsonrpc":"2.0","id":id.clone(),
                "error":{"code":code,"message":msg}}))
        }
    };

    match method {
        "initialize" => ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": "meow-player", "version": env!("CARGO_PKG_VERSION")},
        })),
        // 客户端发来的 initialized 通知，忽略
        "notifications/initialized" => ok(json!({})),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({"tools": tool_defs()})),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(name, &args, state) {
                Ok(text) => ok(json!({
                    "content": [{"type": "text", "text": text}],
                    "isError": false
                })),
                Err(e) => ok(json!({
                    "content": [{"type": "text", "text": e}],
                    "isError": true
                })),
            }
        }
        _ => err(-32601, format!("method not found: {method}")),
    }
}

fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": "pc_screenshot",
            "description": "截取 PC 应用当前窗口画面，返回 PNG 的 base64。冒烟时用于视觉确认布局与渲染。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "full_page": {"type": "boolean", "description": "是否整页（默认仅视口）"}
                }
            }
        }),
        json!({
            "name": "pc_dom",
            "description": "读取当前页面的可访问性/DOM 摘要（角色+名称+文本），用于定位元素。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "max_nodes": {"type": "integer", "description": "最多返回多少个节点，默认 400"}
                }
            }
        }),
        json!({
            "name": "pc_eval",
            "description": "在页面上下文执行只读 JS 表达式并返回结果。用于取状态（当前路由、视频状态、插件信息等）。",
            "inputSchema": {
                "type": "object",
                "required": ["expression"],
                "properties": {
                    "expression": {"type": "string", "description": "JS 表达式，支持 await"}
                }
            }
        }),
        json!({
            "name": "pc_click",
            "description": "点击元素。优先用 CSS 选择器；也可用 text 按可见文本匹配。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "CSS 选择器"},
                    "text": {"type": "string", "description": "按可见文本包含匹配"},
                    "index": {"type": "integer", "description": "多个匹配时取第几个，默认 0"}
                }
            }
        }),
        json!({
            "name": "pc_type",
            "description": "向输入框填值并派发 input 事件（兼容 Vue 的 v-model）。",
            "inputSchema": {
                "type": "object",
                "required": ["value"],
                "properties": {
                    "selector": {"type": "string", "description": "CSS 选择器"},
                    "placeholder": {"type": "string", "description": "按 placeholder 匹配"},
                    "value": {"type": "string", "description": "要填入的文本"},
                    "enter": {"type": "boolean", "description": "填完后是否按回车"}
                }
            }
        }),
        json!({
            "name": "pc_navigate",
            "description": "切换应用内路由（hash 路由，如 #/settings）。",
            "inputSchema": {
                "type": "object",
                "required": ["hash"],
                "properties": {"hash": {"type": "string"}}
            }
        }),
        json!({
            "name": "pc_plugins",
            "description": "读取本机插件（后端/弹幕）状态：phase、端口、版本、错误。",
            "inputSchema": {"type": "object", "properties": {}}
        }),
        json!({
            "name": "pc_plugin_start",
            "description": "启动指定插件（幂等）。",
            "inputSchema": {
                "type": "object",
                "required": ["id"],
                "properties": {"id": {"type": "string"}}
            }
        }),
        json!({
            "name": "pc_plugin_stop",
            "description": "停止指定插件。",
            "inputSchema": {
                "type": "object",
                "required": ["id"],
                "properties": {"id": {"type": "string"}}
            }
        }),
        json!({
            "name": "pc_backend",
            "description": "读取后端基地址与 health，确认 sidecar 是否真的可用。",
            "inputSchema": {"type": "object", "properties": {}}
        }),
        json!({
            "name": "pc_console",
            "description": "读取页面 JS 错误（error / unhandledrejection），含堆栈与发生时的路由。",
            "inputSchema": {"type": "object", "properties": {}}
        }),
        json!({
            "name": "pc_network",
            "description": "读取页面发出的网络请求记录（fetch + XHR）：方法、URL、状态码、耗时、失败原因。不记录请求/响应体。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filter": {"type": "string", "description": "只返回 URL 包含此子串的记录"},
                    "only_failed": {"type": "boolean", "description": "只看失败/非 2xx 的请求"},
                    "limit": {"type": "integer", "description": "最多返回多少条，默认 40"}
                }
            }
        }),
        json!({
            "name": "pc_wait",
            "description": "等待条件成立（轮询）。替代固定 sleep，让冒烟既快又稳。条件四选一：selector / text / video_ready / expression。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "CSS 选择器"},
                    "state": {
                        "type": "string",
                        "enum": ["attached", "visible", "hidden"],
                        "description": "配合 selector：出现/可见/消失，默认 attached"
                    },
                    "text": {"type": "string", "description": "页面可见文本包含此串"},
                    "video_ready": {"type": "boolean", "description": "等待 video 元素 readyState>=3"},
                    "expression": {"type": "string", "description": "自定义 JS 表达式，返回真值即满足"},
                    "timeout_ms": {"type": "integer", "description": "超时毫秒，默认 15000，上限 180000"}
                }
            }
        }),
        json!({
            "name": "pc_hover",
            "description": "悬停到元素上（触发 mouseover/mouseenter/mousemove），用于测悬停才出现的 UI。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "text": {"type": "string", "description": "按可见文本匹配"},
                    "index": {"type": "integer", "description": "多个匹配取第几个，默认 0"}
                }
            }
        }),
        json!({
            "name": "pc_drag",
            "description": "从一点拖到另一点（pointerdown→move→up）。用于进度条、音量条这类拖拽控件。",
            "inputSchema": {
                "type": "object",
                "required": ["from", "to"],
                "properties": {
                    "from": {"type": "object", "description": "{x,y} 视口坐标"},
                    "to": {"type": "object", "description": "{x,y} 视口坐标"},
                    "steps": {"type": "integer", "description": "中间步数，默认 8"}
                }
            }
        }),
        json!({
            "name": "pc_key",
            "description": "派发按键，支持组合键（'Escape' / 'ctrl+a' / 'shift+ArrowLeft'）。不指定 selector 时作用于当前焦点元素。",
            "inputSchema": {
                "type": "object",
                "required": ["key"],
                "properties": {
                    "key": {"type": "string", "description": "如 Escape / Enter / ctrl+a / ArrowRight"},
                    "selector": {"type": "string", "description": "可选，发给指定元素"}
                }
            }
        }),
        json!({
            "name": "pc_danmaku",
            "description": "读取弹幕渲染器状态：canvas 尺寸、当前在场弹幕文本与坐标、队列长度。canvas 内容 DOM 读不到，靠这个断言。",
            "inputSchema": {"type": "object", "properties": {}}
        }),
        json!({
            "name": "pc_perf",
            "description": "性能汇总：导航各阶段耗时、资源数量与类型分布、耗时 p50/p90/p99、最慢的 N 个请求。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "top": {"type": "integer", "description": "返回最慢的多少条，默认 10"}
                }
            }
        }),
        // ---- 语义工具（docs/47 §1.8 方案 A）----
        //
        // 这 9 个不是 UI 原语，而是"一次调用完成一件事"的业务工具。
        // 实现不在 Rust 里，而是转发到页面已有的 `window.__meowTool`（src/ai/bridge.ts）：
        // 业务逻辑唯一真源留在前端 tools.ts，壳只做转发，不会出现
        // "Rust 版和 TS 版行为不一致"。
        //
        // 用它们代替 pc_dom + pc_click 的循环：找片从 5-10 轮 DOM 往返降到 1 次调用。
        meow_tool_def(
            "meow_state",
            "建立上下文：后端版本、站点数、哪些源降级、日志概况与可用日志模块。任何任务开始前先调它。要看具体日志再调 meow_logs。",
            json!({"type": "object", "properties": {}}),
        ),
        meow_tool_def(
            "meow_logs",
            "查后端日志（2000 条环形缓冲）。用户问“刚才报什么错/为什么失败/后端怎么了”，或 meow_diagnose 的结论不够、需要按级别/模块/时间窗确认时用它。条件由你决定：拿不准就先不带条件取 50 条看全局，再按需收窄。",
            json!({
                "type": "object",
                "properties": {
                    "minLevel": {
                        "type": "string",
                        "enum": ["info", "warn", "error"],
                        "description": "最低级别：只看该级别及以上（info < warn < error）"
                    },
                    "tag": {"type": "string", "description": "模块标签，精确匹配；可用值见 meow_state 的 logTags"},
                    "keyword": {"type": "string", "description": "关键词，匹配正文或标签，不区分大小写"},
                    "minutes": {"type": "integer", "description": "只看最近多少分钟"},
                    "limit": {"type": "integer", "description": "最多返回多少条（默认 50，上限 500），取最新的"}
                }
            }),
        ),
        meow_tool_def(
            "meow_diagnose",
            "解释播放失败的原因（读播放器状态、网络失败、后端日志）。用户问“为什么播不了/卡/黑屏”时用它。",
            json!({"type": "object", "properties": {}}),
        ),
        meow_tool_def(
            "meow_search",
            "按片名搜索影片，跨多源合并，返回影片与可播来源。仅在用户这句话里出现了新的片名时使用；回应/追问（“就播它”“还有别的吗”）不要调用。",
            json!({
                "type": "object",
                "required": ["keyword"],
                "properties": {
                    "keyword": {"type": "string", "description": "片名关键词，只填片名（如“庆余年”），不要填整句话"},
                    "limit": {"type": "integer", "description": "最多返回几部，默认 20"}
                }
            }),
        ),
        meow_tool_def(
            "meow_play",
            "取播放地址（内部自动换线路）。需要 site 与 vod_id，二者从 meow_search 的结果里拿。如果上一轮已经拿到这两项，直接复用，不要为了拿 id 重新搜索。",
            json!({
                "type": "object",
                "required": ["site", "vod_id"],
                "properties": {
                    "site": {"type": "string", "description": "来源标识（来自 meow_search）"},
                    "vod_id": {"type": "string", "description": "影片在该源的 id（来自 meow_search）"},
                    "line": {"type": "string", "description": "指定线路名，不填自动挑"},
                    "episode": {"type": "string", "description": "集数，如 “1”；不填取第一集"}
                }
            }),
        ),
        meow_tool_def(
            "meow_sources",
            "源健康清单（哪些降级/停用及失败原因）。用户问“哪些源挂了/源还好吗”时用它。",
            json!({"type": "object", "properties": {}}),
        ),
        meow_tool_def(
            "meow_library",
            "本地 / NAS 片库概览（几个库、多少部片）。用户问“我本地有什么片”时用它。",
            json!({"type": "object", "properties": {}}),
        ),
        meow_tool_def(
            "meow_live",
            "直播频道概览。返回里若 failed 等于 tried，说明上游当天全挂，不是应用问题。",
            json!({"type": "object", "properties": {}}),
        ),
        meow_tool_def(
            "meow_danmaku",
            "查某部片的弹幕源。视频能播但没弹幕是常见情况，与视频源无关。",
            json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "片名"},
                    "episode": {"type": "string", "description": "集数，如 “1”"}
                }
            }),
        ),
        meow_tool_def(
            "meow_cache",
            "本地缓存/离线下载概览（已缓存多少、占用、有无进行中任务）。只支持查询，不能开始下载。",
            json!({"type": "object", "properties": {}}),
        ),
    ]
}

/// 生成一个 `meow_*` 语义工具的定义。
///
/// 单独抽出来是因为这 9 个形制完全一致（名字 + 描述 + schema），
/// 逐个手写 json! 容易漏字段。
fn meow_tool_def(name: &str, desc: &str, schema: Value) -> Value {
    json!({
        "name": name,
        "description": desc,
        "inputSchema": schema,
    })
}

fn call_tool(name: &str, args: &Value, state: &Arc<McpState>) -> Result<String, String> {
    match name {
        "pc_plugins" => {
            let list = state.plugins.discover();
            Ok(serde_json::to_string_pretty(&list).unwrap_or_default())
        }
        "pc_plugin_start" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("缺少 id")?;
            let st = state.plugins.start(id)?;
            Ok(serde_json::to_string_pretty(&st).unwrap_or_default())
        }
        "pc_plugin_stop" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("缺少 id")?;
            state.plugins.stop(id)?;
            Ok(format!("插件 {id} 已停止"))
        }
        "pc_backend" => {
            // 显式标注类型：不标注时 match 分支里的 .into() 会让编译器
            // 把 Some(b) 里的 b 推断成 str（E0277 "size 未知"），
            // 报错位置指向 Some(b) 而不是真正的推断点。
            let base: Option<String> = state.plugins.backend_base();
            match base {
                None => Err("后端未就绪".into()),
                Some(b) => {
                    let health = cdp::http_get(b.as_str(), "/api/health")?;
                    Ok(format!("base: {b}\nhealth: {health}"))
                }
            }
        }
        "pc_screenshot" => {
            let clip = args.get("clip").and_then(|v| v.as_object()).map(|o| {
                (
                    o.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    o.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    o.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    o.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0),
                )
            });
            let opts = cdp::ShotOpts {
                full_page: args
                    .get("full_page")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                selector: args
                    .get("selector")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                clip,
                scale: args.get("scale").and_then(|v| v.as_f64()),
                max_bytes: args
                    .get("max_bytes")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize),
            };
            let data = cdp::screenshot(state.cdp_port, &opts)?;
            // cdp::screenshot 返回 "png:100:<base64>" / "jpeg:65:<base64>"。
            // data URL 的 mime 必须与真实编码一致，否则客户端会按 PNG 解码 JPEG。
            let mut it = data.splitn(3, ':');
            let fmt = it.next().unwrap_or("png");
            let _quality = it.next().unwrap_or("100");
            let b64 = it.next().unwrap_or("");
            let mime = if fmt == "jpeg" { "image/jpeg" } else { "image/png" };
            Ok(format!("data:{mime};base64,{b64}"))
        }
        "pc_dom" => {
            let max = args
                .get("max_nodes")
                .and_then(|v| v.as_u64())
                .unwrap_or(400);
            let js = format!(
                r#"(function(){{
  const out=[];const seen=new Set();
  function walk(el,depth){{
    if(out.length>={max})return;
    if(!el||el.nodeType!==1)return;
    const cs=getComputedStyle(el);
    if(cs.display==='none'||cs.visibility==='hidden')return;
    const role=el.getAttribute('role')||el.tagName.toLowerCase();
    const name=(el.getAttribute('aria-label')||el.textContent||'').trim().replace(/\s+/g,' ').slice(0,60);
    out.push('  '.repeat(depth)+role+(name?': '+name:''));
    for(const c of el.children)walk(c,depth+1);
  }}
  walk(document.body,0);return out.join('\n');
}})()"#
            );
            cdp::evaluate(state.cdp_port, &js)
        }
        "pc_eval" => {
            let expr = args
                .get("expression")
                .and_then(|v| v.as_str())
                .ok_or("缺少 expression")?;
            cdp::evaluate(state.cdp_port, expr)
        }
        "pc_click" => {
            let js = build_click_js(args);
            cdp::evaluate(state.cdp_port, &js)
        }
        "pc_type" => {
            let js = build_type_js(args)?;
            cdp::evaluate(state.cdp_port, &js)
        }
        "pc_navigate" => {
            let hash = args.get("hash").and_then(|v| v.as_str()).ok_or("缺少 hash")?;
            let js = format!(
                "(function(){{location.hash={};return location.hash}})()",
                serde_json::to_string(hash).unwrap()
            );
            let r = cdp::evaluate(state.cdp_port, &js)?;
            std::thread::sleep(Duration::from_millis(800));
            Ok(r)
        }
        "pc_console" => {
            // 读前端 diagnostics.ts 挂的采集器。
            // 没有它时（老版本/Web 端）返回明确提示，而不是空数组冒充"无错误"。
            let js = r#"(function(){
  var d = window.__meowDiag;
  if (!d) return JSON.stringify({available:false, hint:'页面未安装诊断钩子（旧版本或非桌面端）'});
  return JSON.stringify({available:true, errors:d.errors(), total:d.errors().length});
})()"#;
            cdp::evaluate(state.cdp_port, js)
        }
        "pc_network" => {
            let filter = args.get("filter").and_then(|v| v.as_str()).unwrap_or("");
            let only_failed = args
                .get("only_failed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(40);
            let js = format!(
                r#"(function(){{
  var d = window.__meowDiag;
  if (!d) return JSON.stringify({{available:false, hint:'页面未安装诊断钩子'}});
  var all = d.net();
  var f = {filter_js};
  var onlyFail = {only_fail};
  var rows = all.filter(function(r){{
    if (onlyFail && r.ok) return false;
    if (f && r.url.indexOf(f) < 0) return false;
    return true;
  }}).slice(-{limit});
  return JSON.stringify({{available:true, total:all.length, shown:rows.length, rows:rows}});
}})()"#,
                filter_js = serde_json::to_string(filter).unwrap(),
                only_fail = only_failed,
                limit = limit
            );
            cdp::evaluate(state.cdp_port, &js)
        }
        "pc_wait" => wait_for_condition(state, args),
        "pc_hover" => {
            let js = build_hover_js(args);
            cdp::evaluate(state.cdp_port, &js)
        }
        "pc_drag" => {
            let js = build_drag_js(args)?;
            cdp::evaluate(state.cdp_port, &js)
        }
        "pc_key" => {
            let js = build_key_js(args)?;
            cdp::evaluate(state.cdp_port, &js)
        }
        "pc_danmaku" => danmaku_probe(state),
        "pc_perf" => perf_probe(state, args),
        // 语义工具：全部转发到页面里的 window.__meowTool（src/ai/bridge.ts）。
        // 逐个 match 是刻意的——未知的 meow_* 名字会落到最后的兜底分支报错，
        // 而不是被一个 starts_with("meow_") 通配掉（那样打错工具名不会提示）。
        "meow_state" | "meow_logs" | "meow_diagnose" | "meow_search" | "meow_play"
        | "meow_sources" | "meow_library" | "meow_live" | "meow_danmaku" | "meow_cache" => {
            call_meow_tool(name, args, state)
        }
        _ => Err(format!("未知工具: {name}")),
    }
}

/// 把一次 `meow_*` 调用转发到页面内的 `window.__meowTool`。
///
/// 为什么这样而不是在 Rust 里重写：业务逻辑（跨源搜索、换线、诊断规则）
/// 已经在前端 `src/ai/tools.ts` 里了，重写一遍必然漂移。壳只做转发。
///
/// ★ **不能让整个表达式是 IIFE**：`Runtime.evaluate` 的 `awaitPromise` 只对
/// **顶层结果是 Promise** 的表达式生效。写成 `(function(){ return promise })()`
/// 时顶层是 function call 返回的 Promise——这个其实也满足……但为了确定性和
/// 便于加"桥缺失"的提前判断，这里用 `async IIFE + await`，顶层明确是 Promise。
///
/// ★ 不做 `JSON.stringify`：`cdp::evaluate` 已经把非字符串结果 `to_string()` 成
/// JSON 了（见那边的 match）。这里再 stringify 会变成"转义过的字符串"，
/// 外部 MCP 客户端拿到的是 `"{\"ok\":true...}"` 而不是对象。
fn call_meow_tool(name: &str, args: &Value, state: &Arc<McpState>) -> Result<String, String> {
    // 用 JSON.stringify 传参，避免字符串拼接被引号/换行破坏
    let args_json = serde_json::to_string(args).unwrap_or_else(|_| "{}".into());
    let js = format!(
        r#"(async function(){{
  if (typeof window.__meowTool !== 'function') {{
    return {{ok:false, error:'页面里没有 __meowTool，可能是前端版本过旧（需要 0.9.22+）'}};
  }}
  return await window.__meowTool({name}, {args});
}})()"#,
        name = serde_json::to_string(name).unwrap_or_else(|_| "\"\"".into()),
        args = args_json,
    );
    cdp::evaluate(state.cdp_port, &js)
}

/// 悬停：触发 mousemove / mouseover / mouseenter。
///
/// 很多交互（悬停显示操作按钮、tooltip）只在这些事件里出现，
/// 单纯 click 测不到。
fn build_hover_js(args: &Value) -> String {
    let idx = arg_usize(args.get("index"), 0);
    let target = if let Some(sel) = args.get("selector").and_then(|v| v.as_str()) {
        format!(
            "document.querySelectorAll({})[{}]",
            serde_json::to_string(sel).unwrap(),
            idx
        )
    } else if let Some(t) = args.get("text").and_then(|v| v.as_str()) {
        format!(
            "Array.from(document.querySelectorAll('button,a,[role=button]')).filter(function(e){{return e.textContent.includes({})}})[{idx}]",
            serde_json::to_string(t).unwrap()
        )
    } else {
        return "'需要 selector 或 text'".to_string();
    };

    format!(
        r#"(function(){{
  var el={target};
  if(!el) return '悬停目标不存在';
  el.scrollIntoView({{block:'center'}});
  var r=el.getBoundingClientRect();
  var x=r.left+r.width/2, y=r.top+r.height/2;
  var opts={{bubbles:true, clientX:x, clientY:y, view:window}};
  el.dispatchEvent(new MouseEvent('mouseover',opts));
  el.dispatchEvent(new MouseEvent('mouseenter',opts));
  el.dispatchEvent(new MouseEvent('mousemove',opts));
  return '已悬停 ('+Math.round(x)+','+Math.round(y)+')';
}})()"#
    )
}

/// 拖拽：从 from 到 to 派发 pointer/mouse 序列。
///
/// 进度条、音量条都靠 pointerdown→move→up，直接 click 改不了值。
fn build_drag_js(args: &Value) -> Result<String, String> {
    let from = args
        .get("from")
        .and_then(|v| v.as_object())
        .ok_or("缺少 from {x,y}")?;
    let to = args
        .get("to")
        .and_then(|v| v.as_object())
        .ok_or("缺少 to {x,y}")?;
    let fx = from.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let fy = from.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let tx = to.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let ty = to.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let steps = args
        .get("steps")
        .and_then(|v| v.as_u64())
        .unwrap_or(8)
        .clamp(1, 60);

    Ok(format!(
        r#"(function(){{
  var fx={fx}, fy={fy}, tx={tx}, ty={ty}, steps={steps};
  var start=document.elementFromPoint(fx,fy);
  if(!start) return '起点没有元素';
  function fire(type,x,y,extra){{
    var o=Object.assign({{bubbles:true,cancelable:true,clientX:x,clientY:y,view:window,button:0,buttons:1}},extra||{{}});
    var el=document.elementFromPoint(x,y)||start;
    if(type.indexOf('pointer')===0) el.dispatchEvent(new PointerEvent(type,Object.assign({{pointerId:1,pointerType:'mouse',isPrimary:true}},o)));
    else el.dispatchEvent(new MouseEvent(type,o));
  }}
  fire('pointerdown',fx,fy);
  fire('mousedown',fx,fy);
  for(var i=1;i<=steps;i++){{
    var x=fx+(tx-fx)*i/steps, y=fy+(ty-fy)*i/steps;
    fire('pointermove',x,y);
    fire('mousemove',x,y);
  }}
  fire('pointerup',tx,ty,{{buttons:0}});
  fire('mouseup',tx,ty,{{buttons:0}});
  return '已拖拽 ('+Math.round(fx)+','+Math.round(fy)+') → ('+Math.round(tx)+','+Math.round(ty)+')';
}})()"#
    ))
}

/// 键盘：支持组合键（Ctrl+A）与单键。
fn build_key_js(args: &Value) -> Result<String, String> {
    let key = args
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("缺少 key，如 'Escape' / 'ctrl+a'")?;
    let target_sel = args.get("selector").and_then(|v| v.as_str());

    // 解析 "ctrl+shift+k" → 修饰键 + 主键
    let (mods, main) = parse_combo(key);
    let target = match target_sel {
        Some(sel) => format!("document.querySelector({})", serde_json::to_string(sel).unwrap()),
        None => "document.activeElement || document.body".to_string(),
    };

    Ok(format!(
        r#"(function(){{
  var el={target};
  if(!el) return '目标不存在';
  var mods={mods_js};
  var main={main_js};
  var init={{key:main,bubbles:true,cancelable:true,
    ctrlKey:mods.indexOf('ctrl')>=0, shiftKey:mods.indexOf('shift')>=0,
    altKey:mods.indexOf('alt')>=0, metaKey:mods.indexOf('meta')>=0}};
  el.dispatchEvent(new KeyboardEvent('keydown',init));
  el.dispatchEvent(new KeyboardEvent('keypress',init));
  el.dispatchEvent(new KeyboardEvent('keyup',init));
  return '已按键 '+mods.join('+')+(mods.length?'+':'')+main;
}})()"#,
        mods_js = serde_json::to_string(&mods).unwrap(),
        main_js = serde_json::to_string(&main).unwrap()
    ))
}

fn parse_combo(key: &str) -> (Vec<String>, String) {
    let parts: Vec<String> = key
        .split('+')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.len() <= 1 {
        return (vec![], parts.first().cloned().unwrap_or_default());
    }
    let main = parts.last().cloned().unwrap_or_default();
    let mods = parts[..parts.len() - 1].to_vec();
    (mods, main)
}

/// 弹幕状态探针。
///
/// canvas 里画的东西 DOM 读不到，但渲染器自己在
/// `danmaku.ts` 里维护 active 队列。VideoPlayer 把它挂在
/// `window.__meowDm` 上供这里读取。
fn danmaku_probe(state: &Arc<McpState>) -> Result<String, String> {
    let js = r#"(function(){
  var d = window.__meowDm;
  if (!d) return JSON.stringify({available:false, hint:'当前不在播放页，或弹幕未初始化'});
  var out = {available:true};
  try { out.canvas = d.debugCanvasSize(); } catch(e) {}
  try { out.active = d.debugActive(); } catch(e) {}
  try { out.activeCount = out.active ? out.active.length : null; } catch(e) {}
  // 队列里还没上的
  try { out.queue = d.debugQueue ? d.debugQueue() : null; } catch(e) {}
  return JSON.stringify(out);
})()"#;
    cdp::evaluate(state.cdp_port, js)
}

/// 性能探针：汇总 navigation / resource 时序，给出可直接断言的分位数。
fn perf_probe(state: &Arc<McpState>, args: &Value) -> Result<String, String> {
    let top = args.get("top").and_then(|v| v.as_u64()).unwrap_or(10).clamp(1, 50);
    let js = format!(
        r#"(function(){{
  var nav = performance.getEntriesByType('navigation')[0];
  var res = performance.getEntriesByType('resource');
  var byType = {{}};
  res.forEach(function(r){{
    var t = r.initiatorType || 'other';
    byType[t] = (byType[t] || 0) + 1;
  }});
  var slowest = res.slice().sort(function(a,b){{return b.duration-a.duration}}).slice(0,{top})
    .map(function(r){{ return {{url:r.name.slice(-70), ms:Math.round(r.duration), kb:Math.round((r.transferSize||0)/1024)}}; }});
  var durs = res.map(function(r){{return r.duration}}).sort(function(a,b){{return a-b}});
  function pct(p){{ return durs.length ? Math.round(durs[Math.min(durs.length-1, Math.floor(durs.length*p))]) : 0; }}
  return JSON.stringify({{
    navigation: nav ? {{
      ttfb: Math.round(nav.responseStart),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
      load: Math.round(nav.loadEventEnd),
      transferKB: Math.round((nav.transferSize||0)/1024)
    }} : null,
    resourceCount: res.length,
    byType: byType,
    durations: {{p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: durs.length ? Math.round(durs[durs.length-1]) : 0}},
    slowest: slowest
  }});
}})()"#,
        top = top
    );
    cdp::evaluate(state.cdp_port, &js)
}

/// 轮询等待一个条件成立。
///
/// 为什么需要：搜索 3–11s、播放 20s+，冒烟脚本原本只能 sleep 固定时长，
/// 既慢又不稳（机器快的时候白等，慢的时候不够）。这个工具把"等"变成
/// 可判定条件，超时才失败。
fn wait_for_condition(state: &Arc<McpState>, args: &Value) -> Result<String, String> {
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(15_000)
        .min(180_000);
    let interval = 250u64;

    // 支持的判定条件（优先级：selector > text > expression > video_ready）
    let selector = args.get("selector").and_then(|v| v.as_str());
    let text = args.get("text").and_then(|v| v.as_str());
    let expression = args.get("expression").and_then(|v| v.as_str());
    let video_ready = args
        .get("video_ready")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let state_eq = args.get("state").and_then(|v| v.as_str()); // visible/hidden/attached

    let probe_js = if let Some(sel) = selector {
        let sel_js = serde_json::to_string(sel).unwrap();
        let check = match state_eq.unwrap_or("attached") {
            "visible" => format!(
                r#"(function(){{var e=document.querySelector({sel_js});if(!e)return false;var r=e.getBoundingClientRect();var cs=getComputedStyle(e);return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none';}})()"#
            ),
            "hidden" => format!(
                r#"(function(){{var e=document.querySelector({sel_js});if(!e)return true;var r=e.getBoundingClientRect();var cs=getComputedStyle(e);return r.width===0||r.height===0||cs.visibility==='hidden'||cs.display==='none';}})()"#
            ),
            _ => format!(r#"!!document.querySelector({sel_js})"#),
        };
        check
    } else if let Some(t) = text {
        let t_js = serde_json::to_string(t).unwrap();
        format!(r#"document.body.innerText.indexOf({t_js})>=0"#)
    } else if video_ready {
        // readyState>=3：有足够数据可以播（HAVE_FUTURE_DATA）
        r#"(function(){var v=document.querySelector('video');return !!v && v.readyState>=3;})()"#.to_string()
    } else if let Some(e) = expression {
        e.to_string()
    } else {
        return Err("pc_wait 需要 selector / text / expression / video_ready 之一".into());
    };

    let wrapped = format!("(function(){{ try {{ return !!({probe_js}); }} catch(e) {{ return false; }} }})()");

    let started = std::time::Instant::now();
    let mut attempts = 0u32;
    loop {
        attempts += 1;
        match cdp::evaluate(state.cdp_port, &wrapped) {
            Ok(v) => {
                if v == "true" {
                    return Ok(format!(
                        "条件已满足（{}ms，{} 次探测）",
                        started.elapsed().as_millis(),
                        attempts
                    ));
                }
            }
            Err(e) => {
                // CDP 本身失败要立刻返回，别把"端点挂了"当成"条件没满足"，
                // 否则用户会看到超时，误以为是页面慢。
                return Err(format!("CDP 调用失败: {e}"));
            }
        }
        if started.elapsed().as_millis() as u64 >= timeout {
            return Err(format!(
                "等待超时（{timeout}ms，{attempts} 次探测）；条件仍未满足: {}",
                probe_js.chars().take(120).collect::<String>()
            ));
        }
        std::thread::sleep(Duration::from_millis(interval));
    }
}

/// 把 JSON 里的数字或字符串都解析成 usize。
///
/// MCP 客户端可能把 index 传成 "20" 而不是 20。只认 as_u64 会让字符串
/// 静默退化成 0（点错元素还报成功），必须两者都接。
fn arg_usize(v: Option<&Value>, default: usize) -> usize {
    match v {
        Some(Value::Number(n)) => n.as_u64().map(|x| x as usize).unwrap_or(default),
        Some(Value::String(s)) => s.trim().parse::<usize>().unwrap_or(default),
        _ => default,
    }
}

fn build_click_js(args: &Value) -> String {
    // index 可能是数字或字符串（MCP 客户端不保证类型），必须兼容
    let idx = arg_usize(args.get("index"), 0);
    if let Some(sel) = args.get("selector").and_then(|v| v.as_str()) {
        let sel_js = serde_json::to_string(sel).unwrap();
        return format!(
            r#"(function(){{
  const els=document.querySelectorAll({sel_js});
  const el=els[{idx}];
  if(!el)return 'not found: '+{sel_js}+' (count='+els.length+')';
  el.scrollIntoView({{block:'center'}});
  el.click();
  return 'clicked '+{sel_js}+' ['+{idx}+']';
}})()"#
        );
    }
    if let Some(t) = args.get("text").and_then(|v| v.as_str()) {
        let t_js = serde_json::to_string(t).unwrap();
        return format!(
            r#"(function(){{
  const all=Array.from(document.querySelectorAll('button,a,[role=button],input,label'));
  const hits=all.filter(e=>(e.textContent||e.value||'').replace(/\s+/g,' ').includes({t_js}));
  const el=hits[{idx}];
  if(!el)return 'not found by text: '+{t_js}+' (hits='+hits.length+')';
  el.scrollIntoView({{block:'center'}});
  el.click();
  return 'clicked "'+{t_js}+'" ['+{idx}+'] of '+hits.length;
}})()"#
        );
    }
    "'需要 selector 或 text'".to_string()
}

fn build_type_js(args: &Value) -> Result<String, String> {
    let value = args.get("value").and_then(|v| v.as_str()).ok_or("缺少 value")?;
    let v_js = serde_json::to_string(value).unwrap();
    let enter = args.get("enter").and_then(|v| v.as_bool()).unwrap_or(false);

    let pick = if let Some(sel) = args.get("selector").and_then(|v| v.as_str()) {
        format!("document.querySelector({})", serde_json::to_string(sel).unwrap())
    } else if let Some(ph) = args.get("placeholder").and_then(|v| v.as_str()) {
        format!(
            "document.querySelector('input[placeholder*=' + JSON.stringify({}) + '],textarea[placeholder*=' + JSON.stringify({}) + ']')",
            serde_json::to_string(ph).unwrap(),
            serde_json::to_string(ph).unwrap()
        )
    } else {
        "document.querySelector('input,textarea')".to_string()
    };

    Ok(format!(
        r#"(function(){{
  const el={pick};
  if(!el)return 'input not found';
  const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  const setter=Object.getOwnPropertyDescriptor(proto,'value').set;
  setter.call(el,{v_js});
  el.dispatchEvent(new Event('input',{{bubbles:true}}));
  el.dispatchEvent(new Event('change',{{bubbles:true}}));
  el.focus();
  {enter_js}
  return 'typed into '+(el.placeholder||el.tagName)+' value='+el.value;
}})()"#,
        enter_js = if enter {
            r#"el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
  el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true}));"#
        } else {
            ""
        }
    ))
}

// ---------------------------------------------------------------- CDP 桥

pub mod cdp {
    use super::*;

    /// 找到页面 target 并执行 JS，返回字符串结果。
    pub fn evaluate(cdp_port: u16, expression: &str) -> Result<String, String> {
        let target = pick_page_target(cdp_port)?;
        let ws = target
            .get("webSocketDebuggerUrl")
            .and_then(|v| v.as_str())
            .ok_or("target 缺 webSocketDebuggerUrl")?;

        let mut conn = WsConn::connect(ws)?;
        let resp = conn.call(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
                "userGesture": true,
            }),
        )?;

        if let Some(ex) = resp
            .get("result")
            .and_then(|r| r.get("exceptionDetails"))
        {
            return Err(format!("JS 异常: {ex}"));
        }
        let v = resp
            .get("result")
            .and_then(|r| r.get("result"))
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null);
        Ok(match v {
            Value::String(s) => s,
            other => other.to_string(),
        })
    }

    /// 截图参数。
    pub struct ShotOpts {
        pub full_page: bool,
        /// 只截这个 CSS 选择器命中的元素（取第一个）
        pub selector: Option<String>,
        /// 显式裁剪矩形（页面坐标，CSS 像素）
        pub clip: Option<(f64, f64, f64, f64)>,
        /// 缩放系数；<1 能显著减小 base64 体积
        pub scale: Option<f64>,
        /// 体积上限（字节，指 base64 长度）。超了自动降 scale 重截。
        pub max_bytes: Option<usize>,
    }

    /// 截图，返回 base64（不含 data: 前缀）。
    ///
    /// 支持三种定位：selector 元素、显式 clip、整页。
    /// 大页面会自动降采样：WebView2 整页截图动辄 7MB，
    /// 超过 MCP 客户端单条消息上限会被截断甚至丢弃。
    pub fn screenshot(cdp_port: u16, opts: &ShotOpts) -> Result<String, String> {
        let target = pick_page_target(cdp_port)?;
        let ws = target
            .get("webSocketDebuggerUrl")
            .and_then(|v| v.as_str())
            .ok_or("target 缺 webSocketDebuggerUrl")?;
        let mut conn = WsConn::connect(ws)?;

        // 1) 先算出裁剪矩形
        let mut clip: Option<(f64, f64, f64, f64)> = opts.clip;

        if clip.is_none() {
            if let Some(sel) = &opts.selector {
                // 元素可能不在视口内：先滚进来再量
                let js = format!(
                    r#"(function(){{
  var e=document.querySelector({sel_js});
  if(!e) return JSON.stringify({{err:'not found'}});
  e.scrollIntoView({{block:'center', inline:'center'}});
  var r=e.getBoundingClientRect();
  return JSON.stringify({{
    x:Math.round(r.left+window.scrollX),
    y:Math.round(r.top+window.scrollY),
    w:Math.round(r.width),
    h:Math.round(r.height)
  }});
}})()"#,
                    sel_js = serde_json::to_string(sel).unwrap()
                );
                let m = conn.call(
                    "Runtime.evaluate",
                    json!({"expression": js, "returnByValue": true, "awaitPromise": true}),
                )?;
                let s = m
                    .pointer("/result/result/value")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let dim: Value = serde_json::from_str(s).map_err(|e| format!("量元素失败: {e}"))?;
                if dim.get("err").is_some() {
                    return Err(format!("找不到元素: {sel}"));
                }
                let x = dim.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let y = dim.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let w = dim.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let h = dim.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0);
                if w < 1.0 || h < 1.0 {
                    return Err(format!("元素尺寸为 0（可能被隐藏）: {sel}"));
                }
                clip = Some((x, y, w, h));
            } else if opts.full_page {
                let m = conn.call(
                    "Runtime.evaluate",
                    json!({
                        "expression": "JSON.stringify({w:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth),h:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)})",
                        "returnByValue": true
                    }),
                )?;
                let s = m
                    .pointer("/result/result/value")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if let Ok(dim) = serde_json::from_str::<Value>(s) {
                    let w = dim.get("w").and_then(|v| v.as_f64()).unwrap_or(1280.0);
                    let h = dim.get("h").and_then(|v| v.as_f64()).unwrap_or(720.0);
                    clip = Some((0.0, 0.0, w, h.min(20000.0)));
                }
            }
        }

        // 2) 截图；体积超限就降 scale / 换 JPEG 重截
        //
        // PNG 是无损的：整页 1280×3400 能到 2.7MB，缩到 scale=0.25 仍有 700KB。
        // 想"塞进小上限"只能换有损格式 —— JPEG 同尺寸大约小一个数量级。
        let max_bytes = opts.max_bytes.unwrap_or(3 * 1024 * 1024);
        let mut scale = opts.scale.unwrap_or(1.0);
        let mut fmt = "png".to_string();
        let mut quality = 80i64;

        loop {
            let mut params = json!({"format": fmt});
            if fmt == "jpeg" {
                params["quality"] = json!(quality);
            }
            if let Some((x, y, w, h)) = clip {
                params["captureBeyondViewport"] = json!(true);
                params["clip"] = json!({
                    "x": x, "y": y,
                    "width": w, "height": h,
                    "scale": scale
                });
            }

            let resp = conn.call("Page.captureScreenshot", params)?;
            let data = resp
                .pointer("/result/data")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "截图失败: 无 data".to_string())?
                .to_string();

            if data.len() <= max_bytes {
                // 用 data URL 前缀把实际格式告诉调用方，否则会把 jpeg 当 png 解析
                return Ok(if fmt == "jpeg" {
                    format!("jpeg:{quality}:{data}")
                } else {
                    format!("png:100:{data}")
                });
            }

            // 先降质量（视觉损失小、体积收益大），质量到底了再缩尺寸
            if fmt == "jpeg" && quality > 40 {
                quality -= 20;
                continue;
            }
            if scale > 0.25 {
                let shrink = (max_bytes as f64 / data.len() as f64).sqrt() * 0.85;
                scale = (scale * shrink).max(0.25);
                continue;
            }
            // 尺寸也到底了：换 JPEG 再试一轮
            if fmt == "png" {
                fmt = "jpeg".to_string();
                quality = 70;
                continue;
            }
            // 实在压不下去就返回，让调用方自己决定
            return Ok(format!("jpeg:{quality}:{data}"));
        }
    }

    fn pick_page_target(cdp_port: u16) -> Result<Value, String> {
        // CDP 失效时给可执行的提示，而不是裸的 "os error 10060"。
        // 实测 WebView2 的调试端点会「端口还在监听但完全不应答」，
        // 用户看到超时根本不知道要重启应用。
        let list = http_get(&format!("http://127.0.0.1:{cdp_port}"), "/json/list").map_err(|e| {
            format!(
                "CDP {cdp_port} 无响应（{e}）。\
                 WebView2 的调试端点有时会假死，重启猫窝应用即可恢复。"
            )
        })?;
        let arr: Value = serde_json::from_str(&list).map_err(|e| format!("targets 解析失败: {e}"))?;
        let pages: Vec<&Value> = arr
            .as_array()
            .map(|a| a.iter().filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("page")).collect())
            .unwrap_or_default();
        pages
            .first()
            .map(|v| (*v).clone())
            .ok_or_else(|| format!("没有 page target（CDP {cdp_port} 活着但没有页面）"))
    }

    /// 探测 CDP 是否可用（给 /health 与排障用）。
    pub fn probe(cdp_port: u16) -> bool {
        http_get(&format!("http://127.0.0.1:{cdp_port}"), "/json/version").is_ok()
    }

    /// 极简 HTTP GET，返回 body。
    ///
    /// ⚠️ 不要用 `read_to_end`：CDP 的 /json/list 虽然回了 `Connection: close`，
    /// 但实测不会立刻关连接，`read_to_end` 会一直阻塞到 read timeout
    /// （表现为 "os error 10060 连接尝试失败"，极具误导性）。
    /// 这里按 Content-Length 精确读，读不满再兜底读到 EOF。
    pub fn http_get(base: &str, path: &str) -> Result<String, String> {
        let url = format!("{base}{path}");
        let rest = url
            .strip_prefix("http://")
            .ok_or_else(|| format!("只支持 http: {url}"))?;
        let (host_port, p) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        let mut s = TcpStream::connect(host_port).map_err(|e| format!("连接 {host_port}: {e}"))?;
        s.set_read_timeout(Some(Duration::from_secs(8))).ok();
        let req = format!("GET {p} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
        s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut header_end: Option<usize> = None;
        let mut content_len: Option<usize> = None;

        loop {
            // 头已经齐了并且 body 也够长 → 收工
            if let (Some(he), Some(cl)) = (header_end, content_len) {
                if buf.len() >= he + cl {
                    let body = &buf[he..he + cl];
                    return Ok(String::from_utf8_lossy(body).to_string());
                }
            }
            let n = match s.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    // 已拿到头却没拿全 body，用现有数据尽力而为
                    if header_end.is_some() {
                        break;
                    }
                    return Err(format!("读取响应失败: {e}"));
                }
            };
            buf.extend_from_slice(&chunk[..n]);

            if header_end.is_none() {
                if let Some(i) = find_sub(&buf, b"\r\n\r\n") {
                    let he = i + 4;
                    header_end = Some(he);
                    let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
                    content_len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok());
                }
            }
        }

        match header_end {
            Some(he) => Ok(String::from_utf8_lossy(&buf[he..]).to_string()),
            None => Err("响应没有完整头部".into()),
        }
    }

    fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }

    /// 极简 WebSocket 客户端（只支持 text 帧，够 CDP 用）。
    ///
    /// 为什么要手写：引入 tungstenite 会让依赖翻倍，而这里只需要
    /// 发一两个 JSON-RPC 请求再读回响应。
    struct WsConn {
        stream: TcpStream,
        /// 握手响应之后粘过来的字节（可能含完整帧或半个帧头）。
        /// 必须保留：直接用 TcpStream 读会从中间开始，帧头解析全乱。
        pending: Vec<u8>,
    }

    impl WsConn {
        fn connect(ws_url: &str) -> Result<Self, String> {
            let rest = ws_url
                .strip_prefix("ws://")
                .ok_or_else(|| format!("只支持 ws: {ws_url}"))?;
            let (host_port, path) = match rest.find('/') {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, "/"),
            };
            let mut stream =
                TcpStream::connect(host_port).map_err(|e| format!("ws 连接失败: {e}"))?;
            stream.set_read_timeout(Some(Duration::from_secs(30))).ok();

            let key = "dGhlIHNhbXBsZSBub25jZQ==";
            let req = format!(
                "GET {path} HTTP/1.1\r\n\
                 Host: {host_port}\r\n\
                 Upgrade: websocket\r\n\
                 Connection: Upgrade\r\n\
                 Sec-WebSocket-Key: {key}\r\n\
                 Sec-WebSocket-Version: 13\r\n\r\n"
            );
            stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

            // 读握手响应头
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            let header_end;
            loop {
                let n = stream.read(&mut tmp).map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("ws 握手时连接关闭".into());
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(i) = find_sub(&buf, b"\r\n\r\n") {
                    header_end = i + 4;
                    break;
                }
            }
            let head = String::from_utf8_lossy(&buf[..header_end]);
            if !head.starts_with("HTTP/1.1 101") {
                return Err(format!("ws 握手失败: {}", head.lines().next().unwrap_or("")));
            }
            // ⚠️ 握手响应后面可能已粘了帧（CDP 会立刻推 Page/Runtime 事件）。
            // 丢掉这段会导致后续 recv_text 读到的字节错位，表现为各种诡异超时。
            let leftover = buf[header_end..].to_vec();
            Ok(Self {
                stream,
                pending: leftover,
            })
        }

        fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
            let id = 1;
            let msg = json!({"id": id, "method": method, "params": params}).to_string();
            self.send_text(&msg)?;
            loop {
                let txt = self.recv_text()?;
                let v: Value = serde_json::from_str(&txt).map_err(|e| format!("帧解析: {e}"))?;
                if v.get("id").and_then(|x| x.as_i64()) == Some(id) {
                    if let Some(e) = v.get("error") {
                        return Err(format!("CDP 错误: {e}"));
                    }
                    return Ok(v);
                }
                // 其余是事件，忽略
            }
        }

        fn send_text(&mut self, s: &str) -> Result<(), String> {
            let payload = s.as_bytes();
            let len = payload.len();
            let mut frame = Vec::with_capacity(len + 14);
            frame.push(0x81); // FIN + text
            if len < 126 {
                frame.push(0x80 | len as u8);
            } else if len < 65536 {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(len as u16).to_be_bytes());
            } else {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(len as u64).to_be_bytes());
            }
            // 客户端必须掩码
            let mask = [0x37u8, 0xfa, 0x21, 0x3d];
            frame.extend_from_slice(&mask);
            for (i, b) in payload.iter().enumerate() {
                frame.push(b ^ mask[i % 4]);
            }
            self.stream.write_all(&frame).map_err(|e| e.to_string())
        }

        /// 从 socket + pending 缓冲里精确读 n 字节。
        fn read_exact_buf(&mut self, n: usize) -> Result<Vec<u8>, String> {
            let mut out = Vec::with_capacity(n);
            // 先消费握手残留
            let take = n.min(self.pending.len());
            out.extend_from_slice(&self.pending[..take]);
            self.pending.drain(..take);
            if out.len() < n {
                let need = n - out.len();
                let mut rest = vec![0u8; need];
                self.stream
                    .read_exact(&mut rest)
                    .map_err(|e| format!("读帧失败(需{need}字节): {e}"))?;
                out.extend_from_slice(&rest);
            }
            Ok(out)
        }

        fn recv_text(&mut self) -> Result<String, String> {
            let hdr = self.read_exact_buf(2)?;
            let opcode = hdr[0] & 0x0f;
            let masked = hdr[1] & 0x80 != 0;
            let mut len = (hdr[1] & 0x7f) as u64;
            if len == 126 {
                let b = self.read_exact_buf(2)?;
                len = u16::from_be_bytes([b[0], b[1]]) as u64;
            } else if len == 127 {
                let b = self.read_exact_buf(8)?;
                let mut arr = [0u8; 8];
                arr.copy_from_slice(&b);
                len = u64::from_be_bytes(arr);
            }
            let mut mask = [0u8; 4];
            if masked {
                let m = self.read_exact_buf(4)?;
                mask.copy_from_slice(&m);
            }
            let mut payload = self.read_exact_buf(len as usize)?;
            if masked {
                for (i, b) in payload.iter_mut().enumerate() {
                    *b ^= mask[i % 4];
                }
            }
            match opcode {
                0x1 => Ok(String::from_utf8_lossy(&payload).to_string()),
                0x8 => Err("ws 被对端关闭".into()),
                0x9 => {
                    // ping -> 略（CDP 不主动 ping）
                    Ok(String::new())
                }
                _ => Ok(String::new()),
            }
        }
    }
}
