package android.widget;
import android.content.Context;
import android.text.Editable;

public class EditText extends TextView {
  private final Editable editable = new Editable();
  public EditText() { super(); }
  public EditText(Context c) { super(c); }
  public Editable getText() { return editable; }
}
