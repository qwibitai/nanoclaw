#!/usr/bin/env python3
"""
market-data skill — unified market data fetcher
Sources: Alpaca (real-time), Finnhub (quotes + fundamentals), yfinance (historical)

Usage:
  python3 market_data.py quote AAPL
  python3 market_data.py history AAPL --days 90
  python3 market_data.py fundamentals AAPL
  python3 market_data.py batch AAPL MSFT GOOGL
"""

import os
import sys
import json
import argparse
import urllib.parse
from datetime import datetime, timezone


def get_quote_finnhub(ticker: str) -> dict:
    import urllib.request
    api_key = os.environ.get("FINNHUB_API_KEY", "")
    if not api_key:
        return {"error": "FINNHUB_API_KEY not set", "ticker": ticker}
    url = f"https://finnhub.io/api/v1/quote?symbol={urllib.parse.quote(ticker)}&token={api_key}"
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
        return {
            "ticker": ticker,
            "price": data.get("c"),
            "open": data.get("o"),
            "high": data.get("h"),
            "low": data.get("l"),
            "prev_close": data.get("pc"),
            "change_pct": round((data["c"] - data["pc"]) / data["pc"] * 100, 2) if data.get("c") and data.get("pc") else None,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "source": "finnhub"
        }
    except Exception as e:
        return {"error": str(e), "ticker": ticker}


def get_quote_alpaca(ticker: str) -> dict:
    import urllib.request
    key = os.environ.get("ALPACA_API_KEY", "")
    secret = os.environ.get("ALPACA_SECRET_KEY", "")
    if not key or not secret:
        return {"error": "ALPACA_API_KEY or ALPACA_SECRET_KEY not set", "ticker": ticker}
    url = f"https://data.alpaca.markets/v2/stocks/{urllib.parse.quote(ticker)}/quotes/latest"
    req = urllib.request.Request(url, headers={
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        q = data.get("quote", {})
        return {
            "ticker": ticker,
            "bid": q.get("bp"),
            "ask": q.get("ap"),
            "bid_size": q.get("bs"),
            "ask_size": q.get("as"),
            "timestamp": q.get("t"),
            "source": "alpaca"
        }
    except Exception as e:
        return {"error": str(e), "ticker": ticker}


def get_history_yfinance(ticker: str, days: int = 90) -> dict:
    try:
        import yfinance as yf
    except ImportError:
        return {"error": "yfinance not installed — run: pip install yfinance", "ticker": ticker}
    try:
        t = yf.Ticker(ticker)
        hist = t.history(period=f"{days}d")
        if hist.empty:
            return {"error": f"No data for {ticker}", "ticker": ticker}
        records = [
            {
                "date": date.strftime("%Y-%m-%d"),
                "open": round(float(row["Open"]), 4),
                "high": round(float(row["High"]), 4),
                "low": round(float(row["Low"]), 4),
                "close": round(float(row["Close"]), 4),
                "volume": int(row["Volume"])
            }
            for date, row in hist.iterrows()
        ]
        info = t.info or {}
        return {
            "ticker": ticker,
            "days": days,
            "records": records,
            "week_52_high": info.get("fiftyTwoWeekHigh"),
            "week_52_low": info.get("fiftyTwoWeekLow"),
            "market_cap": info.get("marketCap"),
            "source": "yfinance"
        }
    except Exception as e:
        return {"error": str(e), "ticker": ticker}


def get_fundamentals_finnhub(ticker: str) -> dict:
    import urllib.request
    api_key = os.environ.get("FINNHUB_API_KEY", "")
    if not api_key:
        return {"error": "FINNHUB_API_KEY not set", "ticker": ticker}
    results = {"ticker": ticker, "source": "finnhub"}
    try:
        url = f"https://finnhub.io/api/v1/stock/profile2?symbol={urllib.parse.quote(ticker)}&token={api_key}"
        with urllib.request.urlopen(url, timeout=10) as r:
            profile = json.loads(r.read())
        results.update({
            "name": profile.get("name"),
            "industry": profile.get("finnhubIndustry"),
            "exchange": profile.get("exchange"),
            "market_cap": profile.get("marketCapitalization"),
            "shares_outstanding": profile.get("shareOutstanding"),
        })
    except Exception as e:
        results["profile_error"] = str(e)
    try:
        url = f"https://finnhub.io/api/v1/stock/metric?symbol={urllib.parse.quote(ticker)}&metric=all&token={api_key}"
        with urllib.request.urlopen(url, timeout=10) as r:
            metrics = json.loads(r.read()).get("metric", {})
        results.update({
            "pe_ttm": metrics.get("peTTM"),
            "eps_ttm": metrics.get("epsTTM"),
            "revenue_growth_ttm": metrics.get("revenueGrowthTTMYoy"),
            "gross_margin_ttm": metrics.get("grossMarginTTM"),
            "net_margin_ttm": metrics.get("netMarginTTM"),
            "debt_equity": metrics.get("totalDebt/totalEquityAnnual"),
            "roe": metrics.get("roeRfy"),
            "week_52_high": metrics.get("52WeekHigh"),
            "week_52_low": metrics.get("52WeekLow"),
        })
    except Exception as e:
        results["metrics_error"] = str(e)
    return results


def get_batch_quotes(tickers: list) -> list:
    results = []
    for ticker in tickers:
        q = get_quote_finnhub(ticker)
        if "error" in q and "FINNHUB_API_KEY" not in q.get("error", ""):
            hist = get_history_yfinance(ticker, days=2)
            if "records" in hist and hist["records"]:
                latest = hist["records"][-1]
                q = {"ticker": ticker, "price": latest["close"], "source": "yfinance_fallback"}
        results.append(q)
    return results


def main():
    parser = argparse.ArgumentParser(description="Market data fetcher")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("quote")
    p.add_argument("ticker")
    p.add_argument("--source", choices=["finnhub", "alpaca"], default="finnhub")

    p = sub.add_parser("history")
    p.add_argument("ticker")
    p.add_argument("--days", type=int, default=90)

    p = sub.add_parser("fundamentals")
    p.add_argument("ticker")

    p = sub.add_parser("batch")
    p.add_argument("tickers", nargs="+")

    args = parser.parse_args()

    if args.command == "quote":
        result = get_quote_alpaca(args.ticker) if args.source == "alpaca" else get_quote_finnhub(args.ticker)
    elif args.command == "history":
        result = get_history_yfinance(args.ticker, args.days)
    elif args.command == "fundamentals":
        result = get_fundamentals_finnhub(args.ticker)
    elif args.command == "batch":
        result = get_batch_quotes(args.tickers)
    else:
        parser.print_help()
        sys.exit(1)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
