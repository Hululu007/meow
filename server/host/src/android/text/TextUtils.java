package android.text;
public class TextUtils {
  public static boolean isEmpty(CharSequence s) { return s == null || s.length() == 0; }
  public static boolean equals(CharSequence a, CharSequence b) { return a == null ? b == null : a.equals(b); }
  public static String join(CharSequence d, Iterable<?> t) {
    StringBuilder sb = new StringBuilder();
    boolean first = true;
    for (Object o : t) {
      if (!first) sb.append(d);
      sb.append(o);
      first = false;
    }
    return sb.toString();
  }
  public static String join(CharSequence d, Object[] t) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < t.length; i++) {
      if (i > 0) sb.append(d);
      sb.append(t[i]);
    }
    return sb.toString();
  }
}
