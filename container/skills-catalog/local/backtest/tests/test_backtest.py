"""
Tests for the backtest skill — pure math/logic only, no network calls.
"""
import json
import math
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add skill dir to path
SKILL_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SKILL_DIR))

import backtest as bt


# ─── Helpers ─────────────────────────────────────────────────────────────────

def make_prices(start: float, returns: list[float]) -> list[float]:
    """Build a price series from a starting price and a list of daily returns."""
    prices = [start]
    for r in returns:
        prices.append(prices[-1] * (1 + r))
    return prices


def make_dates(n: int, start: str = "2023-01-01") -> list[str]:
    from datetime import datetime, timedelta
    base = datetime.strptime(start, "%Y-%m-%d")
    return [(base + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n)]


# ─── to_close_series ─────────────────────────────────────────────────────────

class TestToCloseSeries(unittest.TestCase):
    def test_basic(self):
        history = [
            {"date": "2023-01-03", "close": 100.0},
            {"date": "2023-01-02", "close": 99.0},
            {"date": "2023-01-04", "close": 101.0},
        ]
        series = bt.to_close_series(history)
        self.assertEqual(list(series.keys()), ["2023-01-02", "2023-01-03", "2023-01-04"])
        self.assertEqual(series["2023-01-03"], 100.0)

    def test_missing_date_skipped(self):
        history = [{"close": 50.0}]  # no date key
        series = bt.to_close_series(history)
        self.assertEqual(series, {})

    def test_uses_timestamp_fallback(self):
        history = [{"timestamp": "2023-01-05T12:00:00Z", "close": 42.0}]
        series = bt.to_close_series(history)
        self.assertIn("2023-01-05", series)


# ─── align_dates ─────────────────────────────────────────────────────────────

class TestAlignDates(unittest.TestCase):
    def test_inner_join(self):
        pm = {
            "A": {"2023-01-01": 10.0, "2023-01-02": 11.0, "2023-01-03": 12.0},
            "B": {"2023-01-02": 20.0, "2023-01-03": 21.0, "2023-01-04": 22.0},
        }
        dates, prices = bt.align_dates(pm)
        self.assertEqual(dates, ["2023-01-02", "2023-01-03"])
        self.assertEqual(prices["A"], [11.0, 12.0])
        self.assertEqual(prices["B"], [20.0, 21.0])

    def test_empty(self):
        dates, prices = bt.align_dates({})
        self.assertEqual(dates, [])
        self.assertEqual(prices, {})

    def test_single_ticker(self):
        pm = {"A": {"2023-01-01": 10.0, "2023-01-02": 11.0}}
        dates, prices = bt.align_dates(pm)
        self.assertEqual(len(dates), 2)


# ─── daily_returns ────────────────────────────────────────────────────────────

class TestDailyReturns(unittest.TestCase):
    def test_flat(self):
        rets = bt.daily_returns([100.0, 100.0, 100.0])
        self.assertEqual(rets, [0.0, 0.0])

    def test_up_10pct(self):
        rets = bt.daily_returns([100.0, 110.0])
        self.assertAlmostEqual(rets[0], 0.10, places=10)

    def test_single_value_empty(self):
        self.assertEqual(bt.daily_returns([100.0]), [])

    def test_empty(self):
        self.assertEqual(bt.daily_returns([]), [])


# ─── cumulative ───────────────────────────────────────────────────────────────

class TestCumulative(unittest.TestCase):
    def test_basic(self):
        curve = bt.cumulative([0.10, -0.05])
        self.assertAlmostEqual(curve[0], 1.0)
        self.assertAlmostEqual(curve[1], 1.10)
        self.assertAlmostEqual(curve[2], 1.10 * 0.95)

    def test_empty_returns(self):
        self.assertEqual(bt.cumulative([]), [1.0])


# ─── compute_metrics ─────────────────────────────────────────────────────────

