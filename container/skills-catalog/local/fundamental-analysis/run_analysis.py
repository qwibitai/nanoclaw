#!/usr/bin/env python3
"""
Blended Stock Analysis Runner
Runs fundamental (60%) + technical (40%) scoring on a list of tickers and
prints a clean Markdown-formatted report with ranked table, per-ticker
summaries, and Top Picks.

Usage:
  python3 run_analysis.py TICKER1 TICKER2 ...
  python3 run_analysis.py  # uses default photonics + mega-cap list
"""

import sys
import os
from datetime import datetime

# Ensure blended_score can find the sibling scripts
SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SKILL_DIR)

import blended_score as bs

DEFAULT_TICKERS = ['COHR', 'LITE', 'IPGP', 'LASR', 'VIAV', 'MRVL', 'MKSI', 'MSFT', 'GOOG']

SIGNAL_LABEL = {
    'strong_buy':  'STRONG BUY',
    'buy':         'BUY',
    'hold_watch':  'WATCH',
    'neutral':     'NEUTRAL',
    'avoid':       'AVOID',
}


def fmt_score(val, fallback='N/A'):
    if val is None:
        return fallback
    return str(val)


def fmt_float(val, decimals=1, fallback='N/A'):
    if val is None:
        return fallback
    try:
        return f'{float(val):.{decimals}f}'
    except (TypeError, ValueError):
        return fallback


def recommendation(signal):
    return SIGNAL_LABEL.get(signal, signal.upper() if signal else 'N/A')


