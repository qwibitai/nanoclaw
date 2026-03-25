#!/usr/bin/env python3
"""
Fundamental Analysis Skill
Computes: Piotroski F-Score, PEG Ratio, Graham Number, ROIC, composite score
"""
import sys
import json
import argparse


def get_data(ticker):
    try:
        import yfinance as yf
        t = yf.Ticker(ticker)
        info = t.info
        cf = t.cashflow
        bs = t.balance_sheet
        inc = t.income_stmt
        return t, info, cf, bs, inc
    except Exception as e:
        return None, {}, None, None, None


def safe(val, default=0):
    if val is None:
        return default
    try:
        f = float(val)
        return f if f == f else default
    except:
        return default


def piotroski_fscore(info, cf, bs, inc):
    """9-point financial health score. 8-9=strong, 5-7=avg, 0-4=weak"""
    score = 0
    breakdown = {}
    try:
        # Profitability (4 points)
        net_income = safe(info.get('netIncomeToCommon'))
        p1 = 1 if net_income > 0 else 0
        breakdown['net_income_positive'] = p1
        score += p1

        ocf = 0
        if cf is not None and not cf.empty:
            for label in ['Operating Cash Flow', 'Total Cash From Operating Activities']:
                if label in cf.index:
                    ocf = safe(cf.loc[label].iloc[0])
                    break
        p2 = 1 if ocf > 0 else 0
        breakdown['ocf_positive'] = p2
        score += p2

        total_assets = safe(info.get('totalAssets'))
        roa_curr = net_income / total_assets if total_assets > 0 else 0
        p3 = 0
        if inc is not None and not inc.empty and len(inc.columns) >= 2:
            try:
                ni_prev = 0
                for k in ['Net Income', 'Net Income Common Stockholders']:
                    if k in inc.index:
                        ni_prev = safe(inc.loc[k].iloc[1])
                        break
                roa_prev = ni_prev / total_assets if total_assets > 0 else 0
                p3 = 1 if roa_curr > roa_prev else 0
            except:
                pass
        breakdown['roa_improving'] = p3
        score += p3

        p4 = 1 if ocf > net_income else 0
        breakdown['ocf_beats_net_income'] = p4
        score += p4

        # Leverage & Liquidity (3 points)
        p5 = 0
        if bs is not None and not bs.empty and len(bs.columns) >= 2:
            try:
                ltd_curr = ltd_prev = 0
                for k in ['Long Term Debt', 'Long-Term Debt']:
                    if k in bs.index:
                        ltd_curr = safe(bs.loc[k].iloc[0])
                        ltd_prev = safe(bs.loc[k].iloc[1])
                        break
                ta_curr = ta_prev = total_assets
                if 'Total Assets' in bs.index:
                    ta_curr = safe(bs.loc['Total Assets'].iloc[0])
                    ta_prev = safe(bs.loc['Total Assets'].iloc[1])
                lev_curr = ltd_curr / ta_curr if ta_curr > 0 else 0
                lev_prev = ltd_prev / ta_prev if ta_prev > 0 else 0
                p5 = 1 if lev_curr < lev_prev else 0
            except:
                pass
        breakdown['leverage_decreasing'] = p5
        score += p5

        p6 = 0
        if bs is not None and not bs.empty and len(bs.columns) >= 2:
            try:
                ca_curr = ca_prev = cl_curr = cl_prev = 0
                for k in ['Current Assets', 'Total Current Assets']:
                    if k in bs.index:
                        ca_curr = safe(bs.loc[k].iloc[0])
                        ca_prev = safe(bs.loc[k].iloc[1])
                        break
                for k in ['Current Liabilities', 'Total Current Liabilities']:
                    if k in bs.index:
                        cl_curr = safe(bs.loc[k].iloc[0])
                        cl_prev = safe(bs.loc[k].iloc[1])
                        break
                cr_curr = ca_curr / cl_curr if cl_curr > 0 else 0
                cr_prev = ca_prev / cl_prev if cl_prev > 0 else 0
                p6 = 1 if cr_curr > cr_prev else 0
            except:
                pass
        breakdown['current_ratio_improving'] = p6
        score += p6

        p7 = 0
        shares_curr = safe(info.get('sharesOutstanding'))
        if bs is not None and not bs.empty and len(bs.columns) >= 2:
            try:
                shares_prev = shares_curr
                for k in ['Common Stock', 'Ordinary Shares Number']:
                    if k in bs.index:
                        v = safe(bs.loc[k].iloc[1])
                        if v > 0:
                            shares_prev = v
                        break
                p7 = 1 if shares_curr <= shares_prev * 1.02 else 0
            except:
                pass
        breakdown['no_dilution'] = p7
        score += p7

        # Operating Efficiency (2 points)
        p8 = 0
        if inc is not None and not inc.empty and len(inc.columns) >= 2:
            try:
                gp_curr = gp_prev = rev_curr = rev_prev = 0
                if 'Gross Profit' in inc.index:
                    gp_curr = safe(inc.loc['Gross Profit'].iloc[0])
                    gp_prev = safe(inc.loc['Gross Profit'].iloc[1])
                for k in ['Total Revenue', 'Revenue']:
                    if k in inc.index:
                        rev_curr = safe(inc.loc[k].iloc[0])
                        rev_prev = safe(inc.loc[k].iloc[1])
                        break
                gm_curr = gp_curr / rev_curr if rev_curr > 0 else 0
                gm_prev = gp_prev / rev_prev if rev_prev > 0 else 0
                p8 = 1 if gm_curr > gm_prev else 0
            except:
                pass
        breakdown['gross_margin_improving'] = p8
        score += p8

        p9 = 0
        if inc is not None and not inc.empty and len(inc.columns) >= 2:
            try:
                rev_curr = rev_prev = 0
                for k in ['Total Revenue', 'Revenue']:
                    if k in inc.index:
                        rev_curr = safe(inc.loc[k].iloc[0])
                        rev_prev = safe(inc.loc[k].iloc[1])
                        break
                at_curr = rev_curr / total_assets if total_assets > 0 else 0
                at_prev = rev_prev / total_assets if total_assets > 0 else 0
                p9 = 1 if at_curr > at_prev else 0
            except:
                pass
        breakdown['asset_turnover_improving'] = p9
        score += p9

    except Exception as e:
        breakdown['error'] = str(e)

    if score >= 8:
        signal = 'strong'
        note = f'F-Score {score}/9 — financially healthy, low distress risk'
    elif score >= 5:
        signal = 'average'
        note = f'F-Score {score}/9 — moderate financial health'
    else:
        signal = 'weak'
        note = f'F-Score {score}/9 — financial deterioration signals, potential value trap'

    return {'score': score, 'max': 9, 'signal': signal, 'note': note, 'breakdown': breakdown}


