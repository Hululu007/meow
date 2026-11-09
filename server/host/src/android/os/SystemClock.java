package android.os;
public class SystemClock { public static long elapsedRealtime() { return System.currentTimeMillis(); } public static void sleep(long ms) { try{Thread.sleep(ms);}catch(Exception e){} } }
