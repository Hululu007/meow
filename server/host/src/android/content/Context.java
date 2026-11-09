package android.content;
import android.content.pm.PackageManager;
import java.util.*;
public class Context {
  private final Map<String,Object> prefs = new HashMap<>();
  public SharedPreferences getSharedPreferences(String n, int m) {
    return new SharedPreferences() {
      public String getString(String k, String d) { Object v = prefs.get(k); return v == null ? d : String.valueOf(v); }
      public int getInt(String k, int d) { Object v = prefs.get(k); return v == null ? d : (Integer) v; }
      public boolean getBoolean(String k, boolean d) { Object v = prefs.get(k); return v == null ? d : (Boolean) v; }
      public long getLong(String k, long d) { Object v = prefs.get(k); return v == null ? d : (Long) v; }
      public Editor edit() {
        return new Editor() {
          private final Map<String,Object> tmp = new HashMap<>();
          public Editor putString(String k, String v) { tmp.put(k, v); return this; }
          public Editor putInt(String k, int v) { tmp.put(k, v); return this; }
          public Editor putBoolean(String k, boolean v) { tmp.put(k, v); return this; }
          public Editor putLong(String k, long v) { tmp.put(k, v); return this; }
          public boolean commit() { prefs.putAll(tmp); return true; }
          public void apply() { commit(); }
        };
      }
    };
  }
  public PackageManager getPackageManager() { return new PackageManager(); }
  public ContentResolver getContentResolver() { return new ContentResolver(); }
  public Object getSystemService(String n) {
    if ("wifi".equals(n)) return new android.net.wifi.WifiManager();
    if ("clipboard".equals(n)) {
      if (clipboard == null) clipboard = new ClipboardManager();
      return clipboard;
    }
    return null;
  }
  public String getPackageName() { return "com.github.tvbox.osc"; }
  public Context getApplicationContext() { return this; }

  private android.content.res.Resources resources;
  private ClipboardManager clipboard;

  public android.content.res.Resources getResources() {
    if (resources == null) resources = new android.content.res.Resources();
    return resources;
  }

  /** clipboard 必须给实例：jar 里拿到就 .setPrimaryClip()，返回 null 会 NPE。 */
  public ClipboardManager getClipboard() { return (ClipboardManager) getSystemService("clipboard"); }
}
