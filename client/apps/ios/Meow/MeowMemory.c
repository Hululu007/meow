#include "MeowMemory.h"

#include <mach/mach.h>
#include <mach/task_info.h>
#include <os/proc.h>

unsigned long long meow_mem_rss(void) {
    mach_task_basic_info_data_t info;
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO,
                  (task_info_t) &info, &count) != KERN_SUCCESS) {
        return 0;
    }
    return info.resident_size;
}

long long meow_mem_available(void) {
    // iOS 13+；部署目标高于该版本，不会有可用性问题
    return (long long) os_proc_available_memory();
}