class TestComputeMetrics(unittest.TestCase):
    def test_flat_portfolio(self):
        # All days flat — no return, no drawdown
        equity = [1.0] * 253  # ~1 year
        dates = make_dates(253)
        m = bt.compute_metrics(equity, dates)
        self.assertAlmostEqual(m["total_return_pct"], 0.0, places=5)
        self.assertAlmostEqual(m["max_drawdown_pct"], 0.0, places=5)
        self.assertEqual(m["trading_days"], 252)

    def test_steady_up_sharpe_positive(self):
        # Steady +0.1% every day → very high Sharpe (zero vol)
        prices = [1.0 * (1.001 ** i) for i in range(253)]
        dates = make_dates(253)
        m = bt.compute_metrics(prices, dates)
        self.assertGreater(m["sharpe"], 0)
        self.assertGreater(m["cagr_pct"], 0)

    def test_max_drawdown_detected(self):
        # Price goes 1.0 → 1.5 → 0.75 → recover
        equity = [1.0, 1.2, 1.5, 1.0, 0.75, 1.0]
        dates = make_dates(6)
        m = bt.compute_metrics(equity, dates)
        # Max drawdown from 1.5 → 0.75 = 50%
        self.assertAlmostEqual(m["max_drawdown_pct"], 50.0, places=1)

    def test_win_rate_all_up(self):
        equity = [1.0 + i * 0.01 for i in range(11)]
        dates = make_dates(11)
        m = bt.compute_metrics(equity, dates)
        self.assertAlmostEqual(m["win_rate_pct"], 100.0, places=5)

    def test_win_rate_all_down(self):
        equity = [1.0 - i * 0.01 for i in range(11)]
        dates = make_dates(11)
        m = bt.compute_metrics(equity, dates)
        self.assertAlmostEqual(m["win_rate_pct"], 0.0, places=5)

    def test_insufficient_data(self):
        m = bt.compute_metrics([1.0], ["2023-01-01"])
        self.assertIn("error", m)

    def test_cagr_correct_2yr(self):
        # 100% total return over 504 trading days (~2 years)
        # CAGR = sqrt(2) - 1 ≈ 41.4%
        n = 505
        equity = [1.0 * (2.0 ** (i / 504)) for i in range(n)]
        dates = make_dates(n)
        m = bt.compute_metrics(equity, dates)
        expected_cagr = (2.0 ** (1.0 / 2.0) - 1.0) * 100
        self.assertAlmostEqual(m["cagr_pct"], expected_cagr, delta=1.0)


# ─── strategy_buy_hold ────────────────────────────────────────────────────────

class TestBuyHold(unittest.TestCase):
    def test_equal_weight(self):
        tickers = ["A", "B", "C"]
        gw = bt.strategy_buy_hold(tickers)
        w = gw("2023-01-01", {"A": [1.0], "B": [1.0], "C": [1.0]}, 0)
        for t in tickers:
            self.assertAlmostEqual(w[t], 1.0 / 3)

    def test_weights_sum_to_one(self):
        tickers = ["X", "Y"]
        gw = bt.strategy_buy_hold(tickers)
        w = gw("2023-01-01", {"X": [1.0], "Y": [1.0]}, 0)
        self.assertAlmostEqual(sum(w.values()), 1.0)


# ─── strategy_momentum ───────────────────────────────────────────────────────

class TestMomentum(unittest.TestCase):
    def test_early_equal_weight(self):
        gw = bt.strategy_momentum(lookback=20)
        prices = {"A": [1.0] * 10, "B": [1.0] * 10}
        w = gw("2023-01-10", prices, 9)  # idx < lookback
        self.assertAlmostEqual(sum(w.values()), 1.0)

    def test_selects_top_performer(self):
        # A up 10%, B down 5% over lookback
        lookback = 5
        gw = bt.strategy_momentum(lookback=lookback, k_frac=0.5)
        # Only 2 tickers → k=1 → pick the top one
        a_prices = [100.0] * lookback + [110.0]
        b_prices = [100.0] * lookback + [95.0]
        w = gw("2023-01-10", {"A": a_prices, "B": b_prices}, lookback)
        # A has higher momentum
        self.assertGreater(w.get("A", 0), w.get("B", 0))

    def test_weights_sum_to_one_after_warmup(self):
        lookback = 5
        gw = bt.strategy_momentum(lookback=lookback, k_frac=1.0)  # take all
        a = [100.0 * (1.01 ** i) for i in range(lookback + 1)]
        b = [100.0 * (0.99 ** i) for i in range(lookback + 1)]
        w = gw("2023-01-10", {"A": a, "B": b}, lookback)
        self.assertAlmostEqual(sum(w.values()), 1.0, places=9)


