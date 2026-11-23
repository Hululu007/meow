#import "JvmBridge.h"

#if !TARGET_OS_SIMULATOR

#include <jni.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

#ifndef RTLD_FIRST
#define RTLD_FIRST 0x100
#endif

/*
 * 静态构建的 libjvm 在找自己的 JNI 原生方法时会调用 dlopen(NULL, RTLD_FIRST)。
 * 在 dylib/主程序混编的 App 里，这个调用会去搜主程序镜像而不是 JVM 自身；
 * 把本编译单元对 dlopen 的引用绑到一个隐藏的同名包装上，返回 JNI_CreateJavaVM
 * 所在镜像的句柄。其它镜像仍然链接 libSystem 的 dlopen（隐藏可见性，不外溢）。
 * 这是 ReadyTalk/Avian 与 iphone-java-runtime-probe 都验证过的静态 JVM 接法。
 */
__attribute__((visibility("hidden")))
void *MeowEmbeddedDlopen(const char *path, int mode) __asm__("_dlopen");
void *MeowEmbeddedDlopen(const char *path, int mode) {
    typedef void *(*Loader)(const char *, int);
    static Loader systemLoader;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        systemLoader = (Loader)dlsym(RTLD_DEFAULT, "dlopen");
    });
    if (!systemLoader) return NULL;
    if (path == NULL && (mode & RTLD_FIRST)) {
        Dl_info image = {0};
        if (!dladdr((const void *)&JNI_CreateJavaVM, &image) || !image.dli_fname) {
            return NULL;
        }
        return systemLoader(image.dli_fname, mode | RTLD_NOLOAD);
    }
    return systemLoader(path, mode);
}

#endif

@implementation JvmBridge

+ (BOOL)isAvailable {
#if TARGET_OS_SIMULATOR
    return NO;
#else
    NSURL *resources = NSBundle.mainBundle.resourceURL;
    if (!resources) return NO;
    NSString *modules = [resources.path stringByAppendingPathComponent:@"openjdk/lib/modules"];
    NSString *hostJar = [resources.path stringByAppendingPathComponent:@"jvm/host.jar"];
    NSFileManager *fm = NSFileManager.defaultManager;
    return [fm fileExistsAtPath:modules] && [fm fileExistsAtPath:hostJar];
#endif
}

