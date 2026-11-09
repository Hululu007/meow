# 猫窝 TV（Android TV 壳）

一个 WebView 壳：加载自研 Web 前端，用注入的 `tv-nav.js` 把遥控器方向键翻译成焦点移动。
**UI 与 Web 完全一致**——因为就是同一份前端，不是"照着画一遍"。

## 为什么不是原生重写

需求是「TV 的 UI 大致对齐自研 Web」。原生重写只能得到两份会漂移的界面；
WebView 方案把"对齐"变成"同一个文件"。电视上真正缺的只有**遥控导航**，
那部分由 `tv-nav.js` 补齐（几何最近邻选焦 + 确认键点击 + 焦点高亮）。

## 构建

```bash
cd client/apps/tv
# local.properties 必须写 sdk.dir=C:/Android（反斜杠会被 properties 吃掉）
./gradlew assembleDebug        # 或本机 /c/Android/gradle-8.9/bin/gradle.bat assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`（约 15KB，不含任何第三方依赖）

## 安装与指定后端

```bash
adb install -r app-debug.apk
# 默认后端 http://10.0.2.2:30010（模拟器访问宿主机）
adb shell am start -n com.meow.tv/.MainActivity --es url http://192.168.1.2:30010
```

`--es url` 指向 **Web 前端地址**（不是 `/config.json`），因为壳加载的是网页本身。

## 已实测（模拟器 meow_tv / android-35）

- 首页渲染（豆瓣海报、分类 tab 与 Web 一致）
- 方向键移动焦点（黄色描边）、确认键点击 tab、进入海报网格
- 窗口全屏横屏、保持常亮

## 已知限制

- 遥控导航依赖 `tv-nav.js` 的几何选焦：极端布局（重叠、绝对定位）可能跳序
- 没有自己的设置页：换后端只能靠 `--es url` 或重装
- 需要 Web 后端可达；Web 前端本身不内嵌，因此 TV 端必须先有可访问的 Web 地址
