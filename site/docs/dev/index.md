# 技术文档

> 面向二次开发与排障。只想把客户端装起来用，走 [快速开始](/guide/quick-start)。
>
> 这些文件就在仓库里，路径 `site/docs/dev/`，与文档站共用同一份正文。

| 文档 | 解决什么 |
|---|---|
| [三端架构](./architecture.md) | 四层骨架、核心组件、三出口、ADR |
| [接口契约](./api-contract.md) | 前后端契约：响应、错误码、降级 |
| [前端手册](./frontend.md) | 前端不可回退决策与踩坑 |
| [TV 接入与 Fongmi](./tv-integration.md) | TV 接入、`/config.json`、Fongmi 消费路径 |
| [插件系统](./plugin-system.md) | manifest、插件源、校验 |
| [Docker 部署](./docker.md) | 四容器、`.env`、排障、多架构 |
| [片库与离线缓存](./library-cache.md) | WebDAV/SMB/local、Range、断点续传 |
| [TV 签名](./tv-signing.md) | keystore 红线与签名注意事项 |
| [AI 助手](./ai-assistant.md) | 客户端 AI 工具与后端哑 REST 的边界 |

## 说明

- 源包（spider jar / 站点配置）不在本仓库，导入规则见 [导入源包](/guide/source-pack)。
- 部署与发版命令见仓库根目录的 `deploy/README.md`。