def peg_ratio(info):
    """PEG = P/E / EPS Growth Rate. < 1 = undervalued relative to growth."""
    pe = safe(info.get('trailingPE') or info.get('forwardPE'))
    growth = safe(info.get('earningsGrowth') or info.get('revenueGrowth'))
    growth_pct = growth * 100 if growth != 0 else 0
    div_yield = safe(info.get('dividendYield', 0)) * 100

    if pe <= 0 or growth_pct <= 0:
        return {
            'pe': pe, 'growth_pct': growth_pct,
            'peg': None, 'lynch_peg': None,
            'signal': 'unavailable',
            'note': 'PEG requires positive P/E and positive growth rate'
        }

    peg = pe / growth_pct
    lynch_peg = pe / (growth_pct + div_yield) if (growth_pct + div_yield) > 0 else None

    if peg < 0.5:
        signal, note = 'strong_buy', f'PEG {peg:.2f} — significantly undervalued vs growth (Lynch target < 0.5)'
    elif peg < 1.0:
        signal, note = 'bullish', f'PEG {peg:.2f} — undervalued relative to growth rate'
    elif peg < 1.5:
        signal, note = 'neutral', f'PEG {peg:.2f} — fairly valued'
    else:
        signal, note = 'bearish', f'PEG {peg:.2f} — expensive relative to growth'

    return {
        'pe': round(pe, 2), 'growth_pct': round(growth_pct, 1),
        'peg': round(peg, 2),
        'lynch_peg': round(lynch_peg, 2) if lynch_peg else None,
        'signal': signal, 'note': note
    }


