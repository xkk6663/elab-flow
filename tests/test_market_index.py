"""社区市场自动维护（elab.market）的离线单测。

        python -m unittest tests.test_market_index

覆盖：ref 选择（最高 semver / 无 tag 回退 commit SHA）、准入校验
（禁用文件 / .gitattributes）、同名去重、索引确定性、封禁清单。
全部不联网：GitHub 调用被注入/打桩。
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

from elab import market                                 # noqa: E402

PACK_YAML = """\
schema_version: 1
name: acme/demo
vendor: acme
platform: demo
version: {version}
license: MIT
status: {status}
description: 测试用适配包
requires:
  kernel_api: ">=1 <2"
  schema_version: 1
"""

CHIP_YAML = """\
id: demo1
vendor: acme
platform: demo
part: DEMO1
core:
  cpu: cortex-m4
memory:
  flash: { origin: 0x08000000, length: 0x10000 }
  ram:   { origin: 0x20000000, length: 0x4000 }
"""

SHA = "a" * 40


def make_pack(root: Path, *, version="0.1.0", status="community",
              gitattributes=True, extra: dict[str, str] | None = None) -> Path:
    pack = root / "pack"
    (pack / "chips").mkdir(parents=True, exist_ok=True)
    (pack / "pack.yaml").write_text(
        PACK_YAML.format(version=version, status=status), encoding="utf-8")
    (pack / "chips" / "demo1.yaml").write_text(CHIP_YAML, encoding="utf-8")
    if gitattributes:
        (pack / ".gitattributes").write_text("* -text\n", encoding="utf-8")
    for name, text in (extra or {}).items():
        (pack / name).write_text(text, encoding="utf-8")
    return pack


class MarketTestBase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory(prefix="elab-test-market-")
        self.root = Path(self._td.name)

    def tearDown(self):
        self._td.cleanup()


class TestPickRef(MarketTestBase):
    def test_highest_semver_tag_wins(self):
        repo = {"full_name": "acme/pack", "default_branch": "main"}
        self.assertEqual(
            market.pick_ref(repo, ["v0.1.0", "0.3.0", "nightly", "v1.2.0"]),
            "v1.2.0")

    def test_no_semver_tag_falls_back_to_commit_sha(self):
        repo = {"full_name": "acme/pack", "default_branch": "main"}
        with mock.patch.object(market, "default_branch_sha", return_value=SHA):
            self.assertEqual(market.pick_ref(repo, ["latest"]), SHA)

    def test_non_semver_tags_ignored(self):
        repo = {"full_name": "acme/pack", "default_branch": "main"}
        with mock.patch.object(market, "default_branch_sha", return_value=SHA):
            self.assertEqual(market.pick_ref(repo, ["release", "1.0"]), SHA)


class TestInspect(MarketTestBase):
    def test_accepts_valid_pack(self):
        pack = make_pack(self.root)
        entry, problems = market.inspect_pack_dir(pack, url="u", ref=SHA)
        self.assertEqual(problems, [])
        self.assertEqual(entry["name"], "acme/demo")
        self.assertEqual(entry["sha256"], market.pkg.tree_hash(pack))
        self.assertEqual(entry["chips"], ["acme/demo1"])
        self.assertEqual(entry["source"], {"type": "git", "url": "u", "ref": SHA})

    def test_market_never_grants_official_status(self):
        pack = make_pack(self.root, status="official")
        entry, _ = market.inspect_pack_dir(pack, url="u", ref=SHA)
        self.assertEqual(entry["status"], "community")

    def test_rejects_script_file(self):
        pack = make_pack(self.root, extra={"evil.py": "print(1)\n"})
        entry, problems = market.inspect_pack_dir(pack, url="u", ref=SHA)
        self.assertIsNone(entry)
        self.assertTrue(any("evil.py" in p for p in problems), problems)

    def test_rejects_missing_gitattributes(self):
        pack = make_pack(self.root, gitattributes=False)
        entry, problems = market.inspect_pack_dir(pack, url="u", ref=SHA)
        self.assertIsNone(entry)
        self.assertTrue(any(".gitattributes" in p for p in problems), problems)


class TestDedupe(unittest.TestCase):
    def _entry(self, name, version, url):
        return {"name": name, "version": version,
                "source": {"type": "git", "url": url, "ref": SHA}}

    def test_higher_version_wins(self):
        packs, rejected = market.dedupe([
            self._entry("acme/demo", "0.1.0", "https://a"),
            self._entry("acme/demo", "0.2.0", "https://b"),
        ])
        self.assertEqual([p["version"] for p in packs], ["0.2.0"])
        self.assertEqual(rejected[0]["repo"], "https://a")

    def test_same_version_is_deterministic(self):
        low = self._entry("acme/demo", "0.1.0", "https://a")
        high = self._entry("acme/demo", "0.1.0", "https://z")
        packs, _ = market.dedupe([high, low])
        self.assertEqual(packs[0]["source"]["url"], "https://a")

    def test_payload_sorted_and_stable(self):
        a = self._entry("beta/x", "0.1.0", "https://b")
        b = self._entry("alpha/x", "0.1.0", "https://a")
        one = json.dumps(market.payload([a, b]), sort_keys=True)
        two = json.dumps(market.payload([b, a]), sort_keys=True)
        self.assertEqual(one, two)
        self.assertEqual([p["name"] for p in market.payload([a, b])["packs"]],
                         ["alpha/x", "beta/x"])


class TestBuildRemoteIndex(MarketTestBase):
    def test_report_and_blocklist(self):
        good = make_pack(self.root, version="0.1.0")
        bad_root = self.root / "bad"
        bad_root.mkdir()
        bad = make_pack(bad_root, extra={"tool.exe": "binary"})
        repos = [
            {"full_name": "acme/good", "clone_url": "https://github.com/acme/good.git",
             "default_branch": "main"},
            {"full_name": "acme/bad", "clone_url": "https://github.com/acme/bad.git",
             "default_branch": "main"},
            {"full_name": "acme/blocked", "clone_url": "https://github.com/acme/blocked.git",
             "default_branch": "main"},
        ]
        seen = {}

        def fake_inspect(url, ref):
            key = "good" if "good" in url else ("bad" if "bad" in url else "blocked")
            seen[key] = True
            pack = good if key == "good" else bad
            return market.inspect_pack_dir(pack, url=url, ref=ref)

        block = self.root / "blocklist.json"
        block.write_text(json.dumps({"repos": ["acme/blocked"]}), encoding="utf-8")
        with mock.patch.object(market, "list_tags", return_value=["v0.1.0"]):
            result = market.build_remote_index(
                repos=repos, block=str(block), inspect=fake_inspect)
        report = result["report"]
        self.assertEqual(len(result["index"]["packs"]), 1)
        self.assertEqual(report["accepted"][0]["name"], "acme/demo")
        reasons = "；".join(r["reason"] for r in report["rejected"])
        self.assertIn("tool.exe", reasons)
        self.assertIn("blocklist", reasons)
        self.assertFalse(seen.get("blocked"), "封禁仓库不应被拉取")


if __name__ == "__main__":
    unittest.main()
