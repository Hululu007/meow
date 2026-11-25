#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// 端内 JVM 桥。
///
/// 真机上把静态链接的 OpenJDK 9 Zero 起在 App 进程内，然后反射调用
/// `ApiServer.main(["--port=9978", "--data-dir=..."])`；模拟器上没有
/// arm64-device 的静态库，`isAvailable` 恒为 NO，UI 走 `--api-base`
/// 连 macOS 上的宿主做验证。
@interface JvmBridge : NSObject

+ (BOOL)isAvailable;

/// 崩溃取证：JVM 的 stdout/stderr 与信号记录都落在 Documents/jvm.log，
/// 这里取最后几行给界面显示（闪退时至少能看到一句原因，而不是白屏）。
+ (nullable NSString *)logTail;

+ (void)startWithJavaHome:(NSString *)javaHome
                classPath:(NSString *)classPath
                  dataDir:(NSString *)dataDir
                     port:(int)port
               completion:(void (^)(BOOL ok, NSString * _Nullable message))completion;

/// App 回前台时叫醒 Java 看门狗（ApiServer.kickWatchdog），让它立刻探一次
/// `/api/_hb`；iOS 挂起期间线程冻结，不踢就要干等下一轮。
+ (void)kickWatchdog;

@end

NS_ASSUME_NONNULL_END
