# 本地镜像插件仓：packages/dsh-elab-cockpit → xkk6663/dsh-elab-cockpit
#
# 用途：没有 token / 不方便等 Action 时，在本机一次把插件子树推成镜像。
# 与 .github/workflows/publish-plugin.yml 等价（同一套 subtree split + 强推）。
#
#   .\scripts\mirror-plugin.ps1            # 推送
#   .\scripts\mirror-plugin.ps1 -DryRun    # 只切子树、打印结果，不推送

param(
  [string]$Remote = 'https://github.com/xkk6663/dsh-elab-cockpit.git',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$prefix = 'packages/dsh-elab-cockpit'

Push-Location $repo
try {
  $dirty = git status --porcelain -- $prefix
  if ($dirty) {
    Write-Host "✗ $prefix 有未提交改动 —— 镜像只推送已提交的历史" -ForegroundColor Red
    $dirty | ForEach-Object { Write-Host "  $_" }
    exit 1
  }

  Write-Host "→ 切出子树历史（$prefix）…"
  $sha = (git subtree split --prefix=$prefix).Trim()
  if (-not $sha) { Write-Host '✗ subtree split 没有产出提交' -ForegroundColor Red; exit 1 }
  git log --oneline -1 $sha | ForEach-Object { Write-Host "  最新：$_" }

  if ($DryRun) {
    Write-Host "✓ DryRun：未推送。目标 $Remote  分支 main  ←  $sha" -ForegroundColor Yellow
    exit 0
  }

  Write-Host "→ 强推镜像仓（$Remote main）…"
  git push --force $Remote "${sha}:main"
  if ($LASTEXITCODE -ne 0) { Write-Host '✗ 推送失败（检查凭据 / 仓库权限）' -ForegroundColor Red; exit $LASTEXITCODE }
  Write-Host '✓ 镜像完成：xkk6663/dsh-elab-cockpit:main' -ForegroundColor Green
}
finally {
  Pop-Location
}
