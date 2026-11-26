#ifndef MEOW_MEMORY_H
#define MEOW_MEMORY_H

/// 当前进程常驻内存（resident size，字节）。失败返回 0。
unsigned long long meow_mem_rss(void);

/// 系统还允许本进程继续申请的字节数（iOS 13+ `os_proc_available_memory`）。
/// 拿不到时返回 -1。
long long meow_mem_available(void);

#endif
