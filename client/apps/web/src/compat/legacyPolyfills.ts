/**
 * Chromium 66（Android 9 电视 / 投影仪的 WebView）缺失的内置 API 补丁。
 *
 * ## 为什么 esbuild 的 target 管不到这里
 *
 * `vite.config.ts` 的 `build.target = 'es2017'` 只保证**语法**可解析
 * （`?.` / `??` 会被降级）。`Promise.allSettled`、`Object.fromEntries`
 * 这类是**运行时内置对象**，语法合法但调用时抛 TypeError —— 构建产物里
 * 原样保留，老内核一执行就炸，而新内核完全无感。
 *
 * ## 投影仪实测清单（2026-11-12，WebView 66 = V8 6.6）
 *
 * | API                        | 起始版本 | 用在哪（源码处） |
 * |----------------------------|---------|------------------|
 * | Promise.allSettled         | 76      | 更新中心「检查全部」/自动检查 |
 * | Array.prototype.flatMap    | 69      | AI 面板多源结果合并 |
 * | Object.fromEntries         | 73      | 收藏保存、AI 工具 schema |
 * | String.prototype.matchAll  | 73      | WebDAV PROPFIND 解析 |
 * | Array.prototype.at         | 92      | fpk 版本挑选 |
 * | Object.hasOwn              | 93      | 防御性判断（预置） |
 * | String.prototype.replaceAll| 85      | 文本清洗（预置） |
 * | Array.prototype.findLast   | 97      | 倒查（预置） |
 * | Promise.any                | 85      | 竞速（预置） |
 *
 * 不补的后果不是"样式难看"，而是这些**功能在投影仪上直接报错**。
 *
 * ## 实现约定
 *
 * - 只在缺失时安装（新内核走原生实现，零开销）；
 * - 模块评估即安装（`import './compat/legacyPolyfills'` 放 main.ts 第一行），
 *   保证任何业务代码执行前已就绪；
 * - 语义对齐 MDN：`matchAll` 要求全局正则、`at` 支持负索引、
 *   `flatMap` 先 map 再 flatten 一层。
 */

type AnyFn = (...args: any[]) => any

function defineOn(target: object, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, { value, writable: true, configurable: true })
  } catch {
    ;(target as Record<string, unknown>)[key] = value
  }
}

