/**
 * AI 对话状态（**模块级单例**，跨实例共享）。
 *
 * <p><b>为什么必须提出来</b>（2026-11-03 用户反馈「面板点全屏后历史会话丢了，
 * 这俩 AI 内容显示应该统一」）：
 * 原来 `msgs` / `cacheBusy` / `cacheDone` 都是 `AiPanel.vue` 的组件内 ref。
 * 而这两个界面是**两个独立实例**：
 *   · 浮层 → `App.vue` 里的 `<AiPanel :hidden="route.name === 'ai'" />`
 *   · 独立页 → `AiView.vue` 里的 `<AiPanel inline />`
 * 组件内 ref 各自一份，点「全屏」只是路由跳转（旧实例 hidden，新实例挂载），
 * 于是新实例从空对话开始——用户眼里就是"聊到一半点全屏，记录没了"。
 *
 * <p>放模块级而不是 Pinia：这里只有一个数组和两个进度表，没有派生逻辑，
 * 引 Pinia 只是多一层。**注意模块级状态在服务端渲染会跨请求泄漏**，
 * 但我们是纯 SPA（Vite 产物 + Tauri/WebView），没有 SSR，不存在这个问题。
 *
 * <p>仍然**不持久化**：刷新即清。面板处理的是"我为什么播不了"这类即时问题，
 * 跨会话留着既没用又让 localStorage 多一份隐私（见 AiPanel 的注释）。
 */

import { ref } from 'vue'
import type { CachePlan, SearchHit } from '@/ai/tools'

export interface ChatMsg {
  id: number
  role: 'user' | 'ai'
  text: string
  /** 该轮的影片卡片（只有 AI 消息可能有） */
  hits?: SearchHit[]
  /** 该轮的工具轨迹 */
  trace?: string[]
  /** 该轮的失败原因（与 text 互斥展示） */
  error?: string
  /**
   * 待用户确认的缓存计划（AI 请求缓存这部片时会带上）。
   *
   * <p>为什么不是"直接下"：下载是写操作、要花流量和磁盘，
   * 模型只负责提出"这部可以缓存，共 12 集"，真正开始必须用户点一下。
   */
  cachePlan?: CachePlan
}

/** 对话记录（浮层与独立页共享同一份） */
export const aiMsgs = ref<ChatMsg[]>([])
/** 正在提交的缓存计划（按消息 id），防重复点击 */
export const aiCacheBusy = ref<number | null>(null)
/** 缓存提交结果提示（按消息 id） */
export const aiCacheDone = ref<Record<number, string>>({})

let seq = 0

/** 追加一条消息，返回它的 id */
export function pushAiMsg(m: Omit<ChatMsg, 'id'>): number {
  const id = ++seq
  aiMsgs.value.push({ id, ...m })
  return id
}

export function patchAiMsg(id: number, patch: Partial<ChatMsg>) {
  const m = aiMsgs.value.find((x) => x.id === id)
  if (m) Object.assign(m, patch)
}

/** 清空对话（浮层与独立页共用同一个「清空」语义） */
export function clearAiMsgs() {
  aiMsgs.value = []
  aiCacheDone.value = {}
  aiCacheBusy.value = null
}
