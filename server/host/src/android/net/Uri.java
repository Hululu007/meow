package android.net;
public class Uri {
  public static Uri parse(String s) { return new Uri(); }
  /** 社区 spider 用它拼搜索词（JavDb 等）。等价于 URLEncoder 但空格要转 %20。 */
  public static String encode(String s) {
    if (s == null) return null;
    try {
      return java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20");
    } catch (Throwable t) {
      return s;
    }
  }
  public String getQueryParameter(String k) { return null; }
  public String getHost() { return null; }
  public String getPath() { return null; }
  public String toString() { return ""; }
  public static class Builder { public Builder scheme(String s){return this;} public Builder authority(String s){return this;} public Builder path(String s){return this;} public Builder appendQueryParameter(String k,String v){return this;} public Uri build(){return new Uri();} }
}
