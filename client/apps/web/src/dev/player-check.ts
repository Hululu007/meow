import { createApp, h, ref } from 'vue'
import VideoPlayer from '@/components/player/VideoPlayer.vue'
import { parseDanmakuXml } from '@/components/player/danmaku'
import '@/styles/tokens.css'

const TEST_STREAM = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
const DANMAKU_API = '/api/proxy/danmaku?name=' + encodeURIComponent('猫鼬') + '&episode=1'

const logEl = document.getElementById('log')!
function log(msg: string) {
  logEl.textContent += msg + '\n'
  console.log(msg)
}

const App = {
  setup() {
    // 不阻塞渲染：先挂播放器，弹幕异步加载并写日志
    ;(async () => {
      try {
        const res = await fetch(DANMAKU_API)
        const xml = await res.text()
        const list = parseDanmakuXml(xml)
        log('danmaku: http ' + res.status + ' / parsed ' + list.length + ' items')
        if (list.length) log('first: ' + JSON.stringify(list[0]))
      } catch (e: any) {
        log('danmaku ERR: ' + e.message)
      }
    })()
    log('stream: ' + TEST_STREAM)

    return () =>
      h(
        'div',
        { style: 'height:100%' },
        [
          h(VideoPlayer, {
            src: TEST_STREAM,
            danmakuUrl: DANMAKU_API,
            title: '播放器自检 · 猫鼬',
            // 片头/片尾标记按 site+vod_id 存取，自检页给个固定组合
            site: 'SelfCheck',
            vodId: 'demo-001',
          }),
        ],
      )
  },
}

createApp(App).mount('#app')
