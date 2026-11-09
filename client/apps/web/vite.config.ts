import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { flattenCssLayers } from './vite-plugins/flattenCssLayers'

// `__APP_VERSION__` 注入的是 **Web 应用自己的版本**（apps/web/package.json，0.2.x），
// 与桌面端（Cargo.toml / tauri.conf.json 的 0.7.x）是两条独立的版本线。
//
// ★ 不要拿它做插件的 `min_app_version` 校验。
//   实测踩过：这里注入 0.2.0，装 0.7.1 的后端插件时报
//   「影视后端 需要应用 0.6.0 或更高（当前 0.2.0）」，明明版本是够的。
//   桌面端该用 boot_info 里由 Rust 提供的 app_version（见 api/index.ts）。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/*
 * 内置更新源：构建期注入，默认留空交给 appUpdate.ts 的 DEFAULT_UPDATE_SOURCE。
 *
 * ★ 为什么允许用环境变量覆盖：换仓库、换自建文件服务器时只需
 *   `MEOW_UPDATE_SOURCE=http://nas:9000/packages.json pnpm build`，不用改源码。
 *
 * ★ 不用 GITHUB_REPOSITORY 之类的 CI 变量反推仓库：本机与 CI 会得到不同的
 *   清单地址，同一份代码在两处行为不一致，排查时极难定位。
 */
const updateSource = (process.env.MEOW_UPDATE_SOURCE || '').trim()

export default defineConfig({
  plugins: [vue(), tailwindcss(), flattenCssLayers()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __UPDATE_SOURCE__: JSON.stringify(updateSource),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  /*
   * vendored 的二维码库是 UMD（`module.exports = factory()`），文件后缀特意
   * 用 `.cjs`（见 src/utils/qr.ts 的说明）。**生产构建没问题**，但 dev 模式下
   * Vite 的 optimizeDeps 会把它当普通模块预打包，报
   * 「does not provide an export named 'default'」——设置页整页打不开
   * （点「设置」跳过去是空白的），排查时极易误判成路由坏了。
   * 加进 exclude 让它交给浏览器/插件按 CJS 处理。
   */
  optimizeDeps: {
    exclude: ['qrcode-generator'],
  },
  server: {
    port: 5173,
    // 监听全部网卡，手机/TV 才能通过局域网 IP 打开页面。
    // Java 后端仍只监听 127.0.0.1:9979，由下面的 /api 代理转发，
    // 不需要把后端一起暴露到局域网。
    host: true,
    proxy: {
      // 开发时把 /api 转发到 Java 后端，避免 CORS
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:9979',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 目标降到 ES2017（Chrome 58+）。
    //
    // 默认的 baseline-widely-available 是 Chrome 107+，而电视/投影仪盒子的
    // WebView 普遍停在 80–100。产物里的可选 catch 绑定、空值合并会让老内核
    // **直接语法报错**——整页白屏，连 JS 错误都打不出来。
    //
    // 实测 es2019 不够：可选 catch 绑定（`catch{}`，ES2019）在 es2019 目标下
    // 原样保留，仍会毒死 Chrome 73 之前的内核；只有 es2017 才会降级成 `catch(e)`。
    target: 'es2017',
  },
})
