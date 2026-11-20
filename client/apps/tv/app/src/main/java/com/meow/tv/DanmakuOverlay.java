package com.meow.tv;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.util.AttributeSet;
import android.view.View;

import androidx.media3.common.Player;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

/**
 * 轻量弹幕层（Canvas 自绘）。
 *
 * <p>为什么自己画而不是引库：media3 至今没有官方 DanmakuView（1.9.0 的
 * media3-ui / media3-ui-compose 里都没有 danmaku 类），而 B 站的
 * DanmakuFlameMaster 只发在 jitpack、老且与 ExoPlayer 无集成。这里只需要
 * 「滚动 + 顶/底静态」两种模式，自绘 300 行可控、零依赖。
 *
 * <p>与播放器的关系：只读 {@link Player#getCurrentPosition()}，不控制播放。
 * 位置跳变 > 2.5 秒视为 seek，清空在场弹幕重新开始，避免"拖完进度弹幕
 * 一次性糊满屏"。
 */
public class DanmakuOverlay extends View {

    /** 一条弹幕。mode 用 B 站约定：1/2/3 滚动，4 底部，5 顶部。 */
    public static class Item {
        final long timeMs;
        final String text;
        final int mode;
        final int color;

        public Item(long timeMs, String text, int mode, int color) {
            this.timeMs = timeMs;
            this.text = text == null ? "" : text;
            this.mode = mode;
            this.color = color;
        }
    }

    /** 控制栏可见时让路：弹幕盖在控件上很难看 */
    public interface ControllerProbe {
        boolean visible();
    }

    private static final long STATIC_MS = 4_000L;
    private static final long SPAWN_WINDOW_MS = 1_200L;
    /** 同车道两次投放的最小间隔：防止密集段两条弹幕贴在一起 */
    private static final long LANE_GAP_MS = 350L;

    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint outline = new Paint(Paint.ANTI_ALIAS_FLAG);

    private List<Item> items = Collections.emptyList();
    private Player player;
    private ControllerProbe controllerProbe;
    private boolean enabled = true;

    private final List<Active> active = new ArrayList<>();
    private long lastPosMs = -1;

    private float textSize = 32f;
    private float laneH = 48f;
    private int lanes = 8;
    /** 顶部/底部静态弹幕各预留几行；滚动弹幕只在中间走 */
    private int topRows = 2;
    private int bottomRows = 2;
    /** 这些是可被网页设置覆盖的项（2026-11-20：不再写死 40%/12s） */
    private float opacity = 0.9f;
    private float scale = 1f;
    private long scrollMs = 12_000L;
    private float areaRatio = 0.7f;
    private final long[] laneLastAt = new long[64];
    /** 验收/排障计数（只在 debug 打开时展示，不参与渲染决策） */
    private long spawnedCount = 0, removedCount = 0;
    private boolean debugDraw = false;
    private final Paint debugPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    private static final class Active {
        final Item item;
        float x;
        float w;
        int lane;
        final long bornAt;

        Active(Item item, int lane, long bornAt) {
            this.item = item;
            this.lane = lane;
            this.bornAt = bornAt;
        }
    }

    public DanmakuOverlay(Context context) {
        super(context);
        init();
    }

