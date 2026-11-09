package jvm;

import platform.Headers;
import platform.HttpExchange;
import platform.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JVM 侧的 {@link HttpServer}：把 JDK 的 {@code com.sun.net.httpserver} 包一层。
 *
 * <p><b>为什么包一层而不是直接用</b>：Android 上不存在那个包（android.jar 实测
 * 0 条），而 JVM 上又不能自带同名包（javac 报「程序包已存在于另一个模块中:
 * jdk.httpserver」）。两端只能各自向 {@code platform.HttpExchange} 适配，
 * 业务代码才是一份。
 *
 * <p><b>本类只在 JVM 构建里编译</b>（`server/host/src/jvm` 不进 TV 的 sourceSets）。
 */
public final class JvmHttpServer extends HttpServer {

    private final com.sun.net.httpserver.HttpServer impl;

    private JvmHttpServer(com.sun.net.httpserver.HttpServer impl) {
        this.impl = impl;
    }

    /** 供 {@code ServerProvider.autoDetect()} 反射调用。 */
    public static HttpServer create(InetSocketAddress addr, int backlog) throws IOException {
        return new JvmHttpServer(com.sun.net.httpserver.HttpServer.create(addr, backlog));
    }

    @Override
    public void start(Handler handler, int threads) throws IOException {
        impl.createContext("/", ex -> {
            JvmExchange wrapped = new JvmExchange(ex);
            try {
                handler.handle(wrapped);
            } catch (IOException e) {
                throw e;
            } catch (Throwable t) {
                // handler 里抛非 IO 异常时，JDK 会直接吞掉并断开连接，
                // 表现成「请求无响应」且日志空白。这里显式记一笔再向上抛。
                platform.Bridge.log("[http] handler failed: " + t);
                throw new IOException(t);
            } finally {
                wrapped.finish();
            }
        });
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        impl.setExecutor(pool);
        impl.start();
    }

    @Override
    public int getPort() {
        return impl.getAddress().getPort();
    }

    @Override
    public void stop() {
        impl.stop(0);
    }

    // ------------------------------------------------------------------ 适配

    private static final class JvmExchange extends HttpExchange {

        private final com.sun.net.httpserver.HttpExchange ex;
        private final Headers reqHeaders = new Headers();
        private final Headers resHeaders = new Headers();
        private boolean closed;

        JvmExchange(com.sun.net.httpserver.HttpExchange ex) {
            this.ex = ex;
            // 请求头一次性拍平：业务侧只用 getFirst，不需要大小写多值语义
            for (Map.Entry<String, List<String>> e : ex.getRequestHeaders().entrySet()) {
                for (String v : e.getValue()) reqHeaders.add(e.getKey(), v);
            }
        }

        @Override
        public String getRequestMethod() {
            return ex.getRequestMethod();
        }

        @Override
        public URI getRequestURI() {
            return ex.getRequestURI();
        }

        @Override
        public Headers getRequestHeaders() {
            return reqHeaders;
        }

        @Override
        public InputStream getRequestBody() {
            return ex.getRequestBody();
        }

        @Override
        public OutputStream getResponseBody() {
            return ex.getResponseBody();
        }

        @Override
        public Headers getResponseHeaders() {
            return resHeaders;
        }

        @Override
        public void sendResponseHeaders(int rCode, long responseLength) throws IOException {
            // 平台层的 Headers 是自建类型，JDK 的是 Map<String,List<String>> 子类，
            // 必须逐条搬过去；否则业务写的 CORS / Content-Type 全部丢失。
            com.sun.net.httpserver.Headers target = ex.getResponseHeaders();
            for (Map.Entry<String, List<String>> e : resHeaders.asMap().entrySet()) {
                target.put(e.getKey(), e.getValue());
            }
            ex.sendResponseHeaders(rCode, responseLength);
        }

        @Override
        public void close() {
            doClose();
        }

        @Override
        public InetSocketAddress getRemoteAddress() {
            return ex.getRemoteAddress();
        }

        private void doClose() {
            if (closed) return;
            closed = true;
            ex.close();
        }

        /** handler 正常/异常返回后兜底关闭，避免连接挂着不释放。 */
        void finish() {
            doClose();
        }
    }
}
