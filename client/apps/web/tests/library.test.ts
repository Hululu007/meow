import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cacheIdFor,
  coverTitleFor,
  dirKindOf,
  groupByTitle,
  isVideoFile,
  libraryStream,
  parseFolderName,
  parseVideoName,
  posterUrl,
  scrapeTitleOf,
  seasonTitle,
  showTitleFrom,
} from '../src/api/library'

/**
 * 用例取自真实片库（docs/37 §零 实测）：命名规则不是猜的，
 * 是拿 NAS 上的实际文件名反过来验证解析器。
 */
describe('文件名解析', () => {
  it('剧集用 E01 而不是 S01E01', () => {
    const p = parseVideoName('白夜追凶.Day.and.Night.2017.E01.2160p.WEB-DL.H265.AAC-FLTTH.mp4')
    expect(p.episode).toBe(1)
    expect(p.year).toBe(2017)
    // 标题不能被 Web-DL 里的连字符切碎
    expect(p.title).toBe('白夜追凶 Day and Night')
  })

  it('两位数集号', () => {
    expect(parseVideoName('白夜追凶.Day.and.Night.2017.E10.2160p.WEB-DL.H265.AAC-FLTTH.mp4').episode).toBe(10)
  })

  it('电影合集用「第N部」，不是集号', () => {
    const p = parseVideoName('第1部.1972.特效中英字幕.BD1080P.X264.AAC.English.CHS-ENG.Mp4Ba.mp4')
    expect(p.part).toBe(1)
    expect(p.episode).toBe(0)
    expect(p.year).toBe(1972)
    // 「特效中英字幕」是字幕说明，不能当片名
    expect(p.title).not.toContain('字幕')
  })

  it('中文数字的部号', () => {
    expect(parseVideoName('教父.第三部.1990.1080p.mp4').part).toBe(3)
  })

  it('第N集', () => {
    const p = parseVideoName('沉默的真相 第3集.mp4')
    expect(p.episode).toBe(3)
    expect(p.title).toBe('沉默的真相')
  })

  it('SxxExx 也能认', () => {
    const p = parseVideoName('Some.Show.S02E07.1080p.mkv')
    expect(p.season).toBe(2)
    expect(p.episode).toBe(7)
  })

  it('解析不出时退回原名，不返回空标题', () => {
    const p = parseVideoName('随机文件.mp4')
    expect(p.title.length).toBeGreaterThan(0)
    expect(p.episode).toBe(0)
  })

  it('非视频扩展名被排除', () => {
    expect(isVideoFile('a.mp4')).toBe(true)
    expect(isVideoFile('a.mkv')).toBe(true)
    expect(isVideoFile('说明.txt')).toBe(false)
    expect(isVideoFile('movie.nfo')).toBe(false)
  })
})

describe('按片名归组', () => {
  it('电影合集按部分成独立条目，而不是一部剧 3 集', () => {
    const groups = groupByTitle([
      { path: '电影/教父/第1部.1972.x.mp4', name: '第1部.1972.x.mp4', dir: false, size: 100 },
      { path: '电影/教父/第2部.1974.x.mp4', name: '第2部.1974.x.mp4', dir: false, size: 200 },
      { path: '电影/教父/第3部.1990.x.mp4', name: '第3部.1990.x.mp4', dir: false, size: 300 },
    ])
    // 片名相同（都被清成同一个标题）但年份不同 → 三年份各一组
    expect(groups.length).toBe(3)
  })

  it('同一部剧的多集归成一组并按集号排序', () => {
    const groups = groupByTitle([
      { path: 'p/E03.mp4', name: '某剧.E03.1080p.mp4', dir: false, size: 1 },
      { path: 'p/E01.mp4', name: '某剧.E01.1080p.mp4', dir: false, size: 1 },
      { path: 'p/E02.mp4', name: '某剧.E02.1080p.mp4', dir: false, size: 1 },
    ])
    expect(groups.length).toBe(1)
    expect(groups[0].files.map((f) => f.episode)).toEqual([1, 2, 3])
  })

  it('忽略非视频文件', () => {
    const groups = groupByTitle([
      { path: 'p/a.mp4', name: 'a.mp4', dir: false, size: 1 },
      { path: 'p/readme.txt', name: 'readme.txt', dir: false, size: 1 },
    ])
    expect(groups.length).toBe(1)
  })
})

