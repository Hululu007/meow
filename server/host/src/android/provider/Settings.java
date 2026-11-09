package android.provider;
import android.content.ContentResolver;
public class Settings {
  public static class Secure {
    private static final String ANDROID_ID = "9774d56d682e549c";
    public static String getString(ContentResolver resolver, String name) {
      return "android_id".equals(name) ? ANDROID_ID : "";
    }
  }
}
