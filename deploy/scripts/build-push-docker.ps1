# 构建并推送多架构镜像到 Docker Hub
#
# 产出两个仓库的多架构清单（amd64 + arm64）：
#   <DOCKER_USER>/meow-web:<version>        前端（nginx）
#   <DOCKER_USER>/meow-apiserver:<version>  后端（JRE）
# 同时打 latest 标签（可用 -NoLatest 关掉）。
#
# 用法：
#   docker login                                  # 只需一次
#   ./build-push-docker.ps1 -User yourname -DryRun # 演练：只构建不推送
#   ./build-push-docker.ps1 -User yourname         # 真正推送
#   ./build-push-docker.ps1 -User yourname -Platforms linux/amd64   # 只一个架构（快）
#   ./build-push-docker.ps1 -User meow -RepoPrefix ""               # → meow/web
#
# 为什么必须 buildx：
#   普通 docker build 只产出**当前机器架构**的镜像；在 x64 上构建的镜像
#   到 arm64 机器报 "exec format error"。buildx 一次构建多架构并合成
#   manifest list，docker pull 时自动选对架构。

param(
    [Parameter(Mandatory = $true)]
    [string]$User,

    # 仓库名前缀，默认 "meow-" → meow-web / meow-apiserver
    [string]$RepoPrefix = "meow-",

    [string]$Platforms = "linux/amd64,linux/arm64",

    # 默认读 client/package.json 的 version
    [string]$Version,

    # drpy 运行时的 tag。**独立版本线**，默认读 .env.example 的 DRPY_VERSION。
    # 不跟 $Version 走：drpy 只在主版本发版时顺带重打，中间主版本号远端不存在，
    # 跟着走会让新机器 compose up 报 manifest unknown（详见 compose 里的注释）。
    [string]$DrpyVersion,

    [switch]$NoLatest,
    [switch]$DryRun,
    [switch]$SkipBuild,

    # 用宿主已构建的 client/apps/web/dist 打 web 镜像，跳过容器内 pnpm build。
    # 适用于容器里拉不到 registry.npmjs.org 的情况（产物与架构无关）。
    [switch]$WebFromDist,
    # builder 名称。默认自建 meow-multiarch（docker-container 驱动）。
    # CI 里 setup-buildx-action 已建好一个并设为默认，传它的名字避免重复创建。
    [string]$Builder = 'meow-multiarch',

    # 构建缓存后端。CI 里传 'gha' 用 GitHub Actions 缓存（跨运行复用
    # 基础镜像层与 apt/pip 层，实测能把二次构建从 5m47s 压到 2-3 分钟）。
    # 本地留空——本机有常驻的 buildkitd 缓存，不需要远端。
    [string]$Cache = ''
)

$ErrorActionPreference = 'Stop'
# 仓库根：脚本在 deploy/scripts/，退两层才是根（client/ server/ docs/ 所在处）
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# ── 版本号 ────────────────────────────────────────────────
if (-not $Version) {
    $pkg = Get-Content (Join-Path $root 'client\package.json') -Raw | ConvertFrom-Json
    $Version = $pkg.version
}
if (-not $Version) { throw "无法确定版本号，请用 -Version 指定" }

# drpy 独立版本线：默认从 .env.example 读，读不到退回写死的当前值。
# 这条**不能**跟 $Version，理由见 param 注释与 compose 里的说明。
if (-not $DrpyVersion) {
    $envEx = Join-Path $root 'deploy\docker\.env.example'
    if (Test-Path $envEx) {
        $line = (Get-Content $envEx | Where-Object { $_ -match '^\s*DRPY_VERSION\s*=' } | Select-Object -First 1)
        if ($line) { $DrpyVersion = ($line -split '=', 2)[1].Trim() }
    }
    if (-not $DrpyVersion) { $DrpyVersion = '0.9.23' }
}

