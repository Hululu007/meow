package android.util;
public class Log {
  public static int d(String t, String m) { System.err.println("D/"+t+": "+m); return 0; }
  public static int i(String t, String m) { System.err.println("I/"+t+": "+m); return 0; }
  public static int w(String t, String m) { System.err.println("W/"+t+": "+m); return 0; }
  public static int e(String t, String m) { System.err.println("E/"+t+": "+m); return 0; }
  public static int e(String t, String m, Throwable x) { System.err.println("E/"+t+": "+m); x.printStackTrace(); return 0; }
  public static int v(String t, String m) { return 0; }
}
