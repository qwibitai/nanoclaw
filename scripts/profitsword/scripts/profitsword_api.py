#!/usr/bin/env python3
"""ProfitSword/ProfitSage API client for Proper Hospitality.
Replaces the Excel VBA macro workflow with a direct Python implementation.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
import ssl

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(SKILL_DIR, "references", "config.json")

BASE_DOMAIN = "ProperHotel.profitsage.net"
TOKEN_URL = f"https://{BASE_DOMAIN}/PS-Handlers/token"
API_BASE = f"https://{BASE_DOMAIN}/PS-Handlers/api/DataPortalv3/CSV"

# Browser-like User-Agent to bypass Cloudflare bot detection (Error 1010)
BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

ENDPOINTS = {
    "monthly_extended": "MonthlyExtended",
    "daily_extended": "DailyExtended",
    "daily_labor": "DailyLabor",
    "ledger_batches": "LedgerBatches",
    "sales_bookings": "SalesBookings",
    "sales_pace_events": "SalesPaceEvents",
    "sales_pace_rooms": "SalesPaceRooms",
    "sales_pace_transient": "SalesPaceTransient",
    "sites": "Sites",
    "datasets": "DataSets",
    "str_day": "STRDay",
    "str_month": "STRMonth",
    "account_class": "AccountClass",
    "site_lists": "SiteLists",
    "site_groups": "SiteGroups",
}

# Mapping of endpoint to its accepted parameters
ENDPOINT_PARAMS = {
    "monthly_extended": {
        "required": ["dataSetID", "year", "begmonth", "endmonth"],
        "site": True,
        "optional": ["includeTotals", "asOfDate", "itemListID", "eyear", "includeZeroes",
                      "itemTag", "class", "excludeClass", "excludeSpecialAccounts",
                      "localCurrency", "dept", "excludeDept"],
    },
    "daily_extended": {
        "required": ["dataSetID", "BD", "ED"],
        "site": True,
        "optional": ["includeTotals", "asOfDate", "itemListID", "includeZeroes",
                      "itemTag", "class", "excludeClass", "excludeSpecialAccounts",
                      "localCurrency", "dept", "excludeDept"],
    },
    "daily_labor": {
        "required": ["BD", "ED"],
        "site": True,
        "optional": [],
    },
    "ledger_batches": {
        "required": ["BD", "ED", "SiteTag", "status", "typeID"],
        "site": False,
        "optional": [],
    },
    "sales_bookings": {
        "required": ["BD", "ED", "SiteTag"],
        "site": False,
        "optional": [],
    },
    "sales_pace_events": {
        "required": ["BD", "ED", "SiteTag", "asOfDate"],
        "site": False,
        "optional": [],
    },
    "sales_pace_rooms": {
        "required": ["BD", "ED", "SiteTag", "asOfDate"],
        "site": False,
        "optional": [],
    },
    "sales_pace_transient": {
        "required": ["BD", "ED", "SiteTag", "asOfDate"],
        "site": False,
        "optional": [],
    },
    "str_day": {
        "required": ["BD"],
        "site": False,
        "optional": [],
    },
    "str_month": {
        "required": ["begmonth", "year"],
        "site": False,
        "optional": [],
    },
    "sites": {"required": [], "site": False, "optional": []},
    "datasets": {"required": [], "site": False, "optional": []},
    "account_class": {"required": [], "site": False, "optional": []},
    "site_lists": {"required": [], "site": False, "optional": []},
    "site_groups": {"required": [], "site": False, "optional": []},
}


def load_config():
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)


def get_token(config):
    """Authenticate via OAuth2 password grant and return access token."""
    password_encoded = urllib.parse.quote(config["password"], safe="")
    body = f"grant_type=password&username={config['username']}&Password={password_encoded}"
    
    req = urllib.request.Request(
        TOKEN_URL,
        data=body.encode("utf-8"),
        headers={
            "Accept": "application/json;charset=UTF-8",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": BROWSER_UA,
        },
        method="POST",
    )
    
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    
    if "error" in data:
        print(f"ERROR: Authentication failed — {data.get('error_description', data['error'])}", file=sys.stderr)
        sys.exit(1)
    
    return data["access_token"]


def build_url(endpoint_key, token, params):
    """Build the full API URL with token and parameters."""
    endpoint_name = ENDPOINTS[endpoint_key]
    url = f"{API_BASE}/{endpoint_name}?writeheader=Y&exportfilename=APITEMP.CSV&access_token={token}"
    
    for key, value in params.items():
        if value is not None and value != "":
            url += f"&{key}={urllib.parse.quote(str(value), safe='')}"
    
    return url


def make_request(url):
    """Execute GET request and return response text."""
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/text",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": BROWSER_UA,
        },
        method="GET",
    )
    
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx, timeout=120) as resp:
        return resp.read().decode("utf-8", errors="replace")


def main():
    parser = argparse.ArgumentParser(description="ProfitSword API Client for Proper Hospitality")
    parser.add_argument("--endpoint", required=True, choices=list(ENDPOINTS.keys()),
                        help="API endpoint to call")
    parser.add_argument("--output", default="/tmp/profitsword_output.csv",
                        help="Output CSV file path")
    
    # Site identification (use one or the other)
    parser.add_argument("--site-tag", help="SiteTag (e.g., 107 for Austin)")
    parser.add_argument("--site-group", help="SiteGroup name")
    
    # Common parameters
    parser.add_argument("--dataset-id", help="DataSet ID (1=Budget, 2=Actuals)")
    parser.add_argument("--year", help="Year")
    parser.add_argument("--begmonth", help="Begin month (1-12)")
    parser.add_argument("--endmonth", help="End month (1-12)")
    parser.add_argument("--bd", help="Begin date (MM/DD/YYYY or YYYY-MM-DD)")
    parser.add_argument("--ed", help="End date (MM/DD/YYYY or YYYY-MM-DD)")
    parser.add_argument("--include-totals", default="N", help="Include totals (Y/N)")
    parser.add_argument("--as-of-date", help="As-of date for pace reports")
    parser.add_argument("--status", help="Ledger status (ALL/Open/Posted)")
    parser.add_argument("--type-id", help="Ledger typeID")
    parser.add_argument("--item-list-id", help="Item list ID filter")
    parser.add_argument("--include-zeroes", help="Include zero values (Y/N)")
    parser.add_argument("--item-tag", help="Item tag filter")
    parser.add_argument("--acct-class", help="Account class filter")
    parser.add_argument("--exclude-class", help="Exclude account class")
    parser.add_argument("--exclude-special", help="Exclude special accounts")
    parser.add_argument("--local-currency", help="Local currency flag")
    parser.add_argument("--dept", help="Department filter")
    parser.add_argument("--exclude-dept", help="Exclude department")
    parser.add_argument("--eyear", help="End year (if different from year)")
    
    # Custom endpoint
    parser.add_argument("--custom-endpoint", help="Custom endpoint name (for custom API calls)")
    parser.add_argument("--custom-params", help="JSON string of custom parameters")
    
    args = parser.parse_args()
    
    # Validate site params
    if args.site_tag and args.site_group:
        print("ERROR: Cannot specify both --site-tag and --site-group", file=sys.stderr)
        sys.exit(1)
    
    # Load config and authenticate
    config = load_config()
    print(f"Authenticating with ProfitSage...", file=sys.stderr)
    token = get_token(config)
    print(f"Token acquired.", file=sys.stderr)
    
    # Build parameter dict
    params = {}
    ep_config = ENDPOINT_PARAMS[args.endpoint]
    
    # Map CLI args to API parameter names
    param_map = {
        "dataset_id": "dataSetID",
        "year": "year",
        "begmonth": "begmonth",
        "endmonth": "endmonth",
        "bd": "BD",
        "ed": "ED",
        "include_totals": "includeTotals",
        "as_of_date": "asOfDate",
        "status": "status",
        "type_id": "typeID",
        "item_list_id": "itemListID",
        "include_zeroes": "includeZeroes",
        "item_tag": "itemTag",
        "acct_class": "class",
        "exclude_class": "excludeClass",
        "exclude_special": "excludeSpecialAccounts",
        "local_currency": "localCurrency",
        "dept": "dept",
        "exclude_dept": "excludeDept",
        "eyear": "eyear",
    }
    
    for cli_name, api_name in param_map.items():
        val = getattr(args, cli_name, None)
        if val is not None:
            params[api_name] = val
    
    # Handle site tag/group
    if ep_config.get("site"):
        if args.site_tag:
            params["SiteTag"] = args.site_tag
        elif args.site_group:
            params["SiteGroup"] = args.site_group
    elif args.site_tag:
        params["SiteTag"] = args.site_tag
    
    # Build URL and make request
    url = build_url(args.endpoint, token, params)
    
    # Log the URL (with token masked)
    masked_url = url.replace(token, "***TOKEN***")
    print(f"Requesting: {masked_url}", file=sys.stderr)
    
    print(f"Fetching data...", file=sys.stderr)
    response_text = make_request(url)
    
    # Write response to file
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(response_text)
    
    # Print summary
    lines = response_text.strip().split("\n")
    if len(lines) > 1:
        headers = lines[0].split(",")
        data_rows = len(lines) - 1
        print(f"\nSuccess: {data_rows} rows, {len(headers)} columns", file=sys.stderr)
        print(f"Columns: {', '.join(headers[:10])}{'...' if len(headers) > 10 else ''}", file=sys.stderr)
        print(f"Output saved to: {args.output}", file=sys.stderr)
    elif len(lines) == 1 and lines[0].strip():
        print(f"Response returned headers only (0 data rows). Params may be too restrictive.", file=sys.stderr)
    else:
        print(f"WARNING: Empty response. Check parameters.", file=sys.stderr)
    
    # Print output path for Claude to pick up
    print(f"OUTPUT_FILE={args.output}")
    print(f"ROW_COUNT={len(lines) - 1 if len(lines) > 1 else 0}")


if __name__ == "__main__":
    main()
