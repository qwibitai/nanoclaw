#!/usr/bin/env python3
"""
technical-analysis skill — RSI, MACD, Bollinger Bands, EMA, ATR
Depends on: yfinance (from market-data skill), pandas, pandas-ta

Usage:
  python3 technical_analysis.py analyze AAPL [--days 200]
  python3 technical_analysis.py rsi AAPL
  python3 technical_analysis.py macd AAPL
  python3 technical_analysis.py bollinger AAPL
  python3 technical_analysis.py ema AAPL
  python3 technical_analysis.py atr AAPL
  python3 technical_analysis.py batch AAPL MSFT NVDA
"""

import sys
import json
import argparse
from datetime import datetime


def fetch_ohlcv(ticker: str, days: int = 200) -> "pd.DataFrame":
    try:
        import yfinance as yf
    except ImportError:
        raise RuntimeError("yfinance not installed — run: pip install yfinance")
    t = yf.Ticker(ticker)
    hist = t.history(period=f"{days}d")
    if hist.empty:
        raise RuntimeError(f"No data for {ticker}")
    return hist


def compute_rsi(close, period: int = 14):
    """RSI using Wilder's smoothing (EMA-based)."""
    import pandas as pd
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, float("nan"))
    rsi = 100 - (100 / (1 + rs))
    return rsi


def compute_macd(close, fast: int = 12, slow: int = 26, signal: int = 9):
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def compute_bollinger(close, period: int = 20, std: float = 2.0):
    middle = close.rolling(window=period).mean()
    rolling_std = close.rolling(window=period).std()
    upper = middle + std * rolling_std
    lower = middle - std * rolling_std
    return upper, middle, lower


def compute_ema(close, span: int):
    return close.ewm(span=span, adjust=False).mean()


def compute_atr(high, low, close, period: int = 14):
    import pandas as pd
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(window=period).mean()


def rsi_signal(value: float) -> tuple:
    if value < 30:
        return "bullish", f"RSI {value:.1f} — oversold, potential bounce"
    elif value > 70:
        return "bearish", f"RSI {value:.1f} — overbought, potential pullback"
    else:
        return "neutral", f"RSI {value:.1f} — neither overbought nor oversold"


def macd_signal(macd_val: float, signal_val: float, histogram: float) -> tuple:
    if macd_val > signal_val and histogram > 0:
        return "bullish", "MACD above signal line, positive histogram"
    elif macd_val < signal_val and histogram < 0:
        return "bearish", "MACD below signal line, negative histogram"
    else:
        return "neutral", "MACD near crossover"


def bollinger_signal(price: float, upper: float, lower: float, middle: float) -> tuple:
    band_width = upper - lower
    if band_width == 0:
        return "neutral", "Bollinger Bands too narrow to interpret"
    pct_b = (price - lower) / band_width  # 0 = lower band, 1 = upper band
    if pct_b < 0.2:
        return "bullish", f"Price near lower Bollinger Band (oversold zone)"
    elif pct_b > 0.8:
        return "bearish", f"Price near upper Bollinger Band (overbought zone)"
    else:
        return "neutral", f"Price within Bollinger Bands (mid zone)"


def ema_signal(price: float, ema20: float, ema50: float, ema200: float) -> tuple:
    if price > ema200 and ema20 > ema50:
        if price > ema20:
            return "bullish", "Price above EMA200, EMA20 > EMA50, trending up"
        else:
            return "bullish", "Price above EMA200, EMA20 > EMA50 — uptrend intact"
    elif price < ema200 and ema20 < ema50:
        return "bearish", "Price below EMA200, EMA20 < EMA50 — downtrend"
    else:
        return "neutral", "Mixed EMA signals"


