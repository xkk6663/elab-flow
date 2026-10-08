"""ota_layout —— OTA 分区表单源化（方案 A/M1，2026-10-08）。

## 问题

F411 接入实测：同一套分区数字（boot/state/offset/app 的地址与大小）在
5 个互不知情的角落各写一遍 —— port 头 ``ota_layout_f411.h``、APP 链接脚本
ORIGIN、projects/*.yaml flash.images 烧录地址、flash_hal 扇区几何表、
CubeMX 生成的 VECT_TAB。改一处漏四处 = 静默错位跑飞。

## 方案（M1 范围）

单一事实源 = **chips/*.yaml 的 ``ota_layout:`` 节**：

.. code-block:: yaml

    ota_layout:
      boot:   { addr: 0x08000000, size: 0x8000 }
      state:  { addr: 0x08008000, size: 0x4000 }
      offset: { addr: 0x0800C000, size: 0x4000 }
      app:    { addr: 0x08010000, size: 0x70000 }
      # 可选：flash_base（缺省=boot.addr）、store_slots（缺省=state.size/4）

三个消费端：

1. **C 侧**（本模块）：构建时渲染 ``ota_layout_gen.h`` 到 ``<work_dir>/elab_gen/``，
   ``inject.cmake`` 经 ``-include`` 强制每个 C 翻译单元最先包含；
   port 头 ``ota_layout_*.h`` 的同名宏带 ``#ifndef`` 守卫 —— **生成的值赢**，
   yaml 未声明时 gen 头不存在，port 兜底值生效（老芯片零回归）。
2. **builder**：``build_project()`` 在 configure 前落盘 gen 头。
   ★ M2 干跑（dry-run）不走 build_project，天然不写盘（只读预演约束）。
3. **doctor.deep**（``doctor.ota_layout_drift()``）：yaml 分区表 ↔
   flash.images 烧录地址 ↔ 各镜像 ld 的 FLASH 起点三方对账，
   漂移在编译前变红灯，而不是板子上跑飞。
"""

from __future__ import annotations

from pathlib import Path

from .config import ElabError

# 分区键固定四区（协议层 PAGES 语义 + 各 port 头既有宏名对齐）
REGION_KEYS = ("boot", "state", "offset", "app")


def _num(v: object, what: str) -> int:
    """yaml 地址/大小归一化：接受 int 或 "0x..." 字符串（YAML 两种写法都实测出现过）。"""
    if isinstance(v, bool) or not isinstance(v, (int, str)):
        raise ElabError(f"{what} 必须是 int 或 \"0x…\" 字符串，得到 {v!r}")
    try:
        n = int(v, 0) if isinstance(v, str) else int(v)
    except ValueError as exc:
        raise ElabError(f"{what} 不是合法数字：{v!r}") from exc
    if n < 0:
        raise ElabError(f"{what} 不能为负：{n}")
    return n


