# PR 草稿：市场条目 —— 新增市场卡图标 + 更新中英简介

**目标仓库**：`awesome-dsh-plugin/awesome-dsh-plugin`
**改动文件**：`data/plugins/xkk6663__elab-flow--packages-dsh-elab-cockpit.yml`
**来源备份**：本仓 `packages/dsh-elab-cockpit/docs/dsh-market-submission/xkk6663__elab-flow--packages-dsh-elab-cockpit.yml`

## 改了什么

### 1. 新增 `icon:` 字段（市场卡头像）

```yaml
icon: https://raw.githubusercontent.com/xkk6663/elab-flow/main/packages/dsh-elab-cockpit/assets/market-icon.png
```

- 源图在本仓 `packages/dsh-elab-cockpit/assets/market-icon.png`（192×192 PNG）。
- 造型与仓库根 `cockpit.ico` / 插件 `icon.svg` **同源**：暗底圆角方块 `#17202e` + 绿色脉搏线 `#34d399`。
- 格式符合市场约束（`scripts/lib/entries.mjs` 的 `iconProblem()`）：https 协议 + GitHub 托管 + 位图。
  **SVG 会被直接拒绝**，所以这里必须另出一张 PNG。

### 2. 更新 `description.en` / `description.zh`

上一版简介只覆盖「STM32 + 基础闭环」，与 v4.0.0 的实际能力面不符。新版补上：

- 源码级调试：断点 / 寄存器 / 内存 / 反汇编 / SVD 外设
- 串口帧协议解码、Agent 自学习协议
- STM32 / AT32 / ESP32 三系支持

## 前置条件（合并顺序，别搞反）

`icon:` 指向 **main 分支**的 raw URL。**必须先把图推到 `xkk6663/elab-flow` 的 main**，
否则本 PR 合并后头像 404，会静默回退成作者 GitHub 头像（`OwnerAvatar` 的 `onError` 分支）。

1. 先：`xkk6663/elab-flow` 推 main（含 `packages/dsh-elab-cockpit/assets/market-icon.png`）
2. 后：合本 PR

## 自检清单

- [x] `icon` 以 `https:` 开头
- [x] `icon` 托管在 `raw.githubusercontent.com`（GitHub 域名白名单内）
- [x] `icon` 指向位图 `.png`（非 SVG）
- [x] `description.en` / `description.zh` 都在
- [x] 未引入白名单外的键（`ENTRY_KEYS` = url / name / category / description / icon / tarball / file）

## 备注

- 图标展示与市场站（awesome-dsh-plugin.com）无关 —— 该站模板不渲染头像；
  本 PR 影响的是 **DSH 宿主内的插件市场（dsh-market）** 卡片。
- npm 包页与 DSH 宿主「已安装插件」用的仍是 `package.json#icon` → `icon.svg`，无需本 PR。
