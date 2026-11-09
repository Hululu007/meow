package com.github.catvod.crawler;
public class SpiderDebug {
  public static void log(String s) { System.err.println("[spider] " + s); }
  public static void log(Throwable t) { t.printStackTrace(); }
}
