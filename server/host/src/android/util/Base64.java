package android.util;

public class Base64 {
  public static final int DEFAULT = 0, NO_WRAP = 2, URL_SAFE = 8, NO_PADDING = 1;

  public static String encodeToString(byte[] b, int f) {
    if ((f & URL_SAFE) != 0) return java.util.Base64.getUrlEncoder().encodeToString(b);
    return java.util.Base64.getEncoder().encodeToString(b);
  }

  public static byte[] encode(byte[] b, int f) {
    if ((f & URL_SAFE) != 0) return java.util.Base64.getUrlEncoder().encode(b);
    return java.util.Base64.getEncoder().encode(b);
  }

  public static byte[] decode(String s, int f) {
    return decode(s.getBytes(java.nio.charset.StandardCharsets.US_ASCII), f);
  }

  public static byte[] decode(byte[] input, int f) {
    String s = new String(input, java.nio.charset.StandardCharsets.US_ASCII).replaceAll("\\s", "");
    try {
      if ((f & URL_SAFE) != 0) return java.util.Base64.getUrlDecoder().decode(s);
      return java.util.Base64.getDecoder().decode(s);
    } catch (IllegalArgumentException e) {
      return java.util.Base64.getMimeDecoder().decode(s);
    }
  }
}
