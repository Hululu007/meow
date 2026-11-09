import { defineStore } from 'pinia'
import { apiBase, fetchSites, isDesktop, isLoopbackUrl, ping } from '@/api'
import type { Site } from '@/api/types'

/**
 * 桌面端冷启动时后端可能还没 bind 端口：先重试几次再报错。
 *
 * <p>踩过（2026-11-09）：插件 autostart 线程与页面首轮 ping 之间有 ~1–2 秒
 * 竞态。手填了回环地址时 `initBackend()` 以前会立刻返回，`store.boot()` 随即
 * ping 一个还没监听的端口 → 首页闪「后端未连接」，用户要点两次重试才进。
 * 这里多给 3 次机会（400ms 间隔，总约 1.2 秒），覆盖正常的 JVM 启动窗口。
 */
async function pingWithStartupRetry(): Promise<boolean> {
  const attempts = isDesktop() ? 4 : 1
  for (let i = 0; i < attempts; i++) {
    try {
      if (await ping()) return true
    } catch {
      // 网络层错误（Failed to fetch）与「返回 false」同等对待，继续重试
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

interface State {
  sites: Site[]
  current: string
  online: boolean
  loading: boolean
  error: string
}

export const useAppStore = defineStore('app', {
  state: (): State => ({
    sites: [],
    current: localStorage.getItem('meow.site') || '',
    online: false,
    loading: false,
    error: '',
  }),

  getters: {
    /** 有 ext 的站点优先展示（通常可用性更好） */
    sortedSites(state): Site[] {
      return [...state.sites].sort((a, b) => {
        // 被跳过的源沉到底：自动降级与手动停用都是"当前不参与聚合"的状态，
        // 只认 degraded 会让手动停用的源仍混在可用源里（用户以为它还在用）
        const ad = a.health?.degraded || a.health?.disabled ? 1 : 0
        const bd = b.health?.degraded || b.health?.disabled ? 1 : 0
        if (ad !== bd) return ad - bd
        const ae = a.ext ? 1 : 0
        const be = b.ext ? 1 : 0
        if (ae !== be) return be - ae
        return a.name.localeCompare(b.name, 'zh-CN')
      })
    },
    currentSite(state): Site | undefined {
      return state.sites.find((s) => s.key === state.current)
    },
  },

  actions: {
    async boot() {
      this.loading = true
      this.error = ''
      try {
        this.online = await pingWithStartupRetry()
        if (!this.online) {
          // 地址从插件管理器来，不再假设 9979；把实际地址显示出来才便于排障
          const where = apiBase()
          if (!isDesktop()) {
            this.error = `后端未连接：${where || '同源 /api'}`
          } else if (!where) {
            this.error =
              '影视后端未就绪：插件还没安装或还没启动完成。到「设置 → 本机插件」安装并启动它。'
          } else if (isLoopbackUrl(where)) {
            // 不要直接把 Failed to fetch 甩给用户：启动窗口期内它只是还没 bind
            this.error = `本机后端（${where}）暂时没有响应。若刚启动应用请稍等几秒；仍失败请到「设置 → 本机插件」查看后端状态。`
          } else {
            this.error = `后端（${where}）暂时无法连接。请检查地址、网络或服务状态；也可到设置页更换后端地址。`
          }
          // ★ 后端不可达不等于整个应用不可用：本地片库与已落盘的离线内容
          //   都在本地，不能让 online=false 把它们一起挡在门外。
          //   这里保留空站点表但**不提前 return 到不可用状态**，
          //   片库页（/library）照常可进、可播本机/局域网文件。
          return
        }
        this.sites = await fetchSites()
        if (!this.current || !this.sites.some((s) => s.key === this.current)) {
          this.current = this.sites[0]?.key || ''
        }
      } catch (e: any) {
        this.error = e?.message || String(e)
        this.online = false
      } finally {
        this.loading = false
      }
    },

    /** 只刷新站点表（含健康标记），不重跑 ping，用于打开"站点明细"时取最新状态 */
    async refreshSites() {
      try {
        this.sites = await fetchSites()
      } catch {
        /* 刷新失败保留旧列表，不打断设置页 */
      }
    },

    setCurrent(key: string) {
      this.current = key
      localStorage.setItem('meow.site', key)
    },
  },
})
