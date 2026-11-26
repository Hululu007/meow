// 端内 CPython 启动桥（Objective-C/Swift 侧只看到一个函数）。
//
// 为什么用 C 而不是 Swift 直接调 Python C API：Python.h 里的宏/变参
// （PyRun_FileExFlags 等）在 Swift 里既不可见也难映射；一层薄 C 更稳。
#include "MeowPython.h"

#include <Python.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>

static char g_script[1024];

static void *meow_py_thread(void *arg) {
    (void)arg;
    Py_Initialize();
    if (!Py_IsInitialized()) {
        fprintf(stderr, "[meow-py] Py_Initialize failed\n");
        return NULL;
    }
    FILE *fp = fopen(g_script, "r");
    if (!fp) {
        fprintf(stderr, "[meow-py] cannot open %s\n", g_script);
        PyErr_Print();
        return NULL;
    }
    PyObject *main_mod = PyImport_AddModule("__main__");
    PyObject *globals = PyModule_GetDict(main_mod);
    // PyRun_FileExFlags 的最后两个参数：closeit=1、flags=NULL
    PyObject *res = PyRun_FileExFlags(fp, g_script, Py_file_input, globals, globals, 1, NULL);
    if (!res) {
        fprintf(stderr, "[meow-py] pyrt exited with error\n");
        PyErr_Print();
    } else {
        Py_DECREF(res);
    }
    return NULL;
}

int meow_py_start(const char *script_path) {
    if (!script_path || !*script_path) return -1;
    snprintf(g_script, sizeof(g_script), "%s", script_path);
    pthread_t t;
    if (pthread_create(&t, NULL, meow_py_thread, NULL) != 0) return -1;
    pthread_detach(t);
    return 0;
}
