package android.view;

/** JVM 宿主的最小 MotionEvent 桩。 */
public class MotionEvent {
    public int getAction() { return 0; }
    public float getX() { return 0; }
    public float getY() { return 0; }
    public int getPointerCount() { return 1; }
}