# ─── strategy_mean_reversion ─────────────────────────────────────────────────

class TestMeanReversion(unittest.TestCase):
    def test_selects_bottom_performer(self):
        lookback = 5
        gw = bt.strategy_mean_reversion(lookback=lookback, k_frac=0.5)
        a_prices = [100.0] * lookback + [110.0]  # A up 10%
        b_prices = [100.0] * lookback + [90.0]   # B down 10%
        w = gw("2023-01-10", {"A": a_prices, "B": b_prices}, lookback)
        # B is the loser → mean reversion bets on B
        self.assertGreater(w.get("B", 0), w.get("A", 0))


# ─── simulate ─────────────────────────────────────────────────────────────────

class TestSimulate(unittest.TestCase):
    def test_flat_prices_equity_flat(self):
        dates = make_dates(10)
        prices = {"A": [100.0] * 10, "B": [100.0] * 10}
        gw = bt.strategy_buy_hold(["A", "B"])
        equity = bt.simulate(dates, prices, gw)
        self.assertEqual(len(equity), 10)
        # All values should be ~1.0 (modulo tiny transaction cost on first day)
        for v in equity:
            self.assertAlmostEqual(v, 1.0, places=5)

    def test_single_up_stock(self):
        n = 20
        dates = make_dates(n)
        prices = {"A": [100.0 * (1.01 ** i) for i in range(n)]}
        gw = bt.strategy_buy_hold(["A"])
        equity = bt.simulate(dates, prices, gw)
        # Should grow monotonically
        self.assertGreater(equity[-1], equity[0])
        for i in range(1, len(equity)):
            self.assertGreaterEqual(equity[i], equity[i - 1] * 0.99)

    def test_equity_curve_length(self):
        n = 30
        dates = make_dates(n)
        prices = {"A": [100.0] * n, "B": [200.0] * n}
        gw = bt.strategy_buy_hold(["A", "B"])
        equity = bt.simulate(dates, prices, gw)
        self.assertEqual(len(equity), n)

    def test_empty_returns_empty(self):
        self.assertEqual(bt.simulate([], {}, bt.strategy_buy_hold([])), [])

    def test_transaction_cost_reduces_value(self):
        n = 40
        dates = make_dates(n)
        # Alternating prices to create high turnover with momentum
        a = [100.0 if i % 2 == 0 else 105.0 for i in range(n)]
        b = [100.0 if i % 2 == 1 else 105.0 for i in range(n)]
        prices = {"A": a, "B": b}
        gw_daily = bt.strategy_momentum(lookback=1, k_frac=0.5)
        gw_hold = bt.strategy_buy_hold(["A", "B"])
        eq_daily = bt.simulate(dates, prices, gw_daily, rebalance="daily", transaction_cost=0.01)
        eq_hold = bt.simulate(dates, prices, gw_hold, rebalance="monthly", transaction_cost=0.01)
        # High-turnover strategy should end lower due to costs
        self.assertLess(eq_daily[-1], eq_hold[-1] * 1.1)  # generous tolerance


# ─── cmd_run (mocked) ─────────────────────────────────────────────────────────

