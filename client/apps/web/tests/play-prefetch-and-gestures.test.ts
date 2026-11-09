import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  prefetchKey,
  putPlayPrefetch,
  takePlayPrefetch,
  hasPlayPrefetch,
  clearPlayPrefetch,
  playPrefetchSize,
  prefetchDiag,
  notePrefetchProgress,
  __resetPrefetchDiag,
  PREFETCH_TTL_MS,
} from '../src/utils/playPrefetch'

/**
 * 下集地址预取（2026-11-03 用户定的"方案 B"）。
 *
 * 只预取**地址**、不预拉分片，理由见模块注释：
 * Web 两个 <video> 不共享 MediaSource，分片预拉用不上；
 * 而地址解析（0.4–1.9s）才是切集转圈的主因。
 */

const dir = join(__dirname, '..', 'src')
const PLAY = readFileSync(join(dir, 'views', 'PlayView.vue'), 'utf8')

beforeEach(() => clearPlayPrefetch())

describe('预取缓存：取走即删（签名地址只能用一次）', () => {
  it('放进去能取出来，取一次之后就没了', () => {
    const k = prefetchKey('AppGet', '4K', 'ep1')
    putPlayPrefetch(k, { url: 'https://x/a.m3u8', header: '{"Referer":"r"}', parse: 0 })
    expect(hasPlayPrefetch(k)).toBe(true)

    const e = takePlayPrefetch(k)
    expect(e?.url).toBe('https://x/a.m3u8')
    expect(e?.header).toBe('{"Referer":"r"}')

    // 第二次取不到：源站直链带 token/time，复用大概率已过期
    expect(takePlayPrefetch(k)).toBeNull()
    expect(playPrefetchSize()).toBe(0)
  })

  it('超过 TTL 的条目取不到，且顺手清掉', () => {
    const k = prefetchKey('AppGet', '4K', 'ep1')
    const t0 = 1_000_000
    putPlayPrefetch(k, { url: 'u' }, t0)
    expect(takePlayPrefetch(k, t0 + PREFETCH_TTL_MS + 1)).toBeNull()
    expect(playPrefetchSize()).toBe(0)
  })

  it('TTL 边界内仍有效', () => {
    const k = prefetchKey('s', 'f', 'e')
    const t0 = 5_000
    putPlayPrefetch(k, { url: 'u' }, t0)
    expect(takePlayPrefetch(k, t0 + PREFETCH_TTL_MS)).not.toBeNull()
  })
})

describe('缓存键必须带线路名', () => {
  it('同一集在不同线路是不同的键（地址不同）', () => {
    expect(prefetchKey('AppGet', '线路一', 'ep1')).not.toBe(prefetchKey('AppGet', '线路二', 'ep1'))
  })

  it('不同站点同样的集名也不冲突', () => {
    expect(prefetchKey('A', 'f', 'ep1')).not.toBe(prefetchKey('B', 'f', 'ep1'))
  })
})

