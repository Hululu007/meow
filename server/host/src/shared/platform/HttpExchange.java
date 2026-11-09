package platform;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;

/**
 * 与 {@code com.sun.net.httpserver.HttpExchange} 同形的最小 HTTP 交换抽象。
 *
 * <p><b>为什么不用 JDK 那个类</b>：Android 上根本没有 {@code com.sun.net.httpserver}
 * （android.jar 里实测 0 条），而 JVM 上又不能自带同名包——javac 会报
 * 「程序包已存在于另一个模块中: jdk.httpserver」，D8 也一样。所以两端都改用本包，
 * 由各自的传输实现继承。
 *
 * <p><b>为什么是抽象类而不是接口</b>：{@code routes/*} 与 {@code ApiServer} 里
 * 只有 9 个方法被调用，没有一处把它赋给变量或做类型判断，抽象类足够且能保留
 * 将来加默认实现的空间。
 *
 * <p><b>只能有这 9 个方法</b>：全部实现（JVM 包装 / Android Socket）都按这 9 个写。
 * 新增方法会让两端同时要改——先确认真的必要。
 */
public abstract class HttpExchange {

    /** {@code GET} / {@code POST} / {@code OPTIONS} … */
    public abstract String getRequestMethod();

    /** 完整请求 URI（含 query）。 */
    public abstract URI getRequestURI();

    /** 请求头。 */
    public abstract Headers getRequestHeaders();

    /** 请求体；调用方自行读到 EOF。空体返回空流而不是 null。 */
    public abstract InputStream getRequestBody();

    /** 响应体；{@code close()} 时一并关闭。 */
    public abstract OutputStream getResponseBody();

    /** 响应头。必须在 {@code sendResponseHeaders} 之前写。 */
    public abstract Headers getResponseHeaders();

    /**
     * 发出状态行与响应头。
     *
     * <p>语义照抄 JDK：{@code responseLength > 0} 表示有确定长度；
     * {@code 0} 表示 chunked/不限长；{@code -1} 表示无响应体（204/304）。
     */
    public abstract void sendResponseHeaders(int rCode, long responseLength) throws IOException;

    /** 结束这个交换。之后再写响应体无效。 */
    public abstract void close();

    /** 对端地址；取不到时可为 null。 */
    public abstract InetSocketAddress getRemoteAddress();
}
