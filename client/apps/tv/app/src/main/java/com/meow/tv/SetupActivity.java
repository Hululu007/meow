package com.meow.tv;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * 配置页：独立 Activity，而不是 MainActivity 里的一个分支。
 *
 * <p><b>为什么必须是独立 Activity</b>：配置错了会导致 WebView 白屏，
 * 而此时用户没有任何退路——返回键在 MainActivity 里是"能后退就后退，
 * 否则回设置页"，但白屏页面往往有历史记录，结果返回键只是在空白页之间跳，
 * 用户就卡死了。独立 Activity 的好处是：进可攻（连接成功才 finish），
 * 退可守（返回键永远能退出，不会困住）。
 *
 * <p><b>三件事解决"配不上"</b>：
 * <ol>
 *   <li><b>自动发现</b>：扫局域网找 {@code /api/health}，列出来点一下就填上，
 *       不用遥控器敲 IP；</li>
 *   <li><b>扫码推送</b>：起一个本地 HTTP 服务，手机扫码在手机上填，推给电视；</li>
 *   <li><b>连接前校验</b>：点「连接」先探一次 {@code /api/health}，
 *       失败就把原因写清楚（拒绝连接/超时/不是猫窝后端），而不是进去看白屏。</li>
 * </ol>
 */
public class SetupActivity extends Activity {

