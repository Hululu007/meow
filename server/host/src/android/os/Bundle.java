package android.os;

import java.util.HashMap;
import java.util.Map;

/** JVM 宿主的最小 Bundle 桩：加密 Guard 载荷的 Application 回调签名需要它。 */
public class Bundle {
    private final Map<String, Object> map = new HashMap<>();

    public Bundle() {
    }

    public void putString(String key, String value) {
        map.put(key, value);
    }

    public String getString(String key) {
        Object v = map.get(key);
        return v == null ? null : String.valueOf(v);
    }

    public void putInt(String key, int value) {
        map.put(key, value);
    }

    public int getInt(String key) {
        Object v = map.get(key);
        return v instanceof Integer ? (Integer) v : 0;
    }

    public void putBoolean(String key, boolean value) {
        map.put(key, value);
    }

    public boolean getBoolean(String key) {
        Object v = map.get(key);
        return v instanceof Boolean && (Boolean) v;
    }

    public boolean containsKey(String key) {
        return map.containsKey(key);
    }

    public Object get(String key) {
        return map.get(key);
    }
}
