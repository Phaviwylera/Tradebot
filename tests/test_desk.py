"""Tests for the Opus Agent Desk.

Run with:  python -m unittest discover -s tests -v

Covers the build-prompt requirements: schema validation, malformed reports, missing timestamps,
stale data, missing sources, risk veto, Boss restrictions, sizing, concentration, determinism,
report persistence, the HTTP API and the absence of order/wallet code.
"""

from __future__ import annotations

import copy
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from dataclasses import replace
from pathlib import Path

from tools.desk import agents, data
from tools.desk.config import ConfigError, ROOT, load_config
from tools.desk.pipeline import (
    PipelineError,
    load_index,
    render_markdown,
    run_pipeline,
    save_run,
    validate_report,
    validate_run,
)
from tools.desk.server import DeskServer, Handler

FIXTURE_SEED = 15  # fixture board shipped in data/fixtures.json


def config_for(source: str = "test", seed: int = FIXTURE_SEED, **overrides):
    base = load_config()
    values = {"source": source, "test_seed": seed, "public_copy": False, **overrides}
    return replace(base, **values)


def approved_run(seed: int = FIXTURE_SEED):
    """A run that reached APPROVE_FOR_PAPER_TEST, used to exercise the veto paths."""
    run = run_pipeline(config_for(seed=seed), persist=False)
    assert run["boss"]["meta"]["decision"] == "APPROVE_FOR_PAPER_TEST", run["boss"]["summary"]
    return run


class ConfigTests(unittest.TestCase):
    def test_shipped_config_parses_identically_without_pyyaml(self):
        from tools.desk import config as config_module
        from tools.desk.yamlish import safe_load

        text = (ROOT / "config.yaml").read_text(encoding="utf-8")
        subset = safe_load(text)
        self.assertEqual(subset["mode"], "paper")
        self.assertIs(subset["allow_live_orders"], False)
        self.assertEqual(subset["scan"]["shortlist_size"], 10)
        self.assertEqual(subset["risk"]["bankroll"], 1000)
        self.assertEqual(subset["dashboard"]["public_copy"], True)
        if config_module._yaml is not None:
            self.assertEqual(config_module._yaml.safe_load(text), subset)

    def test_defaults_are_paper_only(self):
        cfg = load_config()
        self.assertEqual(cfg.mode, "paper")
        self.assertIs(cfg.allow_live_orders, False)
        self.assertIn(cfg.source, ("fixture", "test", "live"))

    def _write(self, text: str) -> str:
        handle = tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False)
        handle.write(text)
        handle.close()
        self.addCleanup(Path(handle.name).unlink)
        return handle.name

    def test_live_mode_is_refused(self):
        path = self._write("mode: live\nallow_live_orders: false\n")
        with self.assertRaises(ConfigError):
            load_config(path)

    def test_live_orders_are_refused(self):
        path = self._write("mode: paper\nallow_live_orders: true\n")
        with self.assertRaises(ConfigError):
            load_config(path)

    def test_bad_source_is_refused(self):
        path = self._write("mode: paper\nallow_live_orders: false\ndata:\n  source: orderbook\n")
        with self.assertRaises(ConfigError):
            load_config(path)

    def test_unknown_override_is_refused(self):
        with self.assertRaises(ConfigError):
            load_config(overrides={"max_leverage": 10})


