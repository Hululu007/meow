#import "JvmBridge.h"

#if !TARGET_OS_SIMULATOR && !defined(MEOW_NO_JVM)

#include <jni.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef RTLD_FIRST
#define RTLD_FIRST 0x100
#endif

/*
 * ★ JVM 现在是**动态库**（build/openjdk-framework/libOpenJDK.dylib），
 * 不再静态链进主程序。原因：静态 JVM + 侧载器（LiveContainer）会在 main
 * 之前就死（LaunchLog 一行都没有），而同一个 App 不链 JVM 就能起。
 * 改成 dlopen 后，主程序与「无 JVM」包一样小，加载失败也只是本地网关不可用。
 *
 * 静态 JVM 在找自己的 JNI 原生方法时会调用 dlopen(NULL, RTLD_FIRST)，
 * 该调用返回的是**主程序**句柄；JVM 在自己的 dylib 里，用主程序句柄找不到
 * 它的符号。把本编译单元对 dlopen 的引用绑到一个隐藏的同名包装上，
 * 把「NULL + RTLD_FIRST」换成 JVM dylib 自己的句柄。
 */
static char gJvmImagePath[PATH_MAX];

/*
 * 只供 kickWatchdog 用：VM 建好之后要能从任意线程（App 回前台）反射调
 * ApiServer.kickWatchdog()，必须留着 JavaVM 指针。
 */
static JavaVM *gJavaVM = NULL;

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
        if (gJvmImagePath[0] == '\0') return NULL;
        return systemLoader(gJvmImagePath, mode | RTLD_NOLOAD);
    }
    return systemLoader(path, mode);
}

typedef jint (*MeowCreateJavaVMFn)(JavaVM **pvm, void **penv, void *args);

#pragma mark - 崩溃现场取证

/*
 * ★ 为什么要有这层：iOS 上 JVM 起不来时，进程可能**直接死掉**（SIGABRT/SIGSEGV），
 * 屏幕上什么都看不到，就是「闪退」。没有日志就无从判断是「VM 选项不被接受」
 * 还是「内存不够被 jetsam 杀」还是「jar 里的类崩了」。
 * 这里做两件事：
 *   1) 启动前把进程的 stdout/stderr 重定向到 Documents/jvm.log（JVM 的致命错误
 *      也走这两个 fd）；
 *   2) 装 SIGABRT/SIGSEGV/SIGILL/SIGFPE/SIGBUS 处理器：先把「崩在哪个信号」
 *      写进同一个文件，再恢复默认动作（重新抛出），进程照旧死，但现场留下来了。
 * 日志目录开了 UIFileSharingEnabled，用户可以从「文件」App 里直接取走。
 */
static int gJvmLogFd = -1;

static void jvmLogWrite(const char *text) {
    if (gJvmLogFd < 0) return;
    size_t len = strlen(text);
    ssize_t ignored = write(gJvmLogFd, text, len);
    (void)ignored;
}

static void jvmSignalHandler(int sig) {
    char buf[128];
    int n = snprintf(buf, sizeof(buf), "\n[meow-jvm] FATAL signal %d at %s\n",
                      sig, __DATE__ " " __TIME__);
    if (n > 0) jvmLogWrite(buf);
    signal(sig, SIG_DFL);
    raise(sig);
}

static void jvmInstallSignalHandlers(void) {
    int sigs[] = {SIGABRT, SIGSEGV, SIGILL, SIGFPE, SIGBUS};
    for (size_t i = 0; i < sizeof(sigs) / sizeof(sigs[0]); i++) {
        signal(sigs[i], jvmSignalHandler);
    }
}

static NSString *jvmLogPath(NSString *dataDir) {
    return [dataDir stringByAppendingPathComponent:@"jvm.log"];
}

/*
 * 原生下载（源 jar）。
 *
 * JVM 侧 platform.IosNative.download 由 RegisterNatives 指到这里：在**调用线程**上
 * 同步等 NSURLSession 下完（调用方是导入/转换的后台线程，不是主线程，允许阻塞）。
 * 失败返回 false，Jars 会回退到自己的 HttpURLConnection 路径 —— 功能不受影响。
 */
