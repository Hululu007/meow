package com.github.catvod.crawler;
import android.app.Activity;
import android.content.Context;
import java.util.*;
import okhttp3.Dns;
public abstract class Spider {
  /**
   * 站点 key。Android 端 Spider 基类一直有它，部分 jar（含肥猫那批）直接读这个
   * 字段拼 proxy 参数，缺了就是 NoSuchFieldError。
   */
  public String siteKey;
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

  /*
   * ↓↓↓ 下面这几项是**肥猫那批 jar 的基类 ABI**（Android 端 Spider 一直是这么写的）。
   *
   * 缺它们的后果是 IncompatibleClassChangeError：实测 ShortQimao / KuLe 报
   * "Expected static method 'okhttp3.Dns ...Spider.safeDns()'" —— 它们按 static 调用，
   * 而 JVM 桩一直是实例方法。「导入肥猫配置后 APP 系源全空/报错」不是源坏了，
   * 是我们这边的基类签名对不上。
   *
   * safeDns 必须返回非 null：返回 null 会让 okhttp 的 Builder().dns(null) 抛 NPE。
   * 这里给 Dns.SYSTEM，DoH 由宿主自己的 OkHttp 配置负责。
   *
   * JVM 没有 Activity / jar 内 proxy 端点，getActivity/getProxyUrl/proxy 返回 null 或
   * 空串：先把 ABI 对上让类能加载，需要 proxy 的播放路径再单独接。
   */
  public static Dns safeDns() { return Dns.SYSTEM; }

  public Activity getActivity() { return null; }

  public String getProxyUrl() { return ""; }

  public String getProxyUrl(Map<String, String> params) { return ""; }

  public Object[] proxy(Map<String, String> params) throws Exception { return null; }
}
