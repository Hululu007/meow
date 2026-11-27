package com.meow.tv.js;

import android.util.Log;

import com.fongmi.quickjs.QuickJS;

import org.json.JSONObject;

import java.io.IOException;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * TV 端内置的 JS 源加载器（QuickJS）。
 *
 * <p><b>方言：两种都认</b>（2026-11-27 补全）——
 * `spider.__jsEvalReturn()`（vbox / Fongmi，源包主流）与全局 `__JS_SPIDER__`
 * （CatVod / drpy 标准）。判据顺序与 `server/drpy/host.js` 一致，保证同一份
 * .js 源在 TV 与 PC/fpk/Docker 上行为相同。以前只认 vbox，纯 CatVod 形态的源
 * 在 TV 上一律报"不是 vbox 方言"。
 * 与 Fongmi 的 `export default class extends Spider`（ES module）仍不是一回事。
 * 所以这里**没有**搬 Fongmi 的 quickjs 模块（那套 2664 行、39 个全局函数、
 * 依赖 catvod 的 Crypto/Js/Task/Trans 一整套工具类），只做方言需要的最小集。
 *
 * <p><b>宿主只注入两个全局</b>（对 14 个源逐个 grep 统计出来的）：
 * <ul>
 *   <li>`print(...)` — 日志，263 处</li>
 *   <li>`req(url, opts)` — 同步 HTTP，22 处；返回 `{ok,status,content,headers}`</li>
 * </ul>
 * 脚本里的 `fetch` 是它们自己定义的函数（内部调 req），不是宿主注入。
 *
 * <p><b>为什么 req 用同步 bind 而不是 bindAsync</b>：这些脚本写的是
 * `var resp = req(url); resp.content`，没有 await。QuickJS 的 owner 线程在
 * 等 Java 返回，Java 里做 OkHttp 的 execute()（不再回调 JS），不会死锁。
 *
 * <p><b>不支持的</b>：需要 pdfh/pdfa/aesX/md5X 等宿主工具的源（Fongmi 系），
 * 以及 `node:` 整包应用。前者报错信息里会明确说缺哪个函数，而不是静默返空。
 */
public final class QuickJsSpider {

    private static final String TAG = "MeowJs";
    private static final long DEFAULT_TIMEOUT_MS = 20_000;

    /** 每个实例一个 client：cookie 与连接池按站点隔离，避免串味 */
    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .followRedirects(true)
            .build();

    private final String api;
    private final String siteKey;
    private final Map<String, String> cookieJar = new ConcurrentHashMap<>();

    private QuickJS ctx;
    private volatile boolean closed;
    private String userAgent;
    /** 站点 ext 原文，dispatch 里按 playArgOrder 决定播放参数顺序 */
    private String ext = "";

    public QuickJsSpider(String siteKey, String api) {
        this.siteKey = siteKey;
        this.api = api;
    }