/**
 * 国产剧的命名是 `01 _ 郭女俠怒砸同福店.mkv`：编号在最前、没有 E 也没有
 * 「第N集」，编号后面跟的是**这一集的副标题**。踩过的表现是武林外传 80 集
 * 在片库页刷出 80 张海报卡，每张都是一集。
 */
describe('纯数字开头的集号（国产剧命名）', () => {
  const real = [
    '01 _ 郭女俠怒砸同福店 佟掌櫃秒點迷路人.mkv',
    '02 _ 掌櫃的慰問裝病者 跑堂人收拾尋釁女.mkv',
    '03 _ 眾夥計淪為小跟班 莫小貝建起八大派.mkv',
  ]

  it('把开头的 01/02/03 认成集号', () => {
    expect(parseVideoName(real[0]).episode).toBe(1)
    expect(parseVideoName(real[1]).episode).toBe(2)
    expect(parseVideoName(real[2]).episode).toBe(3)
  })

  it('带分隔符的几种写法都认', () => {
    expect(parseVideoName('07.某集标题.mkv').episode).toBe(7)
    expect(parseVideoName('08 - 某集标题.mp4').episode).toBe(8)
    expect(parseVideoName('09_某集标题.mkv').episode).toBe(9)
  })

  it('片名本身就是数字（1917）不当集号', () => {
    expect(parseVideoName('1917.mp4').episode).toBe(0)
    expect(parseVideoName('2012.末日.mp4').episode).toBe(0)
  })

  it('整目录归成一个影片，剧名用文件夹名，集号 1..N 有序', () => {
    const groups = groupByTitle(
      real.map((n, i) => ({
        path: `电视剧/武林外传/${n}`,
        name: n,
        dir: false,
        size: (i + 1) * 100,
      })),
      '武林外传',
    )
    expect(groups.length, '每集各成一组 —— 集号没被识别').toBe(1)
    expect(groups[0].title).toBe('武林外传')
    expect(groups[0].files.map((f) => f.episode)).toEqual([1, 2, 3])
  })

  it('没传文件夹名时退回按片名分组（保持旧行为，不静默改语义）', () => {
    const groups = groupByTitle(
      real.map((n) => ({ path: n, name: n, dir: false, size: 1 })),
    )
    expect(groups.length).toBe(3)
  })

  it('电影合集的「第N部」不被误当集号', () => {
    const groups = groupByTitle(
      [
        { path: '教父/第1部.1972.x.mp4', name: '第1部.1972.x.mp4', dir: false, size: 1 },
        { path: '教父/第2部.1974.x.mp4', name: '第2部.1974.x.mp4', dir: false, size: 1 },
        { path: '教父/第3部.1990.x.mp4', name: '第3部.1990.x.mp4', dir: false, size: 1 },
      ],
      '教父',
    )
    // 三部是三部片子，不该因为"传了文件夹名"就被并成一部 3 集的剧
    expect(groups.length).toBe(3)
    expect(groups.every((g) => g.files.length === 1)).toBe(true)
  })
})

describe('播放地址', () => {
  it('走片库自己的流端点，而不是通用代理', () => {
    const u = libraryStream('nas', '电影/教父/第1部.mp4')
    // 通用代理会 403（它拒绝回环且只认任意 URL），片库流是独立端点
    expect(u).toContain('/api/library/stream')
    expect(u).not.toContain('/api/proxy/stream')
    // 中文必须编码
    expect(u).toContain('lib=nas')
    expect(u).not.toContain('电影')
  })
})

