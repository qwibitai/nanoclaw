#!/usr/bin/env python3
"""
backtest skill — strategy validation against historical data

Usage:
  python3 backtest.py run --tickers AAPL MSFT GOOGL --strategy momentum --years 2
  python3 backtest.py run --tickers AAPL MSFT --strategy buy_hold --years 3 --rebalance monthly
  python3 backtest.py run --tickers AAPL MSFT GOOGL NVDA --strategy mean_reversion --lookback 10
  python3 backtest.py compare --tickers AAPL MSFT GOOGL --years 2
  python3 backtest.py chart --tickers AAPL MSFT GOOGL --strategy momentum --years 2 --out equity.png
"""

import os
import sys
import json
import math
import argparse
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

MARKET_DATA_SCRIPT = Path(__file__).parent.parent / "market-data" / "market_data.py"


# ─── Data fetching ───────────────────────────────────────────────────────────

def fetch_history(ticker: str, days: int) -> list[dict]:
    """Fetch OHLCV history via market-data skill."""
    result = subprocess.run(
        [sys.executable, str(MARKET_DATA_SCRIPT), "history", ticker, "--days", str(days)],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        return []
    try:
        data = json.loads(result.stdout)
        if "error" in data:
            return []
        return data.get("history", [])
    except Exception:
        return []


def fetch_all(tickers: list[str], days: int) -> dict[str, list[dict]]:
    """Fetch history for all tickers. Returns {ticker: [ohlcv, ...]}"""
    out = {}
    for t in tickers:
        history = fetch_history(t, days)
        if history:
            out[t] = history
    return out


# ─── Price series helpers ─────────────────────────────────────────────────────

def to_close_series(history: list[dict]) -> dict[str, float]:
    """Return {date_str: close_price} ordered ascending."""
    series = {}
    for row in history:
        d = row.get("date") or row.get("timestamp", "")[:10]
        c = row.get("close") or row.get("c")
        if d and c is not None:
            series[d] = float(c)
    return dict(sorted(series.items()))


def align_dates(price_map: dict[str, dict[str, float]]) -> tuple[list[str], dict[str, list[float]]]:
    """
    Align all tickers to the same date axis (inner join).
    Returns (dates, {ticker: [prices...]}).
    """
    if not price_map:
        return [], {}
    common = None
    for series in price_map.values():
        s = set(series.keys())
        common = s if common is None else common & s
    dates = sorted(common)
    aligned = {t: [price_map[t][d] for d in dates] for t in price_map}
    return dates, aligned


# ─── Return calculations ──────────────────────────────────────────────────────

def daily_returns(prices: list[float]) -> list[float]:
    """Compute day-over-day returns (length = len(prices) - 1)."""
    if len(prices) < 2:
        return []
    return [(prices[i] / prices[i - 1]) - 1.0 for i in range(1, len(prices))]


def cumulative(returns: list[float]) -> list[float]:
    """Convert daily returns to cumulative (starting at 1.0)."""
    curve = [1.0]
    for r in returns:
        curve.append(curve[-1] * (1.0 + r))
    return curve


# ─── Strategy engines ────────────────────────────────────────────────────────

def _rebalance_interval(rebalance: str, dates: list[str], i: int) -> bool:
    """Return True if we should rebalance at date index i."""
    if rebalance == "daily":
        return True
    d = dates[i]
    if rebalance == "weekly":
        return datetime.strptime(d, "%Y-%m-%d").weekday() == 0  # Monday
    if rebalance == "monthly":
        prev_d = dates[i - 1] if i > 0 else ""
        return d[:7] != prev_d[:7]
    return True


def _top_k_weights(scores: dict[str, float], k: int) -> dict[str, float]:
    """Equal-weight top-k tickers by score (higher = better)."""
    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    top = [t for t, _ in ranked[:k]]
    if not top:
        return {}
    w = 1.0 / len(top)
    return {t: w for t in top}


def strategy_buy_hold(tickers: list[str]) -> "callable":
    """Equal-weight all tickers, never rebalance."""
    w = 1.0 / len(tickers) if tickers else 0.0
    weights = {t: w for t in tickers}
    def get_weights(date: str, prices_so_far: dict[str, list[float]], idx: int) -> dict[str, float]:
        return weights
    return get_weights


def strategy_momentum(lookback: int = 20, k_frac: float = 0.5) -> "callable":
    """
    Long top-k tickers ranked by lookback-day return.
    k = max(1, int(n_tickers * k_frac))
    """
    def get_weights(date: str, prices_so_far: dict[str, list[float]], idx: int) -> dict[str, float]:
        if idx < lookback:
            n = len(prices_so_far)
            w = 1.0 / n if n else 0.0
            return {t: w for t in prices_so_far}
        k = max(1, int(len(prices_so_far) * k_frac))
        scores = {}
        for t, series in prices_so_far.items():
            if len(series) > lookback:
                scores[t] = (series[idx] / series[idx - lookback]) - 1.0
        return _top_k_weights(scores, k)
    return get_weights


def strategy_mean_reversion(lookback: int = 20, k_frac: float = 0.5) -> "callable":
    """
    Long bottom-k tickers ranked by lookback-day return (mean-reversion bet).
    """
    def get_weights(date: str, prices_so_far: dict[str, list[float]], idx: int) -> dict[str, float]:
        if idx < lookback:
            n = len(prices_so_far)
            w = 1.0 / n if n else 0.0
            return {t: w for t in prices_so_far}
        k = max(1, int(len(prices_so_far) * k_frac))
        scores = {}
        for t, series in prices_so_far.items():
            if len(series) > lookback:
                # Negate so bottom performers rank highest
                scores[t] = -((series[idx] / series[idx - lookback]) - 1.0)
        return _top_k_weights(scores, k)
    return get_weights


# ─── Portfolio simulation ─────────────────────────────────────────────────────

def simulate(
    dates: list[str],
    prices: dict[str, list[float]],
    get_weights: "callable",
    rebalance: str = "monthly",
    transaction_cost: float = 0.001,
) -> list[float]:
    """
    Simulate portfolio value over time.
    Returns equity curve (length = len(dates), starting at 1.0).
    """
    if not dates or not prices:
        return []

    tickers = list(prices.keys())
    n = len(dates)

    portfolio_value = 1.0
    current_weights: dict[str, float] = {}
    equity_curve = [1.0]

    for i in range(1, n):
        # Decide weights for today (based on data up to and including yesterday)
        if i == 1 or _rebalance_interval(rebalance, dates, i):
            new_weights = get_weights(dates[i - 1], prices, i - 1)
            # Apply transaction cost proportional to turnover
            if current_weights:
                turnover = sum(
                    abs(new_weights.get(t, 0.0) - current_weights.get(t, 0.0))
                    for t in set(new_weights) | set(current_weights)
                )
                portfolio_value *= 1.0 - transaction_cost * turnover * 0.5
            current_weights = new_weights

        # Compute portfolio return for day i
        port_return = 0.0
        for t, w in current_weights.items():
            if t in prices and len(prices[t]) > i:
                day_ret = (prices[t][i] / prices[t][i - 1]) - 1.0
                port_return += w * day_ret

        portfolio_value *= 1.0 + port_return
        equity_curve.append(portfolio_value)

    return equity_curve


# ─── Metrics ─────────────────────────────────────────────────────────────────

def compute_metrics(equity_curve: list[float], dates: list[str]) -> dict:
    """Compute Sharpe, CAGR, max drawdown, win rate from equity curve."""
    if len(equity_curve) < 2:
        return {"error": "insufficient data"}

    returns = [(equity_curve[i] / equity_curve[i - 1]) - 1.0 for i in range(1, len(equity_curve))]
    n = len(returns)

    # CAGR
    total_return = equity_curve[-1] - 1.0
    years = n / 252.0
    cagr = (equity_curve[-1] ** (1.0 / years) - 1.0) if years > 0 and equity_curve[-1] > 0 else 0.0

    # Sharpe (annualised, rf=0)
    mean_r = sum(returns) / n
    variance = sum((r - mean_r) ** 2 for r in returns) / n
    std_r = math.sqrt(variance) if variance > 0 else 0.0
    sharpe = (mean_r / std_r * math.sqrt(252)) if std_r > 0 else 0.0

    # Max drawdown
    peak = equity_curve[0]
    max_dd = 0.0
    for v in equity_curve:
        if v > peak:
            peak = v
        dd = (peak - v) / peak
        if dd > max_dd:
            max_dd = dd

    # Win rate (% of positive-return days)
    wins = sum(1 for r in returns if r > 0)
    win_rate = wins / n if n > 0 else 0.0

    # Volatility (annualised)
    volatility = std_r * math.sqrt(252)

    return {
        "total_return_pct": round(total_return * 100, 2),
        "cagr_pct": round(cagr * 100, 2),
        "sharpe": round(sharpe, 3),
        "max_drawdown_pct": round(max_dd * 100, 2),
        "win_rate_pct": round(win_rate * 100, 2),
        "volatility_pct": round(volatility * 100, 2),
        "trading_days": n,
        "years": round(years, 2),
        "start_date": dates[0] if dates else "",
        "end_date": dates[-1] if dates else "",
    }


# ─── Commands ────────────────────────────────────────────────────────────────

def cmd_run(args) -> dict:
    tickers = [t.upper() for t in args.tickers]
    if not tickers:
        return {"error": "no tickers provided"}

    days = int(args.years * 365.25) + 30  # extra buffer
    spy_needed = "SPY" not in tickers
    all_tickers = tickers + (["SPY"] if spy_needed else [])

    raw = fetch_all(all_tickers, days)
    if not raw:
        return {"error": "failed to fetch price data"}

    price_map = {t: to_close_series(raw[t]) for t in raw}
    dates, prices = align_dates(price_map)
    if not dates:
        return {"error": "no overlapping dates found"}

    # Build strategy
    strategy = args.strategy
    lookback = args.lookback
    if strategy == "momentum":
        get_weights = strategy_momentum(lookback=lookback)
    elif strategy == "mean_reversion":
        get_weights = strategy_mean_reversion(lookback=lookback)
    else:  # buy_hold
        strat_tickers = [t for t in tickers if t in prices]
        get_weights = strategy_buy_hold(strat_tickers)

    # Run simulation — strategy on selected tickers only
    strat_prices = {t: prices[t] for t in tickers if t in prices}
    equity = simulate(dates, strat_prices, get_weights, rebalance=args.rebalance)

    # SPY benchmark
    spy_prices = prices.get("SPY")
    spy_equity = None
    spy_metrics = None
    if spy_prices:
        spy_get_weights = strategy_buy_hold(["SPY"])
        spy_equity = simulate(dates, {"SPY": spy_prices}, spy_get_weights, rebalance="monthly")
        spy_metrics = compute_metrics(spy_equity, dates)

    metrics = compute_metrics(equity, dates)

    result: dict = {
        "strategy": strategy,
        "tickers": tickers,
        "lookback_days": lookback,
        "rebalance": args.rebalance,
        "metrics": metrics,
        "benchmark": {"spy": spy_metrics} if spy_metrics else None,
        "equity_curve": [
            {"date": d, "value": round(v, 6)}
            for d, v in zip(dates, equity)
        ],
    }
    if spy_equity:
        result["benchmark_curve"] = [
            {"date": d, "value": round(v, 6)}
            for d, v in zip(dates, spy_equity)
        ]

    return result


def cmd_compare(args) -> dict:
    """Compare all three strategies on the same ticker set."""
    tickers = [t.upper() for t in args.tickers]
    days = int(args.years * 365.25) + 30
    spy_needed = "SPY" not in tickers
    all_tickers = tickers + (["SPY"] if spy_needed else [])

    raw = fetch_all(all_tickers, days)
    if not raw:
        return {"error": "failed to fetch price data"}

    price_map = {t: to_close_series(raw[t]) for t in raw}
    dates, prices = align_dates(price_map)
    strat_prices = {t: prices[t] for t in tickers if t in prices}

    strategies = {
        "buy_hold": strategy_buy_hold(list(strat_prices.keys())),
        "momentum": strategy_momentum(lookback=args.lookback),
        "mean_reversion": strategy_mean_reversion(lookback=args.lookback),
    }

    comparison = {}
    for name, get_weights in strategies.items():
        equity = simulate(dates, strat_prices, get_weights, rebalance=args.rebalance)
        comparison[name] = compute_metrics(equity, dates)

    spy_prices = prices.get("SPY")
    if spy_prices:
        spy_equity = simulate(dates, {"SPY": spy_prices}, strategy_buy_hold(["SPY"]), rebalance="monthly")
        comparison["SPY_benchmark"] = compute_metrics(spy_equity, dates)

    return {
        "tickers": tickers,
        "years": args.years,
        "comparison": comparison,
    }


def cmd_chart(args) -> dict:
    """Generate equity curve PNG chart."""
    result = cmd_run(args)
    if "error" in result:
        return result

    out_path = args.out or "equity_curve.png"

    try:
        import subprocess as sp
        sp.run([sys.executable, "-m", "pip", "install", "matplotlib", "--quiet"], capture_output=True)
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(figsize=(12, 6))

        dates_labels = [p["date"] for p in result["equity_curve"]]
        strategy_vals = [p["value"] for p in result["equity_curve"]]
        ax.plot(range(len(strategy_vals)), strategy_vals, label=f"{result['strategy']} ({', '.join(result['tickers'][:3])}{'...' if len(result['tickers']) > 3 else ''})", linewidth=2)

        if result.get("benchmark_curve"):
            spy_vals = [p["value"] for p in result["benchmark_curve"]]
            ax.plot(range(len(spy_vals)), spy_vals, label="SPY benchmark", linewidth=1.5, linestyle="--", color="gray")

        # X-axis: show ~8 date labels
        n = len(dates_labels)
        step = max(1, n // 8)
        ax.set_xticks(range(0, n, step))
        ax.set_xticklabels([dates_labels[i] for i in range(0, n, step)], rotation=45, ha="right")

        ax.axhline(y=1.0, color="black", linewidth=0.5, linestyle=":")
        ax.set_ylabel("Portfolio Value (starting at 1.0)")
        ax.set_title(f"Backtest: {result['strategy']} strategy — {result['metrics']['start_date']} to {result['metrics']['end_date']}")
        ax.legend()
        ax.grid(True, alpha=0.3)

        m = result["metrics"]
        summary = (
            f"CAGR: {m['cagr_pct']:.1f}%  |  Sharpe: {m['sharpe']:.2f}  |  "
            f"MaxDD: {m['max_drawdown_pct']:.1f}%  |  WinRate: {m['win_rate_pct']:.1f}%"
        )
        fig.text(0.5, 0.01, summary, ha="center", fontsize=10, color="dimgray")

        plt.tight_layout(rect=[0, 0.04, 1, 1])
        plt.savefig(out_path, dpi=150, bbox_inches="tight")
        plt.close()

        result["chart_path"] = out_path
        result.pop("equity_curve", None)
        result.pop("benchmark_curve", None)

    except Exception as e:
        result["chart_error"] = str(e)

    return result


# ─── Entry point ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="backtest skill")
    sub = parser.add_subparsers(dest="command")

    # Shared arguments
    def add_common(p):
        p.add_argument("--tickers", nargs="+", required=True)
        p.add_argument("--years", type=float, default=2.0)
        p.add_argument("--strategy", choices=["momentum", "mean_reversion", "buy_hold"], default="momentum")
        p.add_argument("--lookback", type=int, default=20)
        p.add_argument("--rebalance", choices=["daily", "weekly", "monthly"], default="monthly")

    p_run = sub.add_parser("run")
    add_common(p_run)

    p_cmp = sub.add_parser("compare")
    p_cmp.add_argument("--tickers", nargs="+", required=True)
    p_cmp.add_argument("--years", type=float, default=2.0)
    p_cmp.add_argument("--lookback", type=int, default=20)
    p_cmp.add_argument("--rebalance", choices=["daily", "weekly", "monthly"], default="monthly")

    p_chart = sub.add_parser("chart")
    add_common(p_chart)
    p_chart.add_argument("--out", type=str, default="equity_curve.png")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command == "run":
        result = cmd_run(args)
    elif args.command == "compare":
        result = cmd_compare(args)
    elif args.command == "chart":
        result = cmd_chart(args)
    else:
        result = {"error": f"unknown command: {args.command}"}

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
