#ifndef MEOW_PYTHON_H
#define MEOW_PYTHON_H

/// 启动端内 CPython 并执行 pyrt.py（阻塞在 HTTP server 的主循环里）。
///
/// <p>必须在后台线程调用：Py_Initialize 与 serve_forever 都不会返回。
/// 返回 0 = 线程已拉起；-1 = 参数错误/线程创建失败。
///
/// <p>log_path 非空时把 Python 的 stdout/stderr 重定向到该文件：
/// iOS 没有终端，Py_Initialize/import 的致命错误否则完全看不到。
int meow_py_start(const char *script_path, const char *log_path);

#endif