def build_report(results, run_date):
    lines = []

    lines.append(f'# Blended Stock Analysis Report')
    lines.append(f'')
    lines.append(f'**Run date:** {run_date}  ')
    lines.append(f'**Scoring:** Fundamental 60% + Technical 40% (blended 0–100)')
    lines.append(f'')
    lines.append('---')
    lines.append('')

    # ---------- Ranked Table ----------
    lines.append('## Ranked Summary')
    lines.append('')
    lines.append('| Rank | Ticker | Fund. Score (/60) | Tech. Score (/40) | Blended (/100) | Recommendation |')
    lines.append('|------|--------|-------------------|-------------------|----------------|----------------|')

    valid = [r for r in results if 'error' not in r]
    invalid = [r for r in results if 'error' in r]

    for i, r in enumerate(valid, 1):
        bd = r.get('breakdown', {})
        fa_pts = fmt_score(bd.get('fundamental', {}).get('score_contribution'))
        ta_pts = fmt_score(bd.get('technical', {}).get('score_contribution'))
        blended = fmt_score(r.get('blended_score'))
        rec = recommendation(r.get('signal'))
        lines.append(f'| {i} | **{r["ticker"]}** | {fa_pts} | {ta_pts} | {blended} | {rec} |')

    for r in invalid:
        lines.append(f'| — | **{r["ticker"]}** | — | — | — | Data unavailable |')

    lines.append('')

    # ---------- Per-Ticker Summaries ----------
    lines.append('## Per-Ticker Details')
    lines.append('')

    for r in valid:
        ticker = r['ticker']
        name = r.get('name', ticker)
        price = r.get('price')
        signal = r.get('signal', 'N/A')
        action = r.get('action', '')
        setup_note = r.get('setup_note')

        bd = r.get('breakdown', {})
        fa = bd.get('fundamental', {})
        ta = bd.get('technical', {})

        rsi = ta.get('rsi')
        rsi_str = fmt_float(rsi, 1)
        peg = fa.get('peg')
        peg_str = fmt_float(peg, 2)
        roic_q = fa.get('roic_quality') or fa.get('overall', 'N/A')
        macd_sig = ta.get('macd_signal') or 'N/A'
        ema_sig = ta.get('ema_signal') or 'N/A'
        piotroski = fa.get('piotroski')
        graham_mos = fa.get('graham_mos_pct')
        raw_fa = fa.get('raw_score')

        lines.append(f'### {ticker} — {name}')
        if price:
            lines.append(f'**Price:** ${fmt_float(price, 2)}  ')
        lines.append(f'**Signal:** {recommendation(signal)}  ')
        lines.append(f'**Action:** {action}')
        if setup_note:
            lines.append(f'')
            lines.append(f'> {setup_note}')
        lines.append('')
        lines.append(f'| Metric | Value |')
        lines.append(f'|--------|-------|')
        lines.append(f'| Fundamental score (raw 0–100) | {fmt_score(raw_fa)} |')
        lines.append(f'| Piotroski F-Score | {fmt_score(piotroski)}/9 |')
        lines.append(f'| PEG Ratio | {peg_str} |')
        lines.append(f'| Graham Margin of Safety | {fmt_float(graham_mos, 1)}% |')
        lines.append(f'| ROIC/Quality signal | {roic_q} |')
        lines.append(f'| RSI (14-day) | {rsi_str} |')
        lines.append(f'| MACD signal | {macd_sig} |')
        lines.append(f'| EMA trend | {ema_sig} |')
        lines.append('')

    for r in invalid:
        lines.append(f'### {r["ticker"]} — Data Unavailable')
        lines.append(f'')
        lines.append(f'> {r.get("error", "Could not retrieve data")}')
        lines.append('')

    # ---------- Top Picks ----------
    lines.append('---')
    lines.append('')
    lines.append('## Top Picks')
    lines.append('')

    top3 = valid[:3]
    if top3:
        lines.append('The top 3 tickers by blended score:')
        lines.append('')
        for i, r in enumerate(top3, 1):
            ticker = r['ticker']
            blended = r.get('blended_score', 'N/A')
            action = r.get('action', '')
            setup_note = r.get('setup_note')
            rec = recommendation(r.get('signal'))
            bd = r.get('breakdown', {})
            ta = bd.get('technical', {})
            rsi = ta.get('rsi')
            fa = bd.get('fundamental', {})
            peg = fa.get('peg')

            highlights = []
            if rsi is not None:
                highlights.append(f'RSI {fmt_float(rsi, 1)}')
            if peg is not None:
                highlights.append(f'PEG {fmt_float(peg, 2)}')
            roic_q = fa.get('roic_quality') or fa.get('overall')
            if roic_q and roic_q not in ('N/A', 'unavailable'):
                highlights.append(f'ROIC quality: {roic_q}')

            highlight_str = ' | '.join(highlights) if highlights else 'see details above'
            lines.append(f'{i}. **{ticker}** — Blended {blended}/100 ({rec})')
            lines.append(f'   - {action}')
            lines.append(f'   - Key metrics: {highlight_str}')
            if setup_note:
                lines.append(f'   - _{setup_note}_')
            lines.append('')
    else:
        lines.append('No valid results available.')
        lines.append('')

    lines.append('---')
    lines.append('')
    lines.append('*Generated by `run_analysis.py` — blended fundamental + technical scoring.*')
    lines.append(f'*Scores are signals, not financial advice.*')

    return '\n'.join(lines)


def main():
    tickers = sys.argv[1:] if len(sys.argv) > 1 else DEFAULT_TICKERS
    tickers = [t.upper() for t in tickers]

    run_date = datetime.now().strftime('%Y-%m-%d %H:%M UTC')

    print(f'Running blended analysis on: {", ".join(tickers)}', file=sys.stderr)
    print('', file=sys.stderr)

    results = []
    for ticker in tickers:
        print(f'  Analyzing {ticker}...', file=sys.stderr)
        try:
            result = bs.blend(ticker)
            results.append(result)
            score = result.get('blended_score', 'N/A')
            signal = result.get('signal', '')
            print(f'    -> blended={score}  signal={signal}', file=sys.stderr)
        except Exception as e:
            results.append({'ticker': ticker, 'error': str(e)})
            print(f'    -> ERROR: {e}', file=sys.stderr)

    # Sort by blended score descending (errors go last)
    results.sort(key=lambda x: x.get('blended_score', -1), reverse=True)

    print('', file=sys.stderr)
    print('Done. Generating report...', file=sys.stderr)
    print('', file=sys.stderr)

    report = build_report(results, run_date)
    print(report)


if __name__ == '__main__':
    main()
