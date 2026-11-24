package android.widget;

import android.content.Context;
import android.graphics.drawable.Drawable;
import android.util.AttributeSet;
import android.view.View;

/** JVM 宿主的最小 ProgressBar 桩（必须 extends View，Guard 载荷会把它当 View 用）。 */
public class ProgressBar extends View {
    public ProgressBar(Context context) { super(context); }
    public ProgressBar(Context context, AttributeSet attrs) { super(context); }
    public ProgressBar(Context context, AttributeSet attrs, int defStyleAttr) { super(context); }
    public void setMax(int max) {}
    public void setProgress(int progress) {}
    public void setProgressDrawable(Drawable drawable) {}
    public void setIndeterminate(boolean indeterminate) {}
    public void setVisibility(int visibility) {}
}