static jboolean meowNativeDownload(JNIEnv *env, jclass cls, jstring jurl, jstring jdest) {
    (void)cls;
    if (jurl == NULL || jdest == NULL) return JNI_FALSE;
    const char *curl = (*env)->GetStringUTFChars(env, jurl, NULL);
    const char *cdest = (*env)->GetStringUTFChars(env, jdest, NULL);
    if (curl == NULL || cdest == NULL) {
        if (curl) (*env)->ReleaseStringUTFChars(env, jurl, curl);
        if (cdest) (*env)->ReleaseStringUTFChars(env, jdest, cdest);
        return JNI_FALSE;
    }
    NSString *url = [NSString stringWithUTF8String:curl];
    NSString *dest = [NSString stringWithUTF8String:cdest];
    (*env)->ReleaseStringUTFChars(env, jurl, curl);
    (*env)->ReleaseStringUTFChars(env, jdest, cdest);
    if (url.length == 0 || dest.length == 0) return JNI_FALSE;

    __block BOOL ok = NO;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    cfg.timeoutIntervalForRequest = 60;
    cfg.timeoutIntervalForResource = 300;
    NSURLSession *session = [NSURLSession sessionWithConfiguration:cfg];
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:url]];
    req.timeoutInterval = 60;
    [req setValue:@"meow-spider-jar/1" forHTTPHeaderField:@"User-Agent"];
    [[session downloadTaskWithRequest:req
                    completionHandler:^(NSURL *loc, NSURLResponse *resp, NSError *err) {
                        (void)resp;
                        if (loc != nil && err == nil) {
                            NSFileManager *fm = [NSFileManager defaultManager];
                            [fm removeItemAtPath:dest error:NULL];
                            ok = [fm moveItemAtURL:loc
                                              toURL:[NSURL fileURLWithPath:dest]
                                              error:NULL];
                        } else if (err != nil) {
                            char buf[256];
                            const char *why = err.localizedDescription.UTF8String;
                            snprintf(buf, sizeof(buf), "[meow-jvm] native download failed: %s\n",
                                     why != NULL ? why : "?");
                            jvmLogWrite(buf);
                        }
                        dispatch_semaphore_signal(sem);
                    }] resume];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)300 * NSEC_PER_SEC));
    [session finishTasksAndInvalidate];
    return ok ? JNI_TRUE : JNI_FALSE;
}

#endif

@implementation JvmBridge

+ (BOOL)isAvailable {
#if TARGET_OS_SIMULATOR
    return NO;
#elif defined(MEOW_NO_JVM)
    /*
     * 排障变体（CI dispatch nojvm=true）：不加载 JVM。
     * 用来区分「闪退发生在 dyld/静态初始化」还是「启动 JVM 的那一刻」。
     */
    return NO;
#else
    NSURL *resources = NSBundle.mainBundle.resourceURL;
    if (!resources) return NO;
    NSString *modules = [resources.path stringByAppendingPathComponent:@"openjdk/lib/modules"];
    NSString *hostJar = [resources.path stringByAppendingPathComponent:@"jvm/host.jar"];
    NSFileManager *fm = NSFileManager.defaultManager;
#ifdef MEOW_JVM_STATIC
    return [fm fileExistsAtPath:modules] && [fm fileExistsAtPath:hostJar];
#else
    NSString *dylib = [NSBundle.mainBundle.privateFrameworksPath
                       stringByAppendingPathComponent:@"libOpenJDK.dylib"];
    return [fm fileExistsAtPath:modules] && [fm fileExistsAtPath:hostJar]
        && [fm fileExistsAtPath:dylib];
#endif
#endif
}

/*
 * App 回前台：叫醒 Java 端看门狗，立刻探一次 /api/_hb。
 *
 * iOS 挂起期间所有线程冻结，系统还可能把监听 socket 收走；回前台后如果干等
 * 看门狗下一轮（5 秒），用户先看到的是「后端连接中断」。这里只做一次
 * AttachCurrentThread + 静态方法调用，不解引用任何页面对象。
 */