    /** 下载并执行脚本。`extend` 原样作为 init 的第一个参数（多数源不用）。 */
    public void init(String extend) throws Exception {
        this.ext = extend == null ? "" : extend;
        String source = download(api);
        if (source == null || source.isEmpty()) {
            throw new IOException("脚本下载失败或为空: " + api);
        }
        ctx = new QuickJS(() -> System.loadLibrary("quickjs-wrapper"));
        // bind 要在 owner 线程跑，但 bind() 内部会 submit；逐个 join 保证顺序
        ctx.bind("print", args -> {
            Log.i(TAG, joinArgs(args));
            return null;
        }).join();
        ctx.bind("req", args -> {
            String url = args.length > 0 ? String.valueOf(args[0]) : "";
            Object opts = args.length > 1 ? args[1] : null;
            return req(url, opts);
        }).join();
        // 脚本可能读的配置全局（vbox 注入约定，缺了也不报错）
        ctx.bind("__meow_siteKey", args -> siteKey).join();

        ctx.evaluate(source, api).get();
        /*
         * 取出导出对象，挂到全局 __meow 上，后续调用都走它。
         *
         * ★ 两种方言都要认（2026-11-27）：
         *   · CatVod / drpy 标准：执行后得到全局 `__JS_SPIDER__`
         *   · vbox / Fongmi：顶层 `var spider = { __jsEvalReturn(){...} }`
         *   以前只认后者（注释还写着"只吃 vbox 方言"），于是纯 CatVod 形态的 .js
         *   源在 TV 上一律报"不是 vbox 方言"，而同一份源在 PC/fpk 的 drpy 里能跑
         *   —— 各端体验不一致。这里补上 __JS_SPIDER__ 分支，与 server/drpy/host.js
         *   的判据顺序保持一致（先 __JS_SPIDER__，再 vbox）。
         */
        final String EXPORT_EXPR =
                "(function(){"
                        + "if (typeof __JS_SPIDER__ !== 'undefined' && __JS_SPIDER__) return __JS_SPIDER__;"
                        + "if (typeof spider !== 'undefined' && spider && typeof spider.__jsEvalReturn === 'function') return spider.__jsEvalReturn();"
                        + "if (typeof __jsEvalReturn === 'function') return __jsEvalReturn();"
                        + "return null"
                        + "})()";
        Object exported = ctx.evaluate(EXPORT_EXPR, api + "#export").get();
        if (exported == null) {
            throw new IllegalStateException(
                    "脚本没有导出 __JS_SPIDER__ 或 spider.__jsEvalReturn()，不是 drpy/vbox 方言");
        }
        ctx.evaluate("var __meow = " + EXPORT_EXPR, api + "#bind").get();
    }

    public String homeContent(boolean filter) throws Exception {
        return callJson("homeContent", String.valueOf(filter));
    }

    /**
     * 按 drpy 的 action 契约分派（协议与 `server/drpy/worker.js` 的 dispatch 逐条对齐）。
     *
     * <p>参数名两套都认：`tid`/`id`、`pg`/`page`、`wd`/`key`。drpy 那边就是这么写的，
     * 我们的后端也按这套发，端上再猜一次只会不一致。
     *
     * @return JSON 字符串；action 不认识或脚本没实现该方法时返回 `{}`
     */
    public String dispatch(String action, JSONObject b) throws Exception {
        JSONObject body = b == null ? new JSONObject() : b;
        switch (action) {
            case "home":
                return callJson("homeContent", "false");
            case "category":
                return callJson("categoryContent",
                        JSONObject.quote(body.optString("tid", body.optString("id", ""))),
                        JSONObject.quote(body.optString("pg", body.optString("page", "1"))),
                        String.valueOf(body.optBoolean("filter", false)),
                        "{}");
            case "detail": {
                org.json.JSONArray ids = body.optJSONArray("ids");
                if (ids == null) {
                    ids = new org.json.JSONArray();
                    ids.put(body.optString("id", ""));
                }
                return callJson("detailContent", ids.toString());
            }
            case "search":
                return callJson("searchContent",
                        JSONObject.quote(body.optString("wd", body.optString("key", ""))),
                        String.valueOf(body.optBoolean("quick", false)));
            case "play": {
                String flag = body.optString("flag", "");
                String id = body.optString("id", "");
                if (playArgOrderIsVbox()) {
                    // vbox 方言：playerContent(vodId, sourceName, episodeId)
                    return callJson("playerContent",
                            JSONObject.quote(id), JSONObject.quote(flag), JSONObject.quote(id));
                }
                return callJson("playerContent",
                        JSONObject.quote(flag), JSONObject.quote(id),
                        body.optJSONArray("vipFlags") == null ? "[]" : body.optJSONArray("vipFlags").toString());
            }
            default:
                return null;
        }
    }

