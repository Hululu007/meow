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
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.ui.PlayerView;

import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

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
    /**
     * 弹幕 XML 地址（我方 /api/proxy/danmaku...）。可选：没有就不画弹幕。
     * 原生播放器自己用 OkHttp 抓，不依赖 WebView。
     */
    public static final String EXTRA_DANMAKU_URL = "danmaku_url";
    /**
     * 网页侧传来的 JSON：site/vod/ep/flag/epUrl/apiBase + dm{opacity,scale,duration,area,block,offset}。
     * 老网页没有这项时全部走默认值（进度不回传、弹幕用默认配置）。
     */
    public static final String EXTRA_META = "meta";
    /**
     * base64 的 meta JSON。与 {@link #EXTRA_URL_B64} 同理：adb shell 会剥掉
     * JSON 里的引号（实测 {"site":...} 变成裸词，am 还会把它当成 intent URI），
     * 验收脚本一律走 base64。
     */
    public static final String EXTRA_META_B64 = "meta_b64";
    /** 验收/排障：屏上显示 items/active/pos/控制栏状态（默认关闭）。 */
    public static final String EXTRA_DEBUG_STATS = "debug_stats";

    private ExoPlayer player;
    private PlayerView view;
    private DanmakuOverlay danmaku;
    private OkHttpClient http;
    private TextView hint;
    private final Handler ui = new Handler(Looper.getMainLooper());
    /** 起播看门狗：15 秒还没有画面就明确报错，而不是一直转圈 */
    private Runnable watchdog;
    /** onVideoSizeChanged 记下的分辨率；READY 时用它出示证（验收 4K 用）。 */
    private String sizeLabel;
    private String titleText = "";
    /* 进度回传：原生播放是独立 Activity，网页收不到 timeupdate */
    private String pSite = "", pVod = "", pEp = "", pFlag = "", pEpUrl = "", pApiBase = "";
    private double lastReportedPos = -1;
    private int dmOffsetMs = 0;
    private String dmBlock = "";
    private final Runnable progressTick = new Runnable() {
        @Override
        public void run() {
            reportProgress(false);
            if (player != null && player.isPlaying()) ui.postDelayed(this, 12_000);
        }
    };

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
        float dmOpacity = 0.9f, dmScale = 1f, dmArea = 0.7f;
        int dmDuration = 12;
        String metaRaw = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_META);
        String metaB64 = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_META_B64);
        if (!TextUtils.isEmpty(metaB64)) {
            try {
                metaRaw = new String(android.util.Base64.decode(metaB64, android.util.Base64.NO_WRAP),
                        java.nio.charset.StandardCharsets.UTF_8);
            } catch (Throwable ignored) { /* 解码失败就用明文 meta */ }
        }
        if (!TextUtils.isEmpty(metaRaw)) {
            try {
                JSONObject meta = new JSONObject(metaRaw);
                pSite = meta.optString("site", "");
                pVod = meta.optString("vod", "");
                pEp = meta.optString("ep", "");
                pFlag = meta.optString("flag", "");
                pEpUrl = meta.optString("epUrl", "");
                pApiBase = meta.optString("apiBase", "");
                JSONObject dm = meta.optJSONObject("dm");
                if (dm != null) {
                    dmOpacity = (float) dm.optDouble("opacity", 0.9);
                    dmScale = (float) dm.optDouble("scale", 1);
                    dmDuration = dm.optInt("duration", 12);
                    dmArea = (float) dm.optDouble("area", 0.7);
                    dmBlock = dm.optString("block", "");
                    dmOffsetMs = (int) Math.round(dm.optDouble("offset", 0) * 1000);
                }
            } catch (Throwable ignored) {
                /* 老/坏 meta 一律当没传，不影响播放 */
            }
        }

        /*
         * 布局走 XML：PlayerView 的 surface_type 必须在构造时就是 texture_view。
         * SurfaceView 会把弹幕层盖住（见 layout 注释），运行时改不了。
         */
        setContentView(R.layout.activity_native_player);
        view = findViewById(R.id.native_player_view);
        danmaku = findViewById(R.id.native_danmaku);
        hint = findViewById(R.id.native_hint);
        titleText = title == null ? "" : title;
        hint.setText(titleText);
        danmaku.setOptions(dmOpacity, dmScale, dmDuration, dmArea);

        http = new OkHttpClient.Builder()
                .followRedirects(true)
                .followSslRedirects(true)
                .build();

        Map<String, String> headers = parseHeaders(
                getIntent() == null ? null : getIntent().getStringExtra(EXTRA_HEADERS));

        player = buildPlayer(headers);
        view.setPlayer(player);
        danmaku.bind(player, () -> view.isControllerFullyVisible());
        String dmUrl = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_DANMAKU_URL);
        if (!TextUtils.isEmpty(dmUrl)) loadDanmaku(dmUrl);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) {
                    cancelWatchdog();
                    // 尺寸回调通常早于 READY；这里再出示 4 秒，否则会被这条 GONE 吃掉
                    if (sizeLabel != null) showSizeHint();
                    else hint.setVisibility(View.GONE);
                }
            }

            /**
             * 视频尺寸一确定就报一次：4K 验收时屏幕上得能看见确实解出了 3840×2160，
             * 否则"没黑屏"不等于"4K 解成功"（可能被 MediaCodec 降级/缩放了）。
             */
            @Override
            public void onVideoSizeChanged(VideoSize size) {
                if (size.width <= 0 || size.height <= 0) return;
                sizeLabel = size.width + "×" + size.height;
                showSizeHint();
            }

            /**
             * 选中轨道确定/切换时记一份编码信息，退出后由 TvBridge.nativeTracks()
             * 回传给网页（面板显示「原生直出 4K HEVC 10-bit」）。
             *
             * 只写 SharedPreferences，不参与播放逻辑；任何异常都吞掉——
             * 轨道信息拿不到最多是面板显示未知，不能因此影响播放。
             */
            @Override
            public void onTracksChanged(androidx.media3.common.Tracks tracks) {
                saveTracks(tracks);
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
        startProgressLoop();

        watchdog = () -> {
            if (player != null && player.getPlaybackState() != Player.STATE_READY) {
                showHint("起播超时（15 秒内没有画面）\n可能是编码不支持或地址失效");
            }
        };
        ui.postDelayed(watchdog, 15_000);
        if (getIntent() != null && getIntent().getBooleanExtra(EXTRA_DEBUG_STATS, false)) {
            danmaku.setDebugDraw(true);
            startDebugStats();
        }
    }

    /** 把选中轨道的编码/分辨率写进 SharedPreferences（见 onTracksChanged）。 */
    private void saveTracks(androidx.media3.common.Tracks tracks) {
        try {
            String vcodec = "";
            String codecs = "";
            String acodec = "";
            int vw = 0;
            int vh = 0;
            int vbr = 0;
            int ach = 0;
            int asr = 0;
            for (androidx.media3.common.Tracks.Group g : tracks.getGroups()) {
                if (!g.isSelected()) continue;
                androidx.media3.common.Format f = g.getTrackFormat(0);
                if (g.getType() == androidx.media3.common.C.TRACK_TYPE_VIDEO) {
                    vcodec = f.sampleMimeType == null ? "" : f.sampleMimeType;
                    codecs = f.codecs == null ? "" : f.codecs;
                    vw = f.width;
                    vh = f.height;
                    vbr = f.bitrate;
                } else if (g.getType() == androidx.media3.common.C.TRACK_TYPE_AUDIO) {
                    acodec = f.sampleMimeType == null ? "" : f.sampleMimeType;
                    ach = f.channelCount;
                    asr = f.sampleRate;
                }
            }
            if (vcodec.isEmpty() && acodec.isEmpty()) return;
            org.json.JSONObject j = new org.json.JSONObject();
            j.put("vcodec", vcodec);
            j.put("codecs", codecs);
            j.put("width", vw);
            j.put("height", vh);
            j.put("bitrate", vbr);
            j.put("acodec", acodec);
            j.put("channels", ach);
            j.put("sampleRate", asr);
            j.put("at", System.currentTimeMillis());
            String json = j.toString();
            String key = pSite + "|" + pVod + "|" + pEp;
            getSharedPreferences("meow_native_tracks", MODE_PRIVATE)
                    .edit()
                    .putString("k:" + key, json)
                    .putString("last", json)
                    .apply();
        } catch (Throwable ignored) {
            /* 轨道信息只是展示用 */
        }
    }

    /** 验收/排障用：每秒把弹幕层内部计数与播放器位置写到屏上。 */
    private void startDebugStats() {
        TextView tv = findViewById(R.id.native_hint);
        if (tv == null) return;
        tv.setTextSize(12f);
        tv.setPadding(24, 24, 24, 24);
        final Runnable tick = new Runnable() {
            @Override public void run() {
                long pos = player == null ? -1 : player.getCurrentPosition();
                boolean ctrl = view != null && view.isControllerFullyVisible();
                if (tv != null) {
                    tv.setVisibility(View.VISIBLE);
                    String ps = player == null ? "?" : (player.isPlaying() ? "1" : "0")
                            + "/" + (player == null ? "?" : (player.getPlayWhenReady() ? "1" : "0"))
                            + "/" + (player == null ? "?" : player.getPlaybackState());
                    tv.setText((danmaku == null ? "no-overlay" : danmaku.debugStats())
                            + " pos=" + (pos / 1000) + "s play=" + ps
                            + " ctrl=" + (ctrl ? 1 : 0));
                }
                ui.postDelayed(this, 1000);
            }
        };
        ui.post(tick);
    }

    /**
     * 抓弹幕 XML 并交给 overlay。
     *
     * <p>失败静默：没有弹幕不该影响看片。XML 是 B 站格式
     * {@code <d p="time,mode,size,color,...">text</d>}。
     */
    private void loadDanmaku(String url) {
        http.newCall(new Request.Builder().url(url).build()).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                android.util.Log.w("MeowNative", "danmaku fetch failed: " + e);
                runOnUiThread(() -> showTransientHint("弹幕获取失败（不影响播放）"));
            }

            @Override
            public void onResponse(Call call, Response response) {
                try (Response r = response) {
                    if (!r.isSuccessful() || r.body() == null) return;
                    String xml = r.body().string();
                    List<DanmakuOverlay.Item> list = parseDanmaku(xml, dmOffsetMs, dmBlock);
                    if (list.isEmpty()) {
                        runOnUiThread(() -> showTransientHint("弹幕为空或解析失败（不影响播放）"));
                    } else {
                        runOnUiThread(() -> danmaku.setItems(list));
                    }
                } catch (Throwable t) {
                    android.util.Log.w("MeowNative", "danmaku parse failed: " + t);
                }
            }
        });
    }

    private static List<DanmakuOverlay.Item> parseDanmaku(String xml, int offsetMs, String blockCsv) {
        List<DanmakuOverlay.Item> out = new ArrayList<>();
        if (xml == null || xml.isEmpty()) return out;
        int rawCount = 0;
        String[] blocks = blockCsv == null ? new String[0]
                : blockCsv.split("[,，\\s]+");
        for (int i = 0; i < blocks.length; i++) blocks[i] = blocks[i].trim();
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("<d p=\"([^\"]*)\"[^>]*>(.*?)</d>", java.util.regex.Pattern.DOTALL)
                .matcher(xml);
        while (m.find()) {
            rawCount++;
            String[] p = m.group(1).split(",");
            if (p.length < 4) continue;
            try {
                double sec = Double.parseDouble(p[0]);
                int mode = (int) Double.parseDouble(p[1]);
                int color = (int) Double.parseDouble(p[3]);
                String text = unescape(m.group(2));
                if (text.isEmpty()) continue;
                boolean blocked = false;
                for (String b : blocks) {
                    if (!b.isEmpty() && text.contains(b)) {
                        blocked = true;
                        break;
                    }
                }
                if (blocked) continue;
                /*
                 * ★ XML 里的 color 是 RGB（如 16777215 = 白），不是 ARGB。
                 * Paint.setColor 要 ARGB，直接传 0x00FFFFFF 的 alpha=0
                 * → 填充画不出来，只剩黑色描边，用户看到的就是"弹幕全黑"
                 * （2026-11-20 投影仪实锤）。这里补不透明 alpha。
                 */
                if (color <= 0) color = Color.WHITE;
                else color = 0xFF000000 | (color & 0xFFFFFF);
                long t = (long) (sec * 1000) + offsetMs;
                if (t < 0) t = 0;
                out.add(new DanmakuOverlay.Item(t, text, mode, color));
            } catch (Throwable ignored) {
            }
        }
        out.sort((a, b) -> Long.compare(a.timeMs, b.timeMs));
        android.util.Log.i("MeowNative", "danmaku raw=" + rawCount + " kept=" + out.size()
                + " offsetMs=" + offsetMs + " block=" + blockCsv);
        return out;
    }

    private static String unescape(String s) {
        return s.replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", "\"").replace("&#39;", "'")
                .replace("&amp;", "&");
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

    /** 原生播放的进度回传：每 12 秒一次 + 离开页面时一次。失败静默（不影响看片）。 */
    private void startProgressLoop() {
        if (pSite.isEmpty() || pVod.isEmpty() || pApiBase.isEmpty()) return;
        ui.postDelayed(progressTick, 12_000);
    }

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
                            android.util.Log.w("MeowNative", "progress report failed: " + e);
                        }

                        @Override
                        public void onResponse(Call call, Response response) {
                            response.close();
                        }
                    });
        } catch (Throwable t) {
            android.util.Log.w("MeowNative", "progress build failed: " + t);
        }
    }

    private void showTransientHint(String text) {
        hint.setText(text);
        hint.setVisibility(View.VISIBLE);
        ui.postDelayed(() -> hint.setVisibility(View.GONE), 3_500);
    }

    private void showSizeHint() {
        if (sizeLabel == null) return;
        String sep = (char) 10 + "";
        hint.setText((titleText.isEmpty() ? "" : titleText + sep) + "画面 " + sizeLabel);
        hint.setVisibility(View.VISIBLE);
        ui.postDelayed(() -> hint.setVisibility(View.GONE), 4_000);
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
        // ESC ≡ 返回：模拟器/外接键盘按 Esc 发的是 KEYCODE_ESCAPE（不是 BACK）
        if (keyCode == KeyEvent.KEYCODE_ESCAPE) {
            finish();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        reportProgress(true);
        super.onPause();
        if (player != null) player.setPlayWhenReady(false);
    }

    @Override
    protected void onDestroy() {
        reportProgress(true);
        ui.removeCallbacks(progressTick);
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
        return open(from, url, title, headers, posMs, null);
    }

    /** @param danmakuUrl 可选；空表示只播视频 */
    static boolean open(Activity from, String url, String title, String headers, long posMs,
                        String danmakuUrl) {
        return open(from, url, title, headers, posMs, danmakuUrl, null);
    }

    /**
     * @param metaJson 网页传的 JSON（进度回传坐标 + 弹幕设置）。空 = 老网页，
     *                 只播视频、不回传进度。
     */
    static boolean open(Activity from, String url, String title, String headers, long posMs,
                        String danmakuUrl, String metaJson) {
        if (TextUtils.isEmpty(url)) return false;
        try {
            Intent i = new Intent(from, NativePlayerActivity.class);
            i.putExtra(EXTRA_URL, url);
            i.putExtra(EXTRA_TITLE, title);
            i.putExtra(EXTRA_HEADERS, headers);
            i.putExtra(EXTRA_POSITION_MS, posMs);
            if (!TextUtils.isEmpty(danmakuUrl)) i.putExtra(EXTRA_DANMAKU_URL, danmakuUrl);
            if (!TextUtils.isEmpty(metaJson)) i.putExtra(EXTRA_META, metaJson);
            from.startActivity(i);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
