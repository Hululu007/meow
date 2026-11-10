# 许可与免责

## 许可类型

**猫窝 Meow 非商业许可 1.0** —— 自定义许可，属于 **source-available（源码可见）**，
不是 OSI 认可的开源许可证。

完整条款以仓库根目录的 [LICENSE](https://github.com/upchr/meow/blob/main/LICENSE) 为准，
本页只是摘要。

## 允许

1. 免费使用、复制、修改本软件
2. 在**非商业目的**下分发本软件及其修改版本，但必须：
   - 保留许可全文与版权声明
   - 在修改版本中注明修改内容

## 禁止

1. **任何商业使用**，包括但不限于：
   - 销售本软件或其修改版
   - 以本软件提供付费服务
   - 集成进商业产品或商业服务
   - 在营利性组织的业务中使用（**即使只在内部使用**）
2. 移除或修改许可与版权声明
3. 用于任何违法用途

## 非商业用途的范围

个人学习、研究、自用、爱好项目、非营利组织与非营利性开源交流，都属于非商业用途。

营利性组织即使只在内部使用，也属于商业用途。

## 免责声明

本软件按「现状」提供，不提供任何明示或暗示的担保，包括但不限于适销性、
特定用途适用性和不侵权担保。作者不对使用本软件产生的任何直接或间接损失负责。

## 内容源责任

::: danger 这一段最重要
- 本仓库与公开 Release **不提供任何内容源**：没有 spider jar、没有站点配置、
  没有影视内容、没有弹幕数据。
- 所有内容都来自用户自行导入的第三方源。**导入什么、看什么、是否合规，由用户负责。**
- 项目只提供「加载与播放」的技术能力，不对源站的内容、可用性与合法性做任何担保。
- 请遵守你所在地区的法律法规与内容平台的服务条款。
:::

## 第三方组件

仓库包含以下第三方代码或协议实现，版权与许可归原作者，**其许可优先于本项目许可**：

| 组件 | 位置 | 许可 |
|---|---|---|
| Fongmi/TV 派生代码 | `client/apps/tv/app/src/main/java/com/github/catvod/` | GPL-3.0；TV 端 APK 作为整体按 GPL-3.0 分发 |
| 依赖 jar | `server/host/libs/` | 各自 `META-INF` 中的声明 |
| danmu_api | 仅在构建产物包含时 | AGPL-3.0（以其 LICENSE 为准） |

完整说明见 [NOTICE](https://github.com/upchr/meow/blob/main/NOTICE)。

::: warning TV APK 的 GPL 义务
TV 端因为包含 Fongmi 派生代码，整个 APK 按 GPL-3.0 分发。
如果你分发修改后的 TV 端，需要同时提供对应源码。
:::

## 参考项目

以下项目只作协议、契约与交互参考，不作为运行时依赖，公开库不包含其源码：

| 项目 | 参考了什么 |
|---|---|
| [Fongmi/TV](https://github.com/Fongmi/TV) | TV 端契约：`/config.json` 九字段、`spider;md5` 语义、`ParseJob` 五种解析、`Site` 三态开关 |
| [Fongmi/CatVodSpider](https://github.com/Fongmi/CatVodSpider) | spider jar 的 class 结构与 `Class.forName` 动态加载模型 |
| [huangxd-/danmu_api](https://github.com/huangxd-/danmu_api) | 弹幕聚合协议、`SOURCE_ORDER`、两段式候选 |
| [motao123/webtv](https://github.com/motao123/webtv) | Android 客户端的源管理、直播、drpy 支持机制对照 |
| [xyoye/DanDanPlayForAndroid](https://github.com/xyoye/DanDanPlayForAndroid) | 弹幕轨道调度与密度控制 |
| [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) | 选线规则、季数感知相关性过滤、SSRF 归一化思路（重写） |
| [MoonTechLab/LunaTV](https://github.com/MoonTechLab/LunaTV) | 用户态存储接口化思路（重写） |
| [orion-lib/OrionTV](https://github.com/orion-lib/OrionTV) | TV 返回键三层语义、长按连发、控制条屏蔽方向键 |

## 贡献

提交代码即表示你同意以本项目许可分发你的贡献。
如果你不同意，请不要提交。