class DataTests(unittest.TestCase):
    def test_fixture_board_is_large_and_labelled(self):
        cfg = config_for(source="fixture")
        markets, meta = data.load_universe(cfg, data.now_ms())
        self.assertGreaterEqual(len(markets), 400)
        self.assertTrue(meta["synthetic"])
        self.assertIn("TEST DATA", meta["label"])
        for market in markets[:50]:
            self.assertTrue(market["synthetic"])
            self.assertIsNotNone(market["end_date"])
            self.assertGreaterEqual(market["end_ms"], data.now_ms())
            self.assertTrue(market["has_quote"])

    def test_history_ends_at_the_quote(self):
        cfg = config_for()
        markets, _ = data.load_universe(cfg, data.now_ms())
        market = markets[0]
        series = data.synthesize_history(market, data.now_ms())
        self.assertEqual(len(series), 96)
        self.assertAlmostEqual(series[-1]["p"], round(market["price"], 4), places=4)

    def test_normalisation_never_invents_a_quote(self):
        market = data.normalize_market({
            "id": "x", "question": "Will it pass?",
            "outcomes": '["Yes","No"]', "clobTokenIds": '["a","b"]',
            "outcomePrices": '["0.4","0.6"]',
        }, data.now_ms())
        self.assertIsNotNone(market)
        self.assertFalse(market["has_quote"])
        self.assertIsNone(market["best_bid"])
        self.assertIsNone(market["spread"])
        self.assertIsNone(data.normalize_market({"id": "broken"}, data.now_ms()))


class PipelineTests(unittest.TestCase):
    def test_fixture_run_approves_with_valid_reports(self):
        run = run_pipeline(config_for(source="fixture"), persist=False)
        self.assertEqual(run["boss"]["meta"]["decision"], "APPROVE_FOR_PAPER_TEST")
        self.assertIsNone(run["halted_at"])
        self.assertEqual(validate_run(run), [])
        self.assertEqual(len(run["contracts"]), 6)
        self.assertTrue(run["universe"]["synthetic"])
        for name in ("scout", "news", "charts", "strategy", "risk", "boss"):
            report = run["reports"][name]
            self.assertIn(report["status"], agents.REPORT_STATUSES)
            self.assertTrue(report["summary"])
            self.assertEqual(validate_report(report), [])

    def test_unavailable_feed_halts_without_crashing(self):
        from unittest.mock import patch

        def broken(*args, **kwargs):
            raise RuntimeError("request failed for https://gamma-api.polymarket.com/markets")

        with patch.object(__import__("tools.desk.pipeline", fromlist=["data"]).data,
                          "load_universe", side_effect=broken):
            run = run_pipeline(config_for(), persist=False)
        self.assertEqual(run["halted_at"], "scout")
        self.assertEqual(run["universe"]["size"], 0)
        self.assertEqual(run["reports"]["scout"]["status"], "needs_data")
        self.assertIn("gamma-api.polymarket.com", run["reports"]["scout"]["summary"])
        self.assertEqual(run["boss"]["meta"]["decision"], "WAIT")
        self.assertEqual(validate_run(run), [])

    def test_wait_and_reject_are_reachable(self):
        wait_run = run_pipeline(config_for(seed=2), persist=False)
        reject_run = run_pipeline(config_for(seed=13), persist=False)
        self.assertEqual(wait_run["boss"]["meta"]["decision"], "WAIT")
        self.assertEqual(reject_run["boss"]["meta"]["decision"], "REJECT")

    def test_determinism_with_a_fixed_clock(self):
        first = run_pipeline(config_for(seed=3), persist=False, reference_ms=1_760_000_000_000)
        second = run_pipeline(config_for(seed=3), persist=False, reference_ms=1_760_000_000_000)
        self.assertEqual(first["boss"]["meta"]["decision"], second["boss"]["meta"]["decision"])
        self.assertEqual(
            [item["market_id"] for item in first["reports"]["scout"]["evidence"]],
            [item["market_id"] for item in second["reports"]["scout"]["evidence"]],
        )
        self.assertEqual(first["reports"]["scout"]["evidence"][0]["metrics"],
                         second["reports"]["scout"]["evidence"][0]["metrics"])

    def test_reports_are_saved_with_timestamps_and_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = config_for(source="fixture", report_dir=tmp)
            run = run_pipeline(cfg)
            json_path = Path(run["files"]["json"])
            markdown_path = Path(run["files"]["markdown"])
            self.assertTrue(json_path.exists())
            self.assertTrue(markdown_path.exists())
            self.assertTrue((Path(tmp) / "latest.json").exists())
            index = load_index(cfg)
            self.assertEqual(index["runs"][0]["run_id"], run["run_id"])
            self.assertEqual(index["runs"][0]["decision"], run["boss"]["meta"]["decision"])
            saved = json.loads(json_path.read_text())
            self.assertEqual(saved["run_id"], run["run_id"])
            self.assertIn("APPROVE_FOR_PAPER_TEST", markdown_path.read_text())
            self.assertIn("No wallet", markdown_path.read_text())