def analyze_ticker(ticker: str, days: int = 200) -> dict:
    try:
        df = fetch_ohlcv(ticker, days)
    except RuntimeError as e:
        return {"ticker": ticker, "error": str(e)}

    close = df["Close"]
    high = df["High"]
    low = df["Low"]

    price = float(close.iloc[-1])
    as_of = df.index[-1].strftime("%Y-%m-%d")

    # RSI
    rsi_series = compute_rsi(close)
    rsi_val = float(rsi_series.iloc[-1])
    rsi_sig, rsi_note = rsi_signal(rsi_val)

    # MACD
    macd_line, signal_line, histogram = compute_macd(close)
    macd_val = float(macd_line.iloc[-1])
    sig_val = float(signal_line.iloc[-1])
    hist_val = float(histogram.iloc[-1])
    macd_sig, macd_note = macd_signal(macd_val, sig_val, hist_val)

    # Bollinger Bands
    bb_upper, bb_middle, bb_lower = compute_bollinger(close)
    bb_u = float(bb_upper.iloc[-1])
    bb_m = float(bb_middle.iloc[-1])
    bb_l = float(bb_lower.iloc[-1])
    bb_sig, bb_note = bollinger_signal(price, bb_u, bb_l, bb_m)

    # EMA
    ema20 = float(compute_ema(close, 20).iloc[-1])
    ema50 = float(compute_ema(close, 50).iloc[-1])
    ema200_series = compute_ema(close, 200)
    ema200 = float(ema200_series.iloc[-1]) if len(close) >= 200 else None
    if ema200 is not None:
        ema_sig, ema_note = ema_signal(price, ema20, ema50, ema200)
    else:
        ema_sig, ema_note = "neutral", "Not enough data for EMA200 (need 200 days)"

    # ATR
    atr_series = compute_atr(high, low, close)
    atr_val = float(atr_series.iloc[-1])
    atr_pct = round(atr_val / price * 100, 2)

    signals = {
        "rsi": {"value": round(rsi_val, 2), "signal": rsi_sig, "note": rsi_note},
        "macd": {
            "value": round(macd_val, 4),
            "signal_line": round(sig_val, 4),
            "histogram": round(hist_val, 4),
            "signal": macd_sig,
            "note": macd_note
        },
        "bollinger": {
            "upper": round(bb_u, 2),
            "middle": round(bb_m, 2),
            "lower": round(bb_l, 2),
            "signal": bb_sig,
            "note": bb_note
        },
        "ema": {
            "ema20": round(ema20, 2),
            "ema50": round(ema50, 2),
            "ema200": round(ema200, 2) if ema200 is not None else None,
            "signal": ema_sig,
            "note": ema_note
        },
        "atr": {
            "value": round(atr_val, 2),
            "pct_of_price": atr_pct,
            "signal": "neutral",
            "note": f"ATR {atr_val:.2f} (~{atr_pct}% of price) — use for position sizing"
        }
    }

    counts = {"bullish": 0, "bearish": 0, "neutral": 0}
    for ind in ["rsi", "macd", "bollinger", "ema"]:  # ATR excluded from overall
        counts[signals[ind]["signal"]] += 1

    if counts["bullish"] > counts["bearish"]:
        overall = "bullish"
    elif counts["bearish"] > counts["bullish"]:
        overall = "bearish"
    else:
        overall = "neutral"

    return {
        "ticker": ticker,
        "price": round(price, 2),
        "as_of": as_of,
        "signals": signals,
        "overall": overall,
        "bullish_count": counts["bullish"],
        "bearish_count": counts["bearish"],
        "neutral_count": counts["neutral"]
    }


def main():
    parser = argparse.ArgumentParser(description="Technical analysis — RSI, MACD, Bollinger, EMA, ATR")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("analyze", help="Full analysis — all indicators + overall signal")
    p.add_argument("ticker")
    p.add_argument("--days", type=int, default=200)

    p = sub.add_parser("rsi", help="RSI only")
    p.add_argument("ticker")
    p.add_argument("--days", type=int, default=100)

    p = sub.add_parser("macd", help="MACD only")
    p.add_argument("ticker")
    p.add_argument("--days", type=int, default=100)

    p = sub.add_parser("bollinger", help="Bollinger Bands only")
    p.add_argument("ticker")
    p.add_argument("--days", type=int, default=60)

    p = sub.add_parser("ema", help="EMA (20/50/200) only")
    p.add_argument("ticker")
    p.add_argument("--days", type=int, default=200)

    p = sub.add_parser("atr", help="ATR (volatility) only")
    p.add_argument("ticker")
    p.add_argument("--days", type=int, default=30)

    p = sub.add_parser("batch", help="Full analysis for multiple tickers")
    p.add_argument("tickers", nargs="+")
    p.add_argument("--days", type=int, default=200)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command in ("analyze", "rsi", "macd", "bollinger", "ema", "atr"):
        result = analyze_ticker(args.ticker, args.days)
        if args.command != "analyze" and "signals" in result:
            # Return just the requested indicator
            result = {
                "ticker": result["ticker"],
                "price": result["price"],
                "as_of": result["as_of"],
                args.command: result["signals"][args.command]
            }
    elif args.command == "batch":
        result = [analyze_ticker(t, args.days) for t in args.tickers]

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
