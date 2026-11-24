package android.text;

/** JVM 宿主的最小 TextWatcher 桩。 */
public interface TextWatcher {
    void beforeTextChanged(CharSequence s, int start, int count, int after);
    void onTextChanged(CharSequence s, int start, int before, int count);
    void afterTextChanged(Editable s);
}
