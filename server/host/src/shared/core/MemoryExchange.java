package core;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;

import org.json.JSONObject;

import platform.Headers;
import platform.HttpExchange;

/**
 * 在内存里跑一次 handler 的假交换：请求体从字符串读，响应写进缓冲区。
 *
 * <p><b>为什么需要它</b>：导入要下载源 jar 再跑 dex2jar（{@code Dex2Jvm.rewrite}），
 * iOS 上 Zero 解释执行一次 30s~2min。等它结束再回 HTTP 响应，WKWebView 的 fetch
 * 早就断了 —— 服务端写响应抛 {@code Broken pipe}，用户看到"导入失败"，而配置
 * 一个字节都没落盘（2026-11-24 真机实测）。有了这个假交换，同一个
 * {@code handleConfigImport} 可以放到后台线程里跑，先把 202 回给客户端，
 * 结果由前端轮询 {@code GET /api/config/import} 取。
 *
 * <p><b>只支持一次完整请求</b>：不做流式、不分块、request body 必须一次性给全。
 * 导入请求恰好就是这个形状（一个 JSON body），不要拿它跑流式下载。
 */
public final class MemoryExchange extends HttpExchange {

    private final String method;
    private final URI uri;
    private final InputStream requestBody;
    private final Headers requestHeaders = new Headers();
    private final Headers responseHeaders = new Headers();
    private final ByteArrayOutputStream responseBody = new ByteArrayOutputStream();

    private int responseCode;
    private boolean closed;

    public MemoryExchange(String path, String method, String body) {
        this.method = method;
        this.uri = URI.create(path);
        byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        this.requestBody = new ByteArrayInputStream(bytes);
    }

    @Override
    public String getRequestMethod() {
        return method;
    }

    @Override
    public URI getRequestURI() {
        return uri;
    }

    @Override
    public Headers getRequestHeaders() {
        return requestHeaders;
    }

    @Override
    public InputStream getRequestBody() {
        return requestBody;
    }

    @Override
    public OutputStream getResponseBody() {
        return responseBody;
    }

    @Override
    public Headers getResponseHeaders() {
        return responseHeaders;
    }

    @Override
    public void sendResponseHeaders(int rCode, long responseLength) {
        // 不写状态行，只记下来；长度参数在这里没有意义（缓冲区自己会长）
        this.responseCode = rCode;
    }

    @Override
    public void close() {
        closed = true;
    }

    @Override
    public InetSocketAddress getRemoteAddress() {
        return null;
    }

    public int responseCode() {
        return responseCode;
    }

    public boolean isClosed() {
        return closed;
    }

    public String responseText() {
        return new String(responseBody.toByteArray(), StandardCharsets.UTF_8);
    }

    /** 响应体按 JSON 解析；空体或非 JSON（极少数分支直接写文本）返回 null。 */
    public JSONObject responseJson() {
        String text = responseText().trim();
        if (text.isEmpty()) return null;
        try {
            return new JSONObject(text);
        } catch (Exception e) {
            return null;
        }
    }
}
