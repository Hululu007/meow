// node 运行时的最小 JNI 桥。
//
// 只做三件事：切 cwd → 把 Java 的 String[] 转成 argv → 调 node::Start。
// node::Start 是**阻塞**的（整个 event loop 跑在调用线程上），所以 Java 侧
// 必须放在专用线程里调，不能在主线程。
//
// nodejs-mobile 的 libnode.so 里该符号是 `_ZN4node5StartEiPPc`（已 nm 核实），
// 这里按 C++ 声明直接链接，DT_NEEDED 会带上 libnode.so —— 宿主用
// DexClassLoader(nativePath="base.apk!/lib/<abi>") 加载本桥时，动态链接器
// 会在同一搜索路径里解析到它。

#include <jni.h>
#include <unistd.h>

#include <string>
#include <vector>

namespace node {
int Start(int argc, char* argv[]);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_meow_runtime_node_NodeBridge_startProcess(JNIEnv* env, jclass,
                                                   jstring workDir,
                                                   jobjectArray argvArray) {
    if (workDir != nullptr) {
        const char* dir = env->GetStringUTFChars(workDir, nullptr);
        if (dir != nullptr) {
            if (chdir(dir) != 0) {
                // cwd 切不过去也无所谓：后面 argv 里用的是绝对路径。
                // 但不能静默 —— 返回一个可识别的错误码。
                env->ReleaseStringUTFChars(workDir, dir);
                return -101;
            }
            env->ReleaseStringUTFChars(workDir, dir);
        }
    }

    jsize count = env->GetArrayLength(argvArray);
    if (count <= 0) return -102;

    std::vector<std::string> store;
    store.reserve(static_cast<size_t>(count));
    for (jsize i = 0; i < count; ++i) {
        auto item = static_cast<jstring>(env->GetObjectArrayElement(argvArray, i));
        const char* chars = item == nullptr ? nullptr : env->GetStringUTFChars(item, nullptr);
        store.emplace_back(chars == nullptr ? "" : chars);
        if (chars != nullptr) env->ReleaseStringUTFChars(item, chars);
        if (item != nullptr) env->DeleteLocalRef(item);
    }

    std::vector<char*> argv;
    argv.reserve(store.size() + 1);
    for (auto& s : store) argv.push_back(const_cast<char*>(s.c_str()));
    argv.push_back(nullptr);

    return node::Start(static_cast<int>(store.size()), argv.data());
}