+ (void)kickWatchdog {
#if TARGET_OS_SIMULATOR || defined(MEOW_NO_JVM)
    return;
#else
    if (gJavaVM == NULL) return;
    JNIEnv *env = NULL;
    BOOL attached = NO;
    jint state = (*gJavaVM)->GetEnv(gJavaVM, (void **)&env, JNI_VERSION_1_8);
    if (state == JNI_EDETACHED) {
        if ((*gJavaVM)->AttachCurrentThread(gJavaVM, (void **)&env, NULL) != JNI_OK) return;
        attached = YES;
    } else if (state != JNI_OK || env == NULL) {
        return;
    }
    jclass serverClass = (*env)->FindClass(env, "ApiServer");
    if (serverClass != NULL) {
        jmethodID kick = (*env)->GetStaticMethodID(env, serverClass, "kickWatchdog", "()V");
        if (kick != NULL) (*env)->CallStaticVoidMethod(env, serverClass, kick);
        if ((*env)->ExceptionCheck(env)) {
            (*env)->ExceptionDescribe(env);
            (*env)->ExceptionClear(env);
        }
        (*env)->DeleteLocalRef(env, serverClass);
    } else {
        (*env)->ExceptionClear(env);
    }
    if (attached) (*gJavaVM)->DetachCurrentThread(gJavaVM);
#endif
}

+ (nullable NSString *)logTail {
#if TARGET_OS_SIMULATOR
    return nil;
#else
    NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
    if (!docs) return nil;
    NSString *path = [docs stringByAppendingPathComponent:@"jvm.log"];
    NSString *text = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    if (!text) return nil;
    NSArray<NSString *> *lines = [text componentsSeparatedByString:@"\n"];
    NSUInteger keep = 25;
    NSUInteger start = lines.count > keep ? lines.count - keep : 0;
    NSArray<NSString *> *tail = [lines subarrayWithRange:NSMakeRange(start, lines.count - start)];
    return [tail componentsJoinedByString:@"\n"];
#endif
}

