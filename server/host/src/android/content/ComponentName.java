package android.content;
public class ComponentName {
  public String pkg = "", cls = "";
  public ComponentName(Context c, Class<?> k) { if (k != null) cls = k.getName(); }
  public ComponentName(String p, String c) { pkg = p; cls = c; }
  public String getPackageName() { return pkg; }
  public String getClassName() { return cls; }
}
