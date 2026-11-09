package platform;

import java.io.IOException;
import java.net.InetSocketAddress;

/**
 * 最小 HTTP 服务端抽象。
 *
 * <p>JVM 侧包装 {@code com.sun.net.httpserver.HttpServer}，Android 侧是
 * {@code ServerSocket} + 报文解析。两者的差异被压在实现里，{@code ApiServer}
 * 启动段的调用形式完全一致。
 */
public abstract class HttpServer {

    /** 处理一个请求；由实现负责把连接关掉。 */
    public interface Handler {
        void handle(HttpExchange exchange) throws IOException;
    }

    /**
     * 起一个监听。
     *
     * @param addr 监听地址；端口 0 表示由系统分配
     * @param backlog 连接排队长度（JVM 侧对应 backlog）
     */
    public static HttpServer create(InetSocketAddress addr, int backlog) throws IOException {
        return ServerProvider.create(addr, backlog);
    }

    /**
     * 注册根路径处理器并启动。
     *
     * <p>只提供「一个根 handler」这一种形态：本项目两条服务（ApiServer /
     * SpiderHost）都是 {@code createContext("/", handler)}，不需要路径前缀路由。
     */
    public abstract void start(Handler handler, int threads) throws IOException;

    /** 实际监听端口（端口传 0 时需要它拿真值）。 */
    public abstract int getPort();

    public abstract void stop();
}
