<#
.SYNOPSIS
  重打 danmu_api 载荷 zip（打补丁 → 重新打包）。

.DESCRIPTION
  为什么需要它：载荷里的 `server.js` 是上游原样代码，两处硬编码在 TV 上会出事 ——
    1. 代理端口写死 5321，没有环境变量可覆盖。同设备只要有一个别的 danmu_api
       （肥猫/影视仓/另一个壳）在跑，EADDRINUSE 会把这个 node 进程直接带走，
       表现是"模块明明装了、弹幕就是没有"。
    2. 监听走 `listenOnAllInterfaces`（绑 :: / 0.0.0.0）。电视上没有任何理由
       让同 Wi-Fi 的机器直连弹幕服务，而 danmu_api 的默认 token 是 87654321。
  所以补丁只做两件事：代理端口可配（0 = 关掉）、绑定地址可配（TV 传 127.0.0.1）。

  脚本是幂等的：已经打过补丁的源文件不会再被改一次。

  踩过：PowerShell 的 here-string 是 CRLF，而 zip 里的源文件是 LF ——
  直接 `$text.Replace($hereString, ...)` 会**静默不匹配**（Replace 找不到就不改，
  不报错）。所以这里把读入文本统一成 LF，再用数组 -join 拼出模式串。

.EXAMPLE
  ./repack-node-payload.ps1
  ./repack-node-payload.ps1 -VerifyOnly     # CI 门禁：只检查补丁在不在
#>
[CmdletBinding()]
param(
    [string]$Zip,
    # 只检查补丁是否已在包里，不改文件（CI 门禁用）
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
if (-not $PSScriptRoot) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Zip) { $Zip = Join-Path $PSScriptRoot 'app\src\main\assets\node-payload-danmu.zip' }
if (-not (Test-Path $Zip)) { throw "载荷不存在: $Zip" }
Add-Type -AssemblyName System.IO.Compression.FileSystem

