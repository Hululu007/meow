import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * fpk / 全端片库转码优化的回归门禁（2026-11-17）。
 *
 * 这批改动都踩过真实坑，注释里写清了原因；这里把「不能改回去」的
 * 硬约束固化成静态断言，避免后续重构悄悄退化：
 *   F1 智能 remux / F2 回环直喂 / F3 SMB 缓冲 / F4 连接池
 *   S1 单集锁 / S3 真实异常 / S4 生命周期 / F5 Safari 预判
 *
 * 只做字符串存在性检查 —— 语义正确性靠 OECT 真机实测 + 冒烟。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const TRANSCODE = join(ROOT, 'server', 'host', 'src', 'shared', 'core', 'Transcode.java')
const LIB_ROUTES = join(ROOT, 'server', 'host', 'src', 'shared', 'routes', 'LibraryRoutes.java')
const PLAY = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue')

describe('F1 智能 remux：能 copy 就不重编码', () => {
  const s = readFileSync(TRANSCODE, 'utf8')

  it('copy 判定收紧（h264 ≤1080p / aac ≤2ch），HEVC、4K、多声道一律转码', () => {
    expect(s).toContain(
      'p.copyVideo = "h264".equals(vcodec) && w > 0 && h > 0 && w <= 1920 && h <= 1080',
    )
    expect(s).toContain('p.copyAudio = "aac".equals(acodec) && ch > 0 && ch <= 2')
  })

  it('探测失败回退全转码（宁可慢也不能产出播不了的流）', () => {
    expect(s).toMatch(/private static Probe probe\(String ff, String source\)/)
    expect(s).toContain('Probe probe = probe(ff, source)')
    // probe 的异常路径必须返回 null（不是抛出去）。用正则匹配，兼容 CRLF/LF
    expect(s).toMatch(/\} catch \(Exception e\) \{\s*return null;\s*\}/)
  })

  it('copy 分支真的写进命令', () => {
    expect(s).toContain('cmd.add("-c:v"); cmd.add("copy")')
    expect(s).toContain('cmd.add("-c:a"); cmd.add("copy")')
  })
})

describe('硬解硬编（RK 设备）：rkmpp 探测 + 回退', () => {
  const s = readFileSync(TRANSCODE, 'utf8')

  it('探测 rkmpp 解码器集合与 h264_rkmpp 编码器（结果缓存）', () => {
    expect(s).toContain('private static volatile java.util.Set<String> RKMPP_DEC')
    expect(s).toContain('private static volatile Boolean RKMPP_ENC')
    expect(s).toContain('rkmppDecoders(ff)')
    expect(s).toContain('rkmppEncoder(ff)')
  })

  it('硬解走 hwaccel + drm_prime，且必须在 -i 之前（RGA/编码器只吃 drm 帧）', () => {
    const iAcc = s.indexOf('cmd.add("-hwaccel"); cmd.add("rkmpp")')
    const iFmt = s.indexOf('cmd.add("-hwaccel_output_format"); cmd.add("drm_prime")')
    const iIn = s.indexOf('cmd.add("-i"); cmd.add(source);')
    expect(iAcc).toBeGreaterThan(-1)
    expect(iFmt).toBeGreaterThan(-1)
    expect(iIn).toBeGreaterThan(-1)
    expect(iAcc).toBeLessThan(iIn)
    expect(iFmt).toBeLessThan(iIn)
  })

  it('硬编缩放到 ≤1080p，且只能用 scale_rkrga（软件 scale 要 hwdownload，实测 -22）', () => {
    expect(s).toContain('cmd.add("-rc_mode"); cmd.add("VBR")')
    expect(s).toContain('cmd.add("-qp_init"); cmd.add("23")')
    const i = s.indexOf('} else if (hw) {')
    expect(i).toBeGreaterThan(-1)
    const body = s.slice(i, s.indexOf('} else {', i))
    // 4K 硬编只有 0.28x，1080p 是 1.28x → 必须缩
    expect(body).toContain('scale_rkrga=w=')
    expect(body).not.toContain("scale='min(1920,iw)'")
    // 输出上限 1080p，码率按输出高度分档
    expect(body).toContain('hwBitrate(p.height > 1080 ? 1080 : p.height)')
  })

  it('非 RK 设备/探测失败仍走 libx264（不能把软解路径删了）', () => {
    expect(s).toContain('cmd.add("libx264")')
    expect(s).toContain('cmd.add("-preset"); cmd.add("veryfast")')
  })

  it('分片 2 秒（首片只需 2 秒内容）', () => {
    expect(s).toContain('private static final int SEG_SECONDS = 2;')
  })

  it('硬解默认开（policy 可关）；只有探测到 rkmpp 才生效', () => {
    // 2026-11-17 定因：之前 apiserver 内失败是 -vf scale 导致的（硬件帧不能软件缩放），
    // 去掉缩放后 4K HEVC 首片 24 秒（软解 100 秒）→ 默认开，失败 pump 自动回退软解
    expect(s).toContain('optBoolean("transcodeHwDecode", true)')
    expect(s).toContain('if (!hwEnabled()) return false;')
    expect(s).toContain('rkmppDecoders(ff).contains(p.vcodec + "_rkmpp") && rkmppEncoder(ff)')
  })
})

