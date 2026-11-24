package com.meow.tv;

import android.app.Activity;
import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.ui.PlayerView;

import org.json.JSONObject;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * O12（2026-11-21）：同页混合渲染宿主 —— ExoPlayer 层叠在 MainActivity 的
 * WebView 之上（addContentView），网页不跳去 {@link NativePlayerActivity}
 * 就能拿到设备级解码（AC3/E-AC3/DTS 音轨、H265 视频）。
 *
 * <p>与 NativePlayerActivity 的关系：复用同一套 media3 依赖与播放参数，
 * 但**不带弹幕层**（弹幕需要 DanmakuOverlay + 网页 meta 的完整链路，
 * 列入 D1 完整版）；控制条用 PlayerView 自带 UI，返回键由 MainActivity
 * 先问本宿主（可见时 close 并回调网页）。
 *
 * <p>生命周期：{@code show()} 建 player、{@code close()} 释放并回调网页；
 * Activity onPause 时 {@link #flushProgress()} 补一次进度（照抄原生页的
 * 每 12 秒回传 + final 语义，失败静默）。
 */
public class EmbedPlayerHost extends FrameLayout {

    /** 关闭时回调网页（恢复网页播放器状态用），主线程。 */
    public interface Listener {
        void onClosed();
    }

    private static final String[] META_KEYS = {"site", "vod_id", "ep", "flag", "ep_url", "api_base"};

    private PlayerView view;
    private TextView hint;
    private ExoPlayer player;
    /** 电源定时器到点暂停用（同页内嵌播放器）。 */
    private static java.lang.ref.WeakReference<EmbedPlayerHost> ACTIVE =
            new java.lang.ref.WeakReference<>(null);
    private OkHttpClient http;
    private Runnable onClosed;
    private boolean showing = false;
    /** 进度回传坐标（meta 解析而来；缺了就不回传，照抄原生页的静默语义）。 */
    private String pSite = "", pVod = "", pEp = "", pFlag = "", pEpUrl = "", pApiBase = "";
    private double lastReportedPos = 0;
    private final android.os.Handler ui = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable progressTick = this::reportProgress;

    public EmbedPlayerHost(@NonNull Context context) {
        this(context, null);
    }

    public EmbedPlayerHost(@NonNull Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        inflate(context, R.layout.activity_embed_player, this);
        view = findViewById(R.id.embed_player_view);
        hint = findViewById(R.id.embed_hint);
        setVisibility(GONE);
    }

    public boolean isShowing() {
        return showing;
    }

    /**
     * 接管播放。{@code headersJson} 是 <code>k=v&k=v</code> 或 JSON 对象串
     * （与 openNative 同构）；{@code metaJson} 与 openNativeFull 的 meta 同构
     * （site/vod_id/ep/flag/ep_url/api_base），只用于进度回传坐标。
     */
    public void show(String url, String headersJson, long posMs, String metaJson, Runnable closed) {
        Activity act = resolveActivity();
        if (act == null) return;
        this.onClosed = closed;
        Map<String, String> headers = parseHeaders(headersJson);
        parseMeta(metaJson);
        hint.setText(pEp.isEmpty() ? "" : "Embed · " + pEp);
        if (http == null) {
            http = new OkHttpClient.Builder()
                    .followRedirects(true)
                    .followSslRedirects(true)
                    .build();
        }
        setVisibility(VISIBLE);
        DefaultLoadControl load = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(15_000, 30_000, 2_500, 5_000)
                .build();
        player = new ExoPlayer.Builder(act)
                .setLoadControl(load)
                .build();
        player.addListener(new androidx.media3.common.Player.Listener() {
            @Override
            public void onPlayerError(@NonNull PlaybackException error) {
                showTransientHint("播放出错：" + errorCodeName(error));
            }
        });
        view.setPlayer(player);
        MediaSource source = buildSource(url, headers);
        player.setMediaSource(source);
        player.prepare();
        if (posMs > 1000) player.seekTo(posMs);
        player.setPlayWhenReady(true);
        showing = true;
        ACTIVE = new java.lang.ref.WeakReference<>(this);
        ui.postDelayed(progressTick, 12_000);
    }

    /** 倒计时到点暂停：内嵌播放器在播时返回 true（TvBridge 调）。 */
    static boolean pauseForPowerTimer() {
        EmbedPlayerHost h = ACTIVE.get();
        if (h == null || !h.showing) return false;
        ExoPlayer p = h.player;
        if (p == null || !p.isPlaying()) return false;
        h.ui.post(() -> {
            if (h.player != null) h.player.setPlayWhenReady(false);
        });
        return true;
    }

    /** 收起并释放；回调网页（网页据此恢复自己的 UI 状态）。 */
    public void close() {
        if (!showing && player == null) return;
        showing = false;
        reportProgress(true);
        ui.removeCallbacks(progressTick);
        if (player != null) {
            player.release();
            player = null;
        }
        view.setPlayer(null);
        setVisibility(GONE);
        if (ACTIVE.get() == this) ACTIVE = new java.lang.ref.WeakReference<>(null);
        Runnable cb = onClosed;
        onClosed = null;
        if (cb != null) cb.run();
    }

    public void flushProgress() {
        if (showing) reportProgress(true);
    }

    private void reportProgress() {
        reportProgress(false);
    }

    /** 进度回传（照抄 NativePlayerActivity：12s 一次 + final；失败静默）。 */
    private void reportProgress(boolean force) {
        if (player == null || pSite.isEmpty() || pVod.isEmpty() || pApiBase.isEmpty()) return;
        long posMs = player.getCurrentPosition();
        if (posMs < 1000) return;
        double pos = posMs / 1000.0;
        if (!force && Math.abs(pos - lastReportedPos) < 2) return;
        lastReportedPos = pos;
        try {
            JSONObject body = new JSONObject()
                    .put("site", pSite)
                    .put("vod_id", pVod)
                    .put("pos", pos)
                    .put("ep_at", System.currentTimeMillis());
            long durMs = player.getDuration();
            if (durMs > 0) body.put("dur", durMs / 1000.0);
            if (!pFlag.isEmpty()) body.put("flag", pFlag);
            if (!pEp.isEmpty()) body.put("ep", pEp);
            if (!pEpUrl.isEmpty()) body.put("ep_url", pEpUrl);
            String base = pApiBase.endsWith("/") ? pApiBase.substring(0, pApiBase.length() - 1) : pApiBase;
            RequestBody rb = RequestBody.create(body.toString(), MediaType.parse("application/json"));
            http.newCall(new Request.Builder().url(base + "/api/state/progress").post(rb).build())
                    .enqueue(new Callback() {
                        @Override
                        public void onFailure(Call call, IOException e) {
                            android.util.Log.w("MeowEmbed", "progress report failed: " + e);
                        }

                        @Override
                        public void onResponse(Call call, Response response) {
                            response.close();
                        }
                    });
        } catch (Throwable t) {
            android.util.Log.w("MeowEmbed", "progress build failed: " + t);
        }
    }

    private void showTransientHint(String text) {
        hint.setText(text);
        hint.setVisibility(VISIBLE);
        ui.postDelayed(() -> hint.setVisibility(GONE), 3_500);
    }

    private static String errorCodeName(PlaybackException error) {
        switch (error.errorCode) {
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED:
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT:
                return "网络连接失败/超时";
            case PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS:
                return "源站返回错误状态码";
            case PlaybackException.ERROR_CODE_DECODING_FAILED:
            case PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED:
                return "解码失败/格式不支持";
            default:
                return "code " + error.errorCode;
        }
    }

    /** ExoPlayer 构建（照抄 NativePlayerActivity：电视盒子缓冲参数）。 */
    private ExoPlayer buildPlayer(Map<String, String> headers) {
        DefaultLoadControl load = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(15_000, 30_000, 2_500, 5_000)
                .build();
        return new ExoPlayer.Builder(getContext())
                .setLoadControl(load)
                .build();
    }

    /** 按扩展名选 MediaSource：m3u8 走 HLS，其余渐进式（mp4 等）。 */
    private MediaSource buildSource(String url, Map<String, String> headers) {
        Map<String, String> req = new HashMap<>(headers);
        req.remove("User-Agent");
        if (!req.containsKey("Referer") && headers.containsKey("referer")) {
            req.put("Referer", headers.get("referer"));
        }
        OkHttpClient client = http != null ? http : new OkHttpClient();
        OkHttpDataSource.Factory httpFactory = new OkHttpDataSource.Factory(client)
                .setUserAgent(headers.containsKey("User-Agent")
                        ? headers.get("User-Agent") : "meow-tv/1.0")
                .setDefaultRequestProperties(req);
        DefaultDataSource.Factory factory = new DefaultDataSource.Factory(getContext(), httpFactory);
        String lower = url.toLowerCase();
        MediaItem item = MediaItem.fromUri(url);
        return lower.contains(".m3u8")
                ? new HlsMediaSource.Factory(factory).createMediaSource(item)
                : new ProgressiveMediaSource.Factory(factory).createMediaSource(item);
    }

    /** headers 串：JSON 对象或 k=v&k=v 都吃（与 NativePlayerActivity.parseHeaders 同构）。 */
    private static Map<String, String> parseHeaders(String raw) {
        Map<String, String> out = new HashMap<>();
        if (raw == null || raw.isEmpty()) return out;
        String t = raw.trim();
        if (t.startsWith("{")) {
            try {
                JSONObject o = new JSONObject(t);
                java.util.Iterator<String> it = o.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    out.put(k, String.valueOf(o.opt(k)));
                }
                return out;
            } catch (Exception ignored) {
            }
        }
        for (String pair : t.split("&")) {
            int i = pair.indexOf('=');
            if (i > 0) out.put(pair.substring(0, i), pair.substring(i + 1));
        }
        return out;
    }

    private void parseMeta(String metaJson) {
        pSite = "";
        pVod = "";
        pEp = "";
        pFlag = "";
        pEpUrl = "";
        pApiBase = "";
        if (metaJson == null || metaJson.isEmpty()) return;
        try {
            JSONObject o = new JSONObject(metaJson);
            pSite = o.optString("site", "");
            pVod = o.optString("vod", "");
            pEp = o.optString("ep", "");
            pFlag = o.optString("flag", "");
            pEpUrl = o.optString("epUrl", "");
            pApiBase = o.optString("apiBase", "");
        } catch (Exception ignored) {
        }
    }

    @Nullable
    private Activity resolveActivity() {
        Context c = getContext();
        while (c instanceof android.content.ContextWrapper) {
            if (c instanceof Activity) return (Activity) c;
            c = ((android.content.ContextWrapper) c).getBaseContext();
        }
        return null;
    }
}