describe('缓存 id 与后端一致', () => {
  it('md5(site|vodId|ep) 前 16 位', () => {
    // 这个值来自后端真实响应（POST /api/cache 返回的 id）：
    // 两边算法漂了就会永远找不到已缓存的集，所以锁死。
    expect(cacheIdFor('test', 'v1', '1')).toBe('6a823a65c1d9a390')
  })

  it('不同集得到不同 id', () => {
    expect(cacheIdFor('s', 'v', '1')).not.toBe(cacheIdFor('s', 'v', '2'))
  })
})

/**
 * 片库层级语义：目录到底是"一部剧"还是"分类"，决定进不进详情页。
 *
 * 踩过的表现（用户截图）：点「沉默的真相」目录先看到一张只有它自己的卡片墙，
 * 再点一次才到详情——"平白多了一重"。反过来「电视剧」这种分类目录必须留下
 * 卡片墙，不能自动钻进第一个子目录。
 */
describe('目录类型判定', () => {
  const dir = (path: string) => ({ path, name: path.split('/').pop()!, dir: true })
  const vid = (name: string, path = `x/${name}`) => ({ path, name, dir: false, size: 1 })

  it('只有视频、全部带集号 → 一部剧（直进详情）', () => {
    const files = Array.from({ length: 12 }, (_, i) => vid(`0${i + 1} 4K.mkv`))
    expect(dirKindOf([], files)).toBe('series')
  })

  it('只有子目录 → 分类层（必须铺卡片）', () => {
    expect(dirKindOf([dir('a'), dir('b')], [])).toBe('browse')
  })

  it('电影合集（无集号）→ 铺卡片，不自动进', () => {
    const files = [
      vid('第1部.1972.特效中英字幕.BD1080P.mp4'),
      vid('第2部.1974.特效中英字幕.BD1080P.mp4'),
    ]
    expect(dirKindOf([], files)).toBe('movies')
  })

  it('子目录 + 散片 → mixed（铺卡片）', () => {
    expect(dirKindOf([dir('S01')], [vid('幕后花絮.mp4')])).toBe('mixed')
  })

  it('毛骗：有子目录所以不自动进（要先选季）', () => {
    expect(dirKindOf([dir('毛骗S01'), dir('毛骗S02')], [])).toBe('browse')
  })

  it('空目录', () => {
    expect(dirKindOf([], [])).toBe('empty')
    expect(dirKindOf([], [vid('说明.txt')])).toBe('empty')
  })
})

describe('季目录名不当剧名', () => {
  it('纯季目录名没有标题，剧名要从上一层取', () => {
    expect(parseFolderName('S01').title).toBe('')
    expect(parseFolderName('S01').season).toBe(1)
    expect(parseFolderName('Season 2').title).toBe('')
    expect(parseFolderName('第一季').title).toBe('')
  })

  it('剧名和季粘在一起时剥出剧名', () => {
    expect(parseFolderName('毛骗S01')).toEqual({ title: '毛骗', season: 1 })
    expect(parseFolderName('某某 第二季')).toEqual({ title: '某某', season: 2 })
  })

  it('普通目录名原样返回', () => {
    expect(parseFolderName('沉默的真相')).toEqual({ title: '沉默的真相', season: 0 })
    // 不能把「18NO」这种误判成季
    expect(parseFolderName('18NO')).toEqual({ title: '18NO', season: 0 })
  })

  it('瑞克和莫蒂/S01 → 剧名是瑞克和莫蒂，不是 S01', () => {
    const files = ['S01E06.mp4', 'S01E04.mp4'].map((n) => ({ path: `x/${n}`, name: n, dir: false, size: 1 }))
    const g = groupByTitle(files, 'S01', '瑞克和莫蒂')
    expect(g.length).toBe(1)
    expect(g[0].title).toBe('瑞克和莫蒂')
    expect(g[0].files.map((f) => f.episode)).toEqual([4, 6])
  })

  it('毛骗S01 里的 01.mp4 → 一集，不是一部"影片"', () => {
    const files = ['01.mp4', '02.mp4', '03.mp4'].map((n) => ({ path: `x/${n}`, name: n, dir: false, size: 1 }))
    const g = groupByTitle(files, '毛骗S01', '毛骗')
    expect(g.length).toBe(1)
    expect(g[0].title).toBe('毛骗')
    expect(g[0].files.map((f) => f.episode)).toEqual([1, 2, 3])
  })
})