    /** XML 里 <com.meow.tv.DanmakuOverlay> 必须走这个构造器，否则 inflate 直接崩。 */
    public DanmakuOverlay(Context context, AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    public DanmakuOverlay(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        init();
    }

    private void init() {
        setWillNotDraw(false);
        debugPaint.setColor(Color.RED);
        debugPaint.setStyle(Paint.Style.FILL);
        setClickable(false);
        setFocusable(false);
        outline.setStyle(Paint.Style.STROKE);
        outline.setStrokeWidth(3f);
        outline.setColor(Color.BLACK);
        fill.setColor(Color.WHITE);
        fill.setTextAlign(Paint.Align.LEFT);
        outline.setTextAlign(Paint.Align.LEFT);
    }

    public void bind(Player p, ControllerProbe probe) {
        player = p;
        controllerProbe = probe;
    }

    /**
     * 套用网页的弹幕设置（透明度/字号/速度/区域）。
     *
     * <p>不传就保持默认（0.9 / 1x / 12s / 70%），与网页默认一致；
     * 老网页没有这些字段时不会把原生端调歪。
     */
    public void setOptions(float opacity, float scale, int durationSec, float areaRatio) {
        this.opacity = Math.max(0.1f, Math.min(1f, opacity));
        this.scale = Math.max(0.5f, Math.min(2f, scale));
        this.scrollMs = Math.max(4, Math.min(30, durationSec)) * 1000L;
        this.areaRatio = Math.max(0.2f, Math.min(1f, areaRatio));
        active.clear();
        recomputeMetrics();
        postInvalidateOnAnimation();
    }

    public void setItems(List<Item> list) {
        items = list == null ? Collections.<Item>emptyList() : list;
        active.clear();
        lastPosMs = -1;
        postInvalidateOnAnimation();
    }

    public void setEnabled(boolean on) {
        enabled = on;
        if (!on) active.clear();
        postInvalidateOnAnimation();
    }

    public boolean hasItems() {
        return !items.isEmpty();
    }

    /** 验收/排障：已解析条数。 */
    public int itemCount() { return items.size(); }

    /** 验收/排障：当前在场条数。 */
    public int activeCount() { return active.size(); }

    /** 验收/排障：打开后画一个固定红块 + 计数，用来区分"没画"和"画到屏外"。 */
    public void setDebugDraw(boolean on) { debugDraw = on; postInvalidateOnAnimation(); }

    public String debugStats() {
        return "items=" + items.size() + " active=" + active.size()
                + " spawned=" + spawnedCount + " removed=" + removedCount
                + " lanes=" + lanes + " top=" + topRows + " bot=" + bottomRows
                + " text=" + (int) textSize;
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        recomputeMetrics();
    }

    /**
     * 字号/车道/区域全部按网页设置重算。
     *
     * <p>顶/底静态各占 2 行（区域小则 1 行），滚动从 topRows 开始；
     * 不分开的话密集时静态弹幕会压在滚动弹幕上（2026-11-20 真机截图可见）。
     */
    private void recomputeMetrics() {
        int h = getHeight();
        if (h <= 0) return;
        textSize = Math.max(18f, Math.min(56f, (h / 32f) * scale));
        fill.setTextSize(textSize);
        outline.setTextSize(textSize);
        fill.setAlpha((int) (255 * opacity));
        outline.setAlpha((int) (255 * Math.min(1f, opacity * 0.85f)));
        laneH = textSize * 1.5f;
        lanes = Math.max(3, (int) ((h * areaRatio) / laneH));
        topRows = lanes >= 8 ? 2 : (lanes >= 5 ? 1 : 0);
        bottomRows = topRows;
        if (lanes - topRows - bottomRows < 2) {
            topRows = 0;
            bottomRows = 0;
            lanes = Math.max(3, lanes);
        }
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (!enabled || items.isEmpty() || player == null) return;
        if (controllerProbe != null && controllerProbe.visible()) {
            postInvalidateOnAnimation();
            return;
        }

        long pos = player.getCurrentPosition();
        if (lastPosMs < 0 || Math.abs(pos - lastPosMs) > 2_500L) {
            active.clear();
        }
        lastPosMs = pos;

        spawn(pos);
        drawActive(canvas, pos);

        if (debugDraw) {
            // 固定参考块：能看到它 = Canvas 通路正常，问题在弹幕坐标/透明度
            canvas.drawRect(getWidth() - 90f, 30f, getWidth() - 40f, 80f, debugPaint);
            debugPaint.setTextSize(22f);
            debugPaint.setColor(Color.RED);
            canvas.drawText("SPAWN=" + spawnedCount, getWidth() - 300f, 120f, debugPaint);
        }

        /*
         * 续帧契约（2026-11-20 投影仪实测两次踩坑）：
         * 起播时 onDraw 先跑在缓冲阶段，player.isPlaying() 还是 false。
         * 只在 true 时续帧，链条会断在第一次缓冲上——之后再没人 invalidate，
         * spawned 永远停在 0/1，屏幕上一根弹幕都没有（数据与设置其实都对）。
         * 播放中 60fps；非播放态用 300ms 惰性帧兜住"开播/切集/让路恢复"，
         * 也不至于暂停时白转 60fps。
         */
        if (player.isPlaying()) postInvalidateOnAnimation();
        else postInvalidateDelayed(300);
    }

    /** 把 [pos-1.2s, pos] 内还没上场的弹幕放进活跃表 */
    private void spawn(long pos) {
        int i = lowerBound(pos - SPAWN_WINDOW_MS);
        for (; i < items.size(); i++) {
            Item it = items.get(i);
            if (it.timeMs > pos) break;
            if (it.timeMs < pos - SPAWN_WINDOW_MS) continue;
            if (contains(it)) continue;
            Active a = new Active(it, -1, pos);
            a.w = fill.measureText(it.text);
            if (it.mode == 4 || it.mode == 5) {
                a.lane = staticLane(it.mode);
                if (a.lane < 0) continue;   // 静态位已满：丢弃，不叠字
            } else {
                a.lane = scrollLane();
                if (a.lane < 0) continue;   // 轨道满了：丢弃（宁可少，不叠）
            }
            a.x = getWidth();
            spawnedCount++;
            active.add(a);
        }
    }

    private boolean contains(Item it) {
        for (int i = 0; i < active.size(); i++) {
            if (active.get(i).item == it) return true;
        }
        return false;
    }

    /** 滚动轨：右侧还有安全距离的轨道里取最靠上的那条 */
    private int scrollLane() {
        float w = getWidth();
        long now = System.currentTimeMillis();
        int from = topRows;
        int to = Math.max(from + 1, lanes - bottomRows);
        for (int lane = from; lane < to && lane < laneLastAt.length; lane++) {
            if (now - laneLastAt[lane] < LANE_GAP_MS) continue;
            float right = -1e9f;
            for (int i = 0; i < active.size(); i++) {
                Active a = active.get(i);
                if (a.lane == lane && a.item.mode != 4 && a.item.mode != 5) {
                    right = Math.max(right, a.x + a.w);
                }
            }
            if (right < w - 40f) {
                laneLastAt[lane] = now;
                return lane;
            }
        }
        return -1;
    }

    /** 顶/底静态位：取当前同模式数量，最多 3 行 */
    private int staticLane(int mode) {
        int n = 0;
        for (int i = 0; i < active.size(); i++) {
            Item it = active.get(i).item;
            if (it.mode == mode) n++;
        }
        int max = Math.max(1, mode == 5 ? topRows : bottomRows);
        return n < max ? n : -1;
    }

    private void drawActive(Canvas canvas, long pos) {
        float w = getWidth();
        float h = getHeight();
        Iterator<Active> iter = active.iterator();
        while (iter.hasNext()) {
            Active a = iter.next();
            Item it = a.item;
            boolean stat = it.mode == 4 || it.mode == 5;
            if (stat) {
                if (pos - a.bornAt > STATIC_MS) {
                    removedCount++;
                    iter.remove();
                    continue;
                }
                a.x = (w - a.w) / 2f;
            } else {
                float speed = (w + a.w) / (scrollMs / 1000f);
                a.x = w - (pos - it.timeMs) / 1000f * speed;
                if (a.x + a.w < 0) {
                    removedCount++;
                    iter.remove();
                    continue;
                }
            }
            float baseY;
            if (it.mode == 5) {
                baseY = textSize + a.lane * laneH;
            } else if (it.mode == 4) {
                baseY = h - 80f - a.lane * laneH;
            } else {
                baseY = textSize + a.lane * laneH;
            }
            int save = canvas.save();
            canvas.clipRect(0, 0, w, h);
            fill.setColor(it.color);
            outline.setColor(Color.BLACK);
            canvas.drawText(it.text, a.x, baseY, outline);
            canvas.drawText(it.text, a.x, baseY, fill);
            canvas.restoreToCount(save);
        }
    }

    private int lowerBound(long timeMs) {
        int lo = 0;
        int hi = items.size() - 1;
        int ans = items.size();
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (items.get(mid).timeMs >= timeMs) {
                ans = mid;
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }
        return ans;
    }
}
