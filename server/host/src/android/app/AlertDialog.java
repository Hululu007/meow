package android.app;
import android.content.Context;
import android.content.DialogInterface;
import android.view.View;

public class AlertDialog extends Dialog {
  public AlertDialog(Context c) { super(c); }
  public AlertDialog(Context c, int theme) { super(c, theme); }

  public static class Builder {
    private final Context context;
    public Builder(Context c) { this.context = c; }
    public Builder setTitle(CharSequence t) { return this; }
    public Builder setTitle(int t) { return this; }
    public Builder setMessage(CharSequence m) { return this; }
    public Builder setMessage(int m) { return this; }
    public Builder setView(View v) { return this; }
    public Builder setView(int v) { return this; }
    public Builder setCancelable(boolean b) { return this; }
    public Builder setPositiveButton(int text, DialogInterface.OnClickListener l) { return this; }
    public Builder setPositiveButton(CharSequence text, DialogInterface.OnClickListener l) { return this; }
    public Builder setNegativeButton(int text, DialogInterface.OnClickListener l) { return this; }
    public Builder setNegativeButton(CharSequence text, DialogInterface.OnClickListener l) { return this; }
    public Builder setNeutralButton(CharSequence text, DialogInterface.OnClickListener l) { return this; }
    public Builder setOnCancelListener(DialogInterface.OnCancelListener l) { return this; }
    public Builder setOnDismissListener(DialogInterface.OnDismissListener l) { return this; }
    public AlertDialog show() {
      AlertDialog d = create();
      d.show();
      return d;
    }
    public AlertDialog create() { return new AlertDialog(context); }
  }
}
