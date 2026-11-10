---
layout: home

hero:
  name: 猫窝 Meow
  text: 一套内核，三个出口
  tagline: 同一套 JVM 宿主、同一份 spider jar、同一套配置语义，同时服务浏览器、Windows 桌面端和 Android TV。仓库只提供加载能力，源包由你导入。
  image:
    src: /logo.svg
    alt: 猫窝 Meow
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: 下载客户端
      link: /reference/downloads
    - theme: alt
      text: GitHub
      link: https://github.com/upchr/meow

features:
  - icon: 🧩
    title: 宿主与源分离
    details: 内容源（spider）以 jar 由第三方分发。项目只做一次宿主，Web、PC、TV 三端复用，仓库不附带任何站点配置。
  - icon: 📺
    title: 三端同一份前端
    details: Vue 3 + TypeScript 一套模板，浏览器、Tauri 桌面壳、Android WebView 壳各自套壳，交互与状态保持一致。
  - icon: 🎬
    title: 播放链路完整
    details: HLS / DASH、解析式播放、自动换线、续播、片头尾跳过、选集连播、字幕、画中画、DLNA 与看门狗。
  - icon: 💬
    title: 弹幕多源降级
    details: 内置直连、聚合服务、自建 danmu_api 可按顺序并发抢占；手动搜索、屏蔽词、密度与透明度可调。
  - icon: 📡
    title: 直播与片库
    details: 站点聚合与 IPTV m3u，WebDAV / SMB / 本地片库，Range 直连与按需转 HLS，单集/整季离线缓存。
  - icon: 🔌
    title: 插件按需下载
    details: 安装包只有壳。后端、drpy、弹幕、Node 运行时都是插件，从插件源拉取、校验 SHA256、原子替换。
---

<DownloadCards />

## 三端怎么分工

| 端 | 后端在哪 | 怎么加载 spider | 典型场景 |
|---|---|---|---|
| **Web** | Docker 容器内独立 apiserver | JVM `classpath`（`Class.forName`） | NAS、服务器，浏览器或电视浏览器直接看 |
| **PC** | 随应用启动的 sidecar 进程 | 同上 | Windows 桌面，离线缓存与投屏 |
| **TV** | 无，客户端自己执行 | `DexClassLoader` 加载 dex 形态 jar | 电视盒子、投影仪，遥控器操作 |

## 这个仓库不包含什么

::: warning 请先读这一段
- **不提供任何内容源**：没有 spider jar、没有站点配置、没有第三方令牌。
- **不提供影视内容**：所有影片、直播与弹幕数据都来自你导入的源。
- **不允许商业使用**：采用自定义非商业许可，属于 source-available（源码可见），不是 OSI 开源许可。
:::

装完是空壳，导入源包后才恢复 jar 站与搜索能力。源包从哪来、怎么放、三端格式差异，见 [导入源包](/guide/source-pack)。

## 当前版本

文档对应源码版本 <VersionBadge />。发布产物以 [Releases](https://github.com/upchr/meow/releases) 页为准，
两者可能短暂不同步（源码版本领先于最近一次发布）。

已知限制集中在源站时效、线路存活与投影仪聚合搜索，逐条列在 [已知限制](/reference/limits)。
