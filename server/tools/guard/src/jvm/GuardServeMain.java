package jvm;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.*;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.URL;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 加密 Guard 载荷的独立运行时（子进程，socket 协议）。
 *
 * <p>不在 ApiServer 的 JVM 里直接跑：宿主自己的 HTTP 栈/线程池会让壳的 y0.g
 * 请求被中断（实测 ApiServer 内恒空、独立进程里全通）。这里只做最小的事：
 * URLClassLoader + InitOrigin 初始化 + 一个本地 socket 入口。
 */
public final class GuardServeMain {

    static URLClassLoader loader;
    static Object app;
    static final Map<String, Object> SPIDERS = new ConcurrentHashMap<>();
    static int proxyPort;

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: GuardServeMain <payloadJar> [proxyPort]");
            System.exit(2);
        }
        File payload = new File(args[0]);
        proxyPort = args.length > 1 ? Integer.parseInt(args[1].trim()) : 0;
        loader = new URLClassLoader(new URL[]{payload.toURI().toURL()}, GuardServeMain.class.getClassLoader());
        Thread.currentThread().setContextClassLoader(loader);

        boolean selftest = args.length > 2 && "selftest".equals(args[2]);
        ServerSocket server = null;
        if (!selftest) {
            server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
            System.out.println("PORT=" + server.getLocalPort());
            System.out.flush();
        }

        init();

        if (selftest) {
            JSONObject b = new JSONObject();
            b.put("wd", "八仙");
            System.out.println("SELFTEST=" + call(spider("WexAiDuBoKuGuard"), "search", b, "WexAiDuBoKuGuard"));
            return;
        }

        // 请求必须在 main 线程串行处理：壳的 y0.g/OkHttp 在其它线程上会写超时（实测）
        final ServerSocket srv = server;
        final java.util.concurrent.BlockingQueue<Socket> queue = new java.util.concurrent.LinkedBlockingQueue<>();
        Thread acceptor = new Thread(() -> {
            try {
                while (true) queue.put(srv.accept());
            } catch (Throwable ignored) {
            }
        }, "guard-accept");
        acceptor.setDaemon(true);
        acceptor.start();
        while (true) {
            Socket s = queue.take();
            handle(s);
        }
    }

    static void init() {
        try {
            Class<?> appCls = Class.forName("android.app.Application");
            app = appCls.getDeclaredConstructor().newInstance();
            Class<?> io = Class.forName("com.github.catvod.spider.InitOrigin", true, loader);
            if (proxyPort > 0) {
                try {
                    Class<?> po = Class.forName("com.github.catvod.spider.ProxyOrigin", true, loader);
                    po.getField("b").setInt(null, proxyPort);
                } catch (Throwable ignored) {
                }
            }
            io.getMethod("init", Class.forName("android.content.Context")).invoke(null, app);
            System.out.println("[serve] InitOrigin OK proxyPort=" + proxyPort);
        } catch (Throwable t) {
            System.out.println("[serve] InitOrigin FAIL " + t);
            try {
                Class<?> io = Class.forName("com.github.catvod.spider.InitOrigin", true, loader);
                Object inst = io.getMethod("get").invoke(null);
                io.getField("c").set(inst, app);
                Object fd = Class.forName("android.app.Application").getMethod("getFilesDir").invoke(app);
                io.getField("f").set(null, fd instanceof File ? ((File) fd).getPath() : null);
            } catch (Throwable ignored) {
            }
        }
        try {
            Class<?> cfg = Class.forName("com.github.catvod.spider.merge.b0.f", true, loader);
            cfg.getMethod("h").invoke(null);
            System.out.println("[serve] remote config OK");
        } catch (Throwable t) {
            System.out.println("[serve] remote config skipped: " + t);
        }
    }

    static void handle(Socket s) {
        try (Socket sock = s;
             DataInputStream in = new DataInputStream(new BufferedInputStream(sock.getInputStream()));
             DataOutputStream out = new DataOutputStream(new BufferedOutputStream(sock.getOutputStream()))) {
            while (true) {
                String site, action, body;
                try {
                    site = readString(in);
                    action = readString(in);
                    body = readString(in);
                } catch (EOFException eof) {
                    return;
                }
                String resp;
                try {
                    JSONObject b = body == null || body.trim().isEmpty() ? new JSONObject() : new JSONObject(body);
                    resp = call(spider(site), action, b, site);
                } catch (Throwable t) {
                    System.out.println("[serve] " + site + "/" + action + " FAIL " + t);
                    resp = "{\"list\":[],\"msg\":\"guard: " + esc(String.valueOf(t)) + "\"}";
                }
                writeString(out, resp == null ? "" : resp);
                out.flush();
            }
        } catch (Throwable t) {
            System.out.println("[serve] handle FAIL " + t);
        }
    }

    static Object spider(String site) throws Exception {
        Object cached = SPIDERS.get(site);
        if (cached != null) return cached;
        synchronized (SPIDERS) {
            cached = SPIDERS.get(site);
            if (cached != null) return cached;
            String clsName = site;
            int hash = clsName.indexOf('#');
            if (hash > 0) clsName = clsName.substring(0, hash);
            Class<?> c = null;
            try {
                c = Class.forName("com.github.catvod.spider." + clsName, true, loader);
            } catch (Throwable ignored) {
                if (clsName.endsWith("Guard")) {
                    c = Class.forName("com.github.catvod.spider." + clsName.substring(0, clsName.length() - 5), true, loader);
                }
            }
            if (c == null) throw new ClassNotFoundException(site);
            Object o = c.getDeclaredConstructor().newInstance();
            try {
                java.lang.reflect.Field f = o.getClass().getField("siteKey");
                f.set(o, clsName.endsWith("Guard") ? clsName.substring(0, clsName.length() - 5) : clsName);
            } catch (Throwable ignored) {
            }
            try {
                c.getMethod("init", Class.forName("android.content.Context"), String.class).invoke(o, app, "");
            } catch (Throwable ignored) {
            }
            SPIDERS.put(site, o);
            return o;
        }
    }

    static String call(Object spider, String action, JSONObject b, String site) throws Exception {
        synchronized (spider) {
            switch (action) {
                case "home":
                    return str(method(spider, "homeContent", boolean.class).invoke(spider, true));
                case "category": {
                    String id = b.optString("id", b.optString("tid", ""));
                    String page = b.optString("page", b.optString("pg", "1"));
                    HashMap<String, String> filters = new HashMap<>();
                    JSONObject f = b.optJSONObject("filters");
                    if (f != null) {
                        java.util.Iterator<String> it = f.keys();
                        while (it.hasNext()) {
                            String k = it.next();
                            filters.put(k, f.optString(k, ""));
                        }
                    }
                    return str(method(spider, "categoryContent", String.class, String.class, boolean.class, HashMap.class)
                            .invoke(spider, id, page, true, filters));
                }
                case "detail": {
                    String id = b.optString("id", b.optString("ids", ""));
                    String t = id.trim();
                    List<String> ids = (t.startsWith("{") || t.startsWith("["))
                            ? new ArrayList<>(Collections.singletonList(id))
                            : new ArrayList<>(Arrays.asList(id.split(",")));
                    return str(method(spider, "detailContent", List.class).invoke(spider, ids));
                }
                case "search": {
                    String wd = b.optString("wd", "");
                    String pg = b.optString("pg", "1");
                    String out = "";
                    try {
                        out = str(method(spider, "searchContent", String.class, boolean.class, String.class)
                                .invoke(spider, wd, false, pg));
                    } catch (Throwable ignored) {
                    }
                    if (out != null && !out.trim().isEmpty() && !isEmptyList(out)) return out;
                    try {
                        String two = str(method(spider, "searchContent", String.class, boolean.class)
                                .invoke(spider, wd, false));
                        if (two != null && !two.trim().isEmpty() && !isEmptyList(two)) return two;
                        if (out != null && !out.trim().isEmpty()) return out;
                        String quick = str(method(spider, "searchContent", String.class, boolean.class)
                                .invoke(spider, wd, true));
                        if (quick != null && !quick.trim().isEmpty() && !isEmptyList(quick)) return quick;
                        String q3 = str(method(spider, "searchContent", String.class, boolean.class, String.class)
                                .invoke(spider, wd, true, pg));
                        if (q3 != null && !q3.trim().isEmpty() && !isEmptyList(q3)) return q3;
                        return two == null ? "" : two;
                    } catch (Throwable t) {
                        System.out.println("[serve] search " + site + " FAIL " + unwrap(t));
                        return out == null ? "" : out;
                    }
                }
                case "play": {
                    String flag = b.optString("flag", "");
                    String id = b.optString("id", "");
                    try {
                        return str(method(spider, "playerContent", String.class, String.class, List.class)
                                .invoke(spider, flag, id, new ArrayList<String>()));
                    } catch (Throwable t) {
                        return new JSONObject().put("parse", 1).put("url", "")
                                .put("msg", "该线路暂不可用：" + unwrap(t)).toString();
                    }
                }
                case "live":
                    return str(method(spider, "liveContent", String.class)
                            .invoke(spider, b.optString("url", "")));
                case "action":
                    return str(method(spider, "action", String.class)
                            .invoke(spider, b.optString("action", "")));
                default:
                    throw new IllegalArgumentException("unknown action: " + action);
            }
        }
    }

    // ---------------------------------------------------------------- util

    static Method method(Object o, String name, Class<?>... types) throws NoSuchMethodException {
        return o.getClass().getMethod(name, types);
    }

    static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }

    static boolean isEmptyList(String s) {
        if (s == null) return true;
        String t = s.trim();
        if (!t.startsWith("{")) return false;
        try {
            JSONArray a = new JSONObject(t).optJSONArray("list");
            return a == null || a.length() == 0;
        } catch (Throwable e) {
            return false;
        }
    }

    static String unwrap(Throwable t) {
        Throwable r = t;
        while (r.getCause() != null) r = r.getCause();
        return r.getClass().getSimpleName() + (r.getMessage() == null ? "" : ": " + r.getMessage());
    }

    static String readString(DataInputStream in) throws IOException {
        int len = in.readInt();
        byte[] b = new byte[len];
        in.readFully(b);
        return new String(b, StandardCharsets.UTF_8);
    }

    static void writeString(DataOutputStream out, String s) throws IOException {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        out.writeInt(b.length);
        out.write(b);
    }

    static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