    private EditText urlInput;
    private EditText cfgInput;
    private TextView status;
    private TextView pushInfo;
    private LinearLayout foundBox;
    private Button connectBtn;
    private Button scanBtn;
    private Button pushBtn;
    private Button debugBtn;
    private TextView debugInfo;
    /** 最近一次 Web 主题（由 TvBridge.setUiTheme 存进来）；首次安装是品牌深色 */
    private InputTheme theme;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean scanning;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        theme = InputTheme.load(this);
        buildUi();
        // 进页面就自动扫一次：绝大多数用户会发现列表里已经有自己的服务
        startScan();
    }

    @Override
    protected void onDestroy() {
        PushServer.stop();
        super.onDestroy();
    }

    // ------------------------------------------------------------ UI

    private int dp(int n) {
        return (int) (n * getResources().getDisplayMetrics().density);
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(theme.base());
        // fillViewport：内容不足时撑满，超过时可滚。不设的话 ScrollView 会
        // 按内容高度量一次，嵌套 LinearLayout 在某些 TV 上量出极小高度，
        // 表现为"下面一半控件点不到"（实测过 content 高度只算出 392px）。
        scroll.setFillViewport(true);
        // 软键盘弹出时不要压缩内容：ADJUST_RESIZE 已经在外层设了，
        // 这里再声明一次避免某些 TV 固件把它吃掉。
        scroll.setClipToPadding(false);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        // TV 的 10% 安全边距：老电视过扫描会切掉边缘
        root.setPadding(dp(64), dp(24), dp(64), dp(24));
        // 必须 wrap_content：MATCH_PARENT 会让 root 在 ScrollView 里拿不到
        // 大于视口的高度，底部按钮被裁掉且无法滚动到。
        scroll.addView(root, new android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setText("猫窝 · 连接设置");
        title.setTextColor(theme.ink());
        title.setTextSize(24);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("只需填一个后端地址——界面已经打包进应用，不用再填网页地址。\n"
                + "不知道填什么，就点下面自动发现的条目。");
        sub.setTextColor(theme.ink2());
        sub.setTextSize(14);
        sub.setPadding(0, dp(6), 0, dp(12));
        root.addView(sub);

        // ---- 自动发现
        TextView scanLabel = new TextView(this);
        scanLabel.setText("局域网里的猫窝服务");
        scanLabel.setTextColor(theme.accent());
        scanLabel.setTextSize(15);
        scanLabel.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(scanLabel);

        foundBox = new LinearLayout(this);
        foundBox.setOrientation(LinearLayout.VERTICAL);
        foundBox.setPadding(0, dp(4), 0, dp(2));
        root.addView(foundBox);

        scanBtn = new Button(this);
        styleButton(scanBtn, false);
        scanBtn.setText("重新扫描");
        scanBtn.setOnClickListener(v -> startScan());
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(dp(200), dp(46));
        slp.topMargin = dp(6);
        root.addView(scanBtn, slp);

        // ---- 手动输入
        TextView manual = new TextView(this);
        manual.setText("手动填写");
        manual.setTextColor(theme.ink2());
        manual.setTextSize(15);
        manual.setPadding(0, dp(14), 0, dp(4));
        root.addView(manual);

        urlInput = mkInput("http://192.168.1.10:9979");
        root.addView(urlInput);

        TextView cfgLabel = new TextView(this);
        cfgLabel.setText("CatVod 配置地址（可选，留空用后端自带站点）");
        cfgLabel.setTextColor(theme.ink3());
        cfgLabel.setTextSize(12);
        cfgLabel.setPadding(0, dp(8), 0, dp(2));
        root.addView(cfgLabel);

        cfgInput = mkInput("http://192.168.1.10:30010/config.json");
        root.addView(cfgInput);

        // ---- 操作
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(14), 0, 0);

        connectBtn = new Button(this);
        styleButton(connectBtn, true);
        connectBtn.setText("连接");
        connectBtn.setOnClickListener(v -> connect());
        actions.addView(connectBtn, new LinearLayout.LayoutParams(dp(180), dp(52)));

        pushBtn = new Button(this);
        styleButton(pushBtn, false);
        pushBtn.setText("手机扫码填写");
        pushBtn.setOnClickListener(v -> togglePush());
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(dp(240), dp(52));
        plp.leftMargin = dp(20);
        actions.addView(pushBtn, plp);
        root.addView(actions);

        // ---- 远程调试（默认关）
        TextView debugLabel = new TextView(this);
        debugLabel.setText("远程调试（局域网 PC 验收用）");
        debugLabel.setTextColor(theme.ink3());
        debugLabel.setTextSize(12);
        debugLabel.setPadding(0, dp(16), 0, dp(2));
        root.addView(debugLabel);

        debugBtn = new Button(this);
        styleButton(debugBtn, false);
        debugBtn.setOnClickListener(v -> toggleDebug());
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(280), dp(46));
        root.addView(debugBtn, dlp);

        debugInfo = new TextView(this);
        debugInfo.setTextColor(theme.accent());
        debugInfo.setTextSize(14);
        debugInfo.setPadding(0, dp(8), 0, 0);
        root.addView(debugInfo);

        // ---- 状态
        status = new TextView(this);
        status.setTextColor(theme.warn());
        status.setTextSize(14);
        status.setPadding(0, dp(10), 0, 0);
        root.addView(status);

        pushInfo = new TextView(this);
        pushInfo.setTextColor(theme.accent());
        pushInfo.setTextSize(15);
        pushInfo.setPadding(0, dp(8), 0, 0);
        root.addView(pushInfo);

        TextView foot = new TextView(this);
        foot.setText("按返回键可退出。任何一页按「返回」都能回到这里重新配置。");
        foot.setTextColor(theme.ink3());
        foot.setTextSize(12);
        foot.setPadding(0, dp(12), 0, 0);
        root.addView(foot);

        setContentView(scroll);

        // 回填已保存的值，方便改了再连
        android.content.SharedPreferences sp = getSharedPreferences(MainActivity.PREF, MODE_PRIVATE);
        // 优先新键；老用户升级时从 K_URL 迁移一次
        String savedApi = sp.getString(MainActivity.K_API, "");
        if (savedApi.isEmpty()) savedApi = sp.getString(MainActivity.K_URL, "");
        urlInput.setText(savedApi);
        cfgInput.setText(getSharedPreferences(MainActivity.PREF, MODE_PRIVATE)
                .getString(MainActivity.K_CONFIG, ""));

        // 内核过旧：上一个进入主界面的尝试被判退回来了，直接把原因写在页面上
        if (getSharedPreferences(MainActivity.PREF, MODE_PRIVATE)
                .getString("webview_too_old", "").equals("1")) {
            status.setTextColor(theme.hot());
            status.setText("这台设备的系统 WebView 版本太旧（需要 Chrome 73 / Android 9 以上），"
                    + "内置界面无法运行。请到系统设置里更新「Android System WebView」，"
                    + "或换一台设备。");
        }

        // 初始焦点给「连接」：EditText 抢焦点会立刻弹 IME 盖住整页
        connectBtn.requestFocus();

        refreshDebugUi();
    }

    private EditText mkInput(String hint) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setTextColor(theme.ink());
        e.setHintTextColor(theme.ink3());
        e.setTextSize(17);
        e.setSingleLine(true);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(theme.field());
        bg.setCornerRadius(dp(10));
        bg.setStroke(dp(1), theme.line());
        e.setBackground(bg);
        e.setPadding(dp(16), dp(14), dp(16), dp(14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(54));
        lp.topMargin = dp(6);
        e.setLayoutParams(lp);
        // 焦点变化时换描边色，遥控器上能看出当前在哪
        e.setOnFocusChangeListener((v, has) -> {
            GradientDrawable g = new GradientDrawable();
            g.setColor(theme.field());
            g.setCornerRadius(dp(10));
            g.setStroke(dp(has ? 2 : 1),
                    (has ? theme.accent() : theme.line()));
            v.setBackground(g);
        });
        return e;
    }

    private void styleButton(Button b, boolean primary) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(primary ? theme.accent() : theme.panel());
        bg.setCornerRadius(dp(10));
        if (!primary) bg.setStroke(dp(1), theme.line());
        b.setBackground(bg);
        b.setTextColor(primary ? theme.onAccent() : theme.ink());
        b.setTextSize(16);
        b.setAllCaps(false);
        b.setOnFocusChangeListener((v, has) -> {
            GradientDrawable g = new GradientDrawable();
            g.setColor(primary ? theme.accentFocus() : theme.panel());
            g.setCornerRadius(dp(10));
            if (!primary) g.setStroke(dp(2), (has ? theme.accent() : theme.line()));
            v.setBackground(g);
        });
    }

    // ------------------------------------------------------------ 自动发现

    private void startScan() {
        if (scanning) return;
        scanning = true;
        foundBox.removeAllViews();
        scanBtn.setText("扫描中…");
        scanBtn.setEnabled(false);
        addFoundHint("正在扫描局域网（本机网段 + 常见家用网段，约 5–12 秒）…", theme.ink3());

        new Thread(() -> {
            // 9000ms 而不是 6000：本网段零命中时会自动再扫几个常见家用网段，
            // 预算太小会让兜底阶段还没扫完就被砍断，等于没加这个能力。
            List<LanScan.Found> found = new ArrayList<>(LanScan.scan(null, 9000));
            ui.post(() -> {
                scanning = false;
                scanBtn.setText("重新扫描");
                scanBtn.setEnabled(true);
                foundBox.removeAllViews();
                if (found.isEmpty()) {
                    addFoundHint("没找到。可以直接在下面手填地址（形如 http://192.168.1.10:30010）。"
                            + "模拟器/虚拟机里运行本应用时，自动发现通常扫不到宿主局域网的后端，"
                            + "这是网络隔离导致的，手填即可。", theme.warn());
                    return;
                }
                for (LanScan.Found f : found) {
                    addFoundItem(f);
                }
            });
        }, "lan-scan").start();
    }

    private void addFoundHint(String text, int color) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(color);
        t.setTextSize(13);
        t.setPadding(0, dp(6), 0, dp(6));
        foundBox.addView(t);
    }

    private void addFoundItem(LanScan.Found f) {
        Button b = new Button(this);
        styleButton(b, false);
        b.setText(f.label + "   v" + f.version);
        b.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        b.setPadding(dp(18), 0, dp(18), 0);
        b.setOnClickListener(v -> {
            String u = "http://" + f.host + ":" + f.port;
            // 内置前端后，任何 /api/health 可达的端口都能直接用——
            // 不再需要区分"后端端口"和"网页端口"。
            urlInput.setText(u);
            // 顺手把配置地址也填上：同一个后端，路径固定
            if (cfgInput.getText().toString().trim().isEmpty()) {
                cfgInput.setText(u + "/config.json");
            }
            status.setText("已选中 " + u + "，按「连接」继续");
            status.setTextColor(theme.accent());
            connectBtn.requestFocus();
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        lp.topMargin = dp(4);
        foundBox.addView(b, lp);
    }

    // ------------------------------------------------------------ 扫码推送

    /**
     * 手机页选的导入方式（merge / replace）。
     *
     * <p>手机页只负责把配置地址"推"到这个页面的输入框，真正导入发生在点
     * 「连接」时 —— 所以选择必须跨这两步存住。默认追加：替换会整表换掉，
     * 用户手机上一不小心点错，现有几百站就没了。
     */
    private volatile String pendingImportMode = "merge";

    private void togglePush() {
        if (PushServer.isRunning()) {
            PushServer.stop();
            pushBtn.setText("手机扫码填写");
            pushInfo.setText("");
            return;
        }
        boolean ok = PushServer.start(this, (url, config, prefsJson, importMode) -> ui.post(() -> {
            if (url != null && !url.isEmpty()) urlInput.setText(url);
            if (config != null && !config.isEmpty()) cfgInput.setText(config);
            // 手机页选的导入方式：记下来，点「连接」时随配置地址一起带给后端。
            // 只认两个合法值，其余（老手机页推上来的空串）按默认「追加」处理。
            if ("merge".equals(importMode) || "replace".equals(importMode)) {
                pendingImportMode = importMode;
            }
            // 配置页没有 WebView，prefs 改不了（入口在设置页）。这里明说，
            // 否则用户会以为"手机上改了弹幕、电视没反应"是坏了。
            boolean hasPrefs = prefsJson != null && !prefsJson.isEmpty() && !"{}".equals(prefsJson);
            status.setText(hasPrefs
                    ? "已收到地址；设置项需在主界面的设置页里扫码才能改"
                    : "已收到手机推送，按「连接」继续");
            status.setTextColor(theme.accent());
            connectBtn.requestFocus();
        }));
        if (!ok) {
            pushInfo.setText("无法启动推送服务（可能没连 WiFi）。");
            pushInfo.setTextColor(theme.hot());
            return;
        }
        pushBtn.setText("停止推送");
        String u = PushServer.pushUrl();
        pushInfo.setText("手机浏览器打开：\n" + u + "\n（手机需与电视在同一 WiFi）");
        pushInfo.setTextColor(theme.accent());
    }

    // ------------------------------------------------------------ 远程调试

    /**
     * 远程调试开关。
     *
     * <p><b>为什么只在配置页拨、主界面才起服务</b>：服务的五个端点全部围绕
     * MainActivity 里那个 WebView（执行 JS、截图、按键），配置页没有 WebView，
     * 在这里起一个只会返回 503 的空壳，反而让用户以为已经能验收。
     *
     * <p><b>为什么每次开启都换新令牌</b>：关掉再打开是最省事的「怀疑令牌泄漏了」
     * 的补救动作；沿用旧令牌会让这个动作毫无作用。旧令牌在关掉的同时清空，
     * MainActivity 的 onResume 会拿不到令牌 -> 停服务。
     */
    private void toggleDebug() {
        android.content.SharedPreferences sp = getSharedPreferences(MainActivity.PREF, MODE_PRIVATE);
        if (sp.getBoolean(MainActivity.K_DEBUG, false)) {
            sp.edit().putBoolean(MainActivity.K_DEBUG, false)
                    .remove(MainActivity.K_DEBUG_TOKEN).apply();
            // 立刻停：用户可能就停在配置页不回去了，监听不该继续
            DebugServer.stop();
            refreshDebugUi();
            return;
        }
        sp.edit().putBoolean(MainActivity.K_DEBUG, true)
                .putString(MainActivity.K_DEBUG_TOKEN, DebugServer.newToken()).apply();
        refreshDebugUi();
    }

    private void refreshDebugUi() {
        android.content.SharedPreferences sp = getSharedPreferences(MainActivity.PREF, MODE_PRIVATE);
        boolean on = sp.getBoolean(MainActivity.K_DEBUG, false);
        String tok = sp.getString(MainActivity.K_DEBUG_TOKEN, "");
        if (!on || tok.isEmpty()) {
            debugBtn.setText("开启远程调试");
            debugInfo.setText("");
            return;
        }
        debugBtn.setText("关闭远程调试");
        StringBuilder sb = new StringBuilder();
        // ★ 令牌按 4 位分组、单独放大：投影仪没有 adb，验收方只能**拍屏幕**再读，
        //   32 位连写在一行里从照片上极易看错一位（1/l、0/O）。
        sb.append("令牌（可拍照发给验收方）\n");
        if (tok.length() == 16) {
            sb.append(tok.substring(0, 4)).append('-').append(tok.substring(4, 8)).append('-')
                    .append(tok.substring(8, 12)).append('-').append(tok.substring(12));
        } else {
            sb.append(tok);
        }
        sb.append("\n\n");

        if (DebugServer.isRunning() && tok.equals(DebugServer.token())) {
            String url = DebugServer.url();
            sb.append("地址  ").append(url).append("\n\n");
            // 给出可直接复制的整条命令：验收方拿到照片后照抄就能通，
            // 不用自己拼 header 名（X-Meow-Token 拼错会得到 403，很难自查）
            sb.append("curl -H \"X-Meow-Token: ").append(tok).append("\" ")
                    .append(url).append("/health");
        } else if (DebugServer.isRunning()) {
            // 开关刚拨过：服务还在用旧令牌，回主界面才会用新的重启
            sb.append("返回主界面后生效（当前服务仍用旧令牌）");
        } else {
            String ip = DebugServer.lanIp();
            if (ip == null || ip.isEmpty()) ip = "<电视IP>";
            sb.append("返回主界面后生效\n地址形如 http://").append(ip).append(":9977\n")
                    .append("（9977 被占会顺延，日志 `debugServer=` 里有实际地址）");
        }
        debugInfo.setText(sb.toString());
        debugInfo.setTextColor(theme.accent());
        // 令牌那几行文本要够大，1080p 投影拍出来才清楚
        debugInfo.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 15);
        debugInfo.setLineSpacing(dp(4), 1f);
    }

    // ------------------------------------------------------------ 连接

    private void connect() {
        String u = urlInput.getText().toString().trim();
        if (u.isEmpty()) {
            status.setText("请先填后端地址，或点上面的自动发现条目");
            status.setTextColor(theme.hot());
            urlInput.requestFocus();
            return;
        }
        if (!u.startsWith("http")) u = "http://" + u;
        // 去掉尾部斜杠，避免拼出 //config.json
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        // 用户很容易把 config.json 填到第一个框：自动纠正并提示，
        // 而不是让他进去看白屏（WebView 渲染 JSON 就是一片空）。
        // 用户容易把 config.json 或 /api 填进第一个框：自动裁到根地址。
        if (u.contains("/config.json")) {
            cfgInput.setText(u);
            u = u.substring(0, u.indexOf("/config.json"));
            urlInput.setText(u);
        }
        if (u.endsWith("/api")) u = u.substring(0, u.length() - 4);
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);

        final String target = u;
        connectBtn.setEnabled(false);
        connectBtn.setText("连接中…");
        status.setTextColor(theme.ink2());
        status.setText("正在检查 " + target + " …");

        new Thread(() -> {
            String err = probe(target);
            ui.post(() -> {
                connectBtn.setEnabled(true);
                connectBtn.setText("连接");
                if (err != null) {
                    status.setText(err);
                    status.setTextColor(theme.hot());
                    return;
                }
                String cfgUrl = cfgInput.getText().toString().trim();
                getSharedPreferences(MainActivity.PREF, MODE_PRIVATE)
                        .edit()
                        .putString(MainActivity.K_API, target)
                        // 老键也写：万一还有代码读它
                        .putString(MainActivity.K_URL, target)
                        .putString(MainActivity.K_CONFIG, cfgUrl)
                        .apply();
                // 填了配置地址就先把站点导进去，再进主界面。
                // 之前只存不导，用户填了肥猫 json 却看不到任何变化——
                // 表现为"填了配置也没用"。
                if (!cfgUrl.isEmpty()) {
                    // 必须放后台线程：网络请求在主线程会抛
                    // NetworkOnMainThreadException（实测踩过，导入静默失败）
                    final String ft = target, fc2 = cfgUrl;
                    final String fmode = pendingImportMode;
                    new Thread(() -> importConfig(ft, fc2, fmode), "cfg-import").start();
                }
                PushServer.stop();
                startActivity(new Intent(this, MainActivity.class));
                finish();
            });
        }, "probe").start();
    }

    /**
     * 把配置源导入到后端。
     *
     * <p>后端 {@code /api/config/import} 会抓 url、解析 sites 表，按 {@code mode}
     * 决定是替换现有站点还是追加合并。导入结果（成功多少、跳过多少、为什么跳过）
     * 写进日志——TV 上没有控制台，但用户能通过"首页源变多了"感知到成功。
     *
     * @param mode {@code merge} 或 {@code replace}；空/未知按 merge（不丢站的默认）
     */
    private void importConfig(String base, String cfgUrl, String mode) {
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                    new java.net.URL(base + "/api/config/import").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(30000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            String m = "replace".equals(mode) ? "replace" : "merge";
            byte[] body = ("{\"url\":" + jsonStr(cfgUrl) + ",\"mode\":" + jsonStr(m) + "}")
                    .getBytes("UTF-8");
            c.getOutputStream().write(body);
            int code = c.getResponseCode();
            java.io.InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            StringBuilder sb = new StringBuilder();
            byte[] buf = new byte[2048];
            int n;
            while ((n = in.read(buf)) != -1) sb.append(new String(buf, 0, n, "UTF-8"));
            in.close();
            android.util.Log.i("MeowTv", "config import -> " + code + " " + sb);
            c.disconnect();
        } catch (Exception e) {
            android.util.Log.w("MeowTv", "config import failed: " + e);
        }
    }

    private static String jsonStr(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    /** 探一次后端；没问题返回 null，否则返回给人看的原因。 */
    private String probe(String base) {
        java.net.HttpURLConnection c = null;
        try {
            java.net.URL u = new java.net.URL(base + "/api/health");
            c = (java.net.HttpURLConnection) u.openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(4000);
            int code = c.getResponseCode();
            if (code != 200) return "后端返回 HTTP " + code + "。确认地址和端口是否正确。";
            java.io.InputStream in = c.getInputStream();
            byte[] buf = new byte[4096];
            int n = in.read(buf);
            String text = n <= 0 ? "" : new String(buf, 0, n, "UTF-8");
            org.json.JSONObject o = new org.json.JSONObject(text);
            if (!o.has("version")) {
                return "这个地址能打开，但不是猫窝后端（响应里没有 version）。"
                        + "如果你填的是网盘/NAS 面板，请改填猫窝后端地址。";
            }
            if (!o.optBoolean("ok", false)) {
                return "后端活着但状态异常（ok=false）。请到后端日志看具体原因。";
            }
            return null;
        } catch (java.net.SocketTimeoutException e) {
            return "连接超时。确认设备在同一局域网，且防火墙放行了该端口。";
        } catch (java.net.ConnectException e) {
            return "拒绝连接。后端没启动，或端口不对。";
        } catch (Exception e) {
            return "连接失败：" + e.getClass().getSimpleName();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // 返回键直接退出到桌面（配置页就是栈底，不困住用户）
        // ESC 同效：模拟器/外接键盘按 Esc 发的是 KEYCODE_ESCAPE
        if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
            finish();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
