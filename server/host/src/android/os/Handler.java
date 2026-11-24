package android.os;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** JVM 宿主的最小 Handler：post 走异步单线程，避免与初始化代码互相递归。 */
public class Handler {
  private static final ExecutorService EXEC = Executors.newSingleThreadExecutor(r -> {
    Thread t = new Thread(r, "meow-handler");
    t.setDaemon(true);
    return t;
  });
  public Handler() {}
  public Handler(Looper looper) {}
  public boolean post(Runnable r){ if (r != null) EXEC.execute(r); return true; }
  public boolean postDelayed(Runnable r,long d){ return post(r); }
  public void removeCallbacks(Runnable r){}
  public void removeCallbacksAndMessages(Object token){}
}