+ (void)startWithJavaHome:(NSString *)javaHome
                classPath:(NSString *)classPath
                  dataDir:(NSString *)dataDir
                     port:(int)port
               completion:(void (^)(BOOL, NSString *_Nullable))completion {
#if TARGET_OS_SIMULATOR
    completion(NO, @"simulator has no embedded JVM");
#else
    static BOOL started = NO;
    @synchronized (self) {
        if (started) {
            completion(YES, nil);
            return;
        }
        started = YES;
    }

    [NSThread detachNewThreadWithBlock:^{
        @autoreleasepool {
            /*
             * JVM 是进程级的单例；即便 ApiServer.main 很快返回（它只负责起监听），
             * 这条线程也要一直活着，否则 JVM 可能在非 daemon 线程耗尽后退出。
             */
            setenv("MEOW_BIND", "127.0.0.1", 1);

            NSString *tmp = NSTemporaryDirectory();
            NSString *trustStore = [javaHome stringByAppendingPathComponent:@"lib/security/cacerts"];
            NSArray<NSString *> *options = @[
                // 外部源包（dex2jar / 其他工具转出的 class）stackmap 常不完整，
                // 默认校验会 VerifyError: Expecting a stackmap frame at branch target。
                // 只关非 boot 类的校验，JDK 自带类照校验；与 PC 插件 / Docker / fpk 一致。
                // 实测：OECT 源服务的 spiderJvm 里 AppDrama/Bili 不关就整类加载失败，
                // AppRJ 搜索报 VerifyError — 关了全部正常。
                @"-XX:+UnlockDiagnosticVMOptions",
                @"-XX:-BytecodeVerificationRemote",
                [@"-Djava.home=" stringByAppendingString:javaHome],
                [@"-Djava.class.path=" stringByAppendingString:classPath],
                [@"-Duser.dir=" stringByAppendingString:dataDir],
                [@"-Duser.home=" stringByAppendingString:dataDir],
                [@"-Djava.io.tmpdir=" stringByAppendingString:tmp],
                [@"-Djavax.net.ssl.trustStore=" stringByAppendingString:trustStore],
                @"-Djavax.net.ssl.trustStoreType=PKCS12",
                @"-Djava.awt.headless=true",
                @"-Dfile.encoding=UTF-8",
                @"-Dsun.jnu.encoding=UTF-8",
                @"-Duser.language=zh",
                @"-Duser.country=CN",
                @"-Djava.security.egd=file:/dev/urandom",
                // iOS 无 fork/exec：dex→class 走端内 dex2jar 库（vendor/dex2jar）。
                @"-Dmeow.dex2jar.inprocess=true",
                @"--add-modules=ALL-SYSTEM",
                @"-Xint",
                @"-Xms64m",
                @"-Xmx512m",
                @"-Xss2m",
                @"-XX:+UseSerialGC",
                @"-XX:CompressedClassSpaceSize=128m"
            ];

            JavaVMOption rawOptions[32] = {0};
            if (options.count > sizeof(rawOptions) / sizeof(rawOptions[0])) {
                completion(NO, @"too many JVM options");
                return;
            }
            for (NSUInteger i = 0; i < options.count; i++) {
                rawOptions[i].optionString = strdup(options[i].UTF8String);
            }

            JavaVMInitArgs args = {0};
            args.version = JNI_VERSION_1_8;
            args.nOptions = (jint)options.count;
            args.options = rawOptions;
            // 未知 -XX 不 abort：不同 JDK 小版本的 VM 选项有差异。
            args.ignoreUnrecognized = JNI_TRUE;

            JavaVM *vm = NULL;
            JNIEnv *env = NULL;
            jint created = JNI_CreateJavaVM(&vm, (void **)&env, &args);
            for (NSUInteger i = 0; i < options.count; i++) free(rawOptions[i].optionString);

            if (created != JNI_OK || vm == NULL || env == NULL) {
                NSLog(@"[meow-jvm] JNI_CreateJavaVM failed: %d", (int)created);
                completion(NO, [NSString stringWithFormat:@"JNI_CreateJavaVM=%d", (int)created]);
                return;
            }

            jclass serverClass = (*env)->FindClass(env, "ApiServer");
            if (serverClass == NULL) {
                (*env)->ExceptionDescribe(env);
                (*env)->ExceptionClear(env);
                NSLog(@"[meow-jvm] ApiServer class not found");
                completion(NO, @"ApiServer class not found");
                return;
            }
            jmethodID mainMethod = (*env)->GetStaticMethodID(env, serverClass, "main", "([Ljava/lang/String;)V");
            if (mainMethod == NULL) {
                (*env)->ExceptionDescribe(env);
                (*env)->ExceptionClear(env);
                completion(NO, @"ApiServer.main not found");
                return;
            }

            jclass stringClass = (*env)->FindClass(env, "java/lang/String");
            jobjectArray arguments = (*env)->NewObjectArray(env, 2, stringClass, NULL);
            jstring portArg = (*env)->NewStringUTF(env, [[NSString stringWithFormat:@"--port=%d", port] UTF8String]);
            jstring dataArg = (*env)->NewStringUTF(env, [[@"--data-dir=" stringByAppendingString:dataDir] UTF8String]);
            (*env)->SetObjectArrayElement(env, arguments, 0, portArg);
            (*env)->SetObjectArrayElement(env, arguments, 1, dataArg);

            NSLog(@"[meow-jvm] starting ApiServer (data=%s)", dataDir.UTF8String);
            (*env)->CallStaticVoidMethod(env, serverClass, mainMethod, arguments);

            if ((*env)->ExceptionCheck(env)) {
                (*env)->ExceptionDescribe(env);
                (*env)->ExceptionClear(env);
                completion(NO, @"ApiServer.main threw");
                return;
            }

            completion(YES, nil);

            /*
             * main 返回后 HTTP 监听线程仍在跑；用当前（非 daemon）线程的 sleep
             * 把 JVM 钉住。中断就重试，永不返回。
             */
            jclass threadClass = (*env)->FindClass(env, "java/lang/Thread");
            jmethodID sleep = (*env)->GetStaticMethodID(env, threadClass, "sleep", "(J)V");
            while (sleep != NULL) {
                (*env)->CallStaticVoidMethod(env, threadClass, sleep, (jlong)3600000);
                if ((*env)->ExceptionCheck(env)) {
                    (*env)->ExceptionClear(env);
                }
            }
        }
    }];
#endif
}

@end