$webImage = "$User/${RepoPrefix}web"
$apiImage = "$User/${RepoPrefix}apiserver"
$drpyImage = "$User/${RepoPrefix}drpy"

Write-Host ""
Write-Host "镜像：" -ForegroundColor Cyan
Write-Host "  $webImage`:$Version"
Write-Host "  $apiImage`:$Version"
Write-Host "  $drpyImage`:$DrpyVersion  （独立版本线）"
Write-Host "架构：$Platforms"
Write-Host "模式：$(if ($DryRun) { '仅构建（不推送）' } else { '构建并推送' })"
Write-Host ""

# ── 检查 ──────────────────────────────────────────────────
Write-Host "[1/4] 检查环境..." -ForegroundColor Yellow

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "找不到 docker" }

docker buildx version *> $null
if ($LASTEXITCODE -ne 0) {
    throw "docker buildx 不可用。Docker Desktop 自带；Linux 需装 buildx 插件。"
}

# 跨架构构建需要 QEMU 注册
if ($Platforms -match 'arm64') {
    $binfmt = (docker run --rm --privileged tonistiigi/binfmt 2>&1 | Out-String)
    if ($binfmt -notmatch 'aarch64') {
        Write-Host "  注册 arm64 模拟器..." -ForegroundColor DarkYellow
        docker run --rm --privileged tonistiigi/binfmt --install arm64 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "注册 QEMU 失败（Linux 需 binfmt_misc 支持）" }
    }
    Write-Host "  arm64 模拟器可用" -ForegroundColor Green
}

# 只有推 Docker Hub 时才检查登录；自建 registry / GHCR 的凭据校验留给 docker 自己报错。
# 判断依据：Hub 用户名不含 "." ":" "/"；含任一个说明是 registry 主机名。
$isDockerHub = -not ($User -match '[.:/]')
if (-not $DryRun -and $isDockerHub) {
    # 跨平台：CI（ubuntu runner）没有 USERPROFILE，只有 HOME。
    $cfg = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.docker/config.json' }
           else { Join-Path $env:HOME '.docker/config.json' }
    if (-not (Test-Path $cfg)) { throw "找不到 $cfg，请先 docker login" }
    $json = Get-Content $cfg -Raw | ConvertFrom-Json
    $authKeys = @()
    if ($json.auths) { $authKeys = $json.auths.PSObject.Properties.Name }
    if (-not ($authKeys -match 'docker\.io|index\.docker\.io')) {
        throw "未登录 Docker Hub，请先执行：docker login"
    }
    Write-Host "  已登录 Docker Hub" -ForegroundColor Green
}

# ── builder ───────────────────────────────────────────────
$builder = $Builder
if ((docker buildx ls 2>&1 | Out-String) -notmatch $builder) {
    Write-Host "  创建 builder: $builder" -ForegroundColor DarkGray
    docker buildx create --name $builder --driver docker-container --bootstrap | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "创建 builder 失败" }
}
docker buildx use $builder | Out-Null