def graham_number(info):
    """Graham Number = sqrt(22.5 * EPS * BVPS). Buy below for margin of safety."""
    eps = safe(info.get('trailingEps') or info.get('forwardEps'))
    bvps = safe(info.get('bookValue'))
    price = safe(info.get('currentPrice') or info.get('regularMarketPrice'))

    if eps <= 0 or bvps <= 0:
        return {
            'graham_number': None, 'current_price': price,
            'margin_of_safety_pct': None, 'signal': 'unavailable',
            'note': 'Graham Number requires positive EPS and positive book value'
        }

    graham = (22.5 * eps * bvps) ** 0.5
    mos = (graham - price) / graham * 100 if price > 0 else None

    if mos is None:
        signal, note = 'unavailable', 'Price unavailable'
    elif mos > 30:
        signal, note = 'strong_buy', f'{abs(mos):.0f}% discount to Graham Number — significant margin of safety'
    elif mos > 0:
        signal, note = 'bullish', f'{mos:.0f}% discount to Graham Number'
    elif mos > -20:
        signal, note = 'neutral', f'{abs(mos):.0f}% premium to Graham Number — fairly valued'
    else:
        signal, note = 'bearish', f'{abs(mos):.0f}% premium to Graham Number — expensive by value standards'

    return {
        'graham_number': round(graham, 2),
        'current_price': round(price, 2) if price else None,
        'margin_of_safety_pct': round(mos, 1) if mos is not None else None,
        'eps': round(eps, 2), 'book_value_per_share': round(bvps, 2),
        'signal': signal, 'note': note
    }


def roic_quality(info, inc, bs, cf):
    """ROIC, ROE, margins, FCF quality check."""
    result = {}
    roe = safe(info.get('returnOnEquity'))
    result['roe_pct'] = round(roe * 100, 1) if roe else None
    roa = safe(info.get('returnOnAssets'))
    result['roa_pct'] = round(roa * 100, 1) if roa else None
    result['gross_margin_pct'] = round(safe(info.get('grossMargins')) * 100, 1) if info.get('grossMargins') else None
    result['operating_margin_pct'] = round(safe(info.get('operatingMargins')) * 100, 1) if info.get('operatingMargins') else None
    result['net_margin_pct'] = round(safe(info.get('profitMargins')) * 100, 1) if info.get('profitMargins') else None

    fcf = safe(info.get('freeCashflow'))
    revenue = safe(info.get('totalRevenue'))
    result['fcf_margin_pct'] = round(fcf / revenue * 100, 1) if revenue > 0 and fcf else None
    ni = safe(info.get('netIncomeToCommon'))
    result['fcf_beats_net_income'] = bool(fcf > ni) if fcf and ni else None

    roic = None
    try:
        if inc is not None and not inc.empty and bs is not None and not bs.empty:
            ebit = 0
            for k in ['EBIT', 'Operating Income']:
                if k in inc.index:
                    ebit = safe(inc.loc[k].iloc[0])
                    break
            tax_rate = safe(info.get('effectiveTaxRate', 0.21))
            nopat = ebit * (1 - tax_rate)
            ca = cl = ppe = 0
            for k in ['Current Assets', 'Total Current Assets']:
                if k in bs.index:
                    ca = safe(bs.loc[k].iloc[0])
                    break
            for k in ['Current Liabilities', 'Total Current Liabilities']:
                if k in bs.index:
                    cl = safe(bs.loc[k].iloc[0])
                    break
            for k in ['Net PPE', 'Property Plant Equipment Net']:
                if k in bs.index:
                    ppe = safe(bs.loc[k].iloc[0])
                    break
            ic = (ca - cl) + ppe
            if ic > 0:
                roic = nopat / ic * 100
    except:
        pass

    result['roic_pct'] = round(roic, 1) if roic else None
    quality_score = roic or (roe * 100 if roe else None)
    if quality_score and quality_score >= 15:
        result['signal'] = 'excellent'
        result['note'] = f'ROIC/ROE {quality_score:.0f}% — well above cost of capital'
    elif quality_score and quality_score >= 10:
        result['signal'] = 'good'
        result['note'] = f'ROIC/ROE {quality_score:.0f}% — solid returns on capital'
    elif quality_score:
        result['signal'] = 'weak'
        result['note'] = f'ROIC/ROE {quality_score:.0f}% — below typical cost of capital'
    else:
        result['signal'] = 'unavailable'
        result['note'] = 'Could not compute ROIC/ROE'
    return result