describe('PlayView 的接入点', () => {
  it('load() 优先读预取，未命中才请求', () => {
    expect(PLAY).toMatch(/takePlayPrefetch\(prefetchKey\(site, flag\.value, rawId\.value\)\)/)
    // 命中时不能再打一次 fetchPlay（否则预取等于白做）
    expect(PLAY).toMatch(/const r = hit\s*\?\s*\(/)
    expect(PLAY).toMatch(/:\s*await fetchPlay\(site, flag\.value, rawId\.value\)/)
  })

  it('预取在播到 30 秒后才触发，且每集只一次', () => {
    expect(PLAY).toMatch(/PLAY_PREFETCH_AFTER_SEC = 30/)
    expect(PLAY).toMatch(/prefetchedPlayEp\.has\(key\)/)
    expect(PLAY).toMatch(/prefetchedPlayEp\.add\(key\)/)
  })

  it('需要解析器（parse=1）的线路不预取：解析器有频率限制，别提前烧配额', () => {
    expect(PLAY).toMatch(/if \(needsParse\(r\)\) \{/)
  })

  it('预取失败静默：不能因为预取挂了就播不了', () => {
    // prefetchNextPlay 内部的 try/catch 必须有
    const i = PLAY.indexOf('async function prefetchNextPlay')
    // 窗口按"到 catch 为止"取：中间的分支会随诊断记录增删，写死长度必失效
    const body = PLAY.slice(i, PLAY.indexOf('function maybePrefetchNextPlay', i))
    expect(body).toContain('try {')
    // catch 里要写诊断事件，所以带参数：catch (e) { ... }
    expect(body).toMatch(/catch\s*(\([^)]*\))?\s*\{/)
  })
})

describe('竖滑手势：亮度 / 音量走系统级', () => {
  const BRIDGE = readFileSync(join(dir, 'api', 'nativeBridge.ts'), 'utf8')
  const JAVA = readFileSync(
    join(__dirname, '..', '..', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'TvBridge.java'),
    'utf8',
  )
  const PLAYER = readFileSync(join(dir, 'components', 'player', 'VideoPlayer.vue'), 'utf8')

  it('桥接口齐全：读写音量 + 读写亮度', () => {
    for (const m of ['getVolume', 'setVolume', 'getBrightness', 'setBrightness']) {
      expect(BRIDGE, `nativeBridge 缺 ${m}`).toContain(m)
      expect(JAVA, `TvBridge 缺 ${m}`).toContain(`public ${m === 'setVolume' || m === 'setBrightness' ? 'boolean' : 'int'} ${m}(`)
    }
  })

  it('Java 侧用 STREAM_MUSIC 与 screenBrightness（不是元素音量/滤镜）', () => {
    expect(JAVA).toContain('AudioManager.STREAM_MUSIC')
    expect(JAVA).toContain('screenBrightness')
  })

  it('亮度和音量都做了 origin 校验（恶意页面不能把屏幕调黑）', () => {
    for (const m of ['getVolume', 'setVolume', 'getBrightness', 'setBrightness']) {
      const i = JAVA.indexOf(`public ${/set/.test(m) ? 'boolean' : 'int'} ${m}(`)
      const body = JAVA.slice(i, i + 200)
      expect(body, `${m} 缺 trustedOrigin()`).toContain('trustedOrigin()')
    }
  })

  it('亮度下限不为 0（全黑后用户找不到手指位置）', () => {
    expect(JAVA).toMatch(/Math\.max\(0\.05f/)
  })

  it('播放器按左右 1/3 分区，中间不抢（留给单击暂停）', () => {
    expect(PLAYER).toMatch(/swipe\.kind = 'brightness'/)
    expect(PLAYER).toMatch(/swipe\.kind = 'volume'/)
    // 中间区必须 return，否则"想暂停却调了音量"
    expect(PLAYER).toMatch(/else return \/\/ 中间 1\/3 不做竖滑/)
  })

  it('系统能力不可用时退回元素音量 / 变暗层，并把兜底说清楚', () => {
    expect(PLAYER).toMatch(/hasSystemVolume|setSystemVolume\(pct\)/)
    expect(PLAYER).toMatch(/cssDim\.value = ok \? 0 :/)
    // 两种兜底语义不同：亮度只能压画面，音量只能改本播放器
    // （2026-11-03 踩过：音量分支也显示「仅画面」，读起来像笔误）
    expect(PLAYER).toContain("'仅画面'")
    expect(PLAYER).toContain("'仅播放器'")
  })

  it('提示条是竖向柱子（手势上下滑，横向进度条方向对不上）', () => {
    // 轨道必须有固定高度、填充按 height 从底部涨
    expect(PLAYER).toMatch(/h-36 w-3 overflow-hidden rounded-full bg-white\/25/)
    expect(PLAYER).toContain('absolute inset-x-0 bottom-0 rounded-full transition-[height]')
    expect(PLAYER).toContain("height: swipeHint.pct + '%'")
    // 不能再留着横向填充
    expect(PLAYER).not.toContain("width: swipeHint.pct + '%'")
  })

  it('竖滑判定：竖直位移 > 16 且大于水平 1.2 倍（斜滑不误判）', () => {
    expect(PLAYER).toMatch(/Math\.abs\(dyRaw\) < 16/)
    expect(PLAYER).toMatch(/Math\.abs\(dyRaw\) < Math\.abs\(dx\) \* 1\.2/)
  })
})

describe('鼠标滚轮调音量（2026-11-03 用户要求）', () => {
  const PLAYER = readFileSync(join(__dirname, '..', 'src', 'components', 'player', 'VideoPlayer.vue'), 'utf8')

  it('绑在舞台上，且触屏不走滚轮', () => {
    expect(PLAYER).toContain('@wheel="onStageWheel"')
    const i = PLAYER.indexOf('function onStageWheel')
    expect(PLAYER.slice(i, i + 400)).toContain('if (isTouch.value) return')
  })

  it('面板打开时不拦（滚轮留给面板翻页）', () => {
    const i = PLAYER.indexOf('function onStageWheel')
    const body = PLAYER.slice(i, i + 900)
    expect(body).toContain('showEpPanel.value')
    expect(body).toContain('showDmSearch.value')
    expect(body).toContain('e.preventDefault()')
  })

  it('deltaMode 归一化 + 40ms 节流 + 落盘延后（触控板不会一次拉到底）', () => {
    const i = PLAYER.indexOf('function onStageWheel')
    const body = PLAYER.slice(i, i + 1600)
    expect(body).toContain('e.deltaMode === 1')
    expect(body).toMatch(/now - wheelThrottleAt < 40/)
    expect(body).toContain('wheelSaveTimer')
    expect(body).toMatch(/notches > 0 \? -5 : 5/)
  })

  it('滚轮走同一个 applySwipe，复用系统音量与浮层', () => {
    const i = PLAYER.indexOf('function onStageWheel')
    const body = PLAYER.slice(i, i + 1600)
    expect(body).toContain("applySwipe('volume', next)")
    expect(body).toContain('systemVolume()')
  })
})

describe('缓冲参数（实测对照后调整）', () => {
  const PLAYER = readFileSync(join(__dirname, '..', 'src', 'components', 'player', 'VideoPlayer.vue'), 'utf8')

  it('三档参数与实测结论一致：180/300/120MB，回看 60 秒', () => {
    expect(PLAYER).toContain('maxBufferLength: 180')
    expect(PLAYER).toContain('maxMaxBufferLength: 300')
    expect(PLAYER).toContain('maxBufferSize: 120 * 1000 * 1000')
    expect(PLAYER).toContain('backBufferLength: 60')
  })

  it('注释里保留实测数据（下一个人要能判断能不能再改）', () => {
    expect(PLAYER).toContain('B 180/300/120MB → 领先 188s')
    expect(PLAYER).toContain('C 240/600/200MB → 领先 235s')
    // 为什么不做全片预缓冲
    expect(PLAYER).toContain('600MB')
  })
})

describe('预取的键必须与 load() 同源（2026-11-03 实测踩过）', () => {
  const PLAY = readFileSync(join(__dirname, '..', 'src', 'views', 'PlayView.vue'), 'utf8')

  it('prefetchNextPlay 用 safeDecode(next.url) 归一后再拼键', () => {
    // 踩过：playlist 里的 url 未解码，load() 用 safeDecode 后的 rawId，
    // 两边直接拼键永远不相等 → hasPlayPrefetch 恒 false，预取一次没命中。
    const i = PLAY.indexOf('async function prefetchNextPlay')
    const body = PLAY.slice(i, i + 1400)
    expect(body).toContain('const epUrl = safeDecode(next.url)')
    expect(body).toContain('prefetchKey(site, flag.value, epUrl)')
    expect(body).toContain('fetchPlay(site, flag.value, epUrl)')
    // 不能再用未归一的 next.url 去请求/拼键
    expect(body).not.toContain('fetchPlay(site, flag.value, next.url)')
    expect(body).not.toContain('prefetchKey(site, flag.value, next.url)')
  })

  it('load() 侧仍然是 safeDecode 后的 rawId（两边同源）', () => {
    expect(PLAY).toContain('rawId = ref(safeDecode(')
    expect(PLAY).toContain('takePlayPrefetch(prefetchKey(site, flag.value, rawId.value))')
  })
})

describe('预取诊断（2026-11-03 排查踩坑后的常驻记录）', () => {
  it('prefetchDiag 直接给出缓存条数', () => {
    // 踩过：在控制台 import('/src/utils/playPrefetch.ts') 再读 playPrefetchSize()
    // 拿到的是 HMR 之后的**另一个模块实例**（URL 带 ?t=），永远是 0，
    // 于是把"预取没触发"误判了两轮。诊断必须从应用自己的实例读。
    const k = prefetchKey('S', 'F', 'ep')
    putPlayPrefetch(k, { url: 'https://x/a.m3u8' })
    expect(prefetchDiag().cached).toBe(1)
    takePlayPrefetch(k)
    expect(prefetchDiag().cached).toBe(0)
  })

  it('记录了进度回调次数与最大播放位置', () => {
    __resetPrefetchDiag()
    notePrefetchProgress(3)
    notePrefetchProgress(41.5)
    const d = prefetchDiag()
    expect(d.progressCalls).toBe(2)
    expect(d.maxPos).toBeCloseTo(41.5)
  })
})

describe('切集不能把旧片位置写成新集进度（2026-11-03 实测：第 5 集从 36 分钟开播）', () => {
  it('路由变化时先关掉进度落盘', () => {
    const i = PLAY.indexOf("watch(\n  () => route.fullPath")
    expect(i, '找不到 route.fullPath 监听').toBeGreaterThan(0)
    const body = PLAY.slice(i, i + 900)
    expect(body).toContain('progressArmed = false')
  })

  it('新片 loaded 之后才允许落盘', () => {
    const i = PLAY.indexOf('function applyResume')
    const body = PLAY.slice(i, i + 300)
    // 必须在 resumeApplied 早退**之前**置位，否则 loaded 第二次进来时不会armed
    expect(body.indexOf('progressArmed = true')).toBeGreaterThan(0)
    expect(body.indexOf('progressArmed = true')).toBeLessThan(body.indexOf('if (resumeApplied) return'))
  })

  it('onProgress 里只挡写历史，不挡观看时长累计', () => {
    const i = PLAY.indexOf('function onProgress')
    const body = PLAY.slice(i, i + 1400)
    expect(body).toContain('if (progressArmed) flushToHistory(p.final, p)')
    // 不能整段 return 掉，否则 watched 会断档
    expect(body).not.toContain('if (!progressArmed) return')
  })
})

describe('预取只触发一次（心跳 5 秒一次，不能每次都进）', () => {
  it('maybePrefetchNextPlay 用 prefetchArmed 去重，换集时重置', () => {
    const i = PLAY.indexOf('function maybePrefetchNextPlay')
    const body = PLAY.slice(i, i + 600)
    expect(body).toContain('if (prefetchArmed) return')
    expect(body).toContain('prefetchArmed = true')
    expect(PLAY).toContain('prefetchArmed = false')
  })
})