$NL = "`n"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('meow-payload-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

function Read-Lf([string]$path) {
    $t = [System.IO.File]::ReadAllText($path)
    return $t.Replace("`r`n", $NL)
}

try {
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $tmp)

    $srv = Join-Path $tmp 'danmu_api\server.js'
    $util = Join-Path $tmp 'danmu_api\utils\server-listen-util.js'
    foreach ($f in @($srv, $util)) {
        if (-not (Test-Path $f)) { throw "载荷结构不对，缺 $f" }
    }

    $srvText = Read-Lf $srv
    $utilText = Read-Lf $util

    $needsSrv = $srvText.IndexOf('DANMU_API_PROXY_PORT') -lt 0
    $needsUtil = $utilText.IndexOf('options.host') -lt 0

    if ($VerifyOnly) {
        if ($needsSrv -or $needsUtil) {
            throw "载荷未打补丁（server.js=$needsSrv, listen-util=$needsUtil）。先跑不带 -VerifyOnly 的版本"
        }
        Write-Host '载荷补丁自检：OK（代理端口可配 + 绑定地址可配）'
        return
    }

    if ($needsUtil) {
        # listenOnAllInterfaces 增加显式 host 分支：给了 host 就单栈绑定，不再折腾 :: / 0.0.0.0
        $anchor = 'export async function listenOnAllInterfaces(server, port, options = {}) {'
        if ($utilText.IndexOf($anchor) -lt 0) { throw 'listen-util 结构变了，找不到函数入口（上游升级？）' }
        $inject = @(
            $anchor,
            '  // meow: 显式 host（TV 传 127.0.0.1）时只绑这一族地址，不做双栈回退',
            '  if (options.host) {',
            '    const bound = await listenOnce(server, { host: options.host, port });',
            '    return createBinding(bound, options.host, port, false);',
            '  }'
        ) -join $NL
        $utilText = $utilText.Replace($anchor, $inject)
        [System.IO.File]::WriteAllText($util, $utilText)
        Write-Host '补丁: listen-util 支持 options.host'
    }

    if ($needsSrv) {
        # 1) 代理端口可配，0 = 不起代理（TV 上没人用这个端点）
        $oldProxy = @(
            '  proxyServer = createProxyServer();',
            '  const proxyBinding = await listenOnAllInterfaces(proxyServer, 5321, {',
            "    serviceName: 'proxy server'",
            '  });',
            '  console.log(`Proxy server running on http://${formatHostForUrl(proxyBinding.address)}:${proxyBinding.port}`);'
        ) -join $NL
        $newProxy = @(
            '  // meow: 代理端口可配；0 = 关闭（TV 上不需要，且 5321 写死会撞其它 danmu_api）',
            "  const configuredProxyPort = Number.parseInt(process.env.DANMU_API_PROXY_PORT ?? '', 10);",
            '  const proxyPort = Number.isNaN(configuredProxyPort) ? 5321 : configuredProxyPort;',
            '  if (proxyPort > 0) {',
            '    proxyServer = createProxyServer();',
            '    const proxyBinding = await listenOnAllInterfaces(proxyServer, proxyPort, {',
            "      serviceName: 'proxy server',",
            '      host: process.env.DANMU_API_BIND || undefined',
            '    });',
            '    console.log(`Proxy server running on http://${formatHostForUrl(proxyBinding.address)}:${proxyBinding.port}`);',
            '  } else {',
            "    console.log('[Proxy] disabled by DANMU_API_PROXY_PORT=0');",
            '  }'
        ) -join $NL
        if ($srvText.IndexOf($oldProxy) -lt 0) {
            throw 'server.js 结构变了，找不到代理监听段（上游升级？）'
        }
        $srvText = $srvText.Replace($oldProxy, $newProxy)

        # 2) 主服务也支持绑定地址
        $oldMain = @(
            '  const mainBinding = await listenOnAllInterfaces(mainServer, mainPort, {',
            "    serviceName: 'main server'",
            '  });'
        ) -join $NL
        $newMain = @(
            '  const mainBinding = await listenOnAllInterfaces(mainServer, mainPort, {',
            "    serviceName: 'main server',",
            '    host: process.env.DANMU_API_BIND || undefined',
            '  });'
        ) -join $NL
        if ($srvText.IndexOf($oldMain) -lt 0) { throw 'server.js 结构变了，找不到主服务监听段（上游升级？）' }
        $srvText = $srvText.Replace($oldMain, $newMain)

        [System.IO.File]::WriteAllText($srv, $srvText)
        Write-Host '补丁: server.js 代理端口可配 + 绑定地址可配'
    }

    if (-not ($needsSrv -or $needsUtil)) { Write-Host '补丁已存在，仅重新打包' }

    # 重新打包：先删旧文件再写，避免追加模式留下重复条目
    #
    # ★ 不能用 ZipFile::CreateFromDirectory（2026-11-06 踩过）：.NET Framework 在
    #   Windows 上会把条目名写成 `danmu_api\server.js`（反斜杠）。Android 的
    #   ZipInputStream 只认 `/`，于是 `danmu_api\server.js` 变成一个"名字里带
    #   反斜杠的单个文件"，解出来目录结构全毁，node 找不到模块直接退出。
    #   必须逐条 CreateEntry 并手动把分隔符换成 `/`。
    Remove-Item $Zip -Force
    $base = (Resolve-Path $tmp).Path.TrimEnd('\') + '\'
    $archive = [System.IO.Compression.ZipFile]::Open(
        $Zip, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Get-ChildItem -Path $tmp -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($base.Length).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $_.FullName, $rel,
                [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }

    # 自检：条目名必须全是 `/`（踩过一次反斜杠，别再犯）
    $bad = @([System.IO.Compression.ZipFile]::OpenRead($Zip).Entries |
        Where-Object { $_.FullName.Contains('\') })
    if ($bad.Count -gt 0) { throw "重打后仍有 $($bad.Count) 个条目用反斜杠分隔，Android 解出来会错位" }

    $size = (Get-Item $Zip).Length
    Write-Host ("载荷已重打: {0} ({1:N1} MB)" -f $Zip, ($size / 1MB))
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
