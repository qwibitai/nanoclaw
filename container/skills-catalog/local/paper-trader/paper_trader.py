#!/usr/bin/env python3
"""
paper-trader skill — Alpaca paper trading API wrapper

Usage:
  python3 paper_trader.py account
  python3 paper_trader.py positions
  python3 paper_trader.py orders
  python3 paper_trader.py order AAPL buy 10 --type market
  python3 paper_trader.py order AAPL buy 5 --type limit --limit-price 210.00
  python3 paper_trader.py cancel <order_id>
  python3 paper_trader.py cancel-all
  python3 paper_trader.py close AAPL
  python3 paper_trader.py reset
  python3 paper_trader.py order AAPL buy 10 --dry-run
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.parse
from datetime import datetime, timezone


BASE_URL = "https://paper-api.alpaca.markets/v2"

DEFAULT_MAX_POSITION_PCT = float(os.environ.get("PAPER_TRADER_MAX_POSITION_PCT", "5.0"))
DEFAULT_MAX_ORDER_PCT = float(os.environ.get("PAPER_TRADER_MAX_ORDER_PCT", "10.0"))
DRY_RUN_DEFAULT = os.environ.get("PAPER_TRADER_DRY_RUN", "").lower() in ("1", "true", "yes")


def get_headers(required: bool = True) -> dict | None:
    api_key = os.environ.get("ALPACA_API_KEY", "")
    secret_key = os.environ.get("ALPACA_SECRET_KEY", "")
    if not api_key or not secret_key:
        if required:
            print(json.dumps({"error": "ALPACA_API_KEY and ALPACA_SECRET_KEY must be set"}))
            sys.exit(1)
        return None
    return {
        "APCA-API-KEY-ID": api_key,
        "APCA-API-SECRET-KEY": secret_key,
        "Content-Type": "application/json",
    }


def alpaca_request(method: str, path: str, body: dict = None) -> dict:
    headers = get_headers()
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read())
        except Exception:
            err_body = {"message": str(e)}
        return {"error": err_body.get("message", str(e)), "status": e.code}
    except Exception as e:
        return {"error": str(e)}


def cmd_account() -> dict:
    data = alpaca_request("GET", "/account")
    if "error" in data:
        return data
    return {
        "equity": float(data.get("equity", 0)),
        "cash": float(data.get("cash", 0)),
        "buying_power": float(data.get("buying_power", 0)),
        "portfolio_value": float(data.get("portfolio_value", 0)),
        "daytrade_count": data.get("daytrade_count", 0),
        "pattern_day_trader": data.get("pattern_day_trader", False),
        "account_blocked": data.get("account_blocked", False),
        "status": data.get("status"),
    }


def cmd_positions() -> list:
    data = alpaca_request("GET", "/positions")
    if isinstance(data, dict) and "error" in data:
        return data
    return [
        {
            "symbol": p["symbol"],
            "qty": float(p["qty"]),
            "side": p["side"],
            "avg_entry_price": float(p["avg_entry_price"]),
            "current_price": float(p.get("current_price") or 0),
            "market_value": float(p.get("market_value") or 0),
            "unrealized_pl": float(p.get("unrealized_pl") or 0),
            "unrealized_plpc": round(float(p.get("unrealized_plpc") or 0) * 100, 2),
            "change_today": round(float(p.get("change_today") or 0) * 100, 2),
        }
        for p in data
    ]


def cmd_orders(status: str = "open") -> list:
    data = alpaca_request("GET", f"/orders?status={status}&limit=50")
    if isinstance(data, dict) and "error" in data:
        return data
    return [
        {
            "id": o["id"],
            "symbol": o["symbol"],
            "side": o["side"],
            "qty": float(o.get("qty") or 0),
            "type": o["type"],
            "limit_price": float(o["limit_price"]) if o.get("limit_price") else None,
            "status": o["status"],
            "filled_qty": float(o.get("filled_qty") or 0),
            "filled_avg_price": float(o["filled_avg_price"]) if o.get("filled_avg_price") else None,
            "submitted_at": o.get("submitted_at"),
        }
        for o in data
    ]


def cmd_order(
    symbol: str,
    side: str,
    qty: float,
    order_type: str = "market",
    limit_price: float = None,
    dry_run: bool = False,
    max_position_pct: float = DEFAULT_MAX_POSITION_PCT,
    max_order_pct: float = DEFAULT_MAX_ORDER_PCT,
) -> dict:
    symbol = symbol.upper()

    # Safety check: get account equity (skip if no keys in dry-run)
    headers_available = get_headers(required=False) is not None
    if headers_available:
        account = cmd_account()
        if "error" in account:
            return {"error": f"Cannot check account: {account['error']}"}
        equity = account["equity"]
        if equity <= 0:
            return {"error": "Account equity is 0 or unavailable"}
    else:
        equity = None  # no keys — skip safety checks

    # Estimate order value (use limit price or approximate)
    price_estimate = limit_price
    if not price_estimate:
        # Try to get current price from market-data skill or rough estimate
        price_estimate = _get_price_estimate(symbol)

    if price_estimate and equity:
        order_value = qty * price_estimate
        order_pct = (order_value / equity) * 100

        if order_pct > max_order_pct:
            return {
                "error": f"Order size {order_pct:.1f}% of portfolio exceeds max_order_pct={max_order_pct:.1f}%. "
                         f"Reduce qty or increase max_order_pct.",
                "order_value_usd": round(order_value, 2),
                "equity_usd": round(equity, 2),
            }

        # Check position size
        positions = cmd_positions()
        if isinstance(positions, list):
            existing = next((p for p in positions if p["symbol"] == symbol), None)
            if existing:
                new_total_value = existing["market_value"] + order_value
                new_pct = (new_total_value / equity) * 100
                if new_pct > max_position_pct:
                    return {
                        "error": f"Combined position would be {new_pct:.1f}% of portfolio, exceeds max_position_pct={max_position_pct:.1f}%.",
                        "current_position_value": round(existing["market_value"], 2),
                        "new_order_value": round(order_value, 2),
                        "equity_usd": round(equity, 2),
                    }

    body = {
        "symbol": symbol,
        "qty": str(qty),
        "side": side,
        "type": order_type,
        "time_in_force": "day",
    }
    if order_type == "limit" and limit_price:
        body["limit_price"] = str(limit_price)

    if dry_run:
        return {
            "dry_run": True,
            "order": body,
            "estimated_value_usd": round(qty * price_estimate, 2) if price_estimate else None,
            "equity_usd": round(equity, 2) if equity else None,
            "note": "Order NOT submitted — dry-run mode active",
        }

    result = alpaca_request("POST", "/orders", body)
    if "error" in result:
        return result

    return {
        "id": result["id"],
        "symbol": result["symbol"],
        "side": result["side"],
        "qty": float(result.get("qty") or 0),
        "type": result["type"],
        "limit_price": float(result["limit_price"]) if result.get("limit_price") else None,
        "status": result["status"],
        "submitted_at": result.get("submitted_at"),
    }


def cmd_cancel(order_id: str) -> dict:
    result = alpaca_request("DELETE", f"/orders/{order_id}")
    if result is None or (isinstance(result, dict) and not result):
        return {"cancelled": order_id}
    if "error" in result:
        return result
    return {"cancelled": order_id, "status": result.get("status", "cancelled")}


def cmd_cancel_all() -> dict:
    result = alpaca_request("DELETE", "/orders")
    if isinstance(result, dict) and "error" in result:
        return result
    count = len(result) if isinstance(result, list) else 0
    return {"cancelled_count": count, "note": "All open orders cancelled"}


def cmd_close(symbol: str) -> dict:
    symbol = symbol.upper()
    result = alpaca_request("DELETE", f"/positions/{urllib.parse.quote(symbol)}")
    if "error" in result:
        return result
    return {
        "closed": symbol,
        "qty": result.get("qty"),
        "status": result.get("status", "close_submitted"),
    }


def cmd_reset() -> dict:
    cancel = cmd_cancel_all()
    if "error" in cancel:
        return {"error": f"Cancel all failed: {cancel['error']}"}

    positions = cmd_positions()
    if isinstance(positions, dict) and "error" in positions:
        return {"error": f"Get positions failed: {positions['error']}"}

    closed = []
    errors = []
    for pos in (positions or []):
        r = cmd_close(pos["symbol"])
        if "error" in r:
            errors.append({"symbol": pos["symbol"], "error": r["error"]})
        else:
            closed.append(pos["symbol"])

    return {
        "cancelled_orders": cancel.get("cancelled_count", 0),
        "closed_positions": closed,
        "errors": errors,
        "note": "Paper account reset — all positions closed, all orders cancelled",
    }


def _get_price_estimate(symbol: str) -> float | None:
    """Try market-data skill or yfinance for price estimate."""
    market_data_py = os.path.join(os.path.dirname(__file__), "../market-data/market_data.py")
    if os.path.exists(market_data_py):
        try:
            import subprocess
            result = subprocess.run(
                [sys.executable, market_data_py, "quote", symbol],
                capture_output=True, text=True, timeout=10
            )
            data = json.loads(result.stdout)
            return float(data.get("price") or 0) or None
        except Exception:
            pass
    # fallback: yfinance
    try:
        import yfinance as yf
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period="1d")
        if not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception:
        pass
    return None


def main():
    parser = argparse.ArgumentParser(description="Alpaca paper trading skill")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("account", help="Get account info")
    sub.add_parser("positions", help="List open positions")

    p_orders = sub.add_parser("orders", help="List orders")
    p_orders.add_argument("--status", default="open", choices=["open", "closed", "all"])

    p_order = sub.add_parser("order", help="Place an order")
    p_order.add_argument("symbol")
    p_order.add_argument("side", choices=["buy", "sell"])
    p_order.add_argument("qty", type=float)
    p_order.add_argument("--type", dest="order_type", default="market", choices=["market", "limit"])
    p_order.add_argument("--limit-price", type=float)
    p_order.add_argument("--dry-run", action="store_true")
    p_order.add_argument("--max-position-pct", type=float, default=DEFAULT_MAX_POSITION_PCT)
    p_order.add_argument("--max-order-pct", type=float, default=DEFAULT_MAX_ORDER_PCT)

    p_cancel = sub.add_parser("cancel", help="Cancel an order by ID")
    p_cancel.add_argument("order_id")

    sub.add_parser("cancel-all", help="Cancel all open orders")

    p_close = sub.add_parser("close", help="Close a position")
    p_close.add_argument("symbol")

    sub.add_parser("reset", help="Cancel all orders and close all positions")

    args = parser.parse_args()

    if args.command == "account":
        result = cmd_account()
    elif args.command == "positions":
        result = cmd_positions()
    elif args.command == "orders":
        result = cmd_orders(args.status)
    elif args.command == "order":
        dry = args.dry_run or DRY_RUN_DEFAULT
        result = cmd_order(
            args.symbol, args.side, args.qty,
            order_type=args.order_type,
            limit_price=args.limit_price,
            dry_run=dry,
            max_position_pct=args.max_position_pct,
            max_order_pct=args.max_order_pct,
        )
    elif args.command == "cancel":
        result = cmd_cancel(args.order_id)
    elif args.command == "cancel-all":
        result = cmd_cancel_all()
    elif args.command == "close":
        result = cmd_close(args.symbol)
    elif args.command == "reset":
        result = cmd_reset()
    else:
        parser.print_help()
        sys.exit(1)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