function Build-Push {
    param([string]$Dockerfile, [string]$Image, [string]$Label, [string]$Target,
          # 单独指定 tag。drpy 走独立版本线（$DrpyVersion），不跟主版本 $Version。
          [string]$Tag)

    if (-not $Tag) { $Tag = $Version }
    Write-Host "[$Label] 构建 $Image`:$Tag" -ForegroundColor Yellow

    $buildArgs = @(
        'buildx', 'build',
        '--builder', $builder,
        '--platform', $Platforms,
        '-f', $Dockerfile,
        '-t', "$Image`:$Tag"
    )
    # web 的 runtime-dist 路线：直接用 client/apps/web/dist，跳过容器内 pnpm build
    # （容器里拉不到 registry.npmjs.org 时用）
    if ($Target) { $buildArgs += @('--target', $Target) }
    if (-not $NoLatest) { $buildArgs += @('-t', "$Image`:latest") }

    # 关掉 provenance/SBOM：否则多架构清单里会多出两条 unknown/unknown
    # 的 attestation 记录，看着像构建异常。
    $buildArgs += @('--provenance=false', '--sbom=false')

    # 缓存：gha 后端把层缓存在 Actions 的 cache 服务里，key 带 $Label，
    # 三个镜像互不干扰。mode=max 才缓存中间层（默认 min 只缓存最终层）。
    if ($Cache -eq 'gha') {
        $buildArgs += @('--cache-from', "type=gha,scope=$Label")
        $buildArgs += @('--cache-to', "type=gha,mode=max,scope=$Label")
    }
    elseif ($Cache) {
        $buildArgs += @('--cache-from', $Cache)
    }

    # manifest list 不能 --load 到本地，所以 DryRun 导出 OCI tar
    if ($DryRun) {
        $tar = Join-Path $root (Join-Path ".tmp" "$Label-oci.tar")
        New-Item -ItemType Directory -Force -Path (Split-Path $tar) | Out-Null
        $buildArgs += "--output=type=oci,dest=$tar"
    }
    else {
        $buildArgs += '--push'
    }
    $buildArgs += $root

    & docker @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "$Label 构建失败" }
}

# ── 构建 ──────────────────────────────────────────────────
if (-not $SkipBuild) {
    Write-Host "[2/4] 前端镜像..." -ForegroundColor Yellow
    $webTarget = if ($WebFromDist) { 'runtime-dist' } else { '' }
    if ($WebFromDist) { Write-Host "  使用宿主预构建 dist（--target runtime-dist）" -ForegroundColor DarkGray }
    Build-Push -Dockerfile (Join-Path $root 'deploy/docker/Dockerfile.web') -Image $webImage -Label 'web' -Target $webTarget

    Write-Host "[3/4] 后端镜像..." -ForegroundColor Yellow
    Build-Push -Dockerfile (Join-Path $root 'deploy/docker/Dockerfile.apiserver') -Image $apiImage -Label 'apiserver'

    # drpy 运行时：没有它，配置里 200+ 个 .js 源在容器部署下全判不可用
    Write-Host "[4/4] drpy 镜像..." -ForegroundColor Yellow
    Build-Push -Dockerfile (Join-Path $root 'deploy/docker/Dockerfile.drpy') -Image $drpyImage -Label 'drpy' -Tag $DrpyVersion
}

# ── 结果 ──────────────────────────────────────────────────
Write-Host "[4/4] 完成" -ForegroundColor Yellow

if ($DryRun) {
    Write-Host ""
    Write-Host "演练完成，产物在 .tmp/*-oci.tar" -ForegroundColor Cyan
    Write-Host "确认无误后去掉 -DryRun 重跑即可推送。" -ForegroundColor DarkGray
    exit 0
}

Write-Host ""
Write-Host "已推送：" -ForegroundColor Green
# 展示清单时临时放宽错误处理：docker 的 stderr 在 $ErrorActionPreference='Stop'
# 下会直接抛异常，而这里只想知道"能不能读到"。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
foreach ($pair in @(@($webImage, $Version), @($apiImage, $Version), @($drpyImage, $DrpyVersion))) {
    $img = $pair[0]; $tag = $pair[1]
    Write-Host "  $img`:$tag"
    $inspect = docker buildx imagetools inspect "$img`:$tag" 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        $inspect -split "`n" | Select-String 'Platform:' |
            ForEach-Object { Write-Host "    $($_.Line.Trim())" }
    }
    else {
        Write-Host "    （清单读取失败，稍后可手动 imagetools inspect 确认）" -ForegroundColor DarkYellow
    }
}
$ErrorActionPreference = $prevEap
$global:LASTEXITCODE = 0

Write-Host ""
Write-Host "别人拉取（Docker 自动选架构）：" -ForegroundColor Cyan
Write-Host "  docker pull $webImage`:$Version"
Write-Host "  docker pull $apiImage`:$Version"