describe('F2 回环直喂 ffmpeg：不再全量拷贝', () => {
  const lib = readFileSync(LIB_ROUTES, 'utf8')
  const s = readFileSync(TRANSCODE, 'utf8')

  it('SMB 分支优先内部回环流，stage 只作端口未知时的回退', () => {
    expect(lib).toContain('int p = core.Transcode.apiPort')
    expect(lib).toContain('/api/library/stream?lib=')
    const i = lib.indexOf('int p = core.Transcode.apiPort')
    const body = lib.slice(i, i + 900)
    expect(body).toContain('stageSmbSource') // 回退仍保留
  })

  it('HTTP 输入只用 ffmpeg 8.1 真实存在的选项', () => {
    // 实测：-http_persistent 在 8.1 不存在，直接 "Option not found" 退出。
    // 注释里可以提它（说明为什么不能用），但命令里绝不能加。
    expect(s).not.toContain('cmd.add("-http_persistent")')
    expect(s).toContain('cmd.add("-multiple_requests")')
    expect(s).toContain('cmd.add("-seekable")')
    expect(s).toContain('cmd.add("-reconnect_streamed")')
  })

  it('ApiServer 启动时回写实际端口（PC 顺延/TV 网关/fpk 都靠它）', () => {
    const api = readFileSync(join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java'), 'utf8')
    expect(api).toContain('core.Transcode.apiPort = port')
  })
})

describe('F3/F4/S3 片库读取：吞吐、连接复用、真实异常', () => {
  const lib = readFileSync(LIB_ROUTES, 'utf8')

  it('读缓冲 1MB（64KB 小包往返是吞吐瓶颈）', () => {
    expect(lib).toContain('new byte[1 << 20]')
    expect(lib).not.toContain('new byte[65536]')
  })

  it('SMB 连接池 + 失效重建', () => {
    expect(lib).toContain('SMB_POOL')
    expect(lib).toContain('private static SmbConn smbConn')
    expect(lib).toContain('SMB_IDLE_MS')
    expect(lib).toContain('private static com.hierynomus.smbj.share.File smbOpenFile')
  })

  it('响应头已发后不再二次 sendJson（否则真实异常被 headers already sent 盖掉）', () => {
    expect(lib).toContain('boolean headersSent = false')
    expect(lib).toContain('if (headersSent)')
    expect(lib).toContain('smb stream aborted (headers sent)')
  })

  it('status 轮询必须在取源之前（否则每 2 秒一次轮询都会并发写 .part）', () => {
    const iStatus = lib.indexOf("q.getOrDefault(\"mode\", \"\")")
    const iType = lib.indexOf('String type = lib.optString("type", "webdav")')
    expect(iStatus).toBeGreaterThan(-1)
    expect(iType).toBeGreaterThan(-1)
    expect(iStatus).toBeLessThan(iType)
  })
})

describe('S1/S4 转码任务：并发锁与生命周期', () => {
  const s = readFileSync(TRANSCODE, 'utf8')

  it('ensure / ensureLocal 都走单集锁', () => {
    expect((s.match(/synchronized \(lockFor\(id\)\)/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it('保留最近 3 个任务，起新任务前清理', () => {
    expect(s).toContain('KEEP_JOBS = 3')
    expect((s.match(/pruneProducts\(\)/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it('「正在播」只认 .access 标记，不能用目录 mtime', () => {
    expect(s).toContain('ACCESS_FILE = ".access"')
    expect(s).toContain('recentlyPlayed(d, now)')
    const i = s.indexOf('private static boolean recentlyPlayed')
    expect(i).toBeGreaterThan(-1)
    const body = s.slice(i, i + 520)
    expect(body).toContain('ACCESS_FILE')
    // 用目录 mtime 判 playing 会让刚转完的任务永远不被清理（实测 6 个全保住）
    expect(body).not.toContain('getLastModifiedTime(d)')
  })

  it('播放器取分片时刷新访问标记', () => {
    const api = readFileSync(join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java'), 'utf8')
    expect(api).toContain('core.Transcode.touch(id)')
  })
})

describe('F5 容器预判（不能播的内核直接转码，不白等 watchdog）', () => {
  const src = readFileSync(PLAY, 'utf8')

  it('判定用 query.file（libraryDirect 是 stream 端点，取不到扩展名）', () => {
    expect(src).toContain('unsupportedContainer(libraryFile.value)')
    expect(src).not.toContain('unsupportedContainer(libraryDirect.value)')
  })

  it('桌面 Chrome/Edge 与全平台 Safari 都预判；Android WebView / Firefox 仍先直连', () => {
    // 2026-11-17 实测：桌面 Chromium 没有 Matroska demuxer，直连 mkv 必失败；
    // Android WebView 与 Firefox 能播，预判会更差（多转一次码）
    expect(src).toContain('function cantPlayContainerDirectly(): boolean')
    const i = src.indexOf('function cantPlayContainerDirectly')
    const body = src.slice(i, i + 500)
    // UA 判据已收口到 compat/ua（业务侧只调能力函数）
    expect(body).toContain('isFirefox()')
    expect(body).toContain('isAndroid()')
  })

  it('容器清单覆盖 mkv/avi/webm 等', () => {
    expect(src).toContain('mkv|avi|webm|flv|rmvb|rm|wmv|m2ts|ts|vob')
  })

  it('预判失败/异常能让错误页显示出来（loading 必须收尾）', () => {
    const i = src.indexOf('async function tryLibraryTranscode')
    const body = src.slice(i, i + 1400)
    expect((body.match(/loading\.value = false/g) || []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('可播判据与并发（2026-11-17 第二轮回修：播几秒就卡）', () => {
  const s = readFileSync(TRANSCODE, 'utf8')
  const play = readFileSync(PLAY, 'utf8')

  it('完成标记 .done：只有 ffmpeg exit 0 才写（半成品不能算 ready）', () => {
    expect(s).toContain('DONE_FILE = ".done"')
    expect(s).toContain('markDone(j.id)')
    // 2026-11-20：pump 改双线程后 tailText 由同步块赋值，改从函数体定位
    const i = s.indexOf('private static void pump(Job j)')
    expect(i).toBeGreaterThan(-1)
    const body = s.slice(i, i + 4000)
    expect(body).toContain('if (code == 0) {')
    // 原来的"清单存在就算 ready"必须消失
    expect(body).not.toContain('|| Files.isRegularFile(playlistOf(j.id))')
  })

  it('playable() 同时要求完成标记与清单；ensure 复用/复用判定都走它', () => {
    expect(s).toContain('public static boolean playable(String id)')
    expect(s).toContain('Files.isRegularFile(dirOf(id).resolve(DONE_FILE))')
    expect((s.match(/if \(playable\(id\)/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it('一次只跑一个重转码（RK VDEC 通道有限，并发必崩一个）', () => {
    expect(s).toContain('stopOtherJobs(j.id)')
    expect(s).toContain('"cancelled"')
    const i = s.indexOf('private static void stopOtherJobs')
    const body = s.slice(i, i + 1600)
    expect(body).toContain('destroyForcibly')
    expect(body).toContain('cleanSegments(o.id)')
  })

  it('硬解失败先重试硬解一次（句柄未释放会瞬时崩），再退软解', () => {
    expect(s).toContain('j.hwRetry < 2')
    expect(s).toContain('boolean retryHw = j.hwRetry == 1')
    expect(s).toContain('o.proc.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)')
  })

  it('被取消的任务不触发重试（否则停了还在后台转）', () => {
    const i = s.indexOf('if (j.hw && j.hwRetry < 2')
    expect(i).toBeGreaterThan(-1)
    const body = s.slice(Math.max(0, i - 500), i)
    expect(body).toContain('"cancelled".equals(j.state)')
  })

  it('ffprobe 超时 30 秒（设备忙时 10 秒会误判 → 4K 静默退软解）', () => {
    expect(s).toContain('runCapture(v, 30)')
    expect(s).toContain('runCapture(a, 30)')
    expect(s).toContain('probe " + id + " failed (ffprobe timeout?)')
  })

  it('status() 不许改 state（会把 running 污染成 ready，进而起第二个 ffmpeg）', () => {
    const i = s.indexOf('public static Job status(String id)')
    expect(i).toBeGreaterThan(-1)
    const body = s.slice(i, s.indexOf('private static int countSegments', i))
    expect(body).not.toContain('j.state = "ready"')
    expect(body).toContain('j.readySeconds = j.segments * SEG_SECONDS')
  })

  it('复用 running 任务前要验进程还活着（否则任务永远停在 running）', () => {
    expect(s).toContain('found.proc != null && found.proc.isAlive()')
    expect(s).toContain('running but process gone -> restart')
  })

  it('exit 0 但产出明显短于源时长 → 判失败（输入被截断时 ffmpeg 会正常退出）', () => {
    expect(s).toContain('short output')
    expect(s).toContain('gotDur < srcDur - 15')
    expect(s).toContain('p.duration = dur')
  })

  it('续播位置夹在已转出范围内（否则起播即卡在等分片）', () => {
    expect(play).toContain('libraryReadyCap')
    expect(play).toContain('libraryReadyCap.value - 2')
    expect(play).toContain('转码进度还没到上次位置')
  })
})

describe('进度条总长：转码未完成时也要显示真实时长', () => {
  const s = readFileSync(TRANSCODE, 'utf8')
  const play = readFileSync(PLAY, 'utf8')
  const vp = readFileSync(join(ROOT, 'client', 'apps', 'web', 'src', 'components', 'player', 'VideoPlayer.vue'), 'utf8')
  const lib = readFileSync(join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'library.ts'), 'utf8')

  it('后端把源时长落盘并放进状态 JSON', () => {
    expect(s).toContain('DURATION_FILE = ".duration"')
    expect(s).toContain('saveDuration(id, probe.duration)')
    expect(s).toContain('public static double durationOf(String id)')
    expect(s).toContain('o.put("duration", (long) Math.round(dur))')
  })

  it('前端类型透传 duration', () => {
    expect(lib).toContain('duration?: number')
  })

  it('播放器用 totalDuration 当分母（video.duration 只是已转出时长）', () => {
    expect(vp).toContain('totalDuration?: number')
    expect(vp).toContain('const shownDur = computed')
    expect(vp).toContain('fmt(shownDur)')
    expect(vp).toContain('shownTime.value / shownDur.value')
  })

  it('转码未完成时可拖动上界 = 已转出（跳过头会卡死）', () => {
    expect(vp).toContain('aheadSeconds?: number')
    expect(vp).toContain('Math.min(sec, ahead - 2)')
    expect(play).toContain(':ahead-seconds="libraryAhead"')
    expect(play).toContain(':total-duration="libraryTotalDuration"')
  })

  it('被串行化取消时立刻返回失败，不干等 600 秒', () => {
    expect(lib).toContain("last.state === 'cancelled'")
    expect(lib).toContain('这个文件的转码被新任务打断了')
  })

  it('转码进度每 5 秒刷新（进度条跟上），完成后停', () => {
    expect(play).toContain('pollTranscodeProgress')
    expect(play).toContain('}, 5000)')
    expect(play).toContain("j.state === 'ready' || j.state === 'failed'")
  })
})

describe('回归加固（2026-11-17 第三轮审计）', () => {
  const s = readFileSync(TRANSCODE, 'utf8')

  it('java 重启后的兜底 status 也要 .done，不能把半成品报 ready', () => {
    const i = s.indexOf('public static Job status(String id)')
    const body = s.slice(i, i + 700)
    expect(body).toContain('playable(id) ? "ready" : "idle"')
  })

  it('严格串行：新任务取消旧任务（2026-11-20 起不再按 .access 豁免）', () => {
    const stop = s.slice(s.indexOf('private static void stopOtherJobs'),
      s.indexOf('private static Path dirOf'))
    expect(stop).not.toContain('recentlyPlayed')
    expect(stop).toContain('o.state = "cancelled"')
    expect(stop).toContain('destroyForcibly')
  })

  it('启动时清掉遗留的转码 ffmpeg（孤儿会抢 VDEC 且永远不写 .done）', () => {
    expect(s).toContain('killStaleTranscodes')
    expect(s).toContain('"pkill", "-f", "cache/transcode/seg-"')
    const api = readFileSync(join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java'), 'utf8')
    expect(api).toContain('core.Transcode.killStaleTranscodes()')
  })

  it('时长探测只用 12 秒（只是 UI 用，不该拖慢起播）', () => {
    expect(s).toContain('runCapture(d, 12)')
  })
})

describe('4K 首片可播性（2026-11-17 第一集播不出来的两个真因）', () => {
  const s = readFileSync(TRANSCODE, 'utf8')
  const lib = readFileSync(
    join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'library.ts'),
    'utf8',
  )

  it('只 map 首视频流 + 首音频流（原来 6 条字幕流一起转 VTT，白烧 2~3 倍 CPU）', () => {
    expect(s).toContain('cmd.add("-map"); cmd.add("0:v:0")')
    expect(s).toContain('cmd.add("-map"); cmd.add("0:a:0?")')
  })

  it('强制按分片周期插关键帧（-hls_time 只是下限，源 GOP 7.5s 会让首片变 7.46s）', () => {
    expect(s).toContain('-force_key_frames')
    expect(s).toContain('expr:gte(t,n_forced*" + SEG_SECONDS + ")')
    // 硬编与软编两条分支都要有（少一条就会出现 7 秒×1080p 首片）
    expect((s.match(/force_key_frames/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it('前端等待上限放宽到 600 秒（4K HEVC 10bit 软解首片要一两分钟）', () => {
    expect(lib).toContain('timeoutMs = 600_000')
  })

  it('状态里的 playlist 必须按磁盘清单判定（内存 Job 会残留 ready/分片数）', () => {
    // 实测：删掉转码目录后 start 仍回旧 playlist → 前端 404 → 误报播放失败
    expect(s).toContain('boolean hasPlaylist = Files.isRegularFile(playlistOf(j.id))')
    expect(s).toContain('hasPlaylist ? j.segments : 0')
    expect(s).toContain('if (hasPlaylist && ("ready".equals(j.state) || j.segments > 0))')
  })
})
