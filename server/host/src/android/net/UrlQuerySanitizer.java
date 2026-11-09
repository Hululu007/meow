package android.net;
import java.util.HashMap;
import java.util.Map;

/** jar 用它从 URL 里取 query 参数；这里做真实解析，比空实现更有用。 */
public class UrlQuerySanitizer {
  private final Map<String, String> params = new HashMap<>();
  public UrlQuerySanitizer() {}
  public UrlQuerySanitizer(String url) {
    if (url == null) return;
    int q = url.indexOf('?');
    if (q < 0) return;
    String query = url.substring(q + 1);
    int hash = query.indexOf('#');
    if (hash >= 0) query = query.substring(0, hash);
    for (String kv : query.split("&")) {
      int eq = kv.indexOf('=');
      if (eq <= 0) continue;
      params.put(kv.substring(0, eq), kv.substring(eq + 1));
    }
  }
  public String getValue(String name) { return params.get(name); }
}
