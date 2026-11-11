# 技术文档

> 面向二次开发与排障。只想把客户端装起来用，走 [快速开始](/guide/quick-start)。
>
> 这些文件就在仓库里，路径 `site/docs/dev/`，与文档站共用同一份正文。

| 文档 | 解决什么 |
|---|---|
| [三端架构](./architecture.md) | 四层骨架、核心组件、三出口、ADR |
| [接口契约](./api-contract.md) | 前后端契约：响应、错误码、降级 |
| [前端手册](./frontend.md) | 前端不可回退决策与踩坑 |
| [播放与转码](./playback.md) | 八类播放错误、转码决策、ABR、看门狗 |
| [弹幕](./danmaku.md) | 四源优先级、降级、缓存与调度 |
| [片库与离线缓存](./library-cache.md) | WebDAV/SMB/local、Range、断点续传 |
| [直播](./live.md) | 两源聚合、跨源合并、线路池 |
| [AI 助手](./ai-assistant.md) | 工具、编排、哑 REST 边界 |
| [配置系统](./config-system.md) | 导入、落盘、jar 加载、站点分派 |
| [插件系统](./plugin-system.md) | manifest、插件源、校验 |
| [TV 接入与 Fongmi](./tv-integration.md) | `/config.json`、加载器、签名与分发 |
| [数据与状态](./data-state.md) | 数据目录、policy.json、跨端通道 |
| [Docker 部署](./docker.md) | 四容器、`.env`、排障、多架构 |
| [构建与发版](./build-release.md) | units.json、tag 与链路、清单生成 |
| [测试与验收](./testing.md) | 单测、CI、冒烟脚本、验收清单 |
## 说明

- 源包（spider jar / 站点配置）不在本仓库，导入规则见 [导入源包](/guide/source-pack)。
- 部署与发版命令见仓库根目录的 `deploy/README.md`。
