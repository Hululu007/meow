package android.widget;
import android.content.Context;
import android.view.View;

public class TextView extends View {
  public TextView() { super(); }
  public TextView(Context c) { super(c); }
  public void setText(CharSequence t) {}
  public void setText(int id) {}
  public CharSequence getText() { return ""; }
  public void setHint(CharSequence h) {}
  public void setHintTextColor(int c) {}
  public void setTextColor(int c) {}
  public void setTextSize(float s) {}
  public void setTextSize(int unit, float s) {}
  public void setGravity(int g) {}
  public void setSingleLine(boolean b) {}
  public void setSelected(boolean b) {}
  public void setPadding(int l, int t, int r, int b) {}
  public void setLines(int n) {}
  public void setMaxLines(int n) {}
  public void setEllipsize(Object e) {}
}
