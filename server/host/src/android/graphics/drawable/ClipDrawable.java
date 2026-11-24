package android.graphics.drawable;

/** JVM 宿主的最小 ClipDrawable 桩：只用于让加密 Guard 载荷的 UI 类通过链接。 */
public class ClipDrawable extends Drawable {
    public ClipDrawable(Drawable drawable, int gravity, int orientation) {
    }
}