+ (void)startWithJavaHome:(NSString *)javaHome
                classPath:(NSString *)classPath
                  dataDir:(NSString *)dataDir
                     port:(int)port
               completion:(void (^)(BOOL, NSString *_Nullable))completion {
#if TARGET_OS_SIMULATOR
    completion(NO, @"simulator has no embedded JVM");
#elif defined(MEOW_NO_JVM)
    completion(NO, @"no-jvm build");
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

            /* 取证：stdout/stderr → Documents/jvm.log（append），再装信号处理器。 */
            NSString *logPath = jvmLogPath(dataDir);
            int fd = open(logPath.fileSystemRepresentation, O_CREAT | O_WRONLY | O_APPEND, 0644);
            if (fd >= 0) {
                gJvmLogFd = fd;
                dup2(fd, STDOUT_FILENO);
                dup2(fd, STDERR_FILENO);
                jvmLogWrite("\n[meow-jvm] app start\n");
            }
            jvmInstallSignalHandlers();

#ifdef MEOW_JVM_STATIC
            /*
             * F 变体：JVM 静态链进主程序 + 固定基址（-Wl,-no_pie）。
             * 依据 E 的 .ips：崩在 OpenJDK logging 的全局构造器里，写 __LINKEDIT
             * 只读页 —— 非 PIC 静态对象在 PIE 里绝对地址失效，-no_pie 是对应的修法。
             */
            Dl_info image = {0};
            if (dladdr((const void *)&JNI_CreateJavaVM, &image) && image.dli_fname) {
                strncpy(gJvmImagePath, image.dli_fname, sizeof(gJvmImagePath) - 1);
            }
            MeowCreateJavaVMFn createVM = (MeowCreateJavaVMFn)&JNI_CreateJavaVM;
            jvmLogWrite("[meow-jvm] static JNI_CreateJavaVM\n");
#else
            /*
             * 0) 探针：先 dlopen 一个 10 行的 dylib（libmeow-smoke.dylib）。
             *    - 探针也 SIGBUS/失败 → 侧载器根本不允许加载内嵌动态库（签名问题），
             *      「JVM 用 dylib」这条路在侧载器里走不通；
             *    - 探针 OK、JVM dylib 崩 → 问题在 OpenJDK 这个 dylib 本身。
             * 日志里这一行就是分水岭。
             */
            NSString *smokePath = [NSBundle.mainBundle.privateFrameworksPath
                stringByAppendingPathComponent:@"libmeow-smoke.dylib"];
            jvmLogWrite([NSString stringWithFormat:@"[meow-jvm] smoke dlopen %@\n", smokePath].UTF8String);
            void *smokeHandle = dlopen(smokePath.fileSystemRepresentation, RTLD_NOW | RTLD_LOCAL);
            if (smokeHandle == NULL) {
                const char *err = dlerror();
                jvmLogWrite([NSString stringWithFormat:@"[meow-jvm] smoke dlopen FAILED: %s\n",
                             err ? err : "unknown"].UTF8String);
            } else {
                void *fn = dlsym(smokeHandle, "meow_smoke");
                jvmLogWrite([NSString stringWithFormat:@"[meow-jvm] smoke dlopen OK (meow_smoke=%s)\n",
                             fn ? "found" : "missing"].UTF8String);
            }

            /* 1) 再加载 JVM 动态库（失败也只是「本地网关不可用」，App 照常进界面）。 */
            NSString *dylibPath = [NSBundle.mainBundle.privateFrameworksPath
                stringByAppendingPathComponent:@"libOpenJDK.dylib"];
            strncpy(gJvmImagePath, dylibPath.fileSystemRepresentation, sizeof(gJvmImagePath) - 1);
            jvmLogWrite([NSString stringWithFormat:@"[meow-jvm] dlopen %@\n", dylibPath].UTF8String);
            void *jvmHandle = dlopen(dylibPath.fileSystemRepresentation, RTLD_NOW | RTLD_LOCAL);
            if (jvmHandle == NULL) {
                const char *err = dlerror();
                NSString *why = [NSString stringWithFormat:@"dlopen libOpenJDK.dylib: %s",
                                 err ? err : "unknown"];
                jvmLogWrite(why.UTF8String);
                completion(NO, why);
                return;
            }
            MeowCreateJavaVMFn createVM =
                (MeowCreateJavaVMFn)dlsym(jvmHandle, "JNI_CreateJavaVM");
            if (createVM == NULL) {
                const char *err = dlerror();
                NSString *why = [NSString stringWithFormat:@"JNI_CreateJavaVM missing: %s",
                                 err ? err : "unknown"];
                jvmLogWrite(why.UTF8String);
                completion(NO, why);
                return;
            }

#endif

            NSString *tmp = NSTemporaryDirectory();
            NSString *trustStore = [javaHome stringByAppendingPathComponent:@"lib/security/cacerts"];
            /*
             * ★ 选项集**刻意与第一版（能正常启动的那版）保持一致**。
             *
             * 曾经加过两条：
             *   -XX:+UnlockDiagnosticVMOptions
             *   -XX:-BytecodeVerificationRemote
             * 目的是让外部 class jar（stackmap 不完整）不报 VerifyError
             * （OECT 源服务的 spider.jar 就是这种）。但静态链接的 Zero VM 与
             * HotSpot 不同：诊断类选项在某些构建里会走 fatal 路径，进程当场死，
             * 表现就是「装完就闪退、看不到任何提示」。
             * 代价（OECT spiderJvm 的 AppRJ 报 VerifyError）先记着，等真机
             * 跑通后再决定用「ASM 重算 stackmap」还是别的路子。
             */
            NSArray<NSString *> *options = @[
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
            jint created = createVM(&vm, (void **)&env, &args);
            for (NSUInteger i = 0; i < options.count; i++) free(rawOptions[i].optionString);

            if (created != JNI_OK || vm == NULL || env == NULL) {
                NSString *why = [NSString stringWithFormat:@"JNI_CreateJavaVM=%d", (int)created];
                jvmLogWrite(why.UTF8String);
                completion(NO, why);
                return;
            }
            gJavaVM = vm;

            /*
             * iOS 无 fork/exec：dex→class 走端内 dex2jar 库（vendor/dex2jar）。
             * 用系统属性而不是 -D 启动参数：属性在 JVM 起来之后再设，
             * 不给「启动参数不被接受」留任何可乘之机。
             */
            {
                jclass systemClass = (*env)->FindClass(env, "java/lang/System");
                if (systemClass != NULL) {
                    jmethodID setProperty = (*env)->GetStaticMethodID(
                        env, systemClass, "setProperty",
                        "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
                    if (setProperty != NULL) {
                        jstring key = (*env)->NewStringUTF(env, "meow.dex2jar.inprocess");
                        jstring value = (*env)->NewStringUTF(env, "true");
                        jobject ignored = (*env)->CallStaticObjectMethod(
                            env, systemClass, setProperty, key, value);
                        if (ignored) (*env)->DeleteLocalRef(env, ignored);
                        (*env)->DeleteLocalRef(env, key);
                        (*env)->DeleteLocalRef(env, value);
                    }
                    (*env)->DeleteLocalRef(env, systemClass);
                }
                if ((*env)->ExceptionCheck(env)) {
                    (*env)->ExceptionDescribe(env);
                    (*env)->ExceptionClear(env);
                }
            }

            /*
             * 注册原生下载：platform.IosNative.download → NSURLSession。
             *
             * 为什么值得：源 jar 常 1~5MB，Zero 解释执行下 JVM 的 TLS 与大文件 IO
             * 要十几秒，原生是秒级。类不存在（旧 jar）就跳过，Jars 会走自己的
             * HttpURLConnection —— 注册失败不影响功能。
             */
            {
                jclass iosNative = (*env)->FindClass(env, "platform/IosNative");
                if (iosNative != NULL) {
                    JNINativeMethod methods[1];
                    methods[0].name = (char *)"download";
                    methods[0].signature = (char *)"(Ljava/lang/String;Ljava/lang/String;)Z";
                    methods[0].fnPtr = (void *)meowNativeDownload;
                    jint rc = (*env)->RegisterNatives(env, iosNative, methods, 1);
                    jvmLogWrite(rc == JNI_OK ? "[meow-jvm] native download registered\n"
                                             : "[meow-jvm] native download register FAILED\n");
                    (*env)->DeleteLocalRef(env, iosNative);
                } else {
                    (*env)->ExceptionClear(env);
                }
            }

            jclass serverClass = (*env)->FindClass(env, "ApiServer");
            if (serverClass == NULL) {
                (*env)->ExceptionDescribe(env);
                (*env)->ExceptionClear(env);
                jvmLogWrite("[meow-jvm] ApiServer class not found\n");
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

            /*
             * 默认只绑回环：iOS 是手机，网关不该默认暴露到同一 Wi-Fi。
             * 「维护 → 调试 → 远程调试」打开后宿主会自己改绑 0.0.0.0 并要求令牌，
             * 状态存在 policy.json（lanDebug / lanToken），重启也保持。
             */
            jclass stringClass = (*env)->FindClass(env, "java/lang/String");
            jobjectArray arguments = (*env)->NewObjectArray(env, 3, stringClass, NULL);
            jstring portArg = (*env)->NewStringUTF(env, [[NSString stringWithFormat:@"--port=%d", port] UTF8String]);
            jstring dataArg = (*env)->NewStringUTF(env, [[@"--data-dir=" stringByAppendingString:dataDir] UTF8String]);
            jstring bindArg = (*env)->NewStringUTF(env, "--bind=127.0.0.1");
            (*env)->SetObjectArrayElement(env, arguments, 0, portArg);
            (*env)->SetObjectArrayElement(env, arguments, 1, dataArg);
            (*env)->SetObjectArrayElement(env, arguments, 2, bindArg);

            jvmLogWrite([NSString stringWithFormat:@"[meow-jvm] starting ApiServer (data=%@)\n",
                         dataDir].UTF8String);
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
