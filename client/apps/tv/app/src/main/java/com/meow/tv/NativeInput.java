package com.meow.tv;

/**
 * 「原生输入框正在显示」的全局标志。
 *
 * <p>为什么必须是独立小类而不是 MainActivity 的字段：
 * {@code MainActivity.dispatchKeyEvent} 要在**任何按键**进来的第一行就判断它，
 * 而 TvBridge 是另一个实例（{@code new TvBridge(this)}），两者共享的只有
 * 静态状态。这个小类就是那个唯一的交汇点。
 *
 * <p>为什么必须让 {@code dispatchKeyEvent} 放行：
 * 壳原本把方向键/确认键全部转给 {@code __meowTvNav}。原生 AlertDialog 里的
 * EditText 需要这些键来移动光标、点「确定」——不放行的话输入框弹出后
 * 遥控器完全失灵，用户只能拔电源（实测）。
 */
final class NativeInput {

    private static volatile boolean showing = false;

    private NativeInput() {}

    static boolean active() {
        return showing;
    }

    static void begin() {
        showing = true;
    }

    static void end() {
        showing = false;
    }
}
