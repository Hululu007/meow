package com.meow.tv;

import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * 原生输入框的配色。
 *
 * <p><b>为什么要有这个类</b>：原生 {@code AlertDialog} 用的是系统主题
 * （深色机型上反而是一块浅灰底），和我们深色的页面放一起像另一个应用。
 * 而 Java 侧读不到 Web 的 CSS 变量，所以由页面把**当前生效**的颜色
 * （八套主题自动跟随）传过来，这里只管画。
 *
 * <p><b>同一份色板也给配置页用</b>：{@link #save}/{@link #load} 把最近一次
 * 主题存进 SharedPreferences。配置页（{@link SetupActivity}）没有 WebView，
 * 读不到 CSS，只能读这份快照；首次安装时用品牌深色兜底。
 *
 * <p><b>为什么不用自定义 layout</b>：一套 layout 要为标题/输入框/按钮
 * 三块各写样式，还得跟着系统版本适配内边距。直接拿到 AlertDialog 的
 * 子 View 改颜色，改动面最小，系统原有的排版与无障碍行为都保留。
 */
final class InputTheme {

    private static final String PREF = "meow_ui_theme";
    private static final String KEY = "json";

    private int base = 0xFF12141D;      // 对话框底
    private int panel = 0xFF2E3346;     // 输入框底 / 提升面
    private int accent = 0xFF03DAC5;    // 主色（按钮、光标、下划线）
    private int onAccent = 0xFF0A0B11;  // 主色上的字
    private int ink = 0xFFFFFFFF;       // 正文
    private int ink2 = 0xFFB8BDCC;      // 次级文字
    private int ink3 = 0xFF7A8095;      // 次要文字（标题）
    private int warn = 0xFFFF5F00;      // 警告
    private int hot = 0xFFFF0057;       // 错误/危险
    private int field = 0x4D000000;     // 输入框底（半透明黑）
    private int line = 0x1FFFFFFF;      // 描边
    private float radius = 14f;         // dp
    private boolean light;

    static InputTheme parse(String json) {
        InputTheme t = new InputTheme();
        if (json == null || json.isEmpty()) return t;
        try {
            JSONObject o = new JSONObject(json);
            t.base = color(o.optString("base"), t.base);
            t.panel = color(o.optString("elevated"), t.panel);
            t.accent = color(o.optString("accent"), t.accent);
            t.onAccent = color(o.optString("onAccent"), t.onAccent);
            t.ink = color(o.optString("ink"), t.ink);
            t.ink2 = color(o.optString("ink2"), t.ink2);
            t.ink3 = color(o.optString("ink3"), t.ink3);
            t.warn = color(o.optString("warn"), t.warn);
            t.hot = color(o.optString("hot"), t.hot);
            t.field = color(o.optString("field"), t.field);
            t.line = color(o.optString("line"), t.line);
            t.light = o.optBoolean("light", false);
            String r = o.optString("radius", "14px");
            t.radius = Float.parseFloat(r.replace("px", "").trim());
        } catch (Throwable ignore) {
            // 主题解析失败就退回默认深色，不能让输入框因此弹不出来
        }
        return t;
    }

    /** 存最近一次主题（配置页读）。只保存原样 JSON，解析失败由 load 兜底。 */
    static void save(Context c, String json) {
        if (c == null || json == null || json.isEmpty()) return;
        try {
            c.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                    .edit().putString(KEY, json).apply();
        } catch (Throwable ignore) {
            // 主题存不下不该影响任何功能
        }
    }

    /** 读最近一次主题；没有/损坏时返回品牌深色默认值。 */
    static InputTheme load(Context c) {
        try {
            return parse(c.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                    .getString(KEY, ""));
        } catch (Throwable t) {
            return new InputTheme();
        }
    }

    int base() { return base; }
    int panel() { return panel; }
    int accent() { return accent; }
    /** 主按钮获得焦点时的底色：主色提亮 22%，TV 上要能看出焦点换了位置。 */
    int accentFocus() { return blend(accent, 0xFFFFFFFF, 0.22f); }
    int onAccent() { return onAccent; }
    int ink() { return ink; }
    int ink2() { return ink2; }
    int ink3() { return ink3; }
    int warn() { return warn; }
    int hot() { return hot; }
    int field() { return field; }
    int line() { return line; }
    float radius() { return radius; }
    boolean light() { return light; }

    /** 按比例把 a 混向 b（t=0 全是 a，t=1 全是 b），保留 alpha。 */
    private static int blend(int a, int b, float t) {
        int aa = (a >>> 24) & 0xFF;
        int ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
        int br = (b >> 16) & 0xFF, bg = (b >> 8) & 0xFF, bb = b & 0xFF;
        int r = Math.round(ar + (br - ar) * t);
        int g = Math.round(ag + (bg - ag) * t);
        int bl = Math.round(ab + (bb - ab) * t);
        return (aa << 24) | (r << 16) | (g << 8) | bl;
    }

    /** 解析 CSS 颜色：支持 #rgb / #rrggbb / #aarrggbb / rgb() / rgba()。 */
    private static int color(String s, int fallback) {
        if (s == null) return fallback;
        s = s.trim();
        if (s.isEmpty()) return fallback;
        try {
            if (s.startsWith("#")) {
                String h = s.substring(1);
                if (h.length() == 3) {
                    int r = Integer.parseInt("" + h.charAt(0) + h.charAt(0), 16);
                    int g = Integer.parseInt("" + h.charAt(1) + h.charAt(1), 16);
                    int b = Integer.parseInt("" + h.charAt(2) + h.charAt(2), 16);
                    return Color.rgb(r, g, b);
                }
                if (h.length() == 6) {
                    return 0xFF000000 | Integer.parseInt(h, 16);
                }
                if (h.length() == 8) {
                    // CSS 是 #rrggbbaa，Android 是 #aarrggbb
                    long v = Long.parseLong(h, 16);
                    int rr = (int) ((v >> 24) & 0xFF);
                    int gg = (int) ((v >> 16) & 0xFF);
                    int bb = (int) ((v >> 8) & 0xFF);
                    int aa = (int) (v & 0xFF);
                    return Color.argb(aa, rr, gg, bb);
                }
                return fallback;
            }
            if (s.startsWith("rgb")) {
                int l = s.indexOf('(');
                int r2 = s.lastIndexOf(')');
                if (l < 0 || r2 < 0) return fallback;
                // 兼容 rgb(255 255 255 / 0.055) 与 rgba(1,2,3,0.5) 两种写法
                String body = s.substring(l + 1, r2).replace('/', ' ').replace(',', ' ');
                String[] parts = body.trim().split("\\s+");
                if (parts.length < 3) return fallback;
                int rr = clamp255(parts[0]);
                int gg = clamp255(parts[1]);
                int bb = clamp255(parts[2]);
                float a = 1f;
                if (parts.length >= 4) {
                    try { a = Float.parseFloat(parts[3]); } catch (Throwable ignore) { }
                }
                return Color.argb((int) (a * 255), rr, gg, bb);
            }
        } catch (Throwable ignore) {
            // 落到 fallback
        }
        return fallback;
    }

    /** 支持 "255" 与 "100%" 两种写法 */
    private static int clamp255(String p) {
        try {
            if (p.endsWith("%")) {
                return (int) (Float.parseFloat(p.substring(0, p.length() - 1)) * 2.55f);
            }
            return Math.max(0, Math.min(255, Integer.parseInt(p)));
        } catch (Throwable ignore) {
            return 0;
        }
    }

    /** 带圆角的实心块 */
    private GradientDrawable box(int fill, float radiusDp, int strokeColor) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setColor(fill);
        g.setCornerRadius(dp(radiusDp));
        if (strokeColor != 0) g.setStroke((int) dp(1), strokeColor);
        return g;
    }

    /** 计算 dp → px 时用的 Context（applyToDialog 里从 Dialog 自己的 context 取） */
    private Context ctx;

    private float dp(float v) {
        if (ctx == null) return v * 2f;
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                ctx.getResources().getDisplayMetrics());
    }

    void applyToEditText(EditText et) {
        ctx = et.getContext();
        et.setTextColor(ink);
        et.setHintTextColor(ink3);
        // 光标/选中色跟随主色，深色底上默认的黑色光标几乎看不见
        try {
            et.setHighlightColor((accent & 0x00FFFFFF) | 0x44000000);
        } catch (Throwable ignore) { }
        et.setBackground(box(panel, radius, (line & 0x00FFFFFF) | 0x33 << 24));
        int padH = (int) dp(14);
        int padV = (int) dp(11);
        et.setPadding(padH, padV, padH, padV);
        et.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            // API 29+ 才能直接改光标色；更老的系统用主色下划线（系统默认行为）
            try {
                et.setTextCursorDrawable(null);
            } catch (Throwable ignore) { }
        }
    }

    void applyToDialog(AlertDialog dlg) {
        ctx = dlg.getContext();
        Window w = dlg.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(box(base, radius + 4, line));
            WindowManager.LayoutParams lp = w.getAttributes();
            // 电视上默认宽度太窄，文字一长就换行；给一个占屏比例
            lp.width = (int) (ctx.getResources().getDisplayMetrics().widthPixels * 0.62f);
            w.setAttributes(lp);
            if (!light) {
                // 状态栏/导航栏跟着深色，避免顶部亮一条
                try {
                    w.setStatusBarColor(base);
                    w.setNavigationBarColor(base);
                } catch (Throwable ignore) { }
            }
        }
        // 标题、按钮默认是系统主色（紫/蓝），改成我们的强调色与正文色。
        // 用 getIdentifier 而不是 android.R.id.alertTitle：后者在部分 SDK
        // 编译目标下不是可见符号（实测 AGP 这里报"找不到符号"），
        // 而它本来就是 hidden API 的稳定 id 名，按名字查更稳。
        int titleId = ctx.getResources().getIdentifier("alertTitle", "id", "android");
        if (titleId != 0) styleText(dlg.findViewById(titleId), ink, 19, true);
        styleButton(dlg.getButton(AlertDialog.BUTTON_POSITIVE), accent);
        styleButton(dlg.getButton(AlertDialog.BUTTON_NEGATIVE), ink3);
        // 分隔线与背景
        View divider = dlg.findViewById(ctx.getResources()
                .getIdentifier("titleDivider", "id", "android"));
        if (divider != null) divider.setBackgroundColor(line);
    }

    private void styleText(TextView tv, int color, float sp, boolean bold) {
        if (tv == null) return;
        tv.setTextColor(color);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        if (bold) tv.setTypeface(tv.getTypeface(), android.graphics.Typeface.BOLD);
        tv.setPadding(tv.getPaddingLeft(), tv.getPaddingTop(), tv.getPaddingRight(), tv.getPaddingBottom());
    }

    private void styleButton(Button b, int color) {
        if (b == null) return;
        b.setTextColor(color);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        b.setAllCaps(false);
        b.setBackground(new ColorDrawable(Color.TRANSPARENT));
    }
}
