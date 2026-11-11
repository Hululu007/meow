# 快速开始

按你手头的设备选一条路。三条路都指向同一个目标：**起一个后端，导入源包，开始播放**。

## 路线选择

| 你的情况 | 走这条 | 预计耗时 |
|---|---|---|
| 有 NAS / 服务器 / 常开的电脑 | [Docker 四容器](#一-docker-最省事) | 5 分钟 |
| 只有 Windows 电脑 | [PC 桌面端](#二-pc-桌面端) | 3 分钟 |
| 只想在电视上看 | [TV 客户端](#三-tv-客户端) | 5 分钟 |
| 用飞牛 fnOS | [fnOS 套件](#四-飞牛-fnos) | 3 分钟 |

::: tip 先准备好源包
所有形态装完都是**空壳**，必须有源包才能搜索与播放。
源包 = `config.all.json` + dex spider jar（JVM 会自动转 class），详见 [导入源包](/guide/source-pack)。
:::

## 一、Docker（最省事）

需要 Docker 与 Compose 插件。

```bash
# 1. 取配置模板
git clone https://github.com/upchr/meow.git
cd meow/deploy/docker
cp .env.example .env

# 2. 起四个容器（web / apiserver / drpy / danmu_api）
docker compose up -d

# 3. 浏览器打开
#    http://localhost:30010
```

四个容器的分工：

| 容器 | 内容 | 默认端口 |
|---|---|---|
| `web` | nginx + 静态文件（不含 JVM） | 30010 |
| `apiserver` | JVM + spider jar + ffmpeg（不含 nginx） | 30011，默认只绑本机 |
| `drpy` | Node 运行时，跑 `.js` / drpy 源 | 30013 |
| `danmu_api` | 弹幕聚合（可选） | 30012，默认只绑本机 |

**drpy 不建议省**：导入大型配置时，几百个 `.js` 源没有它会直接判「不可用」。
不需要弹幕聚合可以把 `MEOW_DANMAKU_API` 显式置空（写成 `MEOW_DANMAKU_API=`），
否则每次弹幕请求会先等一次超时才降级。

完整参数、反代、多架构与排障见 [Web / Docker](/guide/web-docker)。

## 二、PC 桌面端

1. 从 [Releases](https://github.com/upchr/meow/releases) 下载 `meow-setup-<版本>.exe`（安装版）
   或 `meow-bare-<版本>.exe`（免安装）。
2. 首次打开会显示「后端未连接」。**这是设计如此**，不是安装失败：
   安装包不含后端插件。
3. 进入「设置 → 本机插件」，填插件源地址，下载「影视后端」。
4. 装完自动启动，首页恢复。

插件源可以填官方地址，也可以自建；离线环境支持「粘贴 JSON」。
详细步骤与插件升级、回滚见 [PC 桌面端](/guide/pc)。

## 三、TV 客户端

1. 下载 `meow-TV-<版本>.apk`，用 U 盘或 `adb install` 装到电视 / 盒子。
2. 打开应用，进入「设置 → 本机执行 → 配置地址」。
3. 填入源包里的 `config.all.json` 地址（顶层 `spider` 是 dex jar）。
4. 返回首页，等待站点加载。

遥控器操作、扫码把后端地址推给电视、端内网关见 [TV / 投影仪](/guide/tv)。

## 四、飞牛 fnOS

1. 在飞牛应用中心添加应用源，或直接安装 Releases 里的 `meow_<版本>_x86.fpk` / `_arm.fpk`。
2. 装完从应用中心入口打开。
3. 在设置页导入源包。

套件自带 Node 22 运行时，弹幕插件装完即用。见 [飞牛 fnOS](/guide/fnos)。

## 下一步：导入源包

三端入口不同，导入逻辑一致：

- **Web / PC**：设置 → 配置源 → 填地址或上传文件
- **TV**：设置 → 本机执行 → 配置地址

支持多仓索引、单仓 `config.json`、CatVod / TVBox / Fongmi 配置。
逐步说明与格式差异见 [导入源包](/guide/source-pack)。

## 起不来时

1. 先看 [常见问题](/guide/faq)，覆盖了「后端未连接」「源全红」「能搜不能播」这几类。
2. Web 版按容器逐个排查，见 [Web / Docker](/guide/web-docker#排障)。
3. 仍无头绪时提 Issue，附上版本号、端类型与日志片段。