describe('纯数字文件名当集号', () => {
  it('01.mp4 / 1.mkv 认成集号', () => {
    expect(parseVideoName('01.mp4').episode).toBe(1)
    expect(parseVideoName('12.mkv').episode).toBe(12)
  })

  it('四位数字仍是片名（1917 / 2012）', () => {
    expect(parseVideoName('1917.mp4').episode).toBe(0)
    expect(parseVideoName('2012.mkv').episode).toBe(0)
  })
})

describe('showTitleFrom 跳过季目录', () => {
  it('从当前往上找第一个不是季名的目录', () => {
    expect(showTitleFrom(['动漫', '瑞克和莫蒂', 'S01'])).toBe('瑞克和莫蒂')
    expect(showTitleFrom(['电视剧', '毛骗', '毛骗S02'])).toBe('毛骗')
    expect(showTitleFrom(['电视剧', '沉默的真相'])).toBe('沉默的真相')
  })
})

/**
 * 目录卡片该用哪个片名去刮。
 *
 * 用户的口径：「目录海报应该显示目录下第一个影视的海报」。
 * 这三条都是拿真实片库验证出来的错配：
 *   - 拿分类名去搜 → 「动漫」匹配到《剑来 第一季》（实测）
 *   - 拿目录名搜单部电影 → 「色戒」匹配到 2002 年那部同名无关片，
 *     而文件名 Lust.Caution.2007 才是 2007 年的《色，戒》
 *   - 拿文件名搜合集 → 「教父/第1部.1972…」解析成「第1部」，
 *     匹配到《封神第一部：朝歌风云》
 */
describe('目录封面标题', () => {
  const v = (name: string) => ({ path: `x/${name}`, name, dir: false, size: 1 })

  it('剧集目录用目录名（文件名里只有集号和副标题）', () => {
    const files = ['02 _ 掌櫃的慰問裝病者.mkv', '01 _ 郭女俠怒砸同福店.mkv'].map(v)
    expect(coverTitleFor(['电视剧', '武林外传'], files)).toBe('武林外传')
  })

  it('季目录用上一层的剧名', () => {
    const files = ['S01E04.mp4', 'S01E06.mp4'].map(v)
    expect(coverTitleFor(['动漫', '瑞克和莫蒂', 'S01'], files)).toBe('瑞克和莫蒂')
  })

  it('单片电影用文件名里的片名（目录名可能是别名）', () => {
    expect(coverTitleFor(['电影', '色戒'], [v('Lust.Caution.2007.Uncut.1080p.BluRay.x264.DTS.mkv')]))
      .toBe('Lust Caution Uncut')
  })

  it('多部合集用目录名，不用「第N部」', () => {
    const files = [
      v('第1部.1972.特效中英字幕.BD1080P.X264.AAC.Mp4Ba.mp4'),
      v('第2部.1974.特效中英字幕.BD1080P.X264.AAC.Mp4Ba.mp4'),
    ]
    expect(coverTitleFor(['电影', '教父'], files)).toBe('教父')
  })

  it('连「第N部」都没有的单文件，仍退回目录名', () => {
    // 解析失败时 title 会退回原名，那也能用；这里只锁"不返回空"
    expect(coverTitleFor(['电影', '某片'], [v('随机文件.mp4')]).length).toBeGreaterThan(0)
  })
})

