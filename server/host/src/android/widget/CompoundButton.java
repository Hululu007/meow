package android.widget;

/** JVM 宿主的最小 CompoundButton 桩。 */
public class CompoundButton extends TextView {
    public interface OnCheckedChangeListener {
        void onCheckedChanged(CompoundButton buttonView, boolean isChecked);
    }
    public void setChecked(boolean checked) {}
    public boolean isChecked() { return false; }
}
