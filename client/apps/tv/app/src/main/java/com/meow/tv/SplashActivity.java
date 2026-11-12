package com.meow.tv;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 品牌开屏（所有 Android 版本）。
 *
 * <p>为什么有这个 Activity：Android 12+ 有系统 SplashScreen，但 9/10/11 的
 * 电视和投影仪没有——冷启动时只有 {@code windowBackground}，用户看到的是
 * 「黑屏几秒后突然出界面」。这一屏把那段黑屏换成品牌图 + 应用名。
 *
 * <p>为什么最短只停 260ms：超过 300ms 就开始像"故意拖慢启动"。这里只保证
 * 不是闪一下；真正的加载由下一个界面（MainActivity 的品牌窗口底色）接着
 * 显示，两屏同一套视觉，看不出切换。
 *
 * <p>为什么用代码搭 UI 而不是 layout XML：本工程 {@code res/} 下没有
 * layout 目录，全部界面都在 Java 里建；开屏只有三行文字一个图标，加 XML
 * 反而多一份要同步的资源。
 */
public class SplashActivity extends Activity {

    /** 最短展示时间；低于这个值在慢设备上会像"闪了一下" */
    private static final long MIN_SHOW_MS = 260;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean launched;

    private final Runnable launch = new Runnable() {
        @Override
        public void run() {
            if (launched) return;
            launched = true;
            startActivity(new Intent(SplashActivity.this, MainActivity.class));
            overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
            finish();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 开屏期间别让盒子/电视休眠（冷启动本身就要几秒）
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(buildView());
        handler.postDelayed(launch, MIN_SHOW_MS);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(launch);
        super.onDestroy();
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private FrameLayout buildView() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.brand_splash_bg));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        FrameLayout.LayoutParams boxLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        boxLp.gravity = Gravity.CENTER;
        root.addView(box, boxLp);

        ImageView icon = new ImageView(this);
        icon.setImageResource(R.mipmap.ic_launcher);
        box.addView(icon, new LinearLayout.LayoutParams(dp(108), dp(108)));

        TextView name = new TextView(this);
        name.setText("猫窝");
        name.setTextColor(getColor(R.color.brand_splash_ink));
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        name.setLetterSpacing(0.08f);
        name.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams nameLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nameLp.topMargin = dp(20);
        box.addView(name, nameLp);

        TextView en = new TextView(this);
        en.setText("MEOW");
        en.setTextColor(getColor(R.color.brand_splash_dim));
        en.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        en.setLetterSpacing(0.42f);
        en.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams enLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        enLp.topMargin = dp(4);
        box.addView(en, enLp);

        TextView hint = new TextView(this);
        hint.setText("正在启动…");
        hint.setTextColor(getColor(R.color.brand_splash_dim));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.topMargin = dp(28);
        box.addView(hint, hintLp);
        return root;
    }
}