/**
 * 影片卡的刮削名（用户截图：教父三部曲整排挂着《封神》海报）。
 *
 * 三个断言对应三层要求：
 *   - 卡片显示「教父 第1部」——一眼知道是哪一部；
 *   - 刮削名回退到「教父」+ 各自年份——豆瓣上 1972/1974/1990 才是三部片子；
 *   - 目录名本身就叫「第N部」时退到上一层——不能又拿「第1部」去搜。
 */
describe('「第N部」影片卡的刮削名', () => {
  const vid = (name: string) => ({ path: `教父/${name}`, name, dir: false, size: 1 })
  const parts = [
    vid('第1部.1972.特效中英字幕.BD1080P.mp4'),
    vid('第2部.1974.特效中英字幕.BD1080P.mp4'),
    vid('第3部.1990.特效中英字幕.BD1080P.mp4'),
  ]

  it('显示带目录名，刮削用目录名 + 年份', () => {
    const gs = groupByTitle(parts, '教父', '电影')
    expect(gs.map((g) => g.title)).toEqual(['教父 第1部', '教父 第2部', '教父 第3部'])
    expect(gs.map((g) => scrapeTitleOf(g))).toEqual(['教父', '教父', '教父'])
    expect(gs.map((g) => g.year)).toEqual([1972, 1974, 1990])
  })

  it('目录名本身是「第N部」时退到上一层', () => {
    const gs = groupByTitle([vid('第1部.1972.mp4')], '第1部', '教父')
    expect(scrapeTitleOf(gs[0])).toBe('教父')
  })

  it('剧集与普通电影的刮削名就是卡片名（默认不改变）', () => {
    const gs = groupByTitle(
      [{ path: 'x/S01E01.mkv', name: 'S01E01.mkv', dir: false, size: 1 }],
      '瑞克和莫蒂',
    )
    expect(scrapeTitleOf(gs[0])).toBe(gs[0].title)
  })
})

/**
 * 季目录卡片的刮削名（用户要求：S01…S08 别挤成同一张剧海报）。
 *
 * 季名是"额外加料"的名字：豆瓣没这条条目时后端 `pick()` 会退回第一条建议，
 * 所以前端必须复核命中标题是否沾亲、否则回退剧名（见 doScrapeDirs 第二轮）。
 */
describe('季目录卡片的刮削名', () => {
  it('剧名 + 中文季号', () => {
    expect(seasonTitle('瑞克和莫蒂', 1)).toBe('瑞克和莫蒂 第一季')
    expect(seasonTitle('毛骗', 3)).toBe('毛骗 第三季')
  })

  it('超过十季或没有剧名 → 不做季名（调用方退回剧名）', () => {
    expect(seasonTitle('某剧', 11)).toBe('')
    expect(seasonTitle('', 2)).toBe('')
  })

  it('剧名里已经带季，不叠第二遍', () => {
    expect(seasonTitle('瑞克和莫蒂 第一季', 1)).toBe('')
  })
})

/**
 * 目录封面祖先链的反向门禁（用户截图：S01…S08 八个季目录全挂着《剑来》）。
 *
 * `coverTitleByProbe` 只往后追加子目录名，所以调用方必须交**整条 trail**
 * （含当前层）。少一级时 `动漫/瑞克和莫蒂/S01` 拼成 `['动漫','S01']`，
 * S01 当纯季名跳过后落回「动漫」——豆瓣把「动漫」匹配成《剑来 第一季》。
 * 这条链是组件里的两行，纯函数测不出来，只能断言源码形态。
 */
describe('目录封面祖先链', () => {
  const VIEW = readFileSync(join(process.cwd(), 'src/views/LibraryView.vue'), 'utf8')

  it('ancestors 取整条 trail（不能 slice(0,-1) 少一级）', () => {
    // popTrail 里也有 slice(0,-1)，那是"退一层"，是对的；这里只盯 ancestors
    expect(VIEW, 'ancestors 又少了当前层').not.toMatch(
      /ancestors = trail\.value\.slice\(0,\s*-1\)/,
    )
    expect(VIEW.match(/ancestors = trail\.value\.map\(\(t\) => t\.name\)/g) || []).toHaveLength(2)
  })
})

