package android.view;
import android.graphics.drawable.Drawable;

public class Window {
  private WindowManager.LayoutParams attrs = new WindowManager.LayoutParams();
  public WindowManager.LayoutParams getAttributes() { return attrs; }
  public void setAttributes(WindowManager.LayoutParams p) { if (p != null) attrs = p; }
  public void setBackgroundDrawable(Drawable d) {}
  public void setBackgroundDrawableResource(int id) {}
  public void setGravity(int g) {}
  public void setWindowAnimations(int a) {}
  public void setLayout(int w, int h) {}
  public void addFlags(int f) {}
  public void clearFlags(int f) {}
  public View getDecorView() { return new View(); }
}
