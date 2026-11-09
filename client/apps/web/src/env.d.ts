/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_API_TARGET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** 由 vite.config.ts 的 define 注入，值来自 apps/web/package.json 的 version */
declare const __APP_VERSION__: string

/**
 * 内置更新源（repo 级 release 端点），由 vite.config.ts 注入。
 *
 * 构建时可用 `MEOW_UPDATE_SOURCE` 覆盖（自建文件服务器 / 内部测试），
 * 不覆盖时落到 `appUpdate.ts` 的 `DEFAULT_UPDATE_SOURCE`。
 */
declare const __UPDATE_SOURCE__: string
