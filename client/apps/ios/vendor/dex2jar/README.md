# dex2jar 运行时子集（iOS 端内转换）

`client/apps/ios/build/jvm/libs/` 会把这里的 jar 一起打进 IPA，供
`core.Dex2JvmInProcess` 在端上把源包的 `classes.dex` 转成 class jar
（iOS 没有 fork/exec，不能调 `d2j-dex2jar` 脚本）。

| 文件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| `dex-reader-api` / `dex-reader` / `dex-ir` / `dex-translator` | 2.4 | Apache-2.0 | 转换核心 |
| `dex-tools` / `d2j-base-cmd` | 2.4 | Apache-2.0 | `BaksmaliBaseDexExceptionHandler` |
| `asm-*` | 9.5 | BSD-3-Clause | 字节码写出 |

来源：<https://github.com/pxb1988/dex2jar/releases/tag/v2.4> 的
`dex-tools-v2.4/lib/`，只取上面的 11 个 jar（约 1.1MB）。
升级时整组替换，并同步改 `server/host/src/shared/core/Dex2Jvm.java` 的
`toolTag` 命名（端内固定 `inproc`）与本文档。
