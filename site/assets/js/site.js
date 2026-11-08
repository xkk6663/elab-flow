/* ELAB-Flow 官网交互
   ------------------------------------------------------------
   1. hash 路由（首页 / 文档 / 市场）
   2. GitHub 实时数据（star / 最新发布）
   3. 滚动触发动画（揭示 / 视差 / 计数 / 图表绘制）
   4. 代码块打字机 + 行内标注
   5. 文档站内阅读（自带 md 渲染）
   6. 芯片包市场（实时索引 + 提交表单）
*/
(() => {
  "use strict";

  const REPO = "xkk6663/elab-flow";
  const API = "https://api.github.com/repos/" + REPO;
  const RAW = "https://raw.githubusercontent.com/" + REPO + "/main/";
  const REPO_URL = "https://github.com/" + REPO;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const fmt = (n) => n.toLocaleString("en-US");

  /* ---------------------------------------------------------- toast */
  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on"), 1900);
  }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => fallback());
    }
    return Promise.resolve(fallback());
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  /* ---------------------------------------------------------- 路由 */
  const views = { "/": $("#view-home"), "/docs": $("#view-docs"), "/market": $("#view-market") };
  let currentRoute = "/";
  let docsOpened = false;
  let marketOpened = false;

  function parseHash() {
    const h = (location.hash || "#/").replace(/^#/, "");
    if (!h.startsWith("/")) return { route: "/", sub: "" };
    const parts = h.split("/").filter(Boolean);
    if (parts[0] === "docs") return { route: "/docs", sub: parts[1] || "" };
    if (parts[0] === "market") return { route: "/market", sub: "" };
    return { route: "/", sub: "" };
  }

  function go(route, opts = {}) {
    const { sub = "", keepScroll = false } = opts;
    const hash = "#" + route + (sub ? "/" + sub : "");
    if (location.hash !== hash) {
      history.pushState(null, "", hash);
    }
    render(route, sub, keepScroll);
  }

  function render(route, sub, keepScroll) {
    if (!views[route]) route = "/";
    Object.entries(views).forEach(([k, el]) => {
      const on = k === route;
      el.hidden = !on;
      el.classList.toggle("view-enter", on);
    });
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.route === route));
    document.body.dataset.route = route;
    currentRoute = route;
    if (typeof applyTheme === "function") applyTheme();
    if (typeof syncRailOpen === "function") syncRailOpen();
    if (typeof syncTocOpen === "function") syncTocOpen();

    if (!keepScroll) {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    requestAnimationFrame(() => {
      observeReveals();
      scanReveals();
    });

    if (route === "/docs") {
      initDocs().then(() => {
        if (sub) openDoc(sub, true);
        else closeDoc(true);
      });
      docsOpened = true;
    }
    if (route === "/market") {
      initMarket();
      marketOpened = true;
    }
  }

  window.addEventListener("hashchange", () => {
    const { route, sub } = parseHash();
    render(route, sub, false);
  });

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-route]");
    if (a) {
      e.preventDefault();
      go(a.dataset.route);
      return;
    }
    // 正文内页内锚点（教程目录的 [7](#7)）：就地滚动。
    // 不能交给路由——parseHash 见到不以 / 开头的 #0 会当成首页，读者被弹回首页。
    const inDoc = e.target.closest('#docBody a[href^="#"]');
    if (inDoc) {
      const id = decodeURIComponent(inDoc.getAttribute("href").slice(1));
      const el = id && document.getElementById(id);
      if (el) {
        e.preventDefault();
        window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 76, behavior: "smooth" });
        return;
      }
    }
    const anchor = e.target.closest("a[data-anchor]");
    if (anchor) {
      e.preventDefault();
      const id = anchor.dataset.anchor;
      if (currentRoute !== "/") {
        go("/");
        setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }), 120);
      } else {
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
      }
    }
  });

  /* ---------------------------------------------------------- 滚动进度 + 导航态 */
  const nav = $("#nav");
  const progress = $("#navProgress");
  let scrollTick = false;

  function onScroll() {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      const y = window.scrollY || document.documentElement.scrollTop;
      nav.classList.toggle("scrolled", y > 12);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.transform = "scaleX(" + (max > 0 ? Math.min(1, y / max) : 0) + ")";
      parallax();
      scrollTick = false;
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);

  /* ---------------------------------------------------------- 揭示动画 */
  let io;
  function observeReveals() {
    if (!("IntersectionObserver" in window)) {
      $$(".reveal").forEach((el) => el.classList.add("in"));
      return;
    }
    if (!io) {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((en) => {
            if (en.isIntersecting) {
              en.target.classList.add("in");
              io.unobserve(en.target);
            }
          });
        },
        { threshold: 0.08, rootMargin: "0px 0px -6% 0px" }
      );
    }
    $$(".reveal:not(.in)").forEach((el) => io.observe(el));
  }

  function scanReveals() {
    // 视口内已存在的元素直接点亮（切页后不必等滚动）
    $$(".reveal:not(.in)").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.92 && r.bottom > 0) el.classList.add("in");
    });
  }

  /* ---------------------------------------------------------- 视差 */
  const parallaxEls = [];
  function parallax() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!parallaxEls.length) return;
    const vh = window.innerHeight;
    parallaxEls.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) return;
      const amp = parseFloat(el.dataset.parallax) || 16;
      const p = (r.top + r.height / 2 - vh / 2) / vh; // -1..1
      el.style.transform = "translate3d(0," + (p * amp).toFixed(2) + "px,0)";
    });
  }
  $$("[data-parallax]").forEach((el) => parallaxEls.push(el));

  /* ---------------------------------------------------------- Hero 入场 */
  function heroIn() {
    const mock = $("#heroMock");
    if (mock) mock.classList.add("in");
    ["#chip1", "#chip2", "#chip3"].forEach((sel, i) => {
      const el = $(sel);
      if (el) setTimeout(() => el.classList.add("in"), 480 + i * 150);
    });
  }

  /* ---------------------------------------------------------- GitHub 实时数据 */
  function cached(key, ttl, producer) {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const o = JSON.parse(raw);
        if (Date.now() - o.t < ttl) return Promise.resolve(o.v);
      }
    } catch (e) { /* ignore */ }
    return producer().then((v) => {
      try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch (e) { /* ignore */ }
      return v;
    });
  }

  /* 构建期快照：API 被限流 / 离线时兜底 */
  let REPO_META = null;
  function loadRepoMeta() {
    if (REPO_META) return Promise.resolve(REPO_META);
    return fetch("data/repo.json")
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => (REPO_META = d || {}))
      .catch(() => (REPO_META = {}));
  }

  function paintStar(n) {
    $("#starCount").textContent = typeof n === "number" ? fmt(n) : "—";
    $("#ctaStarCount").textContent = typeof n === "number" ? (n > 0 ? fmt(n) : "做第一个") : "★";
  }

  function paintRelease(tag, url) {
    if (tag) {
      const ver = tag.startsWith("v") ? tag : "v" + tag;
      $("#navVer").textContent = ver;
      $("#dlVer").textContent = ver;
    }
    if (url) {
      ["#downloadBtn", "#heroDownload"].forEach((sel) => {
        const el = $(sel);
        if (el) el.href = url;
      });
    }
  }

  function loadStar() {
    loadRepoMeta().then((meta) => paintStar(meta.stars));
    cached("elab.star", 10 * 60 * 1000, () =>
      fetch(API, { headers: { Accept: "application/vnd.github+json" } })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d) => d.stargazers_count)
    )
      .then((n) => {
        if (typeof n === "number") paintStar(n);
      })
      .catch(() => { /* 用快照值 */ });
  }

  function loadRelease() {
    loadRepoMeta().then((meta) => paintRelease(meta.tag, meta.download));
    cached("elab.rel", 10 * 60 * 1000, () =>
      fetch(API + "/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    )
      .then((rel) => {
        if (!rel || !rel.tag_name) return;
        const asset = (rel.assets || []).find((a) => /\.zip$|\.7z$|\.exe$/i.test(a.name));
        const url = asset
          ? asset.browser_download_url
          : "https://github.com/" + REPO + "/archive/refs/tags/" + rel.tag_name + ".zip";
        paintRelease(rel.tag_name, url);
      })
      .catch(() => { /* 用快照值 */ });
  }

  /* ---------------------------------------------------------- 计数 */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function runCounters() {
    $$("#statGrid .count").forEach((el) => {
      const to = parseFloat(el.dataset.to) || 0;
      const dur = 1100;
      const t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        const v = Math.round(to * easeOutCubic(p));
        el.textContent = fmt(v);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  /* ---------------------------------------------------------- 图表 */
  const CHART = {
    mem: {
      note: "// 来源：各工程 build 阶段 .map 统计（RAM 静态 + 栈堆，含 CMSIS-RTOS 对象）",
      legend: [
        ["RAM", "#34d399"],
        ["FLASH", "#14b8a6"],
      ],
      unit: "%",
      max: 100,
      groups: [
        { label: "F103C8T6", a: 11.64, b: 24.1 },
        { label: "F411CEU6", a: 16.29, b: 9.39 },
        { label: "C8 · 测试", a: 57.58, b: 58.66 },
      ],
    },
    fps: {
      note: "// 来源：tests/bench_serialcodec.py · CPython 3.13 · 单线程 · 每档 1.5s",
      legend: [["解码吞吐 帧/秒", "#34d399"]],
      unit: "帧/s",
      max: 20000,
      groups: [
        { label: "14B×1", a: 18253 },
        { label: "14B×4", a: 19000 },
        { label: "14B×75", a: 16000 },
        { label: "18B×4", a: 10936 },
      ],
    },
  };
  let chartKey = "mem";

  function drawChart(key) {
    chartKey = key;
    const cfg = CHART[key];
    const svg = $("#chartSvg");
    const W = 460, H = 240;
    const left = 34, right = 10, top = 12, bottom = 34;
    const cw = W - left - right, ch = H - top - bottom;
    const groups = cfg.groups;
    const n = groups.length;
    const barsPer = key === "mem" ? 2 : 1;
    const slot = cw / n;
    const bw = Math.min(26, (slot * 0.62) / barsPer);
    const gap = 4;

    let out = "";
    // 网格 + y 轴
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (cfg.max / ticks) * i;
      const y = top + ch - (ch * i) / ticks;
      out += '<line class="grid" x1="' + left + '" y1="' + y.toFixed(1) + '" x2="' + (W - right) + '" y2="' + y.toFixed(1) + '"/>';
      out += '<text x="' + (left - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' +
        (key === "mem" ? v : v >= 1000 ? v / 1000 + "k" : v) + "</text>";
    }

    groups.forEach((g, gi) => {
      const cx = left + slot * gi + slot / 2;
      const vals = key === "mem" ? [g.a, g.b] : [g.a];
      const totalW = barsPer * bw + (barsPer - 1) * gap;
      vals.forEach((v, bi) => {
        const h = Math.max(2, (Math.min(v, cfg.max) / cfg.max) * ch);
        const x = cx - totalW / 2 + bi * (bw + gap);
        const y = top + ch - h;
        const colors = key === "mem" ? ["#34d399", "#14b8a6"] : ["url(#gbar)"];
        const fill = colors[bi];
        out += '<rect class="bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + h.toFixed(1) + '" rx="3" fill="' + fill + '" style="transition-delay:' + (gi * 90 + bi * 60) + 'ms"/>';
        out += '<text class="val" x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 6).toFixed(1) +
          '" text-anchor="middle">' + (key === "mem" ? v.toFixed(1) : fmt(v)) + "</text>";
      });
      out += '<text x="' + cx.toFixed(1) + '" y="' + (top + ch + 18) + '" text-anchor="middle">' + g.label + "</text>";
    });

    // 基线
    out += '<line x1="' + left + '" y1="' + (top + ch) + '" x2="' + (W - right) + '" y2="' + (top + ch) +
      '" stroke="rgba(255,255,255,.18)"/>';

    svg.innerHTML =
      '<defs><linearGradient id="gbar" x1="0" y1="1" x2="0" y2="0">' +
      '<stop offset="0" stop-color="#0f9d76"/><stop offset="1" stop-color="#14b8a6"/></linearGradient></defs>' +
      out;
    svg.classList.remove("in");
    void svg.getBoundingClientRect();
    requestAnimationFrame(() => svg.classList.add("in"));

    $("#chartNote").textContent = cfg.note;
    $("#chartLegend").innerHTML = cfg.legend
      .map(([name, color]) => '<span><i style="background:' + color + '"></i>' + name + "</span>")
      .join("");
    if (cfg.unit) $("#chartLegend").innerHTML += '<span style="margin-left:auto;color:#565d6b">单位 ' + cfg.unit + "</span>";
    $$(".chart-tab").forEach((t) => t.classList.toggle("active", t.dataset.chart === key));
  }

  $$(".chart-tab").forEach((t) => t.addEventListener("click", () => drawChart(t.dataset.chart)));

  /* ---------------------------------------------------------- 代码打字机 */
  const K = "tk-key", S = "tk-str", N = "tk-num", C = "tk-com", F = "tk-fn",
    OK = "tk-ok", D = "tk-dim", W = "tk-warn", P = "tk-punc";

  const CODE = {
    yaml: {
      file: "projects/stm32f411ceu6.yaml",
      lines: [
        [[C, "# 由 `elab adapt` 确定性生成；人工接管后不再覆盖"]],
        [[K, "name"], [P, ": "], [S, "stm32f411ceu6"]],
        [[K, "root"], [P, ": "], [S, "${ELAB_ROOT}/examples/STM32F411CEU6"]],
        [],
        [[K, "chip"], [P, ": "], [S, "st/stm32f411ceux"], [C, "          # ← 换芯片只改这一行"]],
        [[K, "version"], [P, ": "], [S, '"0.2.0"']],
        [[K, "build"], [P, ":"]],
        [[P, "  "], [K, "kind"], [P, ": "], [S, "cmake"]],
        [[P, "  "], [K, "work_dir"], [P, ": "], [S, "${ELAB_ROOT}/.work/stm32f411ceu6"]],
        [[P, "  "], [K, "toolchain_file"], [P, ": "], [S, "${ELAB_ROOT}/toolchains/gcc.cmake"]],
        [],
        [[K, "flash"], [P, ":"]],
        [[P, "  "], [K, "images"], [P, ":"]],
        [[P, "    - "], [K, "path"], [P, ": "], [S, "…/f411_boot.bin"], [P, "  "], [K, "address"], [P, ": "], [S, '"0x08000000"']],
        [[P, "    - "], [K, "path"], [P, ": "], [S, "…/411.bin"], [P, "  "], [K, "address"], [P, ": "], [S, '"0x08010000"']],
        [],
        [[K, "guard"], [P, ": "], [K, "untouched"], [P, ": "], [N, "true"], [C, "   # 构建前后文件树快照"]],
        [],
        [[K, "monitor"], [P, ":"]],
        [[P, "  "], [K, "close_on"], [P, ": [{ "], [K, "kind"], [P, ": "], [S, "regex"], [P, ", "], [K, "pattern"], [P, ": "], [S, '"^\\\\[(boot|alive)\\\\]"'], [P, ", "], [K, "within_s"], [P, ": "], [N, "10"], [P, " }]"]],
        [[P, "  "], [K, "fail_on"], [P, ":  [{ "], [K, "kind"], [P, ": "], [S, "regex"], [P, ", "], [K, "pattern"], [P, ": "], [S, '"HardFault|assert|PANIC"'], [P, " }]"]],
      ],
      annots: [
        { line: 4, title: "芯片只写一行", text: "厂商参数、内存布局、平台坑位都在适配包里。换芯片 = 换这一行，命令一个字都不改。" },
        { line: 12, title: "双镜像带显式地址", text: "OTA 的 boot 与 app 各带地址烧录，不会向下擦掉 Bootloader 尾部。" },
        { line: 16, title: "业务源码零改动", text: "构建前后对工程目录做快照比对，断言 untouched —— 外骨骼不改器官。" },
        { line: 19, title: "判据可被机器判定", text: "命中 close_on → ok；命中 fail_on → failed；开了口子没收到关键字 → inconclusive。" },
      ],
    },
    cli: {
      file: "elab loop",
      lines: [
        [[D, "$ "], [F, "./elab"], [S, " loop -p stm32f411ceu6 -v"]],
        [],
        [[D, "[1/5] "], [S, "体检"], [D, "       "], [OK, "✓"], [D, " 0.14s   "], [C, "工具链 / 探针 / 串口"]],
        [[D, "[2/5] "], [S, "编译"], [D, "       "], [OK, "✓"], [D, " 7.46s   "], [S, "RAM "], [N, "16.29%"], [D, " · "], [S, "FLASH "], [N, "9.39%"], [D, " · 守卫 "], [OK, "untouched"]],
        [[D, "[3/5] "], [S, "烧录"], [D, "       "], [OK, "✓"], [D, " ** Programming Started **"]],
        [[D, "[4/5] "], [S, "调试校验"], [D, "   "], [OK, "✓"], [D, " 6.03s   Breakpoint 1 at "], [S, "Core/Src/main.c:84"]],
        [[D, "[5/5] "], [S, "串口闭环"], [D, "   "], [OK, "✓"], [D, " 1.68s   命中 "], [S, "regex:^\\[(boot|alive)\\]"], [D, " within_s=10"]],
        [],
        [[S, "结论 "], [OK, "ok"], [D, " · 7.46s · exit "], [N, "0"], [C, "        # 1=failed  2=inconclusive"]],
      ],
      annots: [
        { line: 2, title: "先体检，再动手", text: "工具链、探针、串口逐项确认。缺什么当场说，不带病往下跑。" },
        { line: 3, title: "内存占位是编译事实", text: "RAM / FLASH 取自 .map，不是估的。守卫提示本次构建有没有碰业务源码。" },
        { line: 5, title: "调试校验不是只看连上", text: "真的下了断点、停在预期的源码行，才算过。" },
        { line: 8, title: "退出码就是结论", text: "0 / 1 / 2 三态直接进 CI；「没验证」不会被写成成功。" },
      ],
    },
  };

  const pane = $("#codePane");
  const annotPane = $("#annotPane");
  let typeRun = 0;
  let codeStarted = false;

  function buildCode(key) {
    const cfg = CODE[key];
    pane.innerHTML = "";
    cfg.lines.forEach((tokens, i) => {
      const line = document.createElement("div");
      line.className = "code-line";
      line.dataset.line = i;
      const ln = document.createElement("span");
      ln.className = "ln";
      ln.textContent = String(i + 1);
      line.appendChild(ln);
      const spans = [];
      (tokens || []).forEach(([cls, text]) => {
        const sp = document.createElement("span");
        sp.className = cls;
        sp.textContent = "";
        sp.dataset.full = text;
        line.appendChild(sp);
        spans.push(sp);
      });
      pane.appendChild(line);
    });

    annotPane.innerHTML = cfg.annots
      .map(
        (a, i) =>
          '<div class="annot-item" data-line="' + a.line + '">' +
          '<span class="annot-num">' + (i + 1) + "</span>" +
          "<div><h5>" + a.title + "</h5><p>" + a.text + "</p></div></div>"
      )
      .join("");
  }

  function typeCode(key) {
    const run = ++typeRun;
    buildCode(key);
    const lines = $$(".code-line", pane);
    const annots = $$(".annot-item", annotPane);
    let li = 0;

    function nextLine() {
      if (run !== typeRun) return;
      if (li >= lines.length) {
        $$(".caret", pane).forEach((c) => c.remove());
        return;
      }
      const line = lines[li];
      line.classList.add("hot");
      if (li > 0) lines[li - 1].classList.remove("hot");
      const hit = annots.find((a) => +a.dataset.line === li);
      if (hit) hit.classList.add("on");

      const spans = Array.from(line.querySelectorAll("span:not(.ln)"));
      let si = 0;
      const caret = document.createElement("span");
      caret.className = "caret";
      line.appendChild(caret);

      if (!spans.length) {
        line.classList.remove("hot");
        li++;
        setTimeout(nextLine, 55);
        return;
      }

      function nextSpan() {
        if (run !== typeRun) return;
        if (si >= spans.length) {
          line.classList.remove("hot");
          li++;
          setTimeout(nextLine, 60);
          return;
        }
        const sp = spans[si];
        const full = sp.dataset.full || "";
        let ci = 0;
        const chunk = Math.max(1, Math.ceil(full.length / 26));
        function tick() {
          if (run !== typeRun) return;
          ci += chunk;
          sp.textContent = full.slice(0, ci);
          if (ci < full.length) {
            requestAnimationFrame(tick);
          } else {
            si++;
            nextSpan();
          }
        }
        tick();
      }
      nextSpan();
    }
    nextLine();
  }

  $$(".code-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".code-tab").forEach((t) => t.classList.toggle("active", t === tab));
      typeCode(tab.dataset.code);
    });
  });

  $("#copyCode").addEventListener("click", () => {
    const key = $(".code-tab.active").dataset.code;
    const text = CODE[key].lines.map((toks) => (toks || []).map((t) => t[1]).join("")).join("\n");
    copy(text).then((ok) => toast(ok ? "已复制到剪贴板" : "复制失败，请手动选择"));
  });

  /* ---------------------------------------------------------- 文档 */
  let DOCS = null;
  let docLoading = null;
  let activeDoc = "";

  function loadDocs() {
    if (DOCS) return Promise.resolve(DOCS);
    if (docLoading) return docLoading;
    docLoading = fetch("data/docs.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        DOCS = d.docs || [];
        return DOCS;
      })
      .catch(() => {
        DOCS = [];
        return DOCS;
      });
    return docLoading;
  }

  function initDocs() {
    return loadDocs().then((docs) => {
      if (!docs.length) {
        $("#docCards").innerHTML = '<div class="mkt-empty">教程数据加载失败，请直接前往 GitHub 阅读。</div>';
        return;
      }
      if (!$("#docList").childElementCount) {
        $("#docList").innerHTML = docs
          .map(
            (d) =>
              '<button class="doc-item" data-doc="' + d.num + '">' +
              '<span class="dn">' + d.num + "</span>" +
              "<span><span class=\"dt\">" + d.name + "</span>" +
              '<span class="dm">' + d.minutes + " min · " + d.chars + " 字</span></span></button>"
          )
          .join("");
        $("#docCards").innerHTML = docs
          .map(
            (d) =>
              '<button class="doc-card" data-doc="' + d.num + '">' +
              '<span class="dc-top"><span class="dc-n">' + d.num + "</span><h4>" + d.name + "</h4></span>" +
              "<p>" + d.desc + "</p>" +
              '<span class="dc-meta">约 ' + d.minutes + " 分钟 · " + d.title.slice(0, 28) + "</span></button>"
          )
          .join("");
      }
    });
  }

  document.addEventListener("click", (e) => {
    const item = e.target.closest("[data-doc]");
    if (!item) return;
    e.preventDefault();
    go("/docs", { sub: item.dataset.doc });
  });

  $("#docBack").addEventListener("click", () => go("/docs", { keepScroll: true }));
  $("#docSearch").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$("#docList .doc-item").forEach((el) => {
      el.style.display = !q || el.textContent.toLowerCase().includes(q) ? "" : "none";
    });
    $$("#docCards .doc-card").forEach((el) => {
      el.style.display = !q || el.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });

  function closeDoc(silent) {
    activeDoc = "";
    tocTargets = [];
    $("#docView").classList.remove("on");
    $("#docOverview").style.display = "";
    shell.classList.add("no-toc");
    syncTocOpen();
    $("#docPager").innerHTML = "";
    $$(".doc-item").forEach((el) => el.classList.remove("active"));
    if (!silent) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openDoc(num, silent) {
    if (!DOCS || !DOCS.length) {
      loadDocs().then(() => openDoc(num, silent));
      return;
    }
    const doc = DOCS.find((d) => d.num === num) || DOCS[0];
    if (!doc) return;
    activeDoc = doc.num;
    $("#docOverview").style.display = "none";
    $("#docView").classList.add("on");
    $("#docMeta").textContent = doc.num + " · 约 " + doc.minutes + " 分钟 · " + doc.chars + " 字";
    $("#docGithub").href = REPO_URL + "/blob/main/docs/tutorials/" + encodeURIComponent(doc.file);
    $("#docBody").innerHTML = md2html(doc.md);
    $$(".doc-item").forEach((el) => el.classList.toggle("active", el.dataset.doc === doc.num));

    buildToc(doc);
    buildPager(doc);
    if (!silent) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---- 本篇目录：h2 + h3，随滚动高亮 ---- */
  let tocTargets = [];

  function buildToc(doc) {
    const heads = $$("#docBody h2, #docBody h3").filter((h) => h.textContent.trim());
    heads.forEach((h, i) => {
      if (!h.id) h.id = "s-" + doc.num + "-" + i;
    });
    tocTargets = heads;
    shell.classList.toggle("no-toc", !heads.length);
    syncTocOpen();
    if (!heads.length) return;
    $("#tocCount").textContent = heads.length + " 节";
    $("#docTocBody").innerHTML = heads
      .map(
        (h) =>
          '<a href="#' + h.id + '" data-toc="' + h.id + '" class="' + (h.tagName === "H3" ? "lv3" : "lv2") + '">' +
          esc(h.textContent.trim()) + "</a>"
      )
      .join("");
    spyToc();
  }

  function spyToc() {
    if (!tocTargets.length || !$("#docView").classList.contains("on")) return;
    const line = window.scrollY + 120;
    let idx = 0;
    tocTargets.forEach((h, i) => {
      if (h.getBoundingClientRect().top + window.scrollY <= line) idx = i;
    });
    const box = $("#docTocBody");
    const links = $$("#docTocBody a");
    links.forEach((a, i) => a.classList.toggle("on", i === idx));
    // 让高亮项留在目录可视区（用 rect 相对量，offsetTop 的 offsetParent 是 sticky 的侧栏，不能用）
    const on = links[idx];
    if (on && box) {
      const r = on.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      if (r.top < br.top || r.bottom > br.bottom) {
        box.scrollTop += r.top - br.top - box.clientHeight / 2 + r.height / 2;
      }
    }
  }

  let tocTick = false;
  window.addEventListener(
    "scroll",
    () => {
      if (tocTick) return;
      tocTick = true;
      requestAnimationFrame(() => {
        tocTick = false;
        spyToc();
      });
    },
    { passive: true }
  );

  /* ---- 文末上一篇 / 下一篇 ---- */
  function buildPager(doc) {
    const i = DOCS.findIndex((d) => d.num === doc.num);
    const prev = i > 0 ? DOCS[i - 1] : null;
    const next = i >= 0 && i < DOCS.length - 1 ? DOCS[i + 1] : null;
    $("#docPager").innerHTML =
      (prev
        ? '<a href="#/docs/' + prev.num + '" data-doc="' + prev.num + '"><span class="pg-k">← 上一篇</span><span class="pg-t">' +
          esc(prev.name) + "</span></a>"
        : "") +
      (next
        ? '<a class="next" href="#/docs/' + next.num + '" data-doc="' + next.num + '"><span class="pg-k">下一篇 →</span><span class="pg-t">' +
          esc(next.name) + "</span></a>"
        : "");
  }

  /* ---- 左右两栏：拖动调宽 / 收起 / 恢复 ---- */
  const shell = $("#docsShell");
  const RAIL_W_KEY = "elab.railW";
  const RAIL_C_KEY = "elab.railCollapsed";
  const TOC_W_KEY = "elab.tocW";
  const TOC_C_KEY = "elab.tocCollapsed";
  const THEME_KEY = "elab.docTheme";
  const RAIL_MIN = 232;
  const RAIL_MAX = 560;
  const RAIL_DEFAULT = 300;
  const TOC_MIN = 190;
  const TOC_MAX = 460;
  const TOC_DEFAULT = 268;

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch (e) {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch (e) {
        /* 隐私模式下写不进去，忽略 */
      }
    },
  };

  const isNarrow = () => window.matchMedia("(max-width: 1060px)").matches;
  const padOf = () => parseFloat(getComputedStyle(shell).paddingLeft) || 0;

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, Math.round(v)));
  }

  let railW = clamp(parseInt(store.get(RAIL_W_KEY), 10) || RAIL_DEFAULT, RAIL_MIN, RAIL_MAX);
  let tocW = clamp(parseInt(store.get(TOC_W_KEY), 10) || TOC_DEFAULT, TOC_MIN, TOC_MAX);

  function setRailW(w) {
    railW = clamp(w, RAIL_MIN, RAIL_MAX);
    shell.style.setProperty("--rail-w", railW + "px");
  }

  function setTocW(w) {
    tocW = clamp(w, TOC_MIN, TOC_MAX);
    shell.style.setProperty("--toc-w", tocW + "px");
  }

  setRailW(railW);
  setTocW(tocW);

  /* 通用拖动条：measure(clientX) 把指针位置换算成宽度 */
  function bindResizer(bar, { measure, commit, reset, step }) {
    if (!bar) return;
    let dragging = false;
    bar.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      dragging = true;
      bar.classList.add("on");
      document.body.classList.add("resizing");
      try {
        bar.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 老浏览器无 pointer capture，靠 document 上的 move 兜底 */
      }
      e.preventDefault();
    });
    const move = (e) => {
      if (dragging) measure(e.clientX);
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove("on");
      document.body.classList.remove("resizing");
      commit();
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    bar.addEventListener("dblclick", reset);
    bar.addEventListener("keydown", step);
  }

  bindResizer($("#railResizer"), {
    measure: (x) => setRailW(x - shell.getBoundingClientRect().left - padOf()),
    commit: () => store.set(RAIL_W_KEY, String(railW)),
    reset: () => {
      setRailW(RAIL_DEFAULT);
      store.set(RAIL_W_KEY, String(RAIL_DEFAULT));
    },
    step: (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setRailW(railW + (e.key === "ArrowRight" ? 16 : -16));
      store.set(RAIL_W_KEY, String(railW));
    },
  });

  bindResizer($("#tocResizer"), {
    measure: (x) => setTocW(shell.getBoundingClientRect().right - padOf() - x),
    commit: () => store.set(TOC_W_KEY, String(tocW)),
    reset: () => {
      setTocW(TOC_DEFAULT);
      store.set(TOC_W_KEY, String(TOC_DEFAULT));
    },
    step: (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setTocW(tocW + (e.key === "ArrowLeft" ? 16 : -16));
      store.set(TOC_W_KEY, String(tocW));
    },
  });

  function syncRailOpen() {
    // 浮出按钮只在本页面 + 侧栏收起时出现
    $("#railOpen").hidden = !(shell.classList.contains("collapsed") && currentRoute === "/docs");
  }

  function syncTocOpen() {
    const hasToc = currentRoute === "/docs" && !shell.classList.contains("no-toc");
    $("#tocOpen").hidden = !(hasToc && shell.classList.contains("toc-collapsed") && !isNarrow());
  }

  function setRailCollapsed(v, persist) {
    shell.classList.toggle("collapsed", v);
    syncRailOpen();
    if (persist) store.set(RAIL_C_KEY, v ? "1" : "0");
  }

  function setTocCollapsed(v, persist) {
    shell.classList.toggle("toc-collapsed", v);
    syncTocOpen();
    if (persist) store.set(TOC_C_KEY, v ? "1" : "0");
  }

  // 窄屏首次访问默认收起两侧，正文优先；用户手动展开后记住选择
  const narrow = isNarrow();
  const storedCollapse = store.get(RAIL_C_KEY);
  setRailCollapsed(storedCollapse === "1" || (storedCollapse === null && narrow), false);

  const storedTocCollapse = store.get(TOC_C_KEY);
  setTocCollapsed(storedTocCollapse === "1" || (storedTocCollapse === null && narrow), false);

  $("#railCollapse").addEventListener("click", () => setRailCollapsed(true, true));
  $("#railOpen").addEventListener("click", () => setRailCollapsed(false, true));
  $("#tocCollapse").addEventListener("click", () => setTocCollapsed(true, true));
  $("#tocOpen").addEventListener("click", () => setTocCollapsed(false, true));

  // 窗口跨过断点时，浮出按钮的显示条件会变
  window.addEventListener(
    "resize",
    () => {
      syncRailOpen();
      syncTocOpen();
    },
    { passive: true }
  );

  /* ---- 全局主题：深色 / 浅色（右上角开关，三个页面都吃） ---- */
  function themeName() {
    return store.get(THEME_KEY) === "light" ? "light" : "dark";
  }

  function applyTheme() {
    const light = themeName() === "light";
    document.documentElement.classList.toggle("light", light);
    const btn = $("#themeToggle");
    if (btn) btn.setAttribute("aria-pressed", light ? "true" : "false");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", light ? "#fbfbfc" : "#08090b");
  }

  $("#themeToggle").addEventListener("click", () => {
    store.set(THEME_KEY, themeName() === "light" ? "dark" : "light");
    applyTheme();
    spyToc();
  });

  document.addEventListener("click", (e) => {
    const toc = e.target.closest("[data-toc]");
    if (!toc) return;
    e.preventDefault();
    const el = document.getElementById(toc.dataset.toc);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 76, behavior: "smooth" });
  });

  /* 极简 markdown 渲染器（够读教程：标题/表格/代码/列表/引用/图片/链接） */
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inline(s) {
    let t = s;
    // 行内代码先占位
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (m, c) => {
      codes.push(c);
      return "\u0000C" + (codes.length - 1) + "\u0000";
    });
    // 裸 HTML 锚点（教程里给 GitHub 目录跳转用的 <a id="7"></a>）：
    // 必须在 esc 之前抽出来，否则会被转义成 &lt;a id="7"&gt; 直接显示在正文里
    const ids = [];
    t = t.replace(/<a\s+(?:id|name)\s*=\s*"([^"\s]+)"\s*>\s*<\/a>/gi, (m, id) => {
      ids.push(id);
      return "\u0000A" + (ids.length - 1) + "\u0000";
    });
    t = esc(t);
    // 图片
    // alt 里可能带一层配对方括号（「[alive] 稳定 1Hz」），[^\]]* 会截断 → 这类图渲染成乱链接
    t = t.replace(/!\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, src) => {
      const url = absUrl(src);
      return '<img src="' + url + '" alt="' + esc(alt) + '" loading="lazy">';
    });
    // 链接
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, text, href) => {
      const url = absUrl(href);
      const ext = /^https?:|^mailto:/.test(url) ? ' target="_blank" rel="noopener"' : "";
      return '<a href="' + url + '"' + ext + ">" + text + "</a>";
    });
    // 粗体 / 斜体 / 删除线
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    // 还原行内代码
    t = t.replace(/\u0000C(\d+)\u0000/g, (m, i) => "<code>" + esc(codes[+i]) + "</code>");
    // 还原锚点：输出不可见定位点，目录里的 [7](#7) 才跳得到
    t = t.replace(/\u0000A(\d+)\u0000/g, (m, i) => '<span class="anchor" id="' + esc(ids[+i]) + '"></span>');
    return t;
  }

  function absUrl(u) {
    if (!u || /^(https?:|mailto:|#|data:)/.test(u)) return u;
    // 教程截图已随站点托管（构建期复制到 tut-assets/），同源加载，不走 raw 热链
    if (u.startsWith("tut-assets/") || u.startsWith("./tut-assets/")) return u.replace(/^\.\//, "");
    if (u.startsWith("/")) return REPO_URL + "/blob/main" + u;
    if (/\.md(#.*)?$/.test(u)) return REPO_URL + "/blob/main/docs/tutorials/" + u.replace(/^\.\//, "");
    return RAW + "docs/tutorials/" + u.replace(/^\.\//, "");
  }

  function md2html(src) {
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;

    function flushList(tag, items) {
      out.push("<" + tag + ">" + items.map((x) => "<li>" + inline(x) + "</li>").join("") + "</" + tag + ">");
    }

    while (i < lines.length) {
      let line = lines[i];

      // 代码块
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        const lang = fence[1];
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++;
        out.push('<pre data-lang="' + lang + '"><code>' + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }

      // 表格
      if (/^\s*\|/.test(line) && /^\s*\|?[\s:-]*\|/.test(lines[i + 1] || "") && (lines[i + 1] || "").includes("-")) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          rows.push(lines[i]);
          i++;
        }
        const cells = (r) =>
          r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        const head = cells(rows[0]);
        const body = rows.slice(2).map(cells);
        out.push(
          "<table><thead><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>" +
          body.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") +
          "</tbody></table>"
        );
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = h[1].length;
        out.push("<h" + lvl + ">" + inline(h[2].replace(/\s+#+\s*$/, "")) + "</h" + lvl + ">");
        i++;
        continue;
      }

      // 裸 HTML 锚点独占一行（GitHub 目录跳转用）：直出不可见定位点，别包成空段落
      const anc = line.match(/^\s*<a\s+(?:id|name)\s*=\s*"([^"\s]+)"\s*>\s*<\/a>\s*$/i);
      if (anc) {
        out.push('<span class="anchor" id="' + esc(anc[1]) + '"></span>');
        i++;
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }

      // 引用
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + buf.map((b) => (b.trim() ? "<p>" + inline(b) + "</p>" : "")).join("") + "</blockquote>");
        continue;
      }

      // 列表
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          let item = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "");
          i++;
          // 续行（缩进两格以上且不是新列表项）
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
            item += " " + lines[i].trim();
            i++;
          }
          items.push(item);
        }
        flushList(ordered ? "ol" : "ul", items);
        continue;
      }

      // 空行
      if (!line.trim()) {
        i++;
        continue;
      }

      // 段落
      const buf = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,6}\s|```|>|\s*\|)/.test(lines[i]) &&
        !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
      ) {
        buf.push(lines[i].trim());
        i++;
      }
      out.push("<p>" + inline(buf.join(" ")) + "</p>");
    }
    return out.join("\n");
  }

  /* ---------------------------------------------------------- 市场 */
  const MARKET_LOCAL = "data/market.json";
  const MARKET_RAW = RAW + "market/index.json";
  let MARKET = null;
  let marketLoading = null;

  function loadMarket() {
    if (MARKET) return Promise.resolve(MARKET);
    if (marketLoading) return marketLoading;
    const withTimeout = (p, ms) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
      });

    marketLoading = withTimeout(fetch(MARKET_RAW, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))), 4500)
      .then((d) => {
        MARKET = { data: d, live: true };
        return MARKET;
      })
      .catch(() =>
        fetch(MARKET_LOCAL)
          .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
          .then((d) => {
            MARKET = { data: d, live: false };
            return MARKET;
          })
          .catch(() => {
            MARKET = { data: { packs: [], providers: [] }, live: false };
            return MARKET;
          })
      );
    return marketLoading;
  }

  const installCmd = (p, kind) =>
    kind === "provider" ? "elab provider install " + p.name : "elab pkg install " + p.name;

  function packCard(p, kind) {
    const status = p.status || (kind === "provider" ? "provider" : "community");
    const chips = (p.chips || []).map((c) => '<span class="chip-tag">' + esc(c) + "</span>").join("");
    const steps = (p.steps || []).map((s) => '<span class="chip-tag">' + esc(s) + "</span>").join("");
    const srcUrl = p.source && p.source.url ? p.source.url.replace(/\.git$/, "") : "";
    const srcLabel = p.source && p.source.type === "local" ? "随仓内置" : srcUrl.replace(/^https?:\/\/github\.com\//, "");
    const initials = (p.vendor || p.name || "??").slice(0, 2).toUpperCase();
    return (
      '<article class="pack" data-search="' +
      esc((p.name + " " + (p.description || "") + " " + (p.chips || []).join(" ") + " " + (p.license || "")).toLowerCase()) +
      '">' +
      '<div class="pack-top">' +
      '<span class="pack-ico">' + esc(initials) + "</span>" +
      "<div><div class=\"pack-name\">" + esc(p.name) + " <span style=\"color:#6c7280;font-size:12px\">@" + esc(p.version || "?") + "</span></div>" +
      '<div class="pack-sub">' + esc(p.license || "—") + " · kernel_api " + esc((p.requires && p.requires.kernel_api) || "—") + "</div></div>" +
      '<span class="badge ' + esc(status) + '" style="margin-left:auto">' + esc(status) + "</span>" +
      "</div>" +
      '<p class="pack-desc">' + esc(p.description || "") + "</p>" +
      (chips ? '<div class="chip-row">' + chips + "</div>" : "") +
      (steps ? '<div class="chip-row">' + steps + "</div>" : "") +
      '<div class="pack-cmd"><span>' + esc(installCmd(p, kind)) + '</span><button class="copy-btn" data-copy="' + esc(installCmd(p, kind)) + '">复制</button></div>' +
      '<div class="pack-foot">' +
      (srcUrl ? '<a href="' + esc(srcUrl) + '" target="_blank" rel="noopener">' + esc(srcLabel) + "</a>" : "<span>" + esc(srcLabel) + "</span>") +
      "<span>sha256 " + esc((p.sha256 || "").slice(0, 10)) + "</span>" +
      "</div></article>"
    );
  }

  function initMarket() {
    loadMarket().then(({ data, live }) => {
      const packs = data.packs || [];
      const provs = data.providers || [];
      const src = $("#mktSrc");
      src.className = "src-note" + (live ? "" : " snap");
      src.innerHTML =
        "<i></i>" +
        (live
          ? "market/index.json · 实时读取"
          : "market/index.json · 快照 " + (data.snapshot_at ? data.snapshot_at.slice(0, 10) : "已打包") + "（实时读取不可用）");

      $("#packCount").textContent = packs.length + " packs";
      $("#provCount").textContent =
        "1 个内置默认" + (provs.length ? " + " + provs.length + " 个外部" : " · 暂无外部 provider");
      $("#packGrid").innerHTML = packs.length
        ? packs.map((p) => packCard(p, "pack")).join("")
        : '<div class="mkt-empty">还没有已登记的芯片包。</div>';
      // 内置默认链是写死在页面里的，重渲染时先摘出来再放回最前面
      const grid = $("#provGrid");
      const builtin = grid.querySelector(".prov-default");
      grid.innerHTML = "";
      if (builtin) grid.appendChild(builtin);
      grid.insertAdjacentHTML(
        "beforeend",
        provs.length
          ? provs.map((p) => packCard(p, "provider")).join("")
          : '<div class="mkt-empty">除内置默认链外，还没有安装任何外部 provider。</div>'
      );
    });
  }

  $("#mktSearch").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$(".pack, .prov-default, .mkt-empty").forEach((el) => {
      const hay = el.dataset.search || "";
      el.style.display = !q || hay.includes(q) ? "" : "none";
    });
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    copy(btn.dataset.copy).then((ok) => toast(ok ? "命令已复制" : "复制失败"));
  });

  /* ---------------------------------------------------------- 上传芯片包 */
  const modal = $("#uploadModal");
  const fields = ["fName", "fVer", "fChips", "fSrc", "fDesc", "fLicense"];

  function currentEntry() {
    const name = $("#fName").value.trim();
    const ver = $("#fVer").value.trim() || "0.1.0";
    const chips = $("#fChips").value.split(",").map((s) => s.trim()).filter(Boolean);
    const src = $("#fSrc").value.trim();
    const desc = $("#fDesc").value.trim() || "芯片适配包";
    const vendor = name.includes("/") ? name.split("/")[0] : name;
    const platform = name.includes("/") ? name.split("/")[1] : name;
    const entry = {
      name,
      vendor,
      platform,
      version: ver,
      description: desc,
      status: "community",
      license: $("#fLicense").value,
      requires: { kernel_api: ">=1 <2", schema_version: 1 },
      chips,
      source: { type: "git", url: src, ref: "<commit-sha>" },
      sha256: "<sha256-of-pack>",
    };
    return entry;
  }

  function refreshEntry() {
    const entry = currentEntry();
    $("#entryOut").textContent = JSON.stringify(entry, null, 2);
    const ok = entry.name && entry.chips.length && entry.source.url;
    const body =
      "## 新增芯片包：" + (entry.name || "<name>") + "\n\n" +
      "```json\n" + JSON.stringify(entry, null, 2) + "\n```\n\n" +
      "### 自查清单\n" +
      "- [ ] 仓库公开，根目录带 `pack.yaml`（schema_version: 1）\n" +
      "- [ ] 仓库带 `.gitattributes`：`* -text`（内容哈希按字节算）\n" +
      "- [ ] `requires.kernel_api` 与目标内核匹配\n" +
      "- [ ] 已在真机上跑过 `elab pkg install` + `elab setup`\n" +
      "- [ ] 包内不含对其它包的 import / 依赖\n";
    const url =
      REPO_URL +
      "/issues/new?labels=pack-market&title=" +
      encodeURIComponent("[pack] 新增芯片包 " + (entry.name || "")) +
      "&body=" +
      encodeURIComponent(body);
    const a = $("#submitIssue");
    a.href = url;
    a.style.opacity = ok ? "1" : ".5";
    a.style.pointerEvents = ok ? "auto" : "none";
    return entry;
  }

  function openModal() {
    modal.hidden = false;
    refreshEntry();
    setTimeout(() => $("#fName").focus(), 60);
  }
  function closeModal() {
    modal.hidden = true;
  }

  $("#openUpload").addEventListener("click", openModal);
  $("#openUpload2").addEventListener("click", openModal);
  $("#closeUpload").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeModal();
  });
  fields.forEach((id) => $("#" + id).addEventListener("input", refreshEntry));
  $("#copyEntry").addEventListener("click", () => {
    copy($("#entryOut").textContent).then((ok) => toast(ok ? "JSON 已复制" : "复制失败"));
  });

  /* ---------------------------------------------------------- 宣传片灯箱 */
  const promoModal = $("#promoModal");
  const promoVideo = $("#promoVideo");
  if (promoModal && promoVideo) {
    const openPromo = () => {
      promoModal.hidden = false;
      document.body.classList.add("no-scroll");
      const p = promoVideo.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
      const root = document.documentElement;
      if (root.requestFullscreen) {
        const fs = root.requestFullscreen();
        if (fs && typeof fs.catch === "function") fs.catch(() => {});
      }
    };
    const closePromo = () => {
      promoModal.hidden = true;
      document.body.classList.remove("no-scroll");
      promoVideo.pause();
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    };
    ["#heroPlay", "#promoCard"].forEach((sel) => {
      const btn = $(sel);
      if (btn) btn.addEventListener("click", openPromo);
    });
    $("#promoClose").addEventListener("click", closePromo);
    promoModal.addEventListener("click", (e) => {
      if (e.target === promoModal) closePromo();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !promoModal.hidden) closePromo();
    });
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && !promoModal.hidden) closePromo();
    });
  }

  /* ---------------------------------------------------------- 启动 */
  function boot() {
    drawChart("mem");
    observeReveals();
    scanReveals();
    onScroll();
    setTimeout(heroIn, 260);
    loadStar();
    loadRelease();

    // 首屏里已经可见的揭示元素立刻点亮
    requestAnimationFrame(() => {
      $$(".hero .reveal").forEach((el, i) => setTimeout(() => el.classList.add("in"), 80 + i * 70));
    });

    // 代码块：进入视口再打字
    if ("IntersectionObserver" in window) {
      const cio = new IntersectionObserver(
        (entries) => {
          entries.forEach((en) => {
            if (en.isIntersecting && !codeStarted) {
              codeStarted = true;
              setTimeout(() => typeCode("yaml"), 260);
              cio.disconnect();
            }
          });
        },
        { threshold: 0.28 }
      );
      const cb = $(".code-block");
      if (cb) cio.observe(cb);
    } else {
      typeCode("yaml");
    }

    // 计数
    if ("IntersectionObserver" in window) {
      const sio = new IntersectionObserver(
        (entries) => {
          entries.forEach((en) => {
            if (en.isIntersecting) {
              runCounters();
              sio.disconnect();
            }
          });
        },
        { threshold: 0.3 }
      );
      const sg = $("#statGrid");
      if (sg) sio.observe(sg);
    }

    // 图表进入视口重绘一次
    if ("IntersectionObserver" in window) {
      const chio = new IntersectionObserver(
        (entries) => {
          entries.forEach((en) => {
            if (en.isIntersecting) {
              drawChart(chartKey);
              chio.disconnect();
            }
          });
        },
        { threshold: 0.25 }
      );
      const cc = $("#chartCard");
      if (cc) chio.observe(cc);
    }

    const { route, sub } = parseHash();
    render(route, sub, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
