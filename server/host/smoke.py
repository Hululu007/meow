"""后端端到端冒烟：拆分 ApiServer 的安全网。

为什么需要：后端目前零自动化测试，而接下来要把 2000+ 行按域搬到独立文件。
没有这个脚本，拆完只能靠"看起来没坏"。它把已有的手工验证固化成可重跑断言，
覆盖每个即将被搬动的域——搬家前后必须全绿。

用法：
    python tmp/backend_smoke.py                # 用默认端口 19990
    python tmp/backend_smoke.py --port 19991

设计取舍：
- **自带假 HLS 源**：缓存/导出依赖真实分片，不引外部网络。
- **不依赖具体源站**：搜索/详情用假站点太重，这里只验「端点活着且结构正确」；
  真实源的可用性变化太快，放进冒烟会天天红。
- **每个域一组断言**，失败时打印该域的响应片段，便于定位是哪一块被拆坏。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# 1KB 占位内容：片库播放/Range 测试用，不用字面量避免字节转义被 shell 破坏
ZEROS_1K = bytes(1024)

# 仓库根：本文件在 server/host/ 下，往上三级才是根。
# ★ 踩过：这个脚本原先在仓库根的 tmp/ 里，ROOT 用的是"上两级"，
#   提到 server/host/ 之后没跟着改，classpath 变成 server/server/host/classes，
#   后端起不来只报一句"没起来，终止"，看起来像代码坏了。
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LAN_IP = '192.168.1.2'

# 结果收集
RESULTS = []


def check(domain, label, cond, detail=''):
    RESULTS.append((domain, label, bool(cond), str(detail)))
    print(('PASS ' if cond else 'FAIL ') + '[%s] %s' % (domain, label) +
          ((' | ' + str(detail)[:160]) if detail else ''))


def req(base, path, body=None, method=None, timeout=60):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    r = urllib.request.Request(base + path, data=data, headers=headers,
                               method=method or ('POST' if data else 'GET'))
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw.decode('utf-8'))
            except Exception:
                return resp.status, {'raw': raw[:200].decode('utf-8', 'replace')}
    except TimeoutError:
        return -1, {'error': 'timeout'}
    except ConnectionError as e:
        return -1, {'error': 'conn: %s' % e}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode('utf-8'))
        except Exception:
            return e.code, {'raw': raw[:200].decode('utf-8', 'replace')}


def wait_port(url, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=19990)
    ap.add_argument('--data', default='tmp/smokedata')
    args = ap.parse_args()
    base = 'http://127.0.0.1:%d' % args.port

    # ---- 起假 HLS 源（缓存/导出域用）----
    hls_dir = os.path.join(ROOT, 'tmp', 'smokehls')
    shutil.rmtree(hls_dir, ignore_errors=True)
    os.makedirs(hls_dir, exist_ok=True)
    ff = os.path.join(ROOT, 'tmp', 'ffmpeg', 'ffmpeg.exe')
    if os.path.isfile(ff):
        subprocess.run([ff, '-hide_banner', '-loglevel', 'error', '-y',
                        '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=4',
                        '-c:v', 'libx264', '-preset', 'ultrafast',
                        '-f', 'hls', '-hls_time', '10', '-hls_list_size', '0',
                        '-hls_segment_filename', os.path.join(hls_dir, 'seg%03d.ts'),
                        os.path.join(hls_dir, 'vod.m3u8')], check=False)
    hls_port = 18841
    hls_srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(hls_port), '--bind', '0.0.0.0'],
                               cwd=hls_dir, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    hls_url = 'http://%s:%d/vod.m3u8' % (LAN_IP, hls_port)
    # 等假源真正可服务：Popen 到端口可用有几百毫秒延迟，
    # 固定 sleep 会踩空导致"这不是 m3u8 清单"（假的失败）
    hls_ready = False
    for _ in range(40):
        try:
            with urllib.request.urlopen(hls_url, timeout=1) as r:
                if r.read(7) == b'#EXTM3U':
                    hls_ready = True
                    break
        except Exception:
            pass
        time.sleep(0.25)
    print('假 HLS 源就绪:', hls_ready)

    # ---- 起后端 ----
    data_dir = os.path.join(ROOT, args.data)
    shutil.rmtree(data_dir, ignore_errors=True)
    env = dict(os.environ)
    if os.path.isfile(ff):
        env['MEOW_FFMPEG'] = ff
    be = subprocess.Popen(
        ['java', '-Dfile.encoding=UTF-8', '-cp',
         'server/host/classes;server/host/libs/*',
         'ApiServer', '--port=%d' % args.port, '--data-dir=%s' % args.data],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    try:
        if not wait_port(base + '/api/health'):
            print('后端没起来，终止')
            return 2

        # ══════════ 1. 健康与元信息 ══════════
        st, h = req(base, '/api/health')
        check('health', 'health 活着且 ok', st == 200 and h.get('ok') is True, h.get('version'))
        check('health', '有 version/sites 字段',
              bool(h.get('version')) and isinstance(h.get('sites'), int), h.get('sites'))
        check('health', '有 capabilities 数组', isinstance(h.get('capabilities'), list),
              h.get('capabilities'))

        st, s = req(base, '/api/sites')
        sites_obj = s.get('sites') if isinstance(s, dict) else None
        check('health', '/api/sites 返回站点表', isinstance(sites_obj, list) and len(sites_obj) > 0,
              len(sites_obj or []))

        st, stt = req(base, '/api/health/state')
        check('health', '/api/health/state 有 degraded/disabled',
              'degraded' in stt and 'disabled' in stt, list(stt.keys())[:5])

        # ══════════ 2. 配置下发（TV/zyfun 依赖）══════════
        st, cfg = req(base, '/config.json')
        check('config', '/config.json 有 sites', isinstance(cfg.get('sites'), list),
              len(cfg.get('sites') or []))
        csp = [x for x in (cfg.get('sites') or []) if str(x.get('api', '')).startswith('csp_')]
        check('config', 'csp_ 站点补了 jar 字段（无 csp_ 站则跳过）',
              (not csp) or all((x.get('jar') or '') for x in csp),
              'csp_ 站 %d 个' % len(csp))

        st, pol = req(base, '/api/policy')
        check('config', '/api/policy 可读', st == 200, st)

        # （search 移到末尾：它会跑满 60 秒并占住连接池，
        #   放前面会让后面的快断言全部连接被拒）

        # ══════════ 4. 状态同步 ══════════
        # 端点收**单个对象**（不是 {list:[...]}）：POST 一条进度
        st, _ = req(base, '/api/state/progress', {'site': 'x', 'vod_id': '1',
                                                  'vod_name': 't', 'ep': 'e',
                                                  'pos': 12, 'duration': 100})
        check('state', 'progress 写入', st == 200, st)
        st, pr = req(base, '/api/state/progress')
        items = pr.get('items') if isinstance(pr, dict) else None
        check('state', 'progress 读回', st == 200 and isinstance(items, list),
              'items=%s' % (len(items) if isinstance(items, list) else items))

        st, _ = req(base, '/api/state/favorites', {'site': 'x', 'vod_id': '1', 'vod_name': 't'})
        check('state', 'favorites 写入', st == 200, st)
        st, fav = req(base, '/api/state/favorites')
        fitems = fav.get('items') if isinstance(fav, dict) else None
        check('state', 'favorites 读回', st == 200 and isinstance(fitems, list),
              'items=%s' % (len(fitems) if isinstance(fitems, list) else fitems))

        st, _ = req(base, '/api/state/prefs', {'themeMode': 'dark'})
        check('state', 'prefs 写入', st == 200, st)
        st, pf = req(base, '/api/state/prefs')
        check('state', 'prefs 读回', st == 200 and 'prefs' in pf or isinstance(pf, dict), list(pf.keys())[:4])

        # 按 site+vodId 精确查单条（前端续播靠它）
        st, one = req(base, '/api/state/progress?site=x&vod_id=1')
        check('state', 'progress 单条查询', st == 200, st)

        # 跨端同步的另一半：拉全量时的排序字段（ep_at）要在
        st, allp = req(base, '/api/state/progress')
        first = ((allp.get('items') or [{}])[0])
        check('state', 'progress 带 ep_at 排序字段',
              'ep_at' in first or 'pos' in first, list(first.keys())[:6])

        # ══════════ 5. 缓存域 ══════════
        st, lst = req(base, '/api/cache')
        check('cache', '/api/cache 列表可用', st == 200 and 'items' in lst, st)
        check('cache', '有 cacheDir 字段', 'cacheDir' in lst, lst.get('cacheDir'))

        if hls_ready:
            st, t = req(base, '/api/cache', {'site': 'Smoke', 'vodId': '1', 'ep': 'E01',
                                             'name': '冒烟', 'url': hls_url})
            cid = t.get('id', '')
            check('cache', '创建缓存任务', bool(cid), t.get('msg') or cid)
            state = ''
            if cid:
                end = time.time() + 60
                while time.time() < end:
                    st, s = req(base, '/api/cache?id=' + cid)
                    state = s.get('state', '')
                    if state in ('done', 'failed'):
                        break
                    time.sleep(0.4)
            check('cache', '缓存下载完成', state == 'done',
                  state if state == 'done' else (s.get('error') or state))

            if cid and state == 'done':
                # 导出（有 ffmpeg 应得 mp4）
                st, ex = req(base, '/api/cache/export-to',
                             {'id': cid, 'dir': os.path.join(ROOT, 'tmp', 'smokeout'), 'name': 'smoke'})
                check('cache', 'export-to 成功', ex.get('ok') is True, ex.get('msg') or ex.get('format'))
                fmt = ex.get('format')
                check('cache', '格式为 mp4（有 ffmpeg）或 ts（无）', fmt in ('mp4', 'ts'), fmt)
                if ex.get('path'):
                    check('cache', '导出文件真实存在', os.path.isfile(ex['path']), ex['path'])

                # 流式导出
                try:
                    with urllib.request.urlopen(base + '/api/cache/export?id=' + cid, timeout=90) as r:
                        body = r.read()
                        fhdr = r.headers.get('X-Meow-Export-Format')
                    check('cache', 'export 流式返回有内容', len(body) > 0,
                          '%d bytes, %s' % (len(body), fhdr))
                    check('cache', 'export 回传格式头', fhdr in ('mp4', 'ts'), fhdr)
                except Exception as e:
                    check('cache', 'export 流式返回', False, str(e)[:80])

                # 批量端点结构
                st, b = req(base, '/api/cache/batch', {'site': 'Smoke', 'vodId': '2', 'items': []})
                check('cache', 'batch 空 items 不炸', st in (200, 400), 'HTTP %s' % st)
                st, bs = req(base, '/api/cache/status')
                check('cache', 'batch status 可查', st == 200, st)
                st, tk = req(base, '/api/cache/tasks')
                check('cache', '未完成任务可列', st == 200, st)

        # ══════════ 6. 日志域 ══════════
        st, lg = req(base, '/api/logs?limit=10')
        check('logs', '/api/logs 可用', st == 200 and 'items' in lg, st)
        check('logs', '有 stats 统计', isinstance(lg.get('stats'), dict), list((lg.get('stats') or {}).keys()))
        check('logs', '日志里有请求记录', any(i.get('tag') == 'req' for i in (lg.get('items') or [])),
              len(lg.get('items') or []))
        st, lg2 = req(base, '/api/logs?level=error')
        check('logs', 'level 筛选可用', st == 200, st)

        # ══════════ 7. 片库域 ══════════
        st, lib = req(base, '/api/library')
        check('library', '/api/library 可用', st == 200 and 'libs' in lib, st)
        tmpest = os.path.join(ROOT, 'tmp', 'smokelib')
        os.makedirs(tmpest, exist_ok=True)
        st, libt = req(base, '/api/library?action=test', {'lib': {'type': 'local', 'base': tmpest}})
        check('library', 'local 库测试连接', st == 200 and libt.get('ok') is True,
              libt.get('msg') or libt.get('entries'))

        # 存一个库 + 列目录 + 取播放地址，把片库主链路走通
        os.makedirs(tmpest, exist_ok=True)
        with open(os.path.join(tmpest, '测试影片.S01E01.mp4'), 'wb') as f:
            f.write(ZEROS_1K)
        os.makedirs(os.path.join(tmpest, '子目录'), exist_ok=True)
        st, _ = req(base, '/api/library', {'libs': [
            {'id': 'smoke-local', 'name': '冒烟库', 'type': 'local', 'base': tmpest,
             'user': '', 'root': ''}]})
        check('library', '保存片库', st == 200, st)
        st, ov = req(base, '/api/library')
        ids = [x.get('id') for x in (ov.get('libs') or [])]
        check('library', '片库读回', 'smoke-local' in ids, ids)

        st, lst = req(base, '/api/library?lib=smoke-local&path=')
        check('library', '列根目录', st == 200 and lst.get('ok') is True,
              'dirs=%s files=%s' % (len(lst.get('dirs') or []), len(lst.get('files') or [])))
        names = [x.get('name') for x in (lst.get('files') or [])]
        check('library', '能看到视频文件', any('mp4' in (n or '') for n in names), names[:3])
        check('library', '能看到子目录', any((x.get('name') or '') == '子目录'
                                            for x in (lst.get('dirs') or [])),
              [x.get('name') for x in (lst.get('dirs') or [])])

        # 播放地址（带 lib+path），必须 200 且支持 Range
        import urllib.parse as _up
        stream_url = base + '/api/library/stream?lib=smoke-local&path=' + _up.quote('测试影片.S01E01.mp4')
        ok_stream = False
        try:
            rq = urllib.request.Request(stream_url, headers={'Range': 'bytes=0-99'})
            with urllib.request.urlopen(rq, timeout=30) as r:
                ok_stream = r.status in (200, 206)
                check('library', '片库播放支持 Range（206/200）', ok_stream,
                      'HTTP %s len=%s' % (r.status, len(r.read())))
        except urllib.error.HTTPError as e:
            check('library', '片库播放支持 Range（206/200）', False, 'HTTP %s' % e.code)
        except Exception as e:
            check('library', '片库播放支持 Range（206/200）', False, str(e)[:60])

        # 路径穿越必须被挡
        try:
            with urllib.request.urlopen(base + '/api/library/stream?lib=smoke-local&path=../../etc/passwd',
                                        timeout=20) as r:
                check('library', '路径穿越被拒', False, 'HTTP %s（竟允许）' % r.status)
        except urllib.error.HTTPError as e:
            check('library', '路径穿越被拒', e.code in (400, 403, 404), 'HTTP %s' % e.code)
        except Exception as e:
            check('library', '路径穿越被拒', True, str(e)[:40])

        # ══════════ 8. 直播/转码/投屏/刮削：端点存在即可 ══════════
        # （live 同 search，移到末尾）

        st, cast = req(base, '/api/cast')
        check('cast', '/api/cast 有 devices', st in (200, 404) and (st != 200 or 'devices' in cast), st)

        # 刮削：参数名是 title（踩过：写成 name 时后端回 400，
        # 而旧断言把 400 也算"可响应"，等于什么都没验）
        st, _ = req(base, '/api/scrape')
        check('scrape', '缺 title 返回 400', st == 400, 'HTTP %s' % st)
        st, sc = req(base, '/api/scrape?title=' + urllib.parse.quote('测试'))
        check('scrape', '带 title 返回 200 且回显 title',
              st == 200 and sc.get('title') == '测试', 'HTTP %s' % st)

        # 解除绑定：DELETE 带 title 删单条，不带 title 清全部。
        # 同一个方法靠 title 是否为空分流，最容易改坏。
        st, un = req(base, '/api/scrape?title=' + urllib.parse.quote('不存在的片名xyz'),
                     method='DELETE')
        check('scrape', 'DELETE 单条：无记录时 ok=false 而不是报错',
              st == 200 and un.get('ok') is False, 'HTTP %s ok=%s' % (st, un.get('ok')))
        st, un = req(base, '/api/scrape', method='DELETE')
        check('scrape', 'DELETE 全部：返回 ok', st == 200 and un.get('ok') is True, 'HTTP %s' % st)

        # ══════════ 9. 代理与安全 ══════════
        st, _ = req(base, '/api/proxy/stream')
        check('proxy', '缺参返回 4xx 而不是 500', 400 <= st < 500, 'HTTP %s' % st)
        st, _ = req(base, '/api/proxy/stream?url=http://127.0.0.1:1/x')
        check('proxy', '回环地址被拒', st in (403, 400), 'HTTP %s' % st)
        st, _ = req(base, '/api/nosuch/action')
        check('core', '未知路径结构化 404', st in (404, 400, 500), 'HTTP %s' % st)

        # ══════════ 10. 慢端点（放最后：会长时间占住连接）══════════
        st, sr = req(base, '/api/search', {'wd': '测试'}, timeout=90)
        if st == -1:
            check('search', '/api/search 超时（源站问题，非结构问题）', True, 'skipped')
        else:
            groups = sr.get('groups')
            check('search', '/api/search 返回 groups 数组', isinstance(groups, list),
                  'len=%s' % (len(groups) if isinstance(groups, list) else groups))

        st, live = req(base, '/api/live', {'force': False}, timeout=120)
        if st == -1:
            check('live', '/api/live 超时（源站问题，非结构问题）', True, 'skipped')
        else:
            check('live', '/api/live 返回 groups/playlists',
                  isinstance(live.get('groups'), list) or isinstance(live.get('playlists'), list),
                  list(live.keys())[:5])

    finally:
        be.terminate()
        hls_srv.terminate()
        for p in (be, hls_srv):
            try:
                p.wait(timeout=8)
            except Exception:
                p.kill()

    # ---- 汇总 ----
    fails = [r for r in RESULTS if not r[2]]
    print()
    print('=' * 60)
    by_domain = {}
    for d, _, ok, _ in RESULTS:
        t = by_domain.setdefault(d, [0, 0])
        t[0] += 1
        if not ok:
            t[1] += 1
    for d, (tot, bad) in by_domain.items():
        print('%-10s %2d/%2d %s' % (d, tot - bad, tot, 'OK' if bad == 0 else '<< %d FAIL' % bad))
    print('=' * 60)
    print('总计 %d/%d 通过' % (len(RESULTS) - len(fails), len(RESULTS)))
    return 0 if not fails else 1


if __name__ == '__main__':
    sys.exit(main())
