package android.app;
import android.content.Context;
import android.content.DialogInterface;
import android.view.View;
import android.view.Window;

/**
 * 无头宿主里的对话框占位。
 *
 * 为什么 getWindow() 必须返回非 null：jar 里拿到 Window 后立刻调
 * setGravity / setAttributes，返回 null 会直接 NPE，而这一步发生在
 * init 阶段（实测 Ali 就是卡在这里），不是"用户点了才弹窗"。
 */
public class Dialog implements DialogInterface {
  protected final Context context;
  private Window window;
  private boolean showing;

  public Dialog(Context c) { this.context = c; }
  public Dialog(Context c, int theme) { this.context = c; }

  public Window getWindow() {
    if (window == null) window = new Window();
    return window;
  }
  public void show() { showing = true; }
  public void dismiss() { showing = false; }
  public void cancel() { showing = false; }
  public boolean isShowing() { return showing; }
  public void setCancelable(boolean b) {}
  public void setCanceledOnTouchOutside(boolean b) {}
  public void setOnCancelListener(DialogInterface.OnCancelListener l) {}
  public void setOnDismissListener(DialogInterface.OnDismissListener l) {}
  public void setOnShowListener(DialogInterface.OnShowListener l) {}
  public void setContentView(View v) {}
  public void setContentView(int layout) {}
  public void setTitle(CharSequence t) {}
  public Context getContext() { return context; }
}
