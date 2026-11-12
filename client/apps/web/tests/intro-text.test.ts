/**
 * 简介净化的行为锁。
 *
 * 取材全部是真实源站返回（2026-11-12 实测），不是编造的夹具 ——
 * 净化规则最容易写成"把正常文案也删了"，用例必须贴着真实形状。
 */
import { describe, expect, it } from 'vitest'
import { cleanIntro, cleanLine } from '../src/utils/introText'

describe('简介净化', () => {
  it('剥 HTML 标签，保留标签之间的文字', () => {
    expect(cleanIntro('<p>好看的<span>剧</span></p>')).toBe('好看的剧')
  })

  it('<br> 变成换行，块级标签断行后不留空行', () => {
    expect(cleanIntro('第一段<br>第二段<br/><br/>第三段')).toBe('第一段\n第二段\n第三段')
    expect(cleanIntro('<p>一</p><p>二</p>')).toBe('一\n二')
  })

  it('剥 BBcode', () => {
    expect(cleanIntro('[b]加粗[/b]普通[color=#fff]彩色[/color]')).toBe('加粗普通彩色')
  })

  it('剥源站塞进简介的 JSON 字段（B 站源实测）', () => {
    const raw =
      '{"id":"440933925/(pg)","name":"bili_75394567453"}]/bili_75394567453[/a]'
    // JSON 与 BBcode 都没了；剩下一个裸标识符也被当成噪音清掉
    expect(cleanIntro(raw)).toBe('')
  })

  it('数据后面跟着真简介时，只留真简介', () => {
    const raw = '{"id":"1","name":"x"}]本剧讲述一段江湖往事。[/a]'
    expect(cleanIntro(raw)).toBe('本剧讲述一段江湖往事。')
  })

  it('解常见实体', () => {
    expect(cleanIntro('A&nbsp;B &amp; C&lt;D&gt;')).toBe('A B & C<D>')
  })

  it('正常中文文案原样保留（含标点、换行）', () => {
    const raw = '十八件高能烧脑惨案对应十八层地狱刑罚。\n刑警队长与心理师从案件背后找出人性。'
    expect(cleanIntro(raw)).toBe(raw)
  })

  it('空值/纯空白返回空串', () => {
    expect(cleanIntro('')).toBe('')
    expect(cleanIntro(undefined)).toBe('')
    expect(cleanIntro('   \n\t ')).toBe('')
  })

  it('cleanLine 把换行压成空格（导演/主演这类单行字段）', () => {
    expect(cleanLine('<b>王辽</b><br>许魏洲')).toBe('王辽 许魏洲')
  })
})
