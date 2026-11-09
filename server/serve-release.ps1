# 本地静态文件服务器：模拟插件源，用于测试下载/更新/回滚
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File serve-release.ps1
#   powershell -ExecutionPolicy Bypass -File serve-release.ps1 -Port 8099
#
# 然后在应用的「设置 → 插件源」填 http://127.0.0.1:8099/
#
# 为什么用它而不是 python -m http.server：
#   1. 零依赖（用 .NET HttpListener，Windows 自带）
#   2. 会打印每个请求，便于确认应用真的在下载
#   3. 支持 Range 请求（断点续传测试需要）
#
# 注意：HttpListener 在非管理员下监听 127.0.0.1 是允许的；
# 换成 http://+:8099/ 则需要管理员权限。

param(
    [int]$Port = 8099,
    # 要服务的目录。默认 <仓库>/server/release（插件清单与 zip）；
    # 测应用在线更新时指向 release/vX.Y.Z（那里有 exe/apk + packages.json）。
    [string]$Dir = '',
    # 默认文件（请求 / 时返回它）
    [string]$Index = 'packages.json'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = if ($Dir) {
    if ([IO.Path]::IsPathRooted($Dir)) {
        $Dir
    } else {
        # 相对路径按**仓库根目录**解析，不是 server/：
        # 用户写 `-Dir release/update-test` 时心里的基准是仓库根。
        # 先试仓库根，再试 server/（兼容旧习惯）。
        $a = Join-Path $repoRoot $Dir
        if (Test-Path $a) { $a } else { Join-Path $PSScriptRoot $Dir }
    }
} else {
    Join-Path $PSScriptRoot 'release'
}

if (-not (Test-Path $releaseDir)) {
    throw "目录不存在：$releaseDir"
}
if (-not (Test-Path (Join-Path $releaseDir $Index))) {
    Write-Host "! $releaseDir 里没有 $Index（清单还没生成？）" -ForegroundColor DarkYellow
}

$prefix = "http://127.0.0.1:$Port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host "静态文件服务已启动: $prefix" -ForegroundColor Green
Write-Host "服务目录: $releaseDir" -ForegroundColor Green
Write-Host "在应用设置里填: ${prefix}$Index" -ForegroundColor Cyan
Write-Host "Ctrl+C 停止`n" -ForegroundColor DarkGray

# MIME 映射
#
# ★ 必须带 .apk / .exe：应用在线更新的安装包就是这两种扩展名。
#   缺了会退化成 application/octet-stream——下载本身还能成，但用浏览器点开时
#   会变成"另存为"而不是识别类型，排查时容易误判成服务器有问题。
$mime = @{
    '.json' = 'application/json; charset=utf-8'
    '.zip'  = 'application/zip'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/markdown; charset=utf-8'
    '.apk'  = 'application/vnd.android.package-archive'
    '.exe'  = 'application/vnd.microsoft.portable-executable'
    '.msi'  = 'application/x-msi'
}

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response

        # ★ CORS：应用页面在 http://meow.local（TV 壳），与 127.0.0.1:8099 不同源。
        #   不加这些头，用浏览器直接打开页面测清单会被拦。
        #   （正式链路走原生下载，不依赖 CORS；这里是为排查方便。）
        $res.AddHeader('Access-Control-Allow-Origin', '*')
        $res.AddHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        $res.AddHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range')
        $res.AddHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')

        # 预检直接放行，不查文件
        if ($req.HttpMethod -eq 'OPTIONS') {
            $res.StatusCode = 204
            $res.Close()
            continue
        }

        $rel = $req.Url.AbsolutePath.TrimStart('/')
        if ([string]::IsNullOrEmpty($rel)) { $rel = $Index }
        # 防目录穿越
        if ($rel.Contains('..')) {
            $res.StatusCode = 400
            $res.Close()
            continue
        }
        $file = Join-Path $releaseDir $rel

        if (-not (Test-Path $file -PathType Leaf)) {
            Write-Host ("  404  {0} {1}" -f $req.HttpMethod, $rel) -ForegroundColor DarkYellow
            $res.StatusCode = 404
            $res.Close()
            continue
        }

        $bytes = [System.IO.File]::ReadAllBytes($file)
        $total = $bytes.Length
        $ext = [System.IO.Path]::GetExtension($file).ToLower()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $res.AddHeader('Accept-Ranges', 'bytes')

        # Range 支持：curl -C - 断点续传要用
        $range = $req.Headers['Range']
        if ($range -and $range -match 'bytes=(\d+)-(\d*)') {
            $start = [int]$Matches[1]
            $end = if ($Matches[2]) { [int]$Matches[2] } else { $total - 1 }
            if ($end -ge $total) { $end = $total - 1 }
            $len = $end - $start + 1
            $res.StatusCode = 206
            $res.AddHeader('Content-Range', "bytes $start-$end/$total")
            $res.ContentLength64 = $len
            $res.OutputStream.Write($bytes, $start, $len)
            Write-Host ("  206  {0} {1}  bytes {2}-{3}" -f $req.HttpMethod, $rel, $start, $end) -ForegroundColor Cyan
        } else {
            $res.StatusCode = 200
            $res.ContentLength64 = $total
            $res.OutputStream.Write($bytes, 0, $total)
            $mb = [math]::Round($total / 1MB, 2)
            Write-Host ("  200  {0} {1}  ({2}MB)" -f $req.HttpMethod, $rel, $mb) -ForegroundColor Green
        }
        $res.OutputStream.Close()
    }
} finally {
    $listener.Stop()
    $listener.Close()
    Write-Host "`n服务器已停止" -ForegroundColor DarkGray
}
