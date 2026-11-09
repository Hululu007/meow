package android.widget;
import android.content.Context;
import android.graphics.Bitmap;
import android.view.View;

public class ImageView extends View {
  public enum ScaleType { MATRIX, FIT_XY, FIT_START, FIT_CENTER, FIT_END, CENTER, CENTER_CROP, CENTER_INSIDE }
  public ImageView() { super(); }
  public ImageView(Context c) { super(c); }
  public void setImageBitmap(Bitmap b) {}
  public void setImageResource(int id) {}
  public void setScaleType(ScaleType t) {}
  public void setAdjustViewBounds(boolean b) {}
}
