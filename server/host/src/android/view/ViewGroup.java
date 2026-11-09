package android.view;
import android.content.Context;

public class ViewGroup extends View implements ViewParent {
  public ViewParent getParent() { return null; }
  public void requestLayout() {}
  public void invalidate() {}

  public static class LayoutParams {
    public static final int MATCH_PARENT = -1;
    public static final int WRAP_CONTENT = -2;
    public int width;
    public int height;
    public LayoutParams() { this(WRAP_CONTENT, WRAP_CONTENT); }
    public LayoutParams(int w, int h) { width = w; height = h; }
  }
  public static class MarginLayoutParams extends LayoutParams {
    public int leftMargin, topMargin, rightMargin, bottomMargin;
    public MarginLayoutParams(int w, int h) { super(w, h); }
    public void setMargins(int l, int t, int r, int b) {
      leftMargin = l; topMargin = t; rightMargin = r; bottomMargin = b;
    }
  }
  public ViewGroup() { super(); }
  public ViewGroup(Context c) { super(c); }
  public void addView(View v) {}
  public void addView(View v, LayoutParams p) { v.setParent(this); }
  public void addView(View v, int index) {}
  public void removeView(View v) {}
  public void removeAllViews() {}
  public int getChildCount() { return 0; }
  public View getChildAt(int i) { return null; }
  public int indexOfChild(View v) { return -1; }
  public void setDescendantFocusability(int f) {}
  public void setLayoutParams(LayoutParams p) {}
}
