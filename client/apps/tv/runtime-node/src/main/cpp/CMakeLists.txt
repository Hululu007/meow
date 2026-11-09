cmake_minimum_required(VERSION 3.22.1)
project(meow_node_bridge CXX)

add_library(meow_node_bridge SHARED node_bridge.cpp)

# 链接模块里预编译的 libnode.so：这样产物的 DT_NEEDED 会带 libnode.so，
# 宿主用 DexClassLoader(nativePath="base.apk!/lib/<abi>") 加载本桥时，
# 动态链接器会在同一个搜索路径里解析到它。
set(NODE_LIB ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(meow_node_bridge ${NODE_LIB} ${log-lib})