    /** 与 worker.js 同判据：站点 ext 显式写 `{"playArgOrder":"vbox"}` 才换序，不猜 */
    private boolean playArgOrderIsVbox() {
        if (ext == null || ext.isEmpty()) return false;
        try {
            JSONObject e = new JSONObject(ext);
            return "vbox".equals(e.optString("playArgOrder", ""));
        } catch (Exception ignored) {
            return false;
        }
    }

    public String categoryContent(String tid, String pg, boolean filter, Map<String, String> extend) throws Exception {
        return callJson("categoryContent", JSONObject.quote(tid), JSONObject.quote(pg),
                String.valueOf(filter), new JSONObject(extend == null ? new java.util.HashMap<>() : extend).toString());
    }

    public String detailContent(java.util.List<String> ids) throws Exception {
        StringBuilder arr = new StringBuilder("[");
        for (int i = 0; i < ids.size(); i++) {
            if (i > 0) arr.append(',');
            arr.append(JSONObject.quote(ids.get(i)));
        }
        arr.append(']');
        return callJson("detailContent", arr.toString());
    }

    public String searchContent(String key, boolean quick) throws Exception {
        return callJson("searchContent", JSONObject.quote(key), String.valueOf(quick));
    }

    public String playerContent(String flag, String id, java.util.List<String> vipFlags) throws Exception {
        return callJson("playerContent", JSONObject.quote(flag), JSONObject.quote(id), "[]");
    }

    /**
     * 调 `__meow.<method>(args...)` 并把返回值 JSON.stringify 出来。
     *
     * <p>不用 `QuickJS.reference` 是因为参数要经过 Java→JS 的类型映射，
     * 而我们的参数只有字符串/布尔/数字，直接拼（字符串走 JSONObject.quote 转义）
     * 更可预测，出问题时的堆栈也直白。
     */
    private String callJson(String method, String... args) throws Exception {
        if (closed) throw new IllegalStateException("spider 已关闭");
        StringBuilder expr = new StringBuilder("(function(){")
                .append("if (!__meow || typeof __meow.").append(method).append(" !== 'function') return null;")
                .append("var r = __meow.").append(method).append('(');
        for (int i = 0; i < args.length; i++) {
            if (i > 0) expr.append(',');
            expr.append(args[i]);
        }
        expr.append(");")
                .append("if (r === null || r === undefined) return null;")
                .append("return typeof r === 'string' ? r : JSON.stringify(r)")
                .append("})()");
        Object out = ctx.evaluate(expr.toString(), api + "#" + method).get();
        return out == null ? null : String.valueOf(out);
    }

    public synchronized void destroy() {
        if (closed) return;
        closed = true;
        try {
            if (ctx != null) ctx.close();
        } catch (Throwable t) {
            Log.w(TAG, "close quickjs: " + t);
        } finally {
            ctx = null;
        }
    }

    // ── HTTP ────────────────────────────────────────────────────────────

