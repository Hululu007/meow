package platform;

import java.io.IOException;
import java.net.InetSocketAddress;

/**
 * 由具体构建决定注入哪一个传输实现。
 *
 * <p><b>为什么两端都用反射探测而不是编译期直接引用</b>：JVM 实现要 import
 * {@code com.sun.net.httpserver}（Android 没有），Android 实现要 import
 * {@code android.content.Context}（JVM 编不过）。两端各自引用对方没有的类，
 * 唯一的单源写法就是按名字探测——缺哪个就说明当前平台是另一端。
 *
 * <p>探测失败时抛一句人能看懂的话，不要让它退化成起服务时的 NPE。
 */
public final class ServerProvider {

    private ServerProvider() {
    }

    /** 构造器签名与 {@link HttpServer#create} 对齐。 */
    public interface Factory {
        HttpServer create(InetSocketAddress addr, int backlog) throws IOException;
    }

    private static volatile Factory factory;

    public static void install(Factory f) {
        factory = f;
    }

    static HttpServer create(InetSocketAddress addr, int backlog) throws IOException {
        Factory f = factory;
        if (f == null) {
            throw new IOException("platform.HttpServer 未初始化：先调用 ServerProvider.autoDetect()");
        }
        return f.create(addr, backlog);
    }

    /**
     * 按当前平台装配传输实现。
     *
     * <p>顺序固定：先 JVM 后 Android。两者互斥（一个镜像里不可能同时存在
     * {@code com.sun.net.httpserver} 与 {@code android.content.Context}），
     * 所以顺序不影响正确性，只影响报错信息。
     */
    public static String autoDetect() {
        if (installByName("jvm.JvmHttpServer", "create")) return "jvm";
        if (installByName("com.meow.tv.SocketHttpServer", "create")) return "android";
        throw new IllegalStateException(
                "找不到 HTTP 传输实现：既没有 jvm.JvmHttpServer，也没有 com.meow.tv.SocketHttpServer");
    }

    private static boolean installByName(String cls, String method) {
        final Class<?> c;
        try {
            c = Class.forName(cls);
        } catch (Throwable notThere) {
            return false;
        }
        install((addr, backlog) -> {
            try {
                return (HttpServer) c.getMethod(method, InetSocketAddress.class, int.class)
                        .invoke(null, addr, backlog);
            } catch (java.lang.reflect.InvocationTargetException e) {
                Throwable cause = e.getCause() == null ? e : e.getCause();
                throw new IOException("起监听失败（" + cls + "）: " + cause, cause);
            } catch (ReflectiveOperationException e) {
                throw new IOException(cls + "." + method + " 不可调用", e);
            }
        });
        return true;
    }
}
