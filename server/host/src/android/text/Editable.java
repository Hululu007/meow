package android.text;
/** EditText.getText() 的返回类型；jar 里只调 toString()/length()。 */
public class Editable implements CharSequence {
  private String value = "";
  public int length() { return value.length(); }
  public char charAt(int i) { return value.charAt(i); }
  public CharSequence subSequence(int s, int e) { return value.subSequence(s, e); }
  public String toString() { return value; }
  public Editable append(CharSequence s) { value += s; return this; }
  public void clear() { value = ""; }
}
