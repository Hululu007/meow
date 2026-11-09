package com.meow.tv;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import platform.Headers;
import platform.HttpExchange;
import platform.HttpServer;

/**
 * Android 侧的 {@link HttpServer}：{@code ServerSocket} + 手写 HTTP/1.1 报文解析。
 *
 * <p><b>为什么必须自己写</b>：Android 没有 {@code com.sun.net.httpserver}
 * （android.jar 实测 0 条），也没有可用的轻量 HTTP 服务端。而 JVM 上又不能自带
 * 同名包（javac 报「程序包已存在于另一个模块中: jdk.httpserver」），
 * 所以两端都向 {@code platform.HttpServer} 适配，业务代码才是同一份。
 *
 * <p><b>只实现本服务用得到的部分</b>：不需要 chunked 请求体、不需要 keep-alive
 * 流水线、不需要 multipart。前端是本站自己的 JS，请求形态可控；
 * 回 {@code Connection: close} 让每个请求一条连接，避免连接复用状态机的复杂度。
 *
 * <p><b>响应体的长度语义对齐 JDK</b>：{@code >0} 定长，{@code 0} 表示不定长，
 * {@code -1} 表示无体（204/304）。{@code 0} 时按「写完就关连接」处理，
 * 因为这里没有 chunked 编码器。
 */
public final class SocketHttpServer extends HttpServer {

    private static final String TAG = "MeowHttp";

    private final ServerSocket server;
    private volatile boolean running;
    private ExecutorService pool;

    private SocketHttpServer(ServerSocket server) {
        this.server = server;
    }

    /** 供 {@code platform.ServerProvider.autoDetect()} 反射调用。 */
    public static HttpServer create(InetSocketAddress addr, int backlog) throws IOException {
        ServerSocket ss = new ServerSocket();
        ss.setReuseAddress(true);
        ss.bind(new InetSocketAddress(
                addr.getAddress() == null ? InetAddress.getByName("127.0.0.1") : addr.getAddress(),
                addr.getPort()), Math.max(backlog, 8));
        return new SocketHttpServer(ss);
    }

    @Override
    public void start(Handler handler, int threads) {
        running = true;
        pool = Executors.newFixedThreadPool(Math.max(2, threads));
        Thread accept = new Thread(() -> {
            while (running) {
                try {
                    final Socket s = server.accept();
                    pool.submit(() -> serve(s, handler));
                } catch (IOException e) {
                    if (running) android.util.Log.w(TAG, "accept failed", e);
                }
            }
        }, "meow-http-accept");
        accept.setDaemon(true);
        accept.start();
        android.util.Log.i(TAG, "listening on 127.0.0.1:" + getPort());
    }

    @Override
    public int getPort() {
        return server.getLocalPort();
    }

    @Override
    public void stop() {
        running = false;
        try {
            server.close();
        } catch (IOException ignored) {
        }
        if (pool != null) pool.shutdownNow();
    }

    // ------------------------------------------------------------------ 单连接

