package android.widget;
import android.content.Context;
import android.view.ViewGroup;

public class FrameLayout extends ViewGroup {
  public static class LayoutParams extends ViewGroup.MarginLayoutParams {
    public static final int MATCH_PARENT = -1;
    public static final int WRAP_CONTENT = -2;
    public int gravity = -1;
    public LayoutParams(int w, int h) { super(w, h); }
    public LayoutParams(ViewGroup.LayoutParams p) { super(p.width, p.height); }
  }
  public FrameLayout() { super(); }
  public FrameLayout(Context c) { super(c); }
}