def normalize_ota_layout(raw: object, chip_id: str = "") -> dict:
    """解析并校验 chips/*.yaml 的 ``ota_layout:`` 节。

    返回带 int 值的归一化 dict（四区 + flash_base + store_slots）；
    缺区 / 重叠 → ``ElabError``（plan 阶段 fail-fast，不进构建）。
    """
    if not isinstance(raw, dict):
        raise ElabError(f"ota_layout 必须是映射（chips yaml）：{chip_id}")
    where = f"ota_layout（{chip_id or '未命名芯片'}）"
    out: dict = {}
    for key in REGION_KEYS:
        r = raw.get(key)
        if not isinstance(r, dict) or "addr" not in r or "size" not in r:
            raise ElabError(f"{where}.{key} 必须是 {{addr, size}} 映射")
        out[key] = {"addr": _num(r["addr"], f"{where}.{key}.addr"),
                    "size": _num(r["size"], f"{where}.{key}.size")}
        if out[key]["size"] == 0:
            raise ElabError(f"{where}.{key}.size 不能为 0")

    # 分区互斥（升序扫描相邻区间）——这是"分区表"能叫分区表的底线
    ordered = sorted((out[k]["addr"], out[k]["addr"] + out[k]["size"], k) for k in REGION_KEYS)
    for (s1, e1, k1), (s2, e2, k2) in zip(ordered, ordered[1:]):
        if e1 > s2:
            raise ElabError(
                f"{where} 分区重叠：{k1}[{s1:#x}~{e1:#x}] ∩ {k2}[{s2:#x}~{e2:#x}]"
            )

    out["flash_base"] = (_num(raw["flash_base"], f"{where}.flash_base")
                         if raw.get("flash_base") is not None else out["boot"]["addr"])
    slots = raw.get("store_slots")
    out["store_slots"] = (int(slots) if slots is not None
                          else out["state"]["size"] // 4)

    # ★ 双槽（A/B Bank，方案 §3）：`slots:` 声明即双槽模式。
    #   不变量：两槽按序无缝覆盖整个 app 区（app = 槽A+槽B 合并视图）——
    #   这样单槽语义（app.addr/app.size）在双槽下依旧成立，flash.images
    #   对账（命中 app.addr == 槽A 起点）不用改判据。
    raw_slots = raw.get("slots")
    if raw_slots is not None:
        if not isinstance(raw_slots, list) or len(raw_slots) != 2:
            raise ElabError(f"{where}.slots 双槽模式必须恰好声明 2 个槽（A/B）")
        norm = []
        for i, s in enumerate(raw_slots):
            if not isinstance(s, dict) or "addr" not in s or "size" not in s:
                raise ElabError(f"{where}.slots[{i}] 必须是 {{addr, size}} 映射")
            norm.append({"addr": _num(s["addr"], f"{where}.slots[{i}].addr"),
                         "size": _num(s["size"], f"{where}.slots[{i}].size")})
        norm.sort(key=lambda s: s["addr"])
        # 槽间无缝：slot0.addr == app.addr，slot1 紧贴 slot0 尾，覆盖到 app 尾
        app_s, app_e = out["app"]["addr"], out["app"]["addr"] + out["app"]["size"]
        if norm[0]["addr"] != app_s or norm[1]["addr"] != norm[0]["addr"] + norm[0]["size"]:
            raise ElabError(f"{where}.slots 两槽必须无缝衔接且槽A起点 == app.addr")
        if norm[1]["addr"] + norm[1]["size"] != app_e:
            raise ElabError(
                f"{where}.slots 槽B尾部 {norm[1]['addr'] + norm[1]['size']:#x} "
                f"≠ app 区尾部 {app_e:#x}（app 必须是两槽的合并视图）"
            )
        out["slots"] = norm
    return out


def render_gen_header(layout: dict, chip_id: str = "",
                      version: tuple[int, int, int] | None = None,
                      build_no: int | None = None) -> str:
    """归一化布局 → ``ota_layout_gen.h`` 的 C 文本。

    宏名与 ``components/ota/port/*/ota_layout_*.h`` 逐字对齐（生成的值赢，
    port 头同名宏带 #ifndef 兜底）。state/offset 的 SIZE 是 port 头没有的
    新赠品（F411 之前没有芯片在 C 里消费它，先备着）。

    version/build_no 提供（双槽方案 §9.2）→ 追加 OTA_VER_* 四宏，
    供 app 的 version tag 与 0x17 应答引用；未提供则不产出（版本机制可选）。
    """
    head = (
        "/* ota_layout_gen.h —— ★ 生成文件，勿手改！\n"
        " *\n"
        f" * 来源：chips/*.yaml ota_layout 节（{chip_id or 'chip'}）\n"
        " * 由 services/elab/ota_layout.py 在构建期生成（方案 A/M1 单源化），\n"
        " * 经 inject.cmake -include 强制每个 C 翻译单元最先包含；\n"
        " * port 头 ota_layout_*.h 的同名宏带 #ifndef 守卫，本文件的值赢。\n"
        " */\n"
        "#ifndef OTA_LAYOUT_GEN_H\n"
        "#define OTA_LAYOUT_GEN_H\n"
        "\n"
    )
    lines = [
        f"#define FLASH_BASE_ADDR       {layout['flash_base']:#010x}",
        f"#define BOOTLOADER_SIZE       {layout['boot']['size']:#010x}UL",
        "",
        f"#define APP_START_ADDRESS     {layout['app']['addr']:#010x}",
        f"#define APP_SIZE              {layout['app']['size']:#010x}UL",
        "",
        f"#define UPGRADE_STATE_ADDR    {layout['state']['addr']:#010x}",
        f"#define UPGRADE_STATE_SIZE    {layout['state']['size']:#010x}UL",
        "",
        f"#define OFFSET_PAGE_ADDR      {layout['offset']['addr']:#010x}",
        f"#define OFFSET_PAGE_SIZE      {layout['offset']['size']:#010x}UL",
        "",
        f"#define OTA_STORE_SLOT_COUNT  {layout['store_slots']}",
    ]
    if layout.get("slots"):
        s0, s1 = layout["slots"]
        lines += [
            "",
            f"#define OTA_SLOT_COUNT        2",
            f"#define OTA_SLOT0_ADDR        {s0['addr']:#010x}UL",
            f"#define OTA_SLOT0_SIZE        {s0['size']:#010x}UL",
            f"#define OTA_SLOT1_ADDR        {s1['addr']:#010x}UL",
            f"#define OTA_SLOT1_SIZE        {s1['size']:#010x}UL",
        ]
    if version is not None:
        lines += [
            "",
            f"#define OTA_VER_MAJOR         {version[0]}",
            f"#define OTA_VER_MINOR         {version[1]}",
            f"#define OTA_VER_PATCH         {version[2]}",
            f"#define OTA_VER_BUILD         {build_no if build_no is not None else 0}",
        ]
    tail = "\n#endif /* OTA_LAYOUT_GEN_H */\n"
    return head + "\n".join(lines) + "\n" + tail


def gen_header_path(work_dir: str | Path) -> Path:
    """gen 头的确定落点：<work_dir>/elab_gen/ota_layout_gen.h（plan/builder/下传三方一致）。"""
    return Path(work_dir) / "elab_gen" / "ota_layout_gen.h"


def write_gen_file(work_dir: str | Path, layout: dict, chip_id: str = "",
                   version: tuple[int, int, int] | None = None,
                   build_no: int | None = None) -> str:
    """把 gen 头落盘（builder.configure 前调用；返回路径字符串，log 用）。"""
    path = gen_header_path(work_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_gen_header(layout, chip_id, version, build_no),
                    encoding="utf-8", newline="\n")
    return str(path)
