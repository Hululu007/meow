# host

最小 JVM 宿主：把 `libs/spider.jar`（dex2jar 产物）加载到普通 JVM，并暴露 zyfun
`T4_CATVOD` 所需的 HTTP 协议。

## 构建

```bat
build.bat
```

依赖（`libs/` 已包含）：

- spider.jar（dex2jar）
- okhttp 3.14.9 + okio 1.17.2
- gson 2.10.1
- android-json（Android 兼容 org.json，**必须**，新版 org.json 会拒绝数字转字符串）
- bcprov（AES/CBC/PKCS7Padding）

## 运行

```bat
run.bat
```

默认 `http://127.0.0.1:9979`。

## 端点

```
GET  /config                     CatVod 配置（zyfun 导入用）
GET  /config?only=A,B            只输出指定站点
GET  /health
POST /{Spider}/init
POST /{Spider}/home
POST /{Spider}/category          {"id":"1","page":"1","filters":{}}
POST /{Spider}/detail            {"id":"123"}
POST /{Spider}/search            {"wd":"关键词","pg":"1"}
POST /{Spider}/play              {"flag":"线路","id":"123"}
POST /{Spider}/action            {"action":"..."}
```

返回体直接是 spider 的 JSON，不包 `{code,data}`。

## zyfun 导入

设置 → 数据配置 → 快捷配置 → **Catvod** →
`http://127.0.0.1:9979/config` → 覆盖。

## 加站点

编辑 `src/SpiderHost.java`：

```java
SITES.put("ClassName", "显示名");
EXT.put("ClassName", "站点 ext");
```

`ClassName` 是配置里 `csp_` 后面的部分。重新 `build.bat`。

## 单 spider 调试

```bash
java -cp "classes;libs/*" Test Jpys "https://y2s52n7.com"
```

`Test` 会依次跑 home / category / detail / play 并打印结果。

## 注意

- 必须带 `-Dfile.encoding=UTF-8`，否则中文乱码
- `Init`、`Config`、`Push`、`Market` 依赖 Android UI，JVM 无法运行
- 网盘类（WangPan/Ali/AList）需要额外适配代理
