package android.view;
public interface WindowManager {
  class LayoutParams {
    public static final int FLAG_FULLSCREEN = 1024;
    public static final int FLAG_LAYOUT_NO_LIMITS = 512;
    public int width = -1;
    public int height = -2;
    public int gravity = 0;
    public float dimAmount = 1f;
    public int x = 0;
    public int y = 0;
    public LayoutParams() {}
    public LayoutParams(int w, int h) { width = w; height = h; }
  }
}
