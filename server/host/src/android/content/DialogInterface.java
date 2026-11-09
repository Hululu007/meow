package android.content;
/** 只保留 jar 里实际引用的四个回调；方法体在 stub 里不会被调用。 */
public interface DialogInterface {
  void cancel();
  void dismiss();
  interface OnCancelListener { void onCancel(DialogInterface d); }
  interface OnDismissListener { void onDismiss(DialogInterface d); }
  interface OnShowListener { void onShow(DialogInterface d); }
  interface OnClickListener { void onClick(DialogInterface d, int which); }
}
