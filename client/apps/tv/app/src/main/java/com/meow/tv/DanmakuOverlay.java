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

    private static final long SCROLL_MS = 12_000L;
    private static final long STATIC_MS = 4_000L;
    private static final long SPAWN_WINDOW_MS = 1_200L;

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

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        textSize = Math.max(20f, Math.min(44f, h / 32f));
        fill.setTextSize(textSize);
        outline.setTextSize(textSize);
        laneH = textSize * 1.5f;
        lanes = Math.max(3, (int) ((h * 0.4f) / laneH));
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

        if (player.isPlaying()) postInvalidateOnAnimation();
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
        for (int lane = 0; lane < lanes; lane++) {
            float right = -1e9f;
            for (int i = 0; i < active.size(); i++) {
                Active a = active.get(i);
                if (a.lane == lane && a.item.mode != 4 && a.item.mode != 5) {
                    right = Math.max(right, a.x + a.w);
                }
            }
            if (right < w - 24f) return lane;
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
        return n < 3 ? n : -1;
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
                    iter.remove();
                    continue;
                }
                a.x = (w - a.w) / 2f;
            } else {
                float speed = (w + a.w) / (SCROLL_MS / 1000f);
                a.x = w - (pos - it.timeMs) / 1000f * speed;
                if (a.x + a.w < 0) {
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
