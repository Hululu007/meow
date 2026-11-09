package android.view;
import android.content.Context;
import android.graphics.drawable.Drawable;

/**
 * 无头宿主的视图占位：全部 setter 空实现，getter 返回稳定值。
 * jar 里的 UI 代码只为"在 Android 上把窗口画出来"，这里只要能跑通不抛异常。
 */
public class View {
  public static final int VISIBLE = 0;
  public static final int INVISIBLE = 4;
  public static final int GONE = 8;

  public interface OnClickListener { void onClick(View v); }
  public interface OnFocusChangeListener { void onFocusChange(View v, boolean hasFocus); }
  public interface OnKeyListener { boolean onKey(View v, int keyCode, KeyEvent e); }

  private ViewParent parent;
  private ViewGroup.LayoutParams params;
  private Object tag;

  public View() {}
  public View(Context c) {}

  public ViewParent getParent() { return parent; }
  public void setParent(ViewParent p) { this.parent = p; }
  public ViewGroup.LayoutParams getLayoutParams() { return params; }
  public void setLayoutParams(ViewGroup.LayoutParams p) { this.params = p; }
  public Object getTag() { return tag; }
  public void setTag(Object t) { this.tag = t; }
  public int getLeft() { return 0; }
  public int getTop() { return 0; }
  public int getWidth() { return 0; }
  public int getHeight() { return 0; }
  public int getId() { return 0; }
  public void setId(int id) {}
  public void setVisibility(int v) {}
  public int getVisibility() { return VISIBLE; }
  public void setBackground(Drawable d) {}
  public void setBackgroundColor(int c) {}
  public void setBackgroundResource(int id) {}
  public void setPadding(int l, int t, int r, int b) {}
  public void setClickable(boolean b) {}
  public void setFocusable(boolean b) {}
  public void setFocusableInTouchMode(boolean b) {}
  public void setHorizontalScrollBarEnabled(boolean b) {}
  public void setSelected(boolean b) {}
  public boolean isFocusable() { return true; }
  public boolean isSelected() { return false; }
  public boolean performClick() { return false; }
  public boolean requestFocus() { return true; }
  public void clearFocus() {}
  public boolean post(Runnable r) { r.run(); return true; }
  public boolean postDelayed(Runnable r, long ms) { r.run(); return true; }
  public void setOnClickListener(OnClickListener l) {}
  public void setOnFocusChangeListener(OnFocusChangeListener l) {}
  public void setOnKeyListener(OnKeyListener l) {}
  public void setOnTouchListener(Object l) {}
  public void invalidate() {}
  public void requestLayout() {}
  public void bringToFront() {}
}
