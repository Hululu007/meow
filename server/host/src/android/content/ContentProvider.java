package android.content;

/** JVM 宿主的最小 ContentProvider 桩。 */
public abstract class ContentProvider {
    public boolean onCreate() { return true; }
    public String getType(android.net.Uri uri) { return null; }
}