    private static void serve(Socket socket, Handler handler) {
        // 配置可能刚被 /api/config/import 换掉，而那条路径走的是复用来的后端代码，
        // 不经过本工程的任何类 —— 只能在这里做一次"变了没"的检查，
        // 让 hosts/doh 在导入后立刻生效（见 LocalDns.refreshIfChanged）。
        LocalDns.refreshIfChanged(GatewayServer.appContext());
        // 用显式变量而不是 try-with-resources：catch 里要看"响应头有没有发出去"，
        // 决定是补一条 500 还是静默断开（喷两段报文会把响应彻底弄坏）。
        Exchange ex = null;
        try {
            socket.setSoTimeout(30_000);
            ex = readRequest(socket);
            if (ex == null) return;
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                // 预检必须放行：页面在 http://meow.local，服务在 127.0.0.1 —— 跨源。
                // POST + application/json 属于非简单请求，拿不到 CORS 头就整条请求判死。
                Headers h = ex.getResponseHeaders();
                h.set("Access-Control-Allow-Origin", "*");
                h.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
                h.set("Access-Control-Allow-Headers",
                        "Content-Type,Range,X-Meow-Token,Authorization");
                h.set("Access-Control-Max-Age", "86400");
                ex.sendResponseHeaders(204, -1);
                ex.close();
                return;
            }
            handler.handle(ex);
            // handler 正常返回但没 close 时补一刀：否则连接挂着不放，
            // 客户端等 Content-Length 等不到（前端表现成"请求永远 pending"）。
            ex.close();
        } catch (Throwable t) {
            android.util.Log.w(TAG, "serve failed", t);
            // 已经发过响应头就不能再补错误响应（会把两段报文拼在一起）；
            // 没发过则回一条可读的 500，让前端看到原因而不是干等超时。
            if (ex == null || !ex.headSent()) {
                exSendFallback(socket, t);
            }
        } finally {
            try {
                socket.close();
            } catch (Throwable ignored) {
            }
        }
    }

    /** 尽力回一条 500；连 socket 都不可写就放弃。 */
    private static void exSendFallback(Socket socket, Throwable t) {
        try {
            if (socket == null || socket.isClosed()) return;
            String msg = String.valueOf(t.getClass().getSimpleName()
                    + (t.getMessage() == null ? "" : ": " + t.getMessage()))
                    .replace("\\", "\\\\").replace("\"", "\\\"");
            byte[] body = ("{\"code\":-1,\"msg\":\"" + msg + "\"}")
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            java.io.OutputStream o = socket.getOutputStream();
            String head = "HTTP/1.1 500 Internal Server Error\r\n"
                    + "Content-Type: application/json; charset=utf-8\r\n"
                    + "Content-Length: " + body.length + "\r\n"
                    + "Connection: close\r\n\r\n";
            o.write(head.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            o.write(body);
            o.flush();
        } catch (Throwable ignored) {
        }
    }

    /**
     * 把一条连接解析成 {@link Exchange}。
     *
     * <p><b>全程按字节读</b>：Content-Length 是字节数，用字符流读中文 body 会永远
     * 填不满而阻塞到超时；先 {@code BufferedReader} 读头再切字节流会把 body 前
     * 几 KB 提前吞掉，切过去就是错位。这两个坑都实测踩过。
     */
    private static Exchange readRequest(Socket sock) throws IOException {
        InputStream raw = sock.getInputStream();
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int b;
        while ((b = raw.read()) >= 0) {
            head.write(b);
            int n = head.size();
            if (n >= 4) {
                byte[] a = head.toByteArray();
                if (a[n - 4] == '\r' && a[n - 3] == '\n' && a[n - 2] == '\r' && a[n - 1] == '\n') break;
            }
            if (n > 32768) break;
        }
        if (head.size() == 0) return null;

        String[] lines = new String(head.toByteArray(), StandardCharsets.ISO_8859_1).split("\r?\n");
        String[] first = lines[0].split(" ");
        if (first.length < 2) return null;

        Headers reqHeaders = new Headers();
        long contentLength = 0;
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon <= 0) continue;
            String k = lines[i].substring(0, colon).trim();
            String v = lines[i].substring(colon + 1).trim();
            reqHeaders.add(k, v);
            if ("content-length".equalsIgnoreCase(k)) {
                try {
                    contentLength = Long.parseLong(v);
                } catch (NumberFormatException ignored) {
                }
            }
        }

        byte[] bodyBytes = new byte[0];
        if (contentLength > 0 && contentLength < 64L * 1024 * 1024) {
            ByteArrayOutputStream body = new ByteArrayOutputStream((int) contentLength);
            byte[] buf = new byte[8192];
            long left = contentLength;
            while (left > 0) {
                int n = raw.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) break;
                body.write(buf, 0, n);
                left -= n;
            }
            bodyBytes = body.toByteArray();
        }

        return new Exchange(sock, first[0], first[1], reqHeaders, bodyBytes);
    }

    // ------------------------------------------------------------------ 交换

    private static final class Exchange extends HttpExchange {

        private final Socket sock;
        private final String method;
        private final String rawPath;
        private final Headers reqHeaders;
        private final byte[] body;
        private final Headers resHeaders = new Headers();
        private final OutputStream out;
        private boolean headSent;
        private boolean closed;

        Exchange(Socket sock, String method, String rawPath, Headers reqHeaders, byte[] body)
                throws IOException {
            this.sock = sock;
            this.method = method;
            this.rawPath = rawPath;
            this.reqHeaders = reqHeaders;
            this.body = body;
            this.out = sock.getOutputStream();
        }

        @Override
        public String getRequestMethod() {
            return method;
        }

        @Override
        public URI getRequestURI() {
            // 原始形态是 "/api/x?a=b"（可能含中文未编码）：先按 URI 规则编一遍
            // 再解析，否则 URI.create 会因非法字符抛异常。
            try {
                return URI.create(encodeNonAscii(rawPath));
            } catch (Exception e) {
                return URI.create("/");
            }
        }

        @Override
        public Headers getRequestHeaders() {
            return reqHeaders;
        }

        @Override
        public InputStream getRequestBody() {
            return new java.io.ByteArrayInputStream(body);
        }

        @Override
        public OutputStream getResponseBody() {
            return new java.io.FilterOutputStream(out) {
                @Override
                public void write(byte[] b, int off, int len) throws IOException {
                    ensureHead();
                    super.write(b, off, len);
                }

                @Override
                public void write(int c) throws IOException {
                    ensureHead();
                    super.write(c);
                }
            };
        }

        @Override
        public Headers getResponseHeaders() {
            return resHeaders;
        }

        @Override
        public void sendResponseHeaders(int rCode, long responseLength) throws IOException {
            pendingCode = rCode;
            pendingLength = responseLength;
            headSent = false;
        }

        private int pendingCode = 200;
        private long pendingLength = 0;

        /** 响应头是否真的写到 socket 上了（catch 里据此决定能不能补 500）。 */
        boolean headSent() {
            return headSent;
        }

        /** 头在网上真正发出去的时刻：业务可能先 sendResponseHeaders 再拿 body 写。 */
        private void ensureHead() throws IOException {
            if (headSent) return;
            headSent = true;
            if (pendingCode == 204 || pendingCode == 304) {
                pendingLength = -1;
            }
            StringBuilder sb = new StringBuilder(256);
            sb.append("HTTP/1.1 ").append(pendingCode).append(' ')
                    .append(reason(pendingCode)).append("\r\n");
            for (Map.Entry<String, List<String>> e : resHeaders.asMap().entrySet()) {
                for (String v : e.getValue()) {
                    sb.append(e.getKey()).append(": ").append(v).append("\r\n");
                }
            }
            if (pendingLength > 0) {
                sb.append("Content-Length: ").append(pendingLength).append("\r\n");
            }
            sb.append("Connection: close\r\n\r\n");
            out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
        }

        @Override
        public void close() {
            if (closed) return;
            closed = true;
            try {
                if (!headSent) {
                    // 业务只发了状态没写体（常见于 204/304/304）——补上头
                    ensureHead();
                }
                out.flush();
            } catch (IOException ignored) {
            } finally {
                try {
                    sock.close();
                } catch (IOException ignored) {
                }
            }
        }

        @Override
        public InetSocketAddress getRemoteAddress() {
            return (InetSocketAddress) sock.getRemoteSocketAddress();
        }
    }

    /** 只把非 ASCII 与空格转成 %XX，保留已有的 % 与路径分隔符。 */
    private static String encodeNonAscii(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || c > 0x7e) {
                try {
                    byte[] bytes = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                    for (byte x : bytes) {
                        sb.append('%').append(String.format("%02X", x));
                    }
                } catch (Exception e) {
                    sb.append('%').append("3F");
                }
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String reason(int code) {
        switch (code) {
            case 200: return "OK";
            case 201: return "Created";
            case 204: return "No Content";
            case 206: return "Partial Content";
            case 301: return "Moved Permanently";
            case 302: return "Found";
            case 304: return "Not Modified";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 416: return "Range Not Satisfiable";
            case 429: return "Too Many Requests";
            case 500: return "Internal Server Error";
            case 501: return "Not Implemented";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            default: return "Status";
        }
    }
}