def analyze(ticker):
    ticker = ticker.upper()
    t, info, cf, bs, inc = get_data(ticker)
    if not info or not info.get('symbol'):
        return {'error': f'No data found for {ticker}'}

    price = safe(info.get('currentPrice') or info.get('regularMarketPrice'))
    fscore = piotroski_fscore(info, cf, bs, inc)
    peg = peg_ratio(info)
    graham = graham_number(info)
    quality = roic_quality(info, inc, bs, cf)

    # Composite fundamental score (0-100)
    points = 0
    max_points = 0
    points += (fscore['score'] / 9) * 35
    max_points += 35
    if peg['peg'] is not None:
        pv = peg['peg']
        points += (25 if pv < 0.5 else 20 if pv < 1.0 else 12 if pv < 1.5 else 0)
        max_points += 25
    if graham['margin_of_safety_pct'] is not None:
        m = graham['margin_of_safety_pct']
        points += (20 if m > 30 else 14 if m > 0 else 8 if m > -20 else 0)
        max_points += 20
    q_pts = {'excellent': 20, 'good': 14, 'weak': 5}.get(quality['signal'], 0)
    points += q_pts
    max_points += 20

    fundamental_score = round(points / max_points * 100) if max_points > 0 else None
    overall = (
        'strong_buy' if fundamental_score >= 75 else
        'bullish' if fundamental_score >= 55 else
        'neutral' if fundamental_score >= 35 else 'bearish'
    ) if fundamental_score is not None else 'unavailable'

    return {
        'ticker': ticker,
        'name': info.get('longName') or info.get('shortName') or ticker,
        'price': price,
        'sector': info.get('sector'),
        'industry': info.get('industry'),
        'market_cap': info.get('marketCap'),
        'fundamental_score': fundamental_score,
        'overall': overall,
        'piotroski': fscore,
        'peg': peg,
        'graham': graham,
        'quality': quality
    }


def batch_analyze(tickers):
    results = []
    for t in tickers:
        try:
            results.append(analyze(t))
        except Exception as e:
            results.append({'ticker': t.upper(), 'error': str(e)})
    results.sort(key=lambda x: x.get('fundamental_score') or 0, reverse=True)
    return results


def main():
    parser = argparse.ArgumentParser(description='Fundamental Analysis')
    parser.add_argument('command', choices=['analyze', 'batch', 'fscore', 'peg', 'graham', 'quality'])
    parser.add_argument('tickers', nargs='+')
    args = parser.parse_args()

    try:
        import yfinance
    except ImportError:
        import subprocess
        subprocess.run([sys.executable, '-m', 'pip', 'install', 'yfinance', '--quiet'], check=True)

    if args.command == 'analyze':
        result = analyze(args.tickers[0])
    elif args.command == 'batch':
        result = batch_analyze(args.tickers)
    else:
        t, info, cf, bs, inc = get_data(args.tickers[0].upper())
        if args.command == 'fscore':
            result = piotroski_fscore(info, cf, bs, inc)
        elif args.command == 'peg':
            result = peg_ratio(info)
        elif args.command == 'graham':
            result = graham_number(info)
        elif args.command == 'quality':
            result = roic_quality(info, inc, bs, cf)

    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()
