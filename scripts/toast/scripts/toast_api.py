#!/usr/bin/env python3
"""Toast POS API client for Proper Hospitality F&B data.

Uses the Enterprise Analytics (ERA) API with enterprise-metrics:read scope.
Credentials are management group level — all properties returned automatically.

Usage:
    python3 toast_api.py --endpoint sales-summary --start-date 20260201 --end-date 20260228
    python3 toast_api.py --endpoint sales-summary --start-date 20260201 --end-date 20260228 --group-by REVENUE_CENTER
    python3 toast_api.py --endpoint sales-summary --start-date 20260201 --end-date 20260228 --property "Austin Proper Hotel"
    python3 toast_api.py --endpoint sales-daily --start-date 20260301 --end-date 20260301
    python3 toast_api.py --endpoint check-discounts --start-date 20260301 --end-date 20260301
    python3 toast_api.py --endpoint check-discounts --start-date 20260301 --end-date 20260301 --property "Austin" --min-discount 50
    python3 toast_api.py --endpoint guest-emails --start-date 20260301 --end-date 20260326
    python3 toast_api.py --endpoint guest-emails --start-date 20260301 --end-date 20260326 --property "Austin"
    python3 toast_api.py --endpoint list-properties

Environment variables (set in ~/.claude/settings.json):
    TOAST_BASE_URL       - API base URL (default: https://ws-api.toasttab.com)
    TOAST_CLIENT_ID      - OAuth2 client ID
    TOAST_CLIENT_SECRET  - OAuth2 client secret
"""
import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime
from urllib.request import Request, urlopen
from urllib.error import HTTPError

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MAPPING_PATH = os.path.join(SCRIPT_DIR, "..", "references", "restaurant_mapping.json")