export function installLegacyPolyfills(): void {
  const PromiseAny = Promise as unknown as { allSettled?: AnyFn }
  if (typeof PromiseAny.allSettled !== 'function') {
    defineOn(Promise, 'allSettled', function allSettled(iterable: Iterable<unknown>) {
      return Promise.all(
        Array.from(iterable, (p) =>
          Promise.resolve(p).then(
            (value) => ({ status: 'fulfilled', value }),
            (reason) => ({ status: 'rejected', reason }),
          ),
        ),
      )
    })
  }

  const arrayProto = Array.prototype as unknown as Record<string, AnyFn>

  if (typeof arrayProto.flat !== 'function') {
    defineOn(Array.prototype, 'flat', function flat(this: ArrayLike<unknown>, depth = 1) {
      const max = depth === undefined ? 1 : Number(depth)
      const out: unknown[] = []
      const walk = (arr: ArrayLike<unknown>, d: number): void => {
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i]
          if (d > 0 && Array.isArray(v)) walk(v, d - 1)
          else out.push(v)
        }
      }
      walk(this as ArrayLike<unknown>, Number.isFinite(max) ? max : Infinity)
      return out
    })
  }

  if (typeof arrayProto.flatMap !== 'function') {
    defineOn(Array.prototype, 'flatMap', function flatMap(this: unknown[], fn: AnyFn, thisArg?: unknown) {
      const mapped = Array.prototype.map.call(this, fn, thisArg)
      return (Array.prototype as unknown as Record<string, AnyFn>).flat.call(mapped, 1)
    })
  }

  if (typeof arrayProto.at !== 'function') {
    defineOn(Array.prototype, 'at', function at(this: ArrayLike<unknown>, index: number) {
      const len = (this as ArrayLike<unknown>).length
      const i = Math.trunc(Number(index)) || 0
      const real = i < 0 ? len + i : i
      if (real < 0 || real >= len) return undefined
      return (this as ArrayLike<unknown>)[real]
    })
  }

  const stringProto = String.prototype as unknown as Record<string, AnyFn>
  if (typeof stringProto.matchAll !== 'function') {
    defineOn(String.prototype, 'matchAll', function matchAll(this: unknown, re: RegExp) {
      if (!(re instanceof RegExp) || !re.global) {
        throw new TypeError('String.prototype.matchAll called with a non-global RegExp argument')
      }
      const src = String(this)
      // 克隆正则：原生 matchAll 不修改入参的 lastIndex
      const clone = new RegExp(re.source, re.flags)
      const found: RegExpExecArray[] = []
      let m: RegExpExecArray | null
      while ((m = clone.exec(src)) !== null) {
        found.push(m)
        if (m[0] === '') clone.lastIndex += 1 // 零宽匹配防死循环
      }
      let idx = 0
      const iterable = {
        next(): IteratorResult<RegExpExecArray> {
          if (idx >= found.length) return { done: true, value: undefined as never }
          return { done: false, value: found[idx++] }
        },
        [Symbol.iterator]() {
          return this
        },
      }
      return iterable
    })
  }

  const ObjectAny = Object as unknown as { fromEntries?: AnyFn }
  if (typeof ObjectAny.fromEntries !== 'function') {
    defineOn(Object, 'fromEntries', function fromEntries(this: unknown, entries: Iterable<[PropertyKey, unknown]>) {
      const out: Record<PropertyKey, unknown> = {}
      for (const pair of entries) {
        if (!Array.isArray(pair) || pair.length < 2) {
          throw new TypeError('Iterator value ' + String(pair) + ' is not an entry object')
        }
        out[pair[0]] = pair[1]
      }
      return out
    })
  }

  const ObjectAny2 = Object as unknown as Record<string, AnyFn>
  if (typeof ObjectAny2.hasOwn !== 'function') {
    defineOn(Object, 'hasOwn', function hasOwn(obj: unknown, prop: PropertyKey) {
      return Object.prototype.hasOwnProperty.call(obj, prop)
    })
  }

  if (typeof stringProto.replaceAll !== 'function') {
    defineOn(String.prototype, 'replaceAll', function replaceAll(
      this: unknown,
      search: string | RegExp,
      replacement: string | ((...args: any[]) => string),
    ) {
      const src = String(this)
      if (search instanceof RegExp) {
        if (!search.global) {
          throw new TypeError('String.prototype.replaceAll called with a non-global RegExp argument')
        }
        return src.replace(search, replacement as never)
      }
      // 字符串搜索走转义正则：$& / $$ / 函数替换的语义与规范一致
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return src.replace(new RegExp(escaped, 'g'), replacement as never)
    })
  }

  if (typeof arrayProto.findLast !== 'function') {
    defineOn(Array.prototype, 'findLast', function findLast(
      this: unknown[],
      pred: AnyFn,
      thisArg?: unknown,
    ) {
      for (let i = this.length - 1; i >= 0; i--) {
        if (pred.call(thisArg, this[i], i, this)) return this[i]
      }
      return undefined
    })
  }
  if (typeof arrayProto.findLastIndex !== 'function') {
    defineOn(Array.prototype, 'findLastIndex', function findLastIndex(
      this: unknown[],
      pred: AnyFn,
      thisArg?: unknown,
    ) {
      for (let i = this.length - 1; i >= 0; i--) {
        if (pred.call(thisArg, this[i], i, this)) return i
      }
      return -1
    })
  }

  // Promise.any 需要 AggregateError（同为 85+）；没用到也一并备好，避免半套。
  // ★ 不能用 globalThis：它是 Chrome 71+，Chromium 66 上**没有**这个标识符，
  //   模块顶层直接 ReferenceError → 整个应用黑屏（2026-11-12 投影仪实测踩到）。
  //   这里用 typeof 守卫 + window 兜底。
  const G: Record<string, unknown> =
    typeof globalThis !== 'undefined'
      ? (globalThis as unknown as Record<string, unknown>)
      : (window as unknown as Record<string, unknown>)
  if (typeof G.AggregateError !== 'function') {
    class AggregateErrorPolyfill extends Error {
      errors: unknown[]
      constructor(errors: unknown[], message?: string) {
        super(message)
        this.name = 'AggregateError'
        this.errors = errors
      }
    }
    defineOn(G as object, 'AggregateError', AggregateErrorPolyfill)
  }
  const PromiseAny2 = Promise as unknown as { any?: AnyFn }
  if (typeof PromiseAny2.any !== 'function') {
    defineOn(Promise, 'any', function any(iterable: Iterable<unknown>) {
      return new Promise((resolve, reject) => {
        const items = Array.from(iterable)
        const errors: unknown[] = new Array(items.length)
        let pending = items.length
        let settled = false
        if (pending === 0) {
          reject(new (G.AggregateError as any)([], 'All promises were rejected'))
          return
        }
        items.forEach((p, i) => {
          Promise.resolve(p).then(
            (v) => {
              if (settled) return
              settled = true
              resolve(v)
            },
            (e) => {
              errors[i] = e
              pending -= 1
              if (pending === 0 && !settled) {
                settled = true
                reject(new (G.AggregateError as any)(errors, 'All promises were rejected'))
              }
            },
          )
        })
      })
    })
  }
}

// 模块评估即安装：main.ts 把它放在第一行 import，业务代码执行前必然已就绪。
installLegacyPolyfills()