/**
 * 海报地址与刮削队列的三条门禁。
 *
 * 前两条是纯函数；后两条是组件里的写法，只能断言源码形态（同「元数据持久化约定」
 * 的理由：跑不了组件）。
 */
describe('海报地址', () => {
  const dec = (u: string) => decodeURIComponent(u)

  it('豆瓣小图抬成大图', () => {
    expect(dec(posterUrl('https://img9.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg')))
      .toContain('/l_ratio_poster/')
    expect(dec(posterUrl('https://img9.doubanio.com/view/photo/m_ratio_poster/public/p1.jpg')))
      .toContain('/l_ratio_poster/')
  })

  it('已经是 l_ 或非豆瓣地址时不动它', () => {
    const big = 'https://img9.doubanio.com/view/photo/l_ratio_poster/public/p1.jpg'
    expect(dec(posterUrl(big))).toContain('/l_ratio_poster/')
    expect(dec(posterUrl('https://example.com/a.jpg'))).toContain('https://example.com/a.jpg')
  })
})

describe('片库刮削与海报 key（组件源码门禁）', () => {
  const VIEW = readFileSync(join(process.cwd(), 'src/views/LibraryView.vue'), 'utf8')

  it('刮削走队列，不再"正在刮就整层丢弃"', () => {
    expect(VIEW, '又退回单飞丢弃（并发导航会丢整层海报）').not.toMatch(
      /if \(scraping\.value \|\| scrapedFor\.value === where\) return/,
    )
    expect(VIEW).toContain('function enqueueScrape')
    expect(VIEW).toContain('function scheduleScrapeRetry')
  })

  it('海报 key 带库 id（两个库同名目录/同名影片不串图）', () => {
    expect(VIEW).toContain('dir:${lib}|${path}')
    expect(VIEW).toContain('${lib}|${title}|${year}')
  })
})

/**
 * 元数据落盘的三条不变量（后端 Scrape.java）。
 *
 * 这几条都是「脱网可用」的地基：片库的意义就是局域网断网也能看，
 * 所以已经刮到的东西不能被一次抖动抹掉、也不能因为重复库而串味。
 *
 * 用源码断言而不是跑 Java：宿主是完整 JVM，vitest 起不来；而这三条都是
 * "某个写法必须存在/必须不存在"的形态约束，源码断言足够挡住回退。
 */
describe('元数据持久化约定（后端源码）', () => {
  // ★ 用 cwd 拼而不是 import.meta.url：vitest 的 jsdom 环境里
  //   import.meta.url 不是 file: 协议，readFileSync 会抛 "must be of scheme file"。
  //   cwd 是 client/apps/web（vitest 的 root），退三层到仓库根。
  const SCRAPE = readFileSync(
    join(process.cwd(), '../../../server/host/src/shared/core/Scrape.java'),
    'utf8',
  )

  it('命中记录永久保留（不再是 30 天 TTL）', () => {
    expect(SCRAPE, '命中 TTL 又被改回有限值了').toContain('KEEP_FOREVER = Long.MAX_VALUE')
    expect(SCRAPE).not.toMatch(/TTL_MS\s*=\s*30L\s*\*\s*24/)
  })

  it('失败结果不得覆盖已有的成功记录', () => {
    // 判据：best == null 分支里必须先检查 prev.ok 并直接 return prev
    expect(SCRAPE, '缺"成功记录不可被失败覆盖"的分支').toMatch(
      /prev\s*!=\s*null\s*&&\s*prev\.optBoolean\("ok"/,
    )
  })

  it('缓存 key 带库维度（两个库同名影片不共用）', () => {
    expect(SCRAPE).toMatch(/private static String keyOf\(String lib/)
    expect(SCRAPE, 'lookup 又退回不带 lib 的形态').toMatch(
      /String key = keyOf\(lib, title, year\)/,
    )
  })
})