class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.report = approved_run()["reports"]["scout"]

    def test_malformed_reports_fail(self):
        self.assertTrue(validate_report(None))
        self.assertTrue(validate_report({}))
        self.assertTrue(validate_report({**self.report, "timestamp_utc": None}))
        self.assertTrue(validate_report({**self.report, "status": "finished"}))
        self.assertTrue(validate_report({**self.report, "evidence": "none"}))

    def test_boss_decision_is_restricted(self):
        boss = approved_run()["reports"]["boss"]
        broken = copy.deepcopy(boss)
        broken["meta"]["decision"] = "MAYBE"
        self.assertTrue(validate_report(broken))

    def test_missing_report_blocks_approval(self):
        run = approved_run()
        partial = {key: value for key, value in run["reports"].items() if key in ("scout", "news")}
        boss = agents.run_boss(partial, config_for(), data.now_ms(), source="test")
        self.assertEqual(boss["meta"]["decision"], "REJECT")
        self.assertIn("incomplete", boss["summary"])
        self.assertTrue(any(not check["pass"] and check["name"] == "pipeline_present"
                            for check in boss["meta"]["integrity"]))

    def test_halted_stage_can_only_wait(self):
        run = approved_run()
        boss = agents.run_boss(run["reports"], config_for(), data.now_ms(),
                               halted_at="charts", source="test")
        self.assertEqual(boss["meta"]["decision"], "WAIT")
        self.assertIn("CHARTS", boss["summary"])

    def test_validation_rejects_a_live_order_run(self):
        run = approved_run()
        run["config"]["allow_live_orders"] = True
        self.assertTrue(validate_run(run))


class RiskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_run = approved_run()
        cls.cleared = [item for item in cls.base_run["reports"]["risk"]["evidence"]
                       if item["verdict"] in ("PASSED", "REDUCED")]
        assert cls.cleared, "fixture run must clear at least one plan"

    def _risk(self, cfg, strategy=None, news=None, scout=None, charts=None, context=None):
        reports = self.base_run["reports"]
        return agents.run_risk(
            strategy or reports["strategy"],
            news or reports["news"],
            scout or reports["scout"],
            charts or reports["charts"],
            context or {"bankroll": 1000, "open_positions": []},
            cfg,
            data.now_ms(),
        )

    def test_cleared_plans_respect_every_limit(self):
        cfg = config_for()
        for item in self.cleared:
            plan = item["plan"]
            self.assertGreater(plan["entry"], plan["invalidation"])
            self.assertGreater(plan["target"], plan["entry"])
            self.assertLessEqual(plan["entry"] - plan["invalidation"], cfg.max_stop_distance + 1e-9)
            self.assertGreaterEqual(item["size"]["shares"], 1)
            self.assertLessEqual(item["size"]["notional"],
                                 cfg.bankroll * cfg.max_total_exposure_pct / 100 + 0.01)
            self.assertLessEqual(item["size"]["risk_dollars"],
                                 cfg.bankroll * cfg.max_position_risk_pct / 100 + 0.01)
            self.assertGreaterEqual(item["size"]["net_rr"], cfg.min_net_rr)
            self.assertEqual([check for check in item["checks"] if not check["pass"]], [])

    def test_spread_veto_blocks_the_whole_board(self):
        strict = config_for(max_spread=0.00001)
        risk = self._risk(strict)
        reviewed = [item for item in risk["evidence"] if item["verdict"] != "NOT_REVIEWED"]
        self.assertTrue(reviewed)
        self.assertTrue(all(item["verdict"] == "REJECTED" for item in reviewed))
        self.assertTrue(all("spread" in item["failed_checks"] for item in reviewed))
        boss = agents.run_boss({**self.base_run["reports"], "risk": risk}, strict, data.now_ms(), source="test")
        self.assertEqual(boss["meta"]["decision"], "REJECT")
        self.assertEqual(boss["meta"]["approved"], [])

    def _shift(self, report, hours=6):
        shifted = copy.deepcopy(report)
        stamp = data.parse_ms(shifted["timestamp_utc"]) - hours * 3_600_000
        shifted["timestamp_utc"] = data.iso(stamp)
        return shifted

    def test_stale_data_is_rejected(self):
        reports = self.base_run["reports"]
        risk = self._risk(
            config_for(),
            strategy=self._shift(reports["strategy"]),
            news=self._shift(reports["news"]),
            scout=self._shift(reports["scout"]),
            charts=self._shift(reports["charts"]),
        )
        reviewed = [item for item in risk["evidence"] if item["verdict"] != "NOT_REVIEWED"]
        self.assertTrue(reviewed)
        self.assertTrue(all(item["verdict"] == "REJECTED" for item in reviewed))
        self.assertTrue(all("input_freshness" in item["failed_checks"] for item in reviewed))
        boss = agents.run_boss({**reports, "risk": risk}, config_for(), data.now_ms(), source="test")
        self.assertEqual(boss["meta"]["decision"], "REJECT")

    def test_missing_source_rejects_the_plan(self):
        target = self.cleared[0]
        news = copy.deepcopy(self.base_run["reports"]["news"])
        record = next(item for item in news["evidence"] if item["market_id"] == target["market_id"])
        record.update({"fresh_count": 0, "headline_count": 0, "source_count": 0, "sources": [],
                       "items": [], "flags": ["NO_SOURCES"], "tone": "unknown"})
        risk = self._risk(config_for(), news=news)
        decision = next(item for item in risk["evidence"] if item["market_id"] == target["market_id"])
        self.assertEqual(decision["verdict"], "REJECTED")
        self.assertIn("news_required", decision["failed_checks"])
        self.assertIn("fresh_news", decision["failed_checks"])

    def test_event_concentration_blocks_a_second_plan(self):
        target = self.cleared[0]
        risk = self._risk(config_for(), context={
            "bankroll": 1000,
            "open_positions": [{
                "market_id": "existing",
                "event_id": target["event_id"],
                "category": target["category"],
                "question": "another contract on the same event",
                "notional": 40,
                "risk_dollars": 1,
            }],
        })
        decision = next(item for item in risk["evidence"] if item["market_id"] == target["market_id"])
        self.assertEqual(decision["verdict"], "REJECTED")
        self.assertIn("event_concentration", decision["failed_checks"])

    def test_duplicate_question_is_rejected(self):
        target = self.cleared[0]
        risk = self._risk(config_for(), context={
            "bankroll": 1000,
            "open_positions": [{
                "market_id": "existing",
                "event_id": "some-other-event",
                "category": "other",
                "question": target["question"],
                "notional": 10,
                "risk_dollars": 0.5,
            }],
        })
        decision = next(item for item in risk["evidence"] if item["market_id"] == target["market_id"])
        self.assertEqual(decision["verdict"], "REJECTED")
        self.assertIn("duplicate_question", decision["failed_checks"])