    /**
     * 同步 HTTP，返回 `{ok,status,content,headers}`。
     *
     * <p>options 兼容两种写法（14 个源里都出现过）：
     * `{method, headers, data}` / `{method, headers, body, timeout}`。
     * `data` 与 `body` 等价——vbox 用 data，部分源写 body。
     */
    private Object req(String url, Object opts) {
        JSONObject out = new JSONObject();
        try {
            String method = "GET";
            String body = null;
            JSONObject headers = null;
            int timeoutMs = (int) DEFAULT_TIMEOUT_MS;
            if (opts instanceof JSONObject o) {
                method = o.optString("method", o.optString("type", "GET")).toUpperCase();
                headers = o.optJSONObject("headers");
                body = o.has("data") ? o.optString("data", null)
                        : (o.has("body") ? o.optString("body", null) : null);
                timeoutMs = o.optInt("timeout", (int) DEFAULT_TIMEOUT_MS);
            }

            Request.Builder rb = new Request.Builder().url(url);
            if (headers != null) {
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String k = it.next();
                    String v = headers.optString(k, "");
                    if (k == null || k.isEmpty()) continue;
                    // Host/Content-Length 这类由 OkHttp 自己算，手填反而被拒
                    if (k.equalsIgnoreCase("host") || k.equalsIgnoreCase("content-length")) continue;
                    rb.header(k, v);
                }
            }
            String cookie = cookieJar.get(hostOf(url));
            if (cookie != null && (headers == null || !headers.has("Cookie"))) {
                rb.header("Cookie", cookie);
            }
            if (userAgent != null && (headers == null || !headers.has("User-Agent"))) {
                rb.header("User-Agent", userAgent);
            }

            RequestBody rbBody = null;
            if (body != null && !method.equals("GET") && !method.equals("HEAD")) {
                String ct = headers == null ? null : headers.optString("Content-Type", null);
                MediaType mt = MediaType.parse(ct != null ? ct : "application/x-www-form-urlencoded; charset=utf-8");
                rbBody = RequestBody.create(body, mt);
            }
            rb.method(method, rbBody);

            OkHttpClient client = HTTP.newBuilder()
                    .readTimeout(Math.max(1000, timeoutMs), TimeUnit.MILLISECONDS)
                    .build();

            try (Response resp = client.newCall(rb.build()).execute()) {
                rememberCookies(url, resp);
                ResponseBody rb2 = resp.body();
                String text = rb2 == null ? "" : rb2.string();
                out.put("ok", resp.isSuccessful());
                out.put("status", resp.code());
                out.put("content", text);
                JSONObject hs = new JSONObject();
                for (String name : resp.headers().names()) hs.put(name, resp.header(name));
                out.put("headers", hs);
                out.put("url", resp.request().url().toString());
            }
        } catch (Throwable t) {
            Log.w(TAG, "req failed " + url + ": " + t);
            out = new JSONObject();
            try {
                out.put("ok", false);
                out.put("status", 0);
                out.put("content", "");
                out.put("error", String.valueOf(t.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return new QuickJS.Json(out.toString());
    }

    private void rememberCookies(String url, Response resp) {
        String host = hostOf(url);
        StringBuilder sb = new StringBuilder();
        for (String set : resp.headers("Set-Cookie")) {
            int semi = set.indexOf(';');
            String pair = (semi > 0 ? set.substring(0, semi) : set).trim();
            if (pair.isEmpty()) continue;
            if (sb.length() > 0) sb.append("; ");
            sb.append(pair);
        }
        if (sb.length() > 0) cookieJar.put(host, sb.toString());
    }

    private static String hostOf(String url) {
        try {
            return java.net.URI.create(url).getHost();
        } catch (Exception e) {
            return url;
        }
    }

    /**
     * 取脚本源码。
     *
     * <p>两种 api 形态都要认：
     * <ul>
     *   <li>`js:<源码>` — drpy 的内联语法。本地调试、以及配置里写死小脚本时用它；
     *       不认的话 OkHttp 会抛 `Expected URL scheme 'http' or 'https' but was 'js'`
     *       （实测在 .77 上第一轮就是这个错）。</li>
     *   <li>http(s) URL — 正常下载。</li>
     * </ul>
     */
    private String download(String url) throws IOException {
        if (url.startsWith("js:")) return url.substring(3);
        Request req = new Request.Builder().url(url).build();
        try (Response resp = HTTP.newCall(req).execute()) {
            if (!resp.isSuccessful()) throw new IOException("HTTP " + resp.code() + " " + url);
            ResponseBody b = resp.body();
            return b == null ? "" : b.string();
        }
    }

    /** 脚本里 `req` 的 UA 默认值：多数源自己带 UA，这里只做兜底 */
    public void setUserAgent(String ua) {
        this.userAgent = ua;
    }

    private static String joinArgs(Object[] args) {
        StringBuilder sb = new StringBuilder();
        for (Object a : args) {
            if (sb.length() > 0) sb.append(' ');
            sb.append(a);
        }
        return sb.toString();
    }
}
