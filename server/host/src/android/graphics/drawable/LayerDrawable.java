package android.graphics.drawable;

/** JVM 宿主的最小 LayerDrawable 桩：只用于让加密 Guard 载荷的 UI 类通过链接。 */
public class LayerDrawable extends Drawable {
    public LayerDrawable(Drawable[] layers) {
    }
}
