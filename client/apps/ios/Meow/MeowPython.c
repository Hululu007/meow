// 端内 CPython 启动桥（Objective-C/Swift 侧只看到一个函数）。
//
// 为什么用 C 而不是 Swift 直接调 Python C API：Python.h 里的宏/变参
// （PyRun_FileExFlags 等）在 Swift 里既不可见也难映射；一层薄 C 更稳。
//
// ★ 日志必须落文件：iOS 没有终端，Py_Initialize 失败或 pyrt.py 在 import
//   阶段抛异常时，stderr 直接进黑洞 —— 表现就是「设置页里 CPython 一直未知」，
//   完全无法区分「没打包」/「框架没加载」/「缺 C 扩展」。这里在初始化前
//   freopen 到 Documents/py.log，设置页可直接展示尾部。
#include "MeowPython.h"

#include <Python.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>

static char g_script[1024];
static char g_log[1024];

/*
 * 把当前 Python 异常的类型/消息直接写到日志文件。
 *
 * 为什么不能只靠 PyErr_Print：端内 CPython 默认不配置 C stdio 时
 * sys.stderr 是 None，PyErr_Print 什么都不写 —— 真机日志里只剩
 * "[meow-py] pyrt exited with error"，完全看不到 ImportError 是哪一个。
 * 这里用 PyErr_Fetch + PyObject_Str 自己取，写完再 Restore 让 PyErr_Print
 * 照旧（stderr 可用时仍有完整 traceback）。
 * 调用时 GIL 必须由当前线程持有（PyRun_FileExFlags 返回 FALSE 时满足）。
 */
static void dump_py_error(const char *path) {
    if (!path || !*path) return;
    PyObject *type = NULL, *value = NULL, *tb = NULL;
    PyErr_Fetch(&type, &value, &tb);
    PyErr_NormalizeException(&type, &value, &tb);
    FILE *f = fopen(path, "a");
    if (f) {
        const char *tname = type ? ((PyTypeObject *) type)->tp_name : "?";
        fprintf(f, "[meow-py] exception: %s: ", tname);
        if (value) {
            PyObject *s = PyObject_Str(value);
            if (s) {
                const char *msg = PyUnicode_AsUTF8(s);
                if (msg) fprintf(f, "%s", msg);
                Py_DECREF(s);
            }
        }
        fprintf(f, "\n");
        fflush(f);
        fclose(f);
    }
    PyErr_Restore(type, value, tb);
}

static void *meow_py_thread(void *arg) {
    (void)arg;
    if (g_log[0]) {
        // fd 1/2 在 Py_Initialize 时被 Python 用来建 sys.stdout/stderr，
        // 所以必须在初始化之前重定向，之后所有 traceback 才会进日志。
        freopen(g_log, "a", stdout);
        freopen(g_log, "a", stderr);
        setvbuf(stderr, NULL, _IONBF, 0);
    }
    fprintf(stderr, "\n[meow-py] start %s\n", g_script);

    Py_Initialize();
    if (!Py_IsInitialized()) {
        fprintf(stderr, "[meow-py] Py_Initialize failed\n");
        return NULL;
    }
    fprintf(stderr, "[meow-py] initialized %s\n", Py_GetVersion());

    FILE *fp = fopen(g_script, "r");
    if (!fp) {
        fprintf(stderr, "[meow-py] cannot open %s\n", g_script);
        return NULL;
    }
    PyObject *main_mod = PyImport_AddModule("__main__");
    PyObject *globals = PyModule_GetDict(main_mod);
    /*
     * ★ PyRun_FileExFlags 不会替我们设置 __file__（那是 import 机制的活）。
     *   pyrt.py 用 `os.path.dirname(os.path.abspath(__file__))` 定位 scripts 目录，
     *   真机实测（2026-11-26）就挂在第一行：NameError: name '__file__' is not defined。
     *   PC/TV 走 importlib 加载所以有 __file__，只有这条 C 桥需要手工补。
     */
    PyObject *dunsel = PyUnicode_FromString(g_script);
    if (dunsel) {
        PyDict_SetItemString(globals, "__file__", dunsel);
        Py_DECREF(dunsel);
    }
    // PyRun_FileExFlags 的最后两个参数：closeit=1、flags=NULL
    PyObject *res = PyRun_FileExFlags(fp, g_script, Py_file_input, globals, globals, 1, NULL);
    if (!res) {
        fprintf(stderr, "[meow-py] pyrt exited with error\n");
        dump_py_error(g_log); // stderr 为 None 时也能留下异常类型/消息
        PyErr_Print();        // 已重定向到 g_log
    } else {
        Py_DECREF(res);
    }
    return NULL;
}

int meow_py_start(const char *script_path, const char *log_path) {
    if (!script_path || !*script_path) return -1;
    snprintf(g_script, sizeof(g_script), "%s", script_path);
    g_log[0] = '\0';
    if (log_path && *log_path) snprintf(g_log, sizeof(g_log), "%s", log_path);

    pthread_attr_t attr;
    pthread_attr_init(&attr);
    /*
     * 8MB 栈：iOS 二级线程默认只有 512KB。Python 初始化 + 标准库 import
     * 的递归深度很容易啃掉几百 KB，栈溢出表现为直接 SIGSEGV —— 与
     * "Python 没起来"在日志上无法区分。NodeBridge 的 node 线程同样给 8MB。
     */
    pthread_attr_setstacksize(&attr, 8 * 1024 * 1024);
    pthread_t t;
    int rc = pthread_create(&t, &attr, meow_py_thread, NULL);
    pthread_attr_destroy(&attr);
    if (rc != 0) return -1;
    pthread_detach(t);
    return 0;
}