class SafetyTests(unittest.TestCase):
    def test_no_order_wallet_or_signing_code(self):
        files = [ROOT / "main.py", *sorted((ROOT / "tools" / "desk").glob("*.py")),
                 ROOT / "public" / "assets" / "app.js"]
        source = "\n".join(path.read_text(encoding="utf-8") for path in files)
        # The word "wallet" appears only in disclaimers ("no wallet"). Look for actual
        # credential handling, signing or order-submission code instead.
        forbidden = [
            "private_key", "privatekey", "seed_phrase", "mnemonic=", "mnemonic =",
            "sign_transaction", "signtransaction", "place_order", "placeorder",
            "submit_order", "py_clob_client", "import web3", "from web3", "import ethers",
            "from ethers", "eth_account", "walletconnect", "eth_sendtransaction",
        ]
        for token in forbidden:
            self.assertNotIn(token, source.lower(), f"found forbidden token: {token}")

    def test_dashboard_targets_the_read_only_api(self):
        html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "public" / "assets" / "app.js").read_text(encoding="utf-8")
        self.assertIn("/api/latest", script)
        self.assertIn("/api/run", script)
        self.assertIn("/reports/latest.json", script)
        self.assertNotIn("localhost:8765", script)
        self.assertIn("Opus Agent Desk", html)
        for anchor in ("hero-decision", "kpis", "exposure", "pipeline", "categories",
                       "scout-table", "news-feed", "charts-grid", "strategy-list",
                       "risk-list", "journal-list", "terminal-log", "raw-json", "limits"):
            self.assertIn(f'id="{anchor}"', html, f"dashboard anchor missing: {anchor}")

    def test_published_snapshots_are_static_browsable(self):
        directory = ROOT / "public" / "reports"
        index = json.loads((directory / "index.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(index["runs"]), 1)
        decisions = set()
        for entry in index["runs"]:
            self.assertEqual(validate_run(json.loads((directory / f"{entry['run_id']}.json").read_text())), [])
            decisions.add(entry["decision"])
        # The shipped snapshots demonstrate all three reachable Boss statuses.
        self.assertEqual(decisions, {"APPROVE_FOR_PAPER_TEST", "WAIT", "REJECT"})

    def test_contract_files_exist(self):
        for name in ("scout", "news", "charts", "strategy", "risk", "boss"):
            path = ROOT / "agents" / f"{name}.md"
            self.assertTrue(path.exists(), f"missing contract {path}")
            self.assertGreater(len(path.read_text(encoding="utf-8")), 500)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cfg = load_config()
        payload = {
            "mode": "paper",
            "allow_live_orders": False,
            "data": {"source": "test", "test_seed": FIXTURE_SEED},
            "pipeline": {"report_dir": cls.tmp.name},
            "dashboard": {"public_copy": False},
        }
        cls.config_path = Path(cls.tmp.name) / "config.yaml"
        cls.config_path.write_text(
            "mode: paper\nallow_live_orders: false\n"
            "data:\n  source: test\n  test_seed: 15\n"
            f"pipeline:\n  report_dir: {cls.tmp.name}\n"
            "dashboard:\n  public_copy: false\n",
            encoding="utf-8",
        )
        _ = cfg
        cls.server = DeskServer(("127.0.0.1", 0), Handler, config_path=str(cls.config_path))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.tmp.cleanup()

    def _get(self, path):
        with urllib.request.urlopen(f"{self.base}{path}", timeout=30) as response:
            return response.status, json.loads(response.read())

    def _post(self, path, payload):
        body = json.dumps(payload).encode()
        request = urllib.request.Request(
            f"{self.base}{path}", data=body,
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    def test_health_and_config(self):
        status, payload = self._get("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["mode"], "paper")
        self.assertIs(payload["live_orders"], False)
        status, payload = self._get("/api/config")
        self.assertTrue(payload["paper_only"])
        self.assertIn("fixture", payload["sources"])

    def test_run_then_read_reports(self):
        status, payload = self._post("/api/run", {})
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["decision"], "APPROVE_FOR_PAPER_TEST")
        status, latest = self._get("/api/latest")
        self.assertEqual(status, 200)
        self.assertEqual(latest["run"]["run_id"], payload["run_id"])
        status, index = self._get("/api/reports")
        self.assertTrue(any(entry["run_id"] == payload["run_id"] for entry in index["runs"]))
        status, single = self._get(f"/api/reports/{payload['run_id']}")
        self.assertEqual(status, 200)
        self.assertEqual(validate_run(single["run"]), [])

    def test_bad_source_and_unknown_route(self):
        status, payload = self._post("/api/run", {"source": "orderbook"})
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        status, payload = self._post("/api/orders", {"side": "buy"})
        self.assertEqual(status, 405)
        self.assertIn("no order endpoints", payload["error"])

    def test_dashboard_is_served(self):
        with urllib.request.urlopen(f"{self.base}/", timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b"Opus Agent Desk", response.read())


if __name__ == "__main__":
    unittest.main()
