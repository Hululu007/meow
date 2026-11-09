import java.lang.reflect.*;

public class Main {
  public static void main(String[] args) throws Exception {
    try {
      java.security.Security.addProvider((java.security.Provider) Class
          .forName("org.bouncycastle.jce.provider.BouncyCastleProvider")
          .getDeclaredConstructor().newInstance());
    } catch (Throwable ignored) {
    }
    String cls = args.length > 0 ? args[0] : "Douban";
    String ext = args.length > 1 ? args[1] : "";
    Class<?> c = Class.forName("com.github.catvod.spider." + cls);
    Object o = c.getDeclaredConstructor().newInstance();
    try {
      Method init = c.getMethod("init", Class.forName("android.content.Context"), String.class);
      init.invoke(o, null, ext);
    } catch (NoSuchMethodException e) {
      System.err.println("no init(ctx,ext)");
    }
    Method home = c.getMethod("homeContent", boolean.class);
    Object r = home.invoke(o, true);
    String s = String.valueOf(r);
    System.out.println("RESULT_LEN=" + s.length());
    System.out.println(s.substring(0, Math.min(600, s.length())));
  }
}
