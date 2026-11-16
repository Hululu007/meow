import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { sanitizeCastHeader } from '@/api'

/**
 * 投屏的"不可回退"约束：
 * 1) 投给第三方设备的 URL 不能带 Cookie/Authorization（电视和沿途日志都能看到）
 * 2) PlayView 必须用局域网旁路 base + 令牌拼投屏地址（否则回环/相对地址会被后端拒）
 * 3) 需解析器的源不能出现投屏入口
 */
describe('投屏 URL 安全与形状', () => {
  it('剔除敏感头，保留 Referer/UA', () => {
    const h = sanitizeCastHeader({
      Referer: 'https://a.example/',
      'User-Agent': 'okhttp/3.12.0',
      Cookie: 'sid=1',
      Authorization: 'Bearer x',
      'X-Api-Key': 'k',
      token: 't',
    })
    expect(h).toEqual({
      Referer: 'https://a.example/',
      'User-Agent': 'okhttp/3.12.0',
    })
  })

  it('只剩敏感头时返回 undefined', () => {
    expect(sanitizeCastHeader({ Cookie: 'sid=1' })).toBeUndefined()
    expect(sanitizeCastHeader('{"Authorization":"x"}')).toBeUndefined()
  })

  it('PlayView 用 castBase + token 拼投屏地址，并排除 needsParse', () => {
    const src = readFileSync('src/views/PlayView.vue', 'utf8')
    expect(src).toContain('castBase(')
    expect(src).toContain('token: cb.token')
    expect(src).toContain('needsParse(play.value)')
    expect(src).toContain('sanitizeCastHeader(')
  })
})

describe('投屏首投确认：应用内弹框 + TV 方向键', () => {
  it('Android 侧不再弹原生 AlertDialog，改为调用页面 confirmDialog', () => {
    const bridge = readFileSync(
      '../tv/app/src/main/java/com/meow/tv/CastReceiverBridge.java',
      'utf8',
    )
    expect(bridge).not.toContain('AlertDialog.Builder')
    expect(bridge).toContain('__meowCastConfirm')
    expect(bridge).toContain('__meowCastCancel')
    const tvBridge = readFileSync(
      '../tv/app/src/main/java/com/meow/tv/TvBridge.java',
      'utf8',
    )
    expect(tvBridge).toContain('castConfirmResult')
    expect(tvBridge).toContain('CastReceiverBridge.resolveConfirm')
  })

  it('页面注册全局确认函数，并把结果回填给原生', () => {
    const app = readFileSync('src/App.vue', 'utf8')
    expect(app).toContain('__meowCastConfirm')
    expect(app).toContain('__meowCastCancel')
    expect(app).toContain('castConfirmResult')
    expect(app).toContain('confirmDialog(')
  })

  it('弹框本身带 TV 焦点契约（方向键收窄到框内、默认落取消）', () => {
    const dlg = readFileSync('src/components/common/ConfirmDialog.vue', 'utf8')
    expect(dlg).toContain('data-tv-scope')
    expect(dlg).toContain('data-tv-first')
  })

  it('ext-play 换会话必须重建组件（否则连投一直播旧片）', () => {
    const app = readFileSync('src/App.vue', 'utf8')
    expect(app).toContain("route.name === 'extPlay' ? route.fullPath : route.path")
    const ext = readFileSync('src/views/ExternalPlayView.vue', 'utf8')
    expect(ext).toContain('st.sessionId && st.media?.url')
    expect(ext).toContain("name: 'extPlay'")
  })
})

describe('投屏来源身份与退出', () => {
  it('发送端按运行时判定 pc/tv/web，并带设备名', () => {
    const lib = readFileSync('src/api/library.ts', 'utf8')
    expect(lib).toContain('castSenderIdentity')
    expect(lib).toContain("kind: 'tv'")
    expect(lib).toContain("kind: 'pc'")
    expect(lib).toContain("kind: 'web'")
    expect(lib).toContain('deviceName')
    expect(lib).toContain('sender: sender || castSenderIdentity()')
  })

  it('接收端记录来源 kind/model/host，弹框用组合标签', () => {
    const recv = readFileSync(
      '../../../server/host/src/shared/core/CastReceiver.java',
      'utf8',
    )
    expect(recv).toContain('senderKind')
    expect(recv).toContain('senderModel')
    expect(recv).toContain('senderHost')
    expect(recv).toContain('senderLabel(')
    expect(recv).toContain('p.confirm(senderLabel(')
  })

  it('接收页显示来源、BACK 退出、自动播放被拦时静音兜底', () => {
    const ext = readFileSync('src/views/ExternalPlayView.vue', 'utf8')
    expect(ext).toContain('senderLabel')
    expect(ext).toContain('__meowTvPageBack')
    expect(ext).toContain('__meowTvConsumeBack')
    expect(ext).toContain('@autoplay-muted="mutedFallback = true"')
    expect(ext).toContain(':muted-fallback="true"')
    expect(ext).toContain('开启声音')
    const vp = readFileSync('src/components/player/VideoPlayer.vue', 'utf8')
    expect(vp).toContain('mutedFallback?: boolean')
    expect(vp).toContain('!props.mutedFallback')
    expect(ext).toContain('来自 {{ senderLabel }}')
    expect(ext).toContain("new Event('meow:tv-pageback')")
  })

  it('A 类占位 DMR 超时提示（回了 playing 但 position/duration 一直 0）', () => {
    const play = readFileSync('src/views/PlayView.vue', 'utf8')
    expect(play).toContain('castStall')
    expect(play).toContain('没有开始播放')
    expect(play).toContain('castDuration.value === 0')
  })
})

describe('投屏面板 UX：分组 / 高度 / TV 滚动 / 成功收起', () => {
  const play = readFileSync('src/views/PlayView.vue', 'utf8')
  const vp = readFileSync('src/components/player/VideoPlayer.vue', 'utf8')

  it('设备按猫窝/DLNA 分组，首项给 TV 焦点', () => {
    expect(play).toContain('castGroups')
    expect(play).toContain("title: '猫窝设备'")
    expect(play).toContain("title: 'DLNA 电视'")
    expect(play).toContain(':data-tv-first="g === castGroups[0] && i === 0 ? true : undefined"')
  })

  it('面板有最大高度，设备列表自己滚动（tv-nav 会跟着焦点滚）', () => {
    expect(play).toContain('max-h-[calc(100dvh-2rem)]')
    expect(play).toContain('min-h-0 flex-1 overflow-y-auto')
    expect(play).toContain('castPanelAnchored')
    expect(play).toContain('castPanelStyle')
    expect(play).toContain("top: '4.25rem'")
    const nav = readFileSync('../tv/app/src/main/assets/tv-nav.js', 'utf8')
    expect(nav).toContain('scrollIntoViewWithin')
    expect(nav).toContain("st.overflowY === 'auto'")
  })

  it('成功后 toast + 900ms 自动收起，不再盖着画面', () => {
    expect(play).toContain('showCastToast')
    expect(play).toContain('已投到「')
    expect(play).toContain('closeCast()')
    expect(play).toContain('}, 900)')
  })

  it('投屏图标在右上角；不可投置灰并保留原因', () => {
    expect(vp).toContain('castReason')
    expect(vp).toContain('投屏不可用')
    expect(vp).toContain('castButtonAnchor($event)')
    expect(vp).toContain('v-if="canCast || !!castReason"')
    expect(vp).toContain('casting')
    expect(play).toContain(':cast-reason="castReason"')
    expect(play).toContain(':casting="!!castSession"')
  })
})
