package android.app;
public class Activity extends android.content.Context { public void runOnUiThread(Runnable r) { r.run(); } public android.content.Intent getIntent(){return new android.content.Intent();} }
