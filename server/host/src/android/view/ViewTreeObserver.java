package android.view;

/** JVM 宿主的最小 ViewTreeObserver 桩。 */
public class ViewTreeObserver {
    public interface OnGlobalLayoutListener {
        void onGlobalLayout();
    }
    public void addOnGlobalLayoutListener(OnGlobalLayoutListener l) {}
    public void removeOnGlobalLayoutListener(OnGlobalLayoutListener l) {}
    public boolean isAlive() { return true; }
}
