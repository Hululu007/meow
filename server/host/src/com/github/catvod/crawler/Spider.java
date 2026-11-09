package com.github.catvod.crawler;
import android.content.Context;
import java.util.*;
import okhttp3.Dns;
public abstract class Spider {
  public void init(Context ctx) throws Exception {}
  public void init(Context ctx, String extend) throws Exception {
    init(ctx);
    // Spiders in this dex reach the Android Application through Init.context(); the
    // plain-JVM host has no Application, so seed the singleton with a stub one.
    try {
      Class<?> ic = Class.forName("com.github.catvod.spider.Init");
      Object inst = ic.getMethod("get").invoke(null);
      java.lang.reflect.Field f = ic.getDeclaredField("c");
      f.setAccessible(true);
      if (f.get(inst) == null) f.set(inst, new android.app.Application());
    } catch (Throwable ignored) {}
  }
  public String homeContent(boolean filter) throws Exception { return ""; }
  public String homeVideoContent() throws Exception { return ""; }
  public String categoryContent(String tid, String pg, boolean filter, HashMap<String,String> extend) throws Exception { return ""; }
  public String detailContent(List<String> ids) throws Exception { return ""; }
  public String searchContent(String key, boolean quick) throws Exception { return ""; }
  public String searchContent(String key, boolean quick, String pg) throws Exception { return ""; }
  public String playerContent(String flag, String id, List<String> vipFlags) throws Exception { return ""; }
  public String liveContent(String url) throws Exception { return ""; }
  public boolean manualVideoCheck() throws Exception { return false; }
  public boolean isVideoFormat(String url) throws Exception { return false; }
  public String action(String action) throws Exception { return ""; }
  public void destroy() {}
  public Dns safeDns() { return null; }
}