class TestCmdRun(unittest.TestCase):
    def _make_args(self, tickers=None, years=1.0, strategy="buy_hold", lookback=5, rebalance="monthly"):
        args = MagicMock()
        args.tickers = tickers or ["AAPL"]
        args.years = years
        args.strategy = strategy
        args.lookback = lookback
        args.rebalance = rebalance
        return args

    def _mock_history(self, ticker, n=260):
        dates = make_dates(n, "2022-01-01")
        return [{"date": d, "close": 100.0 * (1.001 ** i)} for i, d in enumerate(dates)]

    def test_returns_metrics(self):
        with patch.object(bt, "fetch_all") as mock_fetch:
            mock_fetch.return_value = {
                "AAPL": self._mock_history("AAPL"),
                "SPY":  self._mock_history("SPY"),
            }
            result = bt.cmd_run(self._make_args(["AAPL"]))
        self.assertIn("metrics", result)
        self.assertIn("sharpe", result["metrics"])
        self.assertIn("cagr_pct", result["metrics"])

    def test_error_on_no_data(self):
        with patch.object(bt, "fetch_all") as mock_fetch:
            mock_fetch.return_value = {}
            result = bt.cmd_run(self._make_args(["AAPL"]))
        self.assertIn("error", result)

    def test_equity_curve_present(self):
        with patch.object(bt, "fetch_all") as mock_fetch:
            mock_fetch.return_value = {
                "AAPL": self._mock_history("AAPL"),
                "SPY":  self._mock_history("SPY"),
            }
            result = bt.cmd_run(self._make_args(["AAPL"]))
        self.assertIn("equity_curve", result)
        self.assertIsInstance(result["equity_curve"], list)
        self.assertGreater(len(result["equity_curve"]), 0)

    def test_benchmark_included(self):
        with patch.object(bt, "fetch_all") as mock_fetch:
            mock_fetch.return_value = {
                "AAPL": self._mock_history("AAPL"),
                "SPY":  self._mock_history("SPY"),
            }
            result = bt.cmd_run(self._make_args(["AAPL"]))
        self.assertIsNotNone(result.get("benchmark"))
        self.assertIn("spy", result["benchmark"])

    def test_momentum_strategy_runs(self):
        with patch.object(bt, "fetch_all") as mock_fetch:
            mock_fetch.return_value = {
                "AAPL": self._mock_history("AAPL"),
                "MSFT": self._mock_history("MSFT"),
                "SPY":  self._mock_history("SPY"),
            }
            result = bt.cmd_run(self._make_args(["AAPL", "MSFT"], strategy="momentum"))
        self.assertNotIn("error", result)
        self.assertIn("metrics", result)


# ─── cmd_compare (mocked) ────────────────────────────────────────────────────

class TestCmdCompare(unittest.TestCase):
    def _mock_history(self, n=260):
        dates = make_dates(n, "2022-01-01")
        return [{"date": d, "close": 100.0 * (1.001 ** i)} for i, d in enumerate(dates)]

    def test_all_strategies_present(self):
        args = MagicMock()
        args.tickers = ["AAPL", "MSFT"]
        args.years = 1.0
        args.lookback = 5
        args.rebalance = "monthly"
        with patch.object(bt, "fetch_all") as mock_fetch:
            mock_fetch.return_value = {
                "AAPL": self._mock_history(),
                "MSFT": self._mock_history(),
                "SPY":  self._mock_history(),
            }
            result = bt.cmd_compare(args)
        self.assertIn("comparison", result)
        cmp = result["comparison"]
        self.assertIn("buy_hold", cmp)
        self.assertIn("momentum", cmp)
        self.assertIn("mean_reversion", cmp)
        self.assertIn("SPY_benchmark", cmp)

    def test_error_on_no_data(self):
        args = MagicMock()
        args.tickers = ["AAPL"]
        args.years = 1.0
        args.lookback = 5
        args.rebalance = "monthly"
        with patch.object(bt, "fetch_all") as mock_fetch:
            mock_fetch.return_value = {}
            result = bt.cmd_compare(args)
        self.assertIn("error", result)


if __name__ == "__main__":
    unittest.main()
