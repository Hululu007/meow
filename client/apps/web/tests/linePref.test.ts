import { describe, expect, it, beforeEach } from 'vitest'
import { clearLinePref, getLinePref, setLinePref } from '../src/stores/linePref'

describe('线路偏好', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('记住后能读回', () => {
    setLinePref('A', '100', '线路二')
    expect(getLinePref('A', '100')).toBe('线路二')
  })

  it('不同片的偏好互不干扰', () => {
    setLinePref('A', '100', '线路二')
    setLinePref('A', '200', '线路三')
    expect(getLinePref('A', '100')).toBe('线路二')
    expect(getLinePref('A', '200')).toBe('线路三')
  })

  it('同 id 不同站的偏好互不干扰', () => {
    setLinePref('A', '100', '线路二')
    setLinePref('B', '100', '线路四')
    expect(getLinePref('A', '100')).toBe('线路二')
    expect(getLinePref('B', '100')).toBe('线路四')
  })

  it('没记过返回空串（调用方据此退回第一条线路）', () => {
    expect(getLinePref('A', '999')).toBe('')
  })

  it('缺参数时不写脏数据', () => {
    setLinePref('', '100', '线路二')
    setLinePref('A', '', '线路二')
    setLinePref('A', '100', '')
    expect(getLinePref('', '100')).toBe('')
    expect(getLinePref('A', '')).toBe('')
    expect(getLinePref('A', '100')).toBe('')
  })

  it('后写覆盖先写（用户改主意了）', () => {
    setLinePref('A', '100', '线路二')
    setLinePref('A', '100', '线路五')
    expect(getLinePref('A', '100')).toBe('线路五')
  })

  it('可以清除', () => {
    setLinePref('A', '100', '线路二')
    clearLinePref('A', '100')
    expect(getLinePref('A', '100')).toBe('')
  })

  it('存储被写坏时降级成"没有偏好"，不抛异常', () => {
    localStorage.setItem('meow.linepref', '{这不是合法 JSON')
    expect(() => getLinePref('A', '100')).not.toThrow()
    expect(getLinePref('A', '100')).toBe('')
    // 坏数据不该阻止后续写入
    setLinePref('A', '100', '线路二')
    expect(getLinePref('A', '100')).toBe('线路二')
  })

  it('超过 200 部片时裁掉最老的（长期数据也不能无限长）', () => {
    for (let i = 0; i < 205; i++) setLinePref('A', `v${i}`, '线路一')
    // 最老的几条被清掉，最新的一定还在
    expect(getLinePref('A', 'v0')).toBe('')
    expect(getLinePref('A', 'v204')).toBe('线路一')
    const raw = JSON.parse(localStorage.getItem('meow.linepref') || '{}')
    expect(Object.keys(raw).length).toBe(200)
  })
})