BASE_URL = os.environ.get("TOAST_BASE_URL", "https://ws-api.toasttab.com")
CLIENT_ID = os.environ.get("TOAST_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("TOAST_CLIENT_SECRET", "")

TOKEN_CACHE = {}


def load_mapping():
    """Load restaurant GUID to property/outlet mapping."""
    with open(MAPPING_PATH) as f:
        return json.load(f)


def build_guid_lookup(mapping):
    """Build a flat lookup: restaurantGuid -> (property, outlet_name)."""
    lookup = {}
    for prop_name, prop_data in mapping.get("properties", {}).items():
        for guid, outlet_name in prop_data.get("restaurants", {}).items():
            lookup[guid] = {
                "property": prop_name,
                "outlet": outlet_name,
                "profitsword_site_tag": prop_data.get("profitsword_site_tag"),
            }
    return lookup


def get_token():
    """Authenticate and get bearer token."""
    if TOKEN_CACHE.get("token") and TOKEN_CACHE.get("expires_at", 0) > datetime.now().timestamp():
        return TOKEN_CACHE["token"]

    url = f"{BASE_URL}/authentication/v1/authentication/login"
    payload = json.dumps({
        "clientId": CLIENT_ID,
        "clientSecret": CLIENT_SECRET,
        "userAccessType": "TOAST_MACHINE_CLIENT"
    }).encode()

    req = Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")

    print("Authenticating with Toast...", file=sys.stderr)
    try:
        with urlopen(req) as resp:
            data = json.loads(resp.read().decode())
    except HTTPError as e:
        body = e.read().decode() if e.fp else ""
        print(f"Auth failed: {e.code} {e.reason}\n{body}", file=sys.stderr)
        sys.exit(1)

    token = data["token"]["accessToken"]
    expires_in = data["token"].get("expiresIn", 3600)
    TOKEN_CACHE["token"] = token
    TOKEN_CACHE["expires_at"] = datetime.now().timestamp() + expires_in - 60
    print("Token acquired.", file=sys.stderr)
    return token


class ERAUnavailableError(Exception):
    """Raised when ERA API returns 403 (scope not provisioned)."""
    pass


def era_request(start_date, end_date, group_by=None, restaurant_ids=None, time_range=None):
    """Submit ERA analytics request and retrieve results.

    Raises ERAUnavailableError on 403 so callers can fall back to Orders API.
    """
    token = get_token()

    body = {
        "startBusinessDate": start_date,
        "endBusinessDate": end_date,
        "restaurantIds": restaurant_ids or [],
        "excludedRestaurantIds": [],
        "groupBy": group_by or [],
    }

    path = f"/era/v1/metrics/{time_range}" if time_range else "/era/v1/metrics"
    url = f"{BASE_URL}{path}"

    req = Request(url, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.data = json.dumps(body).encode()

    print(f"Requesting: POST {path}", file=sys.stderr)
    print(f"  Date range: {start_date} to {end_date}", file=sys.stderr)
    if group_by:
        print(f"  Group by: {group_by}", file=sys.stderr)

    try:
        with urlopen(req) as resp:
            report_guid = resp.read().decode().strip().strip('"')
    except HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        if e.code == 403:
            print(f"ERA unavailable (403) — falling back to Orders API.", file=sys.stderr)
            raise ERAUnavailableError(body_text)
        print(f"ERA request failed: {e.code}\n{body_text}", file=sys.stderr)
        sys.exit(1)

    print(f"  Report GUID: {report_guid}", file=sys.stderr)

    # Retrieve results (may need brief wait)
    time.sleep(1)
    fetch_url = f"{BASE_URL}/era/v1/metrics/{report_guid}"
    req2 = Request(fetch_url, method="GET")
    req2.add_header("Authorization", f"Bearer {token}")

    try:
        with urlopen(req2) as resp:
            results = json.loads(resp.read().decode())
    except HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        print(f"ERA retrieve failed: {e.code}\n{body_text}", file=sys.stderr)
        sys.exit(1)

    print(f"  Records returned: {len(results)}", file=sys.stderr)
    return results


def era_check_request(start_date, end_date, restaurant_ids=None):
    """Submit ERA check reporting request and retrieve results."""
    token = get_token()

    body = {
        "startBusinessDate": start_date,
        "endBusinessDate": end_date,
        "restaurantIds": restaurant_ids or [],
        "excludedRestaurantIds": [],
    }

    path = "/era/v1/check/day"
    url = f"{BASE_URL}{path}"

    req = Request(url, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.data = json.dumps(body).encode()

    print(f"Requesting: POST {path}", file=sys.stderr)
    print(f"  Date range: {start_date} to {end_date}", file=sys.stderr)

    try:
        with urlopen(req) as resp:
            report_guid = resp.read().decode().strip().strip('"')
    except HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        print(f"ERA check request failed: {e.code}\n{body_text}", file=sys.stderr)
        sys.exit(1)

    print(f"  Report GUID: {report_guid}", file=sys.stderr)

    # Poll for results — check endpoint may take longer
    for attempt in range(5):
        time.sleep(2)
        fetch_url = f"{BASE_URL}/era/v1/check/{report_guid}?fetchRestaurantNames=true"
        req2 = Request(fetch_url, method="GET")
        req2.add_header("Authorization", f"Bearer {token}")

        try:
            with urlopen(req2) as resp:
                if resp.status == 200:
                    results = json.loads(resp.read().decode())
                    print(f"  Records returned: {len(results)}", file=sys.stderr)
                    return results
        except HTTPError as e:
            if e.code == 202:
                print(f"  Report still processing (attempt {attempt + 1}/5)...", file=sys.stderr)
                continue
            body_text = e.read().decode() if e.fp else ""
            print(f"ERA check retrieve failed: {e.code}\n{body_text}", file=sys.stderr)
            sys.exit(1)

    print("ERROR: Report timed out after 5 attempts.", file=sys.stderr)
    sys.exit(1)


def orders_request(restaurant_guid, start_date, end_date):
    """Fetch all orders for a restaurant via the Orders API with pagination.

    start_date / end_date: YYYYMMDD strings — converted to ISO8601 internally.
    Returns list of order dicts. Respects rate limit headers (5 req/min).
    """
    token = get_token()

    # Convert YYYYMMDD to ISO8601
    sd = datetime.strptime(start_date, "%Y%m%d").strftime("%Y-%m-%dT00:00:00.000+0000")
    ed = datetime.strptime(end_date, "%Y%m%d").strftime("%Y-%m-%dT23:59:59.000+0000")
    sd_enc = sd.replace("+", "%2B")
    ed_enc = ed.replace("+", "%2B")

    all_orders = []
    url = f"{BASE_URL}/orders/v2/ordersBulk?startDate={sd_enc}&endDate={ed_enc}&pageSize=100"

    while url:
        req = Request(url, method="GET")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Toast-Restaurant-External-ID", restaurant_guid)

        try:
            with urlopen(req) as resp:
                # Respect rate limit
                remaining = int(resp.headers.get("x-toast-ratelimit-remaining", 10))
                reset_ts = int(resp.headers.get("x-toast-ratelimit-reset", 0))
                orders = json.loads(resp.read().decode())
                all_orders.extend(orders)

                # Check for next page in Link header
                link_header = resp.headers.get("link", "")
                next_url = None
                for part in link_header.split(","):
                    part = part.strip()
                    if 'rel="next"' in part:
                        next_url = part.split(";")[0].strip().strip("<>")
                        break
                url = next_url

                # Throttle if rate limit is low
                if remaining <= 1:
                    wait = max(0, reset_ts - int(time.time())) + 1
                    print(f"    Rate limit reached, waiting {wait}s...", file=sys.stderr)
                    time.sleep(wait)
                else:
                    time.sleep(0.15)  # polite delay between pages

        except HTTPError as e:
            if e.code == 429:
                reset_ts = int(e.headers.get("x-toast-ratelimit-reset", time.time() + 60))
                wait = max(1, reset_ts - int(time.time())) + 1
                print(f"    429 rate limited, waiting {wait}s...", file=sys.stderr)
                time.sleep(wait)
                # retry same url
            else:
                body = e.read().decode() if e.fp else ""
                print(f"    Orders API error {e.code}: {body[:200]}", file=sys.stderr)
                url = None

    return all_orders


def labor_request(restaurant_guid, start_date, end_date):
    """Fetch labor time entries for a restaurant via the Labor API.

    start_date / end_date: YYYYMMDD strings.
    Returns total regular + overtime hours.
    """
    token = get_token()

    sd = datetime.strptime(start_date, "%Y%m%d").strftime("%Y-%m-%dT00:00:00.000+0000")
    ed = datetime.strptime(end_date, "%Y%m%d").strftime("%Y-%m-%dT23:59:59.000+0000")
    sd_enc = sd.replace("+", "%2B")
    ed_enc = ed.replace("+", "%2B")

    url = f"{BASE_URL}/labor/v1/timeEntries?startDate={sd_enc}&endDate={ed_enc}"
    req = Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Toast-Restaurant-External-ID", restaurant_guid)

    try:
        with urlopen(req) as resp:
            entries = json.loads(resp.read().decode())
    except HTTPError as e:
        if e.code in (403, 404):
            return 0.0
        body = e.read().decode() if e.fp else ""
        print(f"    Labor API error {e.code}: {body[:200]}", file=sys.stderr)
        return 0.0

    total_hours = 0.0
    for entry in entries:
        total_hours += (entry.get("regularHours") or 0)
        total_hours += (entry.get("overtimeHours") or 0)
    return total_hours


def orders_sales_aggregate(mapping, lookup, start_date, end_date, property_filter=None):
    """Aggregate sales data from Orders API — fallback when ERA is unavailable.

    Returns list of dicts matching the same schema as ERA-based sales summary.
    """
    targets = []
    for prop_name, prop_data in mapping["properties"].items():
        if property_filter and property_filter.lower() not in prop_name.lower():
            continue
        for guid, outlet_name in prop_data.get("restaurants", {}).items():
            targets.append((guid, prop_name, outlet_name))

    if not targets:
        print(f"No matching properties for '{property_filter}'.", file=sys.stderr)
        return []

    print(f"Orders API fallback: querying {len(targets)} outlets ({start_date} to {end_date})...", file=sys.stderr)

    property_totals = {}
    for i, (guid, prop_name, outlet_name) in enumerate(targets):
        print(f"  [{i+1}/{len(targets)}] {prop_name} — {outlet_name}", file=sys.stderr)

        # Pull orders
        orders = orders_request(guid, start_date, end_date)
        print(f"    {len(orders)} orders", file=sys.stderr)

        # Pull labor hours
        labor_hours = labor_request(guid, start_date, end_date)

        # Aggregate from orders
        net_sales = 0.0
        gross_sales = 0.0
        discounts = 0.0
        voids = 0.0
        checks = 0
        guests = 0

        for order in orders:
            guests += order.get("numberOfGuests") or 0

            if order.get("voided"):
                for chk in order.get("checks", []):
                    voids += chk.get("totalAmount") or 0
                continue

            for chk in order.get("checks", []):
                if chk.get("voided"):
                    voids += chk.get("totalAmount") or 0
                    continue

                checks += 1
                check_amount = chk.get("amount") or 0  # pre-tax subtotal (after discounts)
                tax = chk.get("taxAmount") or 0
                total = chk.get("totalAmount") or 0     # includes tax

                # Net sales = total - tax (what ERA calls netSalesAmount)
                net_sales += total - tax

                # Gross = net + discounts (pre-discount revenue)
                applied = chk.get("appliedDiscounts") or []
                check_discounts = sum(d.get("discountAmount") or 0 for d in applied)
                discounts += check_discounts
                gross_sales += (total - tax) + check_discounts

        key = (prop_name, outlet_name)
        property_totals[key] = {
            "property": prop_name,
            "outlet": outlet_name,
            "netSales": round(net_sales, 2),
            "grossSales": round(gross_sales, 2),
            "discounts": round(discounts, 2),
            "voids": round(voids, 2),
            "refunds": 0,  # not available at order level without itemization
            "checks": checks,
            "guests": guests,
            "laborHours": round(labor_hours, 2),
        }

    rows = sorted(property_totals.values(), key=lambda x: (x["property"], -x["netSales"]))
    for r in rows:
        r["avgCheck"] = round(r["netSales"] / r["checks"], 2) if r["checks"] else 0

    return rows


def cmd_guest_emails(args):
    """Pull checks with guest emails and applied discount detail via Orders API."""
    mapping = load_mapping()
    lookup = build_guid_lookup(mapping)

    # Build list of (guid, property, outlet) to query
    targets = []
    for prop_name, prop_data in mapping["properties"].items():
        if args.property and args.property.lower() not in prop_name.lower():
            continue
        for guid, outlet_name in prop_data.get("restaurants", {}).items():
            targets.append((guid, prop_name, outlet_name))

    if not targets:
        print(f"Property '{args.property}' not found.", file=sys.stderr)
        sys.exit(1)

    print(f"Querying {len(targets)} outlets ({args.start_date} to {args.end_date})...", file=sys.stderr)

    rows = []
    for i, (guid, prop_name, outlet_name) in enumerate(targets):
        print(f"  [{i+1}/{len(targets)}] {prop_name} — {outlet_name}", file=sys.stderr)
        orders = orders_request(guid, args.start_date, args.end_date)

        for order in orders:
            biz_date = str(order.get("businessDate", ""))
            order_guid = order.get("guid", "")
            for check in order.get("checks", []):
                cust = check.get("customer") or {}
                email = cust.get("email", "")
                if not email:
                    continue

                # Applied discounts detail
                discounts = check.get("appliedDiscounts") or []
                discount_names = "; ".join(
                    d.get("discount", {}).get("name", "Unknown") for d in discounts
                ) if discounts else ""
                discount_total = sum(
                    d.get("discountAmount", 0) or 0 for d in discounts
                )

                rows.append({
                    "property": prop_name,
                    "outlet": outlet_name,
                    "businessDate": biz_date,
                    "email": email,
                    "firstName": cust.get("firstName", ""),
                    "lastName": cust.get("lastName", ""),
                    "phone": cust.get("phone", ""),
                    "checkTotal": round(check.get("totalAmount") or 0, 2),
                    "discountTotal": round(discount_total, 2),
                    "discountNames": discount_names,
                    "discountCount": len(discounts),
                    "paymentStatus": check.get("paymentStatus", ""),
                    "orderGuid": order_guid,
                    "checkGuid": check.get("guid", ""),
                })

    rows.sort(key=lambda x: (x["property"], x["outlet"], x["businessDate"]))

    outpath = args.output or "/tmp/toast_guest_emails.csv"
    write_csv(rows, outpath)

    # Summary
    by_outlet = {}
    unique_emails = set()
    for r in rows:
        key = (r["property"], r["outlet"])
        by_outlet[key] = by_outlet.get(key, 0) + 1
        unique_emails.add(r["email"].lower())

    print(f"\nChecks with guest email:", file=sys.stderr)
    print(f"  {'Property':<28} {'Outlet':<30} {'Checks':>8}", file=sys.stderr)
    print(f"  {'-'*70}", file=sys.stderr)
    for (prop, outlet), count in sorted(by_outlet.items()):
        print(f"  {prop:<28} {outlet:<30} {count:>8,d}", file=sys.stderr)
    print(f"\n  Total checks with email: {len(rows):,}", file=sys.stderr)
    print(f"  Unique email addresses:  {len(unique_emails):,}", file=sys.stderr)

    return rows


def cmd_list_properties(args):
    """List all properties and their Toast restaurant GUIDs."""
    mapping = load_mapping()
    lookup = build_guid_lookup(mapping)

    print(f"\n{'Property':<30s} {'Outlet':<35s} {'GUID':<40s} {'PS SiteTag'}")
    print("-" * 140)
    for prop_name, prop_data in sorted(mapping["properties"].items()):
        for guid, outlet_name in sorted(prop_data.get("restaurants", {}).items(), key=lambda x: x[1]):
            ps_tag = prop_data.get("profitsword_site_tag", "")
            print(f"  {prop_name:<28s} {outlet_name:<35s} {guid:<40s} {ps_tag}")


def cmd_sales_summary(args):
    """Pull aggregated sales by property and outlet for a date range.

    Tries ERA API first. Falls back to Orders API on 403 (ERA scope not provisioned).
    """
    mapping = load_mapping()
    lookup = build_guid_lookup(mapping)

    group_by = ["REVENUE_CENTER"] if args.group_by == "REVENUE_CENTER" else []
    use_orders_api = False

    # Filter to specific property if requested
    restaurant_ids = None
    matched_prop = None
    if args.property:
        for prop_name, prop_data in mapping["properties"].items():
            if args.property.lower() in prop_name.lower():
                restaurant_ids = list(prop_data.get("restaurants", {}).keys())
                matched_prop = prop_name
                print(f"Filtering to {prop_name}: {len(restaurant_ids)} restaurants", file=sys.stderr)
                break
        if not restaurant_ids:
            print(f"Property '{args.property}' not found in mapping.", file=sys.stderr)
            sys.exit(1)

    # Try ERA first, fall back to Orders API on 403
    try:
        results = era_request(args.start_date, args.end_date, group_by=group_by,
                              restaurant_ids=restaurant_ids)
    except ERAUnavailableError:
        use_orders_api = True

    if use_orders_api:
        if group_by:
            print("NOTE: REVENUE_CENTER grouping not available via Orders API fallback.", file=sys.stderr)
        rows = orders_sales_aggregate(mapping, lookup, args.start_date, args.end_date,
                                      property_filter=args.property)
        print("\n[Data source: Orders API (ERA unavailable)]", file=sys.stderr)
    else:
        # Aggregate ERA results by property and outlet
        property_totals = {}
        for r in results:
            guid = r.get("restaurantGuid", "")
            info = lookup.get(guid, {"property": f"Unknown ({guid[:8]}...)", "outlet": "Unknown"})
            prop = info["property"]
            outlet = info["outlet"]
            rc = r.get("revenueCenter", "")

            display_name = f"{outlet} - {rc}" if rc and group_by else outlet

            key = (prop, display_name)
            if key not in property_totals:
                property_totals[key] = {
                    "property": prop,
                    "outlet": display_name,
                    "netSales": 0,
                    "grossSales": 0,
                    "discounts": 0,
                    "voids": 0,
                    "refunds": 0,
                    "checks": 0,
                    "guests": 0,
                    "laborHours": 0,
                }

            t = property_totals[key]
            t["netSales"] += r.get("netSalesAmount") or 0
            t["grossSales"] += r.get("grossSalesAmount") or 0
            t["discounts"] += r.get("discountAmount") or 0
            t["voids"] += r.get("voidOrdersAmount") or 0
            t["refunds"] += r.get("refundAmount") or 0
            t["checks"] += r.get("ordersCount") or 0
            t["guests"] += r.get("guestCount") or 0
            t["laborHours"] += r.get("hourlyJobTotalHours") or 0

        rows = sorted(property_totals.values(), key=lambda x: (x["property"], -x["netSales"]))
        for r in rows:
            for k in ["netSales", "grossSales", "discounts", "voids", "refunds", "laborHours"]:
                r[k] = round(r[k], 2)
            r["avgCheck"] = round(r["netSales"] / r["checks"], 2) if r["checks"] else 0

        print("\n[Data source: ERA API]", file=sys.stderr)

    outpath = args.output or "/tmp/toast_sales_summary.csv"
    write_csv(rows, outpath)

    # Print property summary
    print(f"\n{'Property':<30s} {'Outlet':<35s} {'Net Sales':>14} {'Checks':>8} {'Guests':>8} {'Avg Chk':>10} {'Labor Hrs':>10} {'Rev/Hr':>10}", file=sys.stderr)
    print("-" * 140, file=sys.stderr)
    current_prop = None
    prop_total = 0
    grand_total = 0
    for r in rows:
        if current_prop and current_prop != r["property"]:
            print(f"  {'':28s} {'PROPERTY TOTAL':>35s} ${prop_total:>12,.2f}", file=sys.stderr)
            print(file=sys.stderr)
            prop_total = 0
        current_prop = r["property"]
        prop_total += r["netSales"]
        grand_total += r["netSales"]
        rev_hr = f"${r['netSales'] / r['laborHours']:,.2f}" if r["laborHours"] > 0 else "N/A"
        print(f"  {r['property']:<28s} {r['outlet']:<35s} ${r['netSales']:>12,.2f} {r['checks']:>8,d} {r['guests']:>8,d} ${r.get('avgCheck',0):>8,.2f} {r['laborHours']:>10,.1f} {rev_hr:>10s}", file=sys.stderr)

    if current_prop:
        print(f"  {'':28s} {'PROPERTY TOTAL':>35s} ${prop_total:>12,.2f}", file=sys.stderr)
    print(f"\n  {'':28s} {'PORTFOLIO TOTAL':>35s} ${grand_total:>12,.2f}", file=sys.stderr)

    return rows


def cmd_sales_daily(args):
    """Pull daily sales by property (no revenue center grouping)."""
    mapping = load_mapping()
    lookup = build_guid_lookup(mapping)

    restaurant_ids = None
    if args.property:
        for prop_name, prop_data in mapping["properties"].items():
            if args.property.lower() in prop_name.lower():
                restaurant_ids = list(prop_data.get("restaurants", {}).keys())
                break

    results = era_request(args.start_date, args.end_date, group_by=[],
                          restaurant_ids=restaurant_ids, time_range="day")

    rows = []
    for r in results:
        guid = r.get("restaurantGuid", "")
        info = lookup.get(guid, {"property": f"Unknown ({guid[:8]}...)", "outlet": "Unknown"})
        rows.append({
            "property": info["property"],
            "outlet": info["outlet"],
            "businessDate": r.get("businessDate", ""),
            "netSales": round(r.get("netSalesAmount") or 0, 2),
            "grossSales": round(r.get("grossSalesAmount") or 0, 2),
            "discounts": round(r.get("discountAmount") or 0, 2),
            "checks": r.get("ordersCount") or 0,
            "guests": r.get("guestCount") or 0,
            "laborHours": round(r.get("hourlyJobTotalHours") or 0, 2),
        })

    rows.sort(key=lambda x: (x["businessDate"], x["property"], -x["netSales"]))

    outpath = args.output or "/tmp/toast_daily_sales.csv"
    write_csv(rows, outpath)
    return rows


def cmd_check_discounts(args):
    """Pull check-level discount detail by property, outlet, server, and date."""
    mapping = load_mapping()
    lookup = build_guid_lookup(mapping)

    restaurant_ids = None
    if args.property:
        for prop_name, prop_data in mapping["properties"].items():
            if args.property.lower() in prop_name.lower():
                restaurant_ids = list(prop_data.get("restaurants", {}).keys())
                print(f"Filtering to {prop_name}: {len(restaurant_ids)} restaurants", file=sys.stderr)
                break
        if not restaurant_ids:
            print(f"Property '{args.property}' not found in mapping.", file=sys.stderr)
            sys.exit(1)

    results = era_check_request(args.start_date, args.end_date,
                                restaurant_ids=restaurant_ids)

    min_discount = float(args.min_discount) if args.min_discount else 0.01

    rows = []
    for r in results:
        discount = r.get("checkDiscountAmount") or 0
        if discount < min_discount:
            continue

        guid = r.get("restaurantGuid", "")
        info = lookup.get(guid, {"property": f"Unknown ({guid[:8]}...)", "outlet": "Unknown"})

        rows.append({
            "property": info["property"],
            "outlet": info["outlet"],
            "businessDate": r.get("orderOpenDate", ""),
            "checkNumber": r.get("checkNumber", ""),
            "orderNumber": r.get("orderNumber", ""),
            "serverName": r.get("serverName", ""),
            "revenueCenter": r.get("revenueCenter", ""),
            "diningOption": r.get("diningOption", ""),
            "checkStatus": r.get("checkStatus", ""),
            "checkTotal": round(r.get("checkTotalAmount") or 0, 2),
            "discountAmount": round(discount, 2),
            "discountPct": round(discount / (r.get("checkTotalAmount") or 1) * 100, 1),
            "taxAmount": round(r.get("checkTaxAmount") or 0, 2),
            "tipAmount": round(r.get("checkTipAmount") or 0, 2),
            "refundAmount": round(r.get("checkRefundAmount") or 0, 2),
            "orderGuid": r.get("orderGuid", ""),
        })

    rows.sort(key=lambda x: (-x["discountAmount"], x["property"], x["outlet"]))

    outpath = args.output or "/tmp/toast_check_discounts.csv"
    write_csv(rows, outpath)

    # Print summary by property/outlet
    outlet_totals = {}
    for r in rows:
        key = (r["property"], r["outlet"])
        if key not in outlet_totals:
            outlet_totals[key] = {"count": 0, "totalDiscount": 0, "totalCheckAmt": 0}
        outlet_totals[key]["count"] += 1
        outlet_totals[key]["totalDiscount"] += r["discountAmount"]
        outlet_totals[key]["totalCheckAmt"] += r["checkTotal"]

    print(f"\nChecks with discounts >= ${min_discount:.2f}:", file=sys.stderr)
    print(f"\n{'Property':<30s} {'Outlet':<30s} {'Checks':>8} {'Total Discount':>16} {'Avg Discount':>14}", file=sys.stderr)
    print("-" * 102, file=sys.stderr)
    grand_count = 0
    grand_discount = 0
    for (prop, outlet), t in sorted(outlet_totals.items()):
        avg = t["totalDiscount"] / t["count"] if t["count"] else 0
        print(f"  {prop:<28s} {outlet:<30s} {t['count']:>8,d} ${t['totalDiscount']:>14,.2f} ${avg:>12,.2f}", file=sys.stderr)
        grand_count += t["count"]
        grand_discount += t["totalDiscount"]

    print(f"\n  {'TOTAL':<58s} {grand_count:>8,d} ${grand_discount:>14,.2f}", file=sys.stderr)

    # Top servers by discount volume
    server_totals = {}
    for r in rows:
        key = (r["property"], r["serverName"])
        if key not in server_totals:
            server_totals[key] = {"count": 0, "totalDiscount": 0}
        server_totals[key]["count"] += 1
        server_totals[key]["totalDiscount"] += r["discountAmount"]

    top_servers = sorted(server_totals.items(), key=lambda x: -x[1]["totalDiscount"])[:15]
    if top_servers:
        print(f"\nTop servers by discount volume:", file=sys.stderr)
        print(f"  {'Property':<28s} {'Server':<25s} {'Checks':>8} {'Total Discount':>16}", file=sys.stderr)
        print(f"  {'-'*80}", file=sys.stderr)
        for (prop, server), t in top_servers:
            print(f"  {prop:<28s} {server:<25s} {t['count']:>8,d} ${t['totalDiscount']:>14,.2f}", file=sys.stderr)

    return rows


def write_csv(rows, path):
    """Write list of dicts to CSV."""
    if not rows:
        print("No data to write.", file=sys.stderr)
        return
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    print(f"\nOutput saved to: {path}", file=sys.stderr)
    print(f"OUTPUT_FILE={path}")
    print(f"ROW_COUNT={len(rows)}")


def main():
    parser = argparse.ArgumentParser(description="Toast POS API Client — Proper Hospitality")
    parser.add_argument("--endpoint", required=True,
                        choices=["list-properties", "sales-summary", "sales-daily", "check-discounts", "guest-emails"],
                        help="API endpoint to call")
    parser.add_argument("--start-date", help="Start date (YYYYMMDD)")
    parser.add_argument("--end-date", help="End date (YYYYMMDD)")
    parser.add_argument("--property", help="Filter to a specific property (partial name match)")
    parser.add_argument("--group-by", choices=["REVENUE_CENTER"],
                        help="Group results by dimension")
    parser.add_argument("--min-discount", help="Minimum discount amount to include (default: 0.01)")
    parser.add_argument("--output", help="Output file path")
    args = parser.parse_args()

    if not CLIENT_ID or not CLIENT_SECRET:
        print("Error: TOAST_CLIENT_ID and TOAST_CLIENT_SECRET must be set.", file=sys.stderr)
        sys.exit(1)

    if args.endpoint == "list-properties":
        cmd_list_properties(args)
    elif args.endpoint == "sales-summary":
        if not all([args.start_date, args.end_date]):
            print("Error: --start-date and --end-date required (YYYYMMDD)", file=sys.stderr)
            sys.exit(1)
        cmd_sales_summary(args)
    elif args.endpoint == "sales-daily":
        if not all([args.start_date, args.end_date]):
            print("Error: --start-date and --end-date required (YYYYMMDD)", file=sys.stderr)
            sys.exit(1)
        cmd_sales_daily(args)
    elif args.endpoint == "check-discounts":
        if not all([args.start_date, args.end_date]):
            print("Error: --start-date and --end-date required (YYYYMMDD)", file=sys.stderr)
            sys.exit(1)
        cmd_check_discounts(args)
    elif args.endpoint == "guest-emails":
        if not all([args.start_date, args.end_date]):
            print("Error: --start-date and --end-date required (YYYYMMDD)", file=sys.stderr)
            sys.exit(1)
        cmd_guest_emails(args)


if __name__ == "__main__":
    main()
