import java.lang.reflect.*;
import java.util.*;
public class Test {
  public static void main(String[] a) throws Exception {
    try { java.security.Security.addProvider((java.security.Provider) Class
        .forName("org.bouncycastle.jce.provider.BouncyCastleProvider")
        .getDeclaredConstructor().newInstance()); } catch (Throwable ignored) {}
    String cls=a[0], ext=a.length>1?a[1]:"", wantTid=a.length>2?a[2]:"";
    Class<?> c=Class.forName("com.github.catvod.spider."+cls);
    Object o=c.getDeclaredConstructor().newInstance();
    try { c.getMethod("init", Class.forName("android.content.Context"), String.class).invoke(o,null,ext); } catch(NoSuchMethodException e){}
    String home=(String)c.getMethod("homeContent", boolean.class).invoke(o,true);
    System.out.println("HOME "+home.substring(0,Math.min(200,home.length())));
    org.json.JSONObject h=new org.json.JSONObject(home);
    org.json.JSONArray hc=h.optJSONArray("class");
    System.out.println("HOME_CLASSES "+(hc==null?0:hc.length()));
    String tid=h.getJSONArray("class").getJSONObject(0).getString("type_id");
    if(!wantTid.isEmpty()) tid=wantTid;
    String cat=(String)c.getMethod("categoryContent", String.class,String.class,boolean.class,HashMap.class).invoke(o,tid,"1",true,new HashMap<String,String>());
    System.out.println("CAT "+cat.substring(0,Math.min(200,cat.length())));
    org.json.JSONObject cj=new org.json.JSONObject(cat);
    org.json.JSONArray cl=cj.optJSONArray("list");
    System.out.println("CAT_ITEMS "+(cl==null?0:cl.length()));
    org.json.JSONArray list=cj.getJSONArray("list");
    org.json.JSONObject dj=null;
    String froms="", urls="";
    int tries=Math.min(5, list.length());
    for(int i=0;i<tries;i++){
      String vid=list.getJSONObject(i).getString("vod_id");
      String det=(String)c.getMethod("detailContent", java.util.List.class).invoke(o, Collections.singletonList(vid));
      org.json.JSONObject d=new org.json.JSONObject(det).getJSONArray("list").getJSONObject(0);
      String f=d.optString("vod_play_from",""), u=d.optString("vod_play_url","");
      if(dj==null){ dj=d; froms=f; urls=u; }
      if(!u.isEmpty()){ dj=d; froms=f; urls=u; break; }
    }
    System.out.println("DETAIL name="+dj.optString("vod_name"));
    System.out.println("FROM="+froms);
    System.out.println("URL="+urls.substring(0,Math.min(300,urls.length())));
    if(!urls.isEmpty()){
      String sep=java.util.regex.Pattern.quote("$$$");
      String g=urls.split(sep)[0]; int hi=g.indexOf('#'); String ent=hi>=0?g.substring(0,hi):g;
      String fid=froms.split(sep)[0]; int di=ent.indexOf('$'); String pid=di>=0?ent.substring(di+1):ent;
      String play=(String)c.getMethod("playerContent", String.class,String.class,java.util.List.class).invoke(o,fid,pid,new ArrayList<String>());
      emitPlay(play);
    } else {
      String vid=list.getJSONObject(0).getString("vod_id");
      String play=(String)c.getMethod("playerContent", String.class,String.class,java.util.List.class)
          .invoke(o,"",vid,new ArrayList<String>());
      emitPlay(play);
    }
  }

  private static void emitPlay(String play) {
    System.out.println("PLAY "+play.substring(0,Math.min(400,play.length())));
    try {
      org.json.JSONObject pj=new org.json.JSONObject(play);
      System.out.println("PLAY_PARSE "+pj.optInt("parse",0));
      Object u=pj.opt("url");
      String url="";
      if(u instanceof org.json.JSONArray){
        org.json.JSONArray arr=(org.json.JSONArray)u;
        for(int i=0;i<arr.length();i++){
          String s=arr.optString(i,"");
          if(s.startsWith("http")){ url=s; break; }
        }
      } else if(u!=null){
        url=String.valueOf(u);
      }
      System.out.println("PLAY_URL "+url);
    } catch(Exception ignored) {}
  }
}
