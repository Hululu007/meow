package com.meow.tv;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.ui.PlayerView;

import java.util.HashMap;
import java.util.Map;

import okhttp3.OkHttpClient;

/**
 * 端上原生播放页（ExoPlayer）。
 *
 * <p>为什么要有它：原来 TV 只在 WebView 里用 hls.js 播。WebView 的
 * MediaCodec 能力受盒子固件限制，常见的三种失败都是它引起的：
 * HEVC/AV1 不解、Dolby 音轨无声、4K 掉帧。ExoPlayer 直连 MediaCodec，
 * 同一台机器能播的格式明显更多，也省掉 JS 一层。
 *
 * <p>什么时候用它：Web UI 判断"这条线路需要原生播放"时通过 JS 接口
 * {@link TvBridge#openNative} 拉起；播放地址与请求头由页面传过来。
 *
 * <p>不支持的就退回 WebView：拉起失败（没装 ExoPlayer 的机型、
 * 地址格式不对）只提示一句，不阻塞原来的播放路径。
 */
@OptIn(markerClass = UnstableApi.class)
public class NativePlayerActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TITLE = "title";
    /** 逗号分隔的 key=value，供 Referer/UA 等；值里的逗号需要 URL 编码后再传 */
    public static final String EXTRA_HEADERS = "headers";
    public static final String EXTRA_POSITION_MS = "position_ms";
    /**
     * base64 的 url。给人用的 {@link #EXTRA_URL} 保留 —— 但从 adb/shell 传带
     * {@code &} 的签名 URL 时，shell 会把 {@code &} 当命令分隔符切断
     * （实测报 "x-amz-...: inaccessible or not found"）。base64 只有字母数字和
     * {@code +/=}，绝对安全。
     */
    public static final String EXTRA_URL_B64 = "url_b64";

    private ExoPlayer player;
    private PlayerView view;
    private OkHttpClient http;
    private TextView hint;
    private final Handler ui = new Handler(Looper.getMainLooper());
    /** 起播看门狗：15 秒还没有画面就明确报错，而不是一直转圈 */
    private Runnable watchdog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);

        String url = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_URL);
        // base64 版本优先：从 adb 传签名 URL 时必须用它（见 EXTRA_URL_B64 注释）
        String urlB64 = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_URL_B64);
        if (!TextUtils.isEmpty(urlB64)) {
            try {
                url = new String(android.util.Base64.decode(urlB64, android.util.Base64.NO_WRAP),
                        java.nio.charset.StandardCharsets.UTF_8);
            } catch (Throwable ignored) {
                /* 解码失败就退回明文 url */
            }
        }
        if (TextUtils.isEmpty(url)) {
            finish();
            return;
        }
        String title = getIntent().getStringExtra(EXTRA_TITLE);
        long startMs = getIntent().getLongExtra(EXTRA_POSITION_MS, 0L);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        view = new PlayerView(this);
        view.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        view.setUseController(true);
        root.addView(view);

        hint = new TextView(this);
        hint.setTextColor(Color.WHITE);
        hint.setTextSize(16f);
        hint.setPadding(48, 48, 48, 48);
        hint.setText(title == null ? "" : title);
        root.addView(hint, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        setContentView(root);

        http = new OkHttpClient.Builder()
                .followRedirects(true)
                .followSslRedirects(true)
                .build();

        Map<String, String> headers = parseHeaders(
                getIntent() == null ? null : getIntent().getStringExtra(EXTRA_HEADERS));

        player = buildPlayer(headers);
        view.setPlayer(player);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) {
                    cancelWatchdog();
                    hint.setVisibility(View.GONE);
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                cancelWatchdog();
                // 错误要说人话：电视上没人能看堆栈
                showHint("播放失败：" + friendly(error));
            }
        });

        player.setMediaSource(buildSource(url, headers));
        player.prepare();
        if (startMs > 0) player.seekTo(startMs);
        player.setPlayWhenReady(true);

        watchdog = () -> {
            if (player != null && player.getPlaybackState() != Player.STATE_READY) {
                showHint("起播超时（15 秒内没有画面）\n可能是编码不支持或地址失效");
            }
        };
        ui.postDelayed(watchdog, 15_000);
    }

    private ExoPlayer buildPlayer(Map<String, String> headers) {
        // 缓冲参数按电视盒子调：盒子内存小默认值太激进，弱网又会频繁卡顿。
        // 5s/30s 是实测在 2GB 盒子上不 OOM、切集也够快的折中。
        DefaultLoadControl load = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(15_000, 30_000, 2_500, 5_000)
                .build();
        return new ExoPlayer.Builder(this)
                .setLoadControl(load)
                .build();
    }

    /** 按扩展名选 MediaSource：m3u8 走 HLS，其余按渐进式（mp4 等）。 */
    private MediaSource buildSource(String url, Map<String, String> headers) {
        // 自定义头一次性传：OkHttpDataSource.Factory 只接受 Map，
        // 没有逐个 set 的接口（1.4.1 的 API，试过 setDefaultRequestProperty 会编译失败）
        Map<String, String> req = new HashMap<>(headers);
        req.remove("User-Agent");
        if (!req.containsKey("Referer") && headers.containsKey("referer")) {
            req.put("Referer", headers.get("referer"));
        }
        OkHttpDataSource.Factory httpFactory = new OkHttpDataSource.Factory(http)
                .setUserAgent(headers.containsKey("User-Agent")
                        ? headers.get("User-Agent") : "meow-tv/1.0")
                .setDefaultRequestProperties(req);
        DefaultDataSource.Factory factory = new DefaultDataSource.Factory(this, httpFactory);
        String lower = url.toLowerCase();
        boolean isHls = lower.contains(".m3u8") || lower.startsWith("hls");
        MediaItem item = MediaItem.fromUri(url);
        return isHls
                ? new HlsMediaSource.Factory(factory).createMediaSource(item)
                : new ProgressiveMediaSource.Factory(factory).createMediaSource(item);
    }

    /**
     * 解析 {@code k=v} 列表。
     *
     * <p>为什么用这种笨格式而不是 Bundle：Web 侧传过来的是 JS 对象序列化后的
     * 字符串，用 JSON 解析要多引一个解析器；{@code k=v&k=v} 两边都好拼。
     * 值里如果有 & 或 = 由调用方先 URL 编码。
     */
    private static Map<String, String> parseHeaders(String raw) {
        Map<String, String> out = new HashMap<>();
        if (raw == null || raw.trim().isEmpty()) return out;
        for (String pair : raw.split("&")) {
            int i = pair.indexOf('=');
            if (i <= 0) continue;
            String k = decode(pair.substring(0, i).trim());
            String v = decode(pair.substring(i + 1).trim());
            if (!k.isEmpty() && !v.isEmpty()) out.put(k, v);
        }
        return out;
    }

    private static String decode(String s) {
        try {
            return java.net.URLDecoder.decode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    private void showHint(String text) {
        runOnUiThread(() -> {
            hint.setText(text);
            hint.setVisibility(View.VISIBLE);
        });
    }

    /** 把 ExoPlayer 的错误码翻成能看懂的话。 */
    private static String friendly(PlaybackException e) {
        int code = e.errorCode;
        if (code == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS) {
            return "服务器拒绝访问（404/403），可能需要 Referer 或地址已失效";
        }
        if (code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT) {
            return "网络连不上（检查盒子网络或源站是否可达）";
        }
        if (code == PlaybackException.ERROR_CODE_DECODING_FAILED
                || code == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED) {
            return "这台设备解不了这个编码（试试换线路或降到 1080p）";
        }
        if (code == PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED) {
            return "播放列表格式异常（源站返回的不是有效 m3u8）";
        }
        return e.getErrorCodeName();
    }

    private void cancelWatchdog() {
        if (watchdog != null) {
            ui.removeCallbacks(watchdog);
            watchdog = null;
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // 电视遥控：播放/暂停用中间的 OK 键，返回键退出
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) {
            if (player != null) {
                player.setPlayWhenReady(!player.getPlayWhenReady());
                return true;
            }
        }
        if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE && player != null) {
            player.setPlayWhenReady(!player.getPlayWhenReady());
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT && player != null) {
            player.seekTo(Math.max(0, player.getCurrentPosition() - 10_000));
            Toast.makeText(this, "« 10 秒", Toast.LENGTH_SHORT).show();
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT && player != null) {
            player.seekTo(player.getCurrentPosition() + 10_000);
            Toast.makeText(this, "10 秒 »", Toast.LENGTH_SHORT).show();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (player != null) player.setPlayWhenReady(false);
    }

    @Override
    protected void onDestroy() {
        cancelWatchdog();
        if (view != null) view.setPlayer(null);
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    /** 供桥接层打开播放页；失败返回 false（调用方退回 WebView 播放）。 */
    static boolean open(Activity from, String url, String title, String headers, long posMs) {
        if (TextUtils.isEmpty(url)) return false;
        try {
            Intent i = new Intent(from, NativePlayerActivity.class);
            i.putExtra(EXTRA_URL, url);
            i.putExtra(EXTRA_TITLE, title);
            i.putExtra(EXTRA_HEADERS, headers);
            i.putExtra(EXTRA_POSITION_MS, posMs);
            from.startActivity(i);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
