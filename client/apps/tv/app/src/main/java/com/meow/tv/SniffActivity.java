package com.meow.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 页面嗅探：用一个不可见的 WebView 打开播放页，拦请求找媒体地址。
 *
 * <p>为什么必须有它：有些源的播放地址是 JS 现算的（拼接、解密、签名），
 * 服务端抓 HTML 只能拿到源码，算不出最终地址。真浏览器跑一遍是唯一办法。
 * 这条能力只能在 TV/Android 端做——PC 的 WebView2 与后端 JVM 都没有同等控制力。
 *
 * <p>实现照搬 Fongmi `ParseWebView` 的核心思路（拦截 shouldInterceptRequest），
 * 但只保留"找地址"这一件事：不做 Cloudflare 过盾、不做点击脚本执行。
 *
 * <p>失败时一定要有结论：15 秒内没找到就明确返回 null，
 * 让调用方（Web UI）显示"这条线路需要解析但没解析出来"，而不是一直转圈。
 */
@SuppressLint("SetJavaScriptEnabled")
public class SniffActivity extends Activity {

    public static final String EXTRA_PAGE = "page";
    public static final String EXTRA_REFERER = "referer";
    private static final long TIMEOUT_MS = 15_000L;

    /** 媒体地址特征：扩展名或常见流式路径 */
    private static final Pattern MEDIA = Pattern.compile(
            "\\.(m3u8|mp4|flv|mkv|ts)(\\?|$)|/(hls|live|playlist|index)/",
            Pattern.CASE_INSENSITIVE);

    /** 这些不是播放地址：广告、统计、图片、字体 */
    private static final Pattern SKIP = Pattern.compile(
            "(\\.(js|css|png|jpe?g|gif|webp|svg|woff2?|ttf|ico|html?)(\\?|$))"
                    + "|(google|doubleclick|googlesyndication|baidu\\.com|cnzz|umeng"
                    + "|analytics|beacon|sentry|ping)",
            Pattern.CASE_INSENSITIVE);

    private WebView web;
    private TextView tip;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Set<String> found = new LinkedHashSet<>();
    private volatile boolean finished;
    private String pageUrl;

    /** 结果回调：由壳内 JS 通过 TvBridge 读取 */
    private static volatile String result;
    private static volatile boolean running;

    static boolean isRunning() {
        return running;
    }

    static String takeResult() {
        String r = result;
        result = null;
        return r;
    }

    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pageUrl = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_PAGE);
        if (TextUtils.isEmpty(pageUrl)) {
            finishWith(null);
            return;
        }
        running = true;
        result = null;

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        // 不显示给用户：1x1 且透明。用户看到的是"正在解析"提示，不是网页内容
        root.addView(web, new FrameLayout.LayoutParams(1, 1));
        tip = new TextView(this);
        tip.setText("正在解析播放地址…");
        tip.setTextSize(18f);
        tip.setPadding(64, 64, 64, 64);
        root.addView(tip, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " meow-tv");
        // 混合内容：很多播放页是 https 里嵌 http 的播放器
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                try {
                    String u = req.getUrl() == null ? "" : req.getUrl().toString();
                    consider(u);
                } catch (Throwable ignored) {
                }
                // 返回 null = 不拦截，请求照常发（我们只要地址，不要内容）
                return null;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 页面加载完再等一下：播放器初始化常是异步的
                ui.postDelayed(() -> {
                    if (!finished && found.isEmpty()) finishWith(null);
                }, 4_000);
            }
        });

        web.loadUrl(pageUrl);
        ui.postDelayed(() -> {
            if (!finished) finishWith(found.isEmpty() ? null : firstUsable());
        }, TIMEOUT_MS);
    }

    /** 记录一个看起来像播放地址的 URL；命中第一个就结束，不等超时 */
    private void consider(String url) {
        if (finished || TextUtils.isEmpty(url)) return;
        if (!url.startsWith("http")) return;
        if (SKIP.matcher(url).find()) return;
        if (!MEDIA.matcher(url).find()) return;
        synchronized (found) {
            found.add(url);
        }
        // 拿到就结束：继续跑只会拖时间，用户已经等了
        finishWith(url);
    }

    private String firstUsable() {
        synchronized (found) {
            for (String u : found) return u;
        }
        return null;
    }

    private void finishWith(String url) {
        if (finished) return;
        finished = true;
        result = url;
        running = false;
        runOnUiThread(() -> {
            if (tip != null) tip.setText(url == null ? "没找到播放地址" : "已找到");
            // 让提示停留一下再关，用户才知道发生了什么
            ui.postDelayed(() -> {
                if (web != null) {
                    ViewGroup p = (ViewGroup) web.getParent();
                    if (p != null) p.removeView(web);
                    web.destroy();
                    web = null;
                }
                finish();
            }, url == null ? 900 : 250);
        });
    }

    @Override
    protected void onDestroy() {
        finished = true;
        running = false;
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // 用户按返回 = 放弃解析
        finishWith(null);
    }
}
