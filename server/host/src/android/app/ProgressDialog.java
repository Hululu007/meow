package android.app;
import android.content.Context;

public class ProgressDialog extends Dialog {
  public static final int STYLE_SPINNER = 0;
  public static final int STYLE_HORIZONTAL = 1;

  public ProgressDialog(Context c) { super(c); }
  public ProgressDialog(Context c, int theme) { super(c, theme); }

  public void setProgressStyle(int style) {}
  public void setProgress(int value) {}
  public void setMax(int max) {}
  public void setIndeterminate(boolean b) {}
  public void setMessage(CharSequence m) {}
  public static ProgressDialog show(Context c, CharSequence title, CharSequence message) {
    ProgressDialog d = new ProgressDialog(c);
    d.show();
    return d;
  }
}
