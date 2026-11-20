import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VideoPlayer from '../src/components/player/VideoPlayer.vue'
import { __resetPrefsCache } from '../src/stores/prefs'

/**
 * 进度条悬停不能让控制栏上方布局抖动（2026-11-20 用户实报）。
 *
 * 原来 `h-1.5 → group-hover/bar:h-2` 直接挂在流内元素上：鼠标一进进度条区域，
 * 包裹层高 2px 变化，控制栏是 absolute bottom-0，上方的密度峰谷图被顶起/落下，
 * 表现为"鼠标指着进度时上下抖动"。
 *
 * 判据：变粗的那层外面必须有一个固定高度的槽（h-2 + items-center），
 * 让视觉条在槽内对称长大，不参与父级高度计算。
 */
beforeEach(() => {
  __resetPrefsCache()
  localStorage.clear()
  document.documentElement.removeAttribute('data-tv')
})

describe('进度条悬停不改变流内高度', () => {
  it('h-1.5/h-2 的视觉条被固定高度槽包住', () => {
    const w = mount(VideoPlayer, {
      props: { src: 'https://cdn.example.com/a.mp4' },
      attachTo: document.body,
    })
    const bar = w.find('[class*="group-hover/bar:h-2"]')
    expect(bar.exists()).toBe(true)
    const slot = bar.element.parentElement as HTMLElement
    expect(slot).toBeTruthy()
    // 槽必须固定 8px 且垂直居中，否则悬停时父级仍会被撑高 2px
    expect(slot.className).toContain('h-2')
    expect(slot.className).toContain('items-center')
    // 视觉条自己不能再是流内的唯一高度来源（外层已有 h-2）
    expect(slot.className).not.toContain('group-hover/bar:h-2')
    w.unmount()
  })
})
