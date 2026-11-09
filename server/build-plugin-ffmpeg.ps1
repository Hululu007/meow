# 打包 ffmpeg 插件：下载 Windows 静态版 → build/plugins/ffmpeg/
#
# 为什么要有这个插件：浏览器内核（Chromium / WebView2）没有 HEVC 解码器，
# 用户 NAS 上的 MKV（H.265）在 PC/Web 端放不了。转码本身由后端的
# core/Transcode.java 调 ffmpeg 完成，所以只要把 ffmpeg.exe 放到本机、
# 并把路径写进 policy.json 的 ffmpegPath，用户就零配置可用。
#
# 为什么只留 ffmpeg.exe：essentials 包里还有 ffplay/ffprobe/doc，
# 解压后 200MB+，而我们只用 ffmpeg 一个可执行文件（约 80MB）。
#
# 用法：
#   .\build-plugin-ffmpeg.ps1              # 复用已下载的缓存
#   .\build-plugin-ffmpeg.ps1 -Clean       # 重新下载
#   .\build-plugin-ffmpeg.ps1 -Local       # 用本机已装的 ffmpeg（不走网络）
param(
    [switch]$Clean,
    [switch]$Local
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root 'build\plugins\ffmpeg'
$cache = Join-Path $root 'build\.tmp\ffmpeg-dl'
$zip = Join-Path $cache 'ffmpeg-essentials.zip'
# gyan.dev 的 essentials 构建：109MB 压缩包，解压后取 ffmpeg.exe
$url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

if ($Clean) {
    Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $cache -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $out | Out-Null
New-Item -ItemType Directory -Force -Path $cache | Out-Null

$exe = Join-Path $out 'ffmpeg.exe'

if ($Local) {
    # 用本机已装的：避免每次构建都下 109MB。开发期用这个。
    $found = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
    if (-not $found) { throw '本机没有 ffmpeg，先装一个或用不带 -Local 的方式构建' }
    Write-Host "  用本机 ffmpeg: $found" -ForegroundColor DarkGray
    Copy-Item $found $exe -Force
} else {
    if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 50MB) {
        Write-Host "  下载 ffmpeg essentials（约 110MB）…" -ForegroundColor Yellow
        # 用 curl.exe 而不是 Invoke-WebRequest：后者在 PS5.1 下对大文件
        # 会整份读进内存，109MB 能让它卡几十秒
        & curl.exe -L --fail --retry 3 -o $zip $url
        if ($LASTEXITCODE -ne 0) { throw "下载失败（$LASTEXITCODE）" }
    }
    $stage = Join-Path $cache 'x'
    if (-not (Test-Path (Join-Path $stage 'ffmpeg.exe'))) {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host '  解压…' -ForegroundColor DarkGray
        Expand-Archive -Path $zip -DestinationPath $stage -Force
        # 压缩包结构是 ffmpeg-<ver>-essentials_build/bin/ffmpeg.exe
        $inner = Get-ChildItem $stage -Recurse -Filter 'ffmpeg.exe' |
            Select-Object -First 1
        if (-not $inner) { throw '压缩包里找不到 ffmpeg.exe' }
        Copy-Item $inner.FullName (Join-Path $stage 'ffmpeg.exe') -Force
    }
    Copy-Item (Join-Path $stage 'ffmpeg.exe') $exe -Force
}

# manifest：tool 型插件（不是常驻服务），inject 把路径写进 policy.json
$manifest = @'
{
  "id": "ffmpeg",
  "name": "FFmpeg 转码器",
  "version": "9.0.2",
  "capability": "tool",
  "required": false,
  "fatal": false,
  "tool": true,
  "exec": "ffmpeg.exe",
  "args": [],
  "autostart": false,
  "inject": {
    "target": "{appData}/data/policy.json",
    "key": "ffmpegPath",
    "value": "{pluginDir}/ffmpeg.exe"
  }
}
'@
# 必须 UTF-8 无 BOM：应用侧 serde_json 不接受 BOM
[System.IO.File]::WriteAllText(
    (Join-Path $out 'manifest.json'),
    $manifest,
    (New-Object System.Text.UTF8Encoding $false)
)

$mb = [math]::Round((Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "  ffmpeg 插件: ${mb}MB → $out" -ForegroundColor Green

# 自检：能跑出版本号才算成功
$v = & $exe -hide_banner -version 2>&1 | Select-Object -First 1
Write-Host "  $v" -ForegroundColor DarkGray
