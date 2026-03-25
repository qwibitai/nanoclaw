#!/usr/bin/env python3
"""
Blended Stock Score
Combines Fundamental Analysis (60%) + Technical Analysis (40%) into a single 0-100 signal.

Best setups: fundamentally strong stocks (score > 55) that are technically oversold (RSI < 35)
"""
import sys
import json
import argparse
import subprocess
import os

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
FA_SCRIPT = os.path.join(SKILL_DIR, 'fundamental_analysis.py')

# Technical analysis script — prefer skills-catalog local copy, fall back to installed skill
_ta_candidates = [
    os.path.join(os.path.dirname(SKILL_DIR), 'technical-analysis', 'technical_analysis.py'),
    '/home/node/.claude/skills/technical-analysis/technical_analysis.py',
]
TA_SCRIPT = next((p for p in _ta_candidates if os.path.exists(p)), _ta_candidates[0])


def run_script(script, args):
    try:
        result = subprocess.run(
            [sys.executable, script] + args,
            capture_output=True, text=True, timeout=120
        )
        return json.loads(result.stdout)
    except Exception as e:
        return {'error': str(e)}


def score_technical(ta):
    """Convert TA signals to 0-40 points."""
    if 'error' in ta or 'signals' not in ta:
        return 0, 'unavailable'

    points = 0
    signals = ta.get('signals', {})

    # RSI (0-12 pts) — oversold = high score (best entry point)
    rsi_val = signals.get('rsi', {}).get('value', 50)
    if rsi_val < 30:    points += 12
    elif rsi_val < 40:  points += 9
    elif rsi_val < 50:  points += 6
    elif rsi_val < 60:  points += 4
    elif rsi_val < 70:  points += 2
    # else: overbought = 0

    # MACD (0-10 pts)
    macd_sig = signals.get('macd', {}).get('signal', 'neutral')
    points += {'bullish': 10, 'neutral': 5, 'bearish': 0}.get(macd_sig, 5)

    # EMA trend (0-10 pts)
    ema_sig = signals.get('ema', {}).get('signal', 'neutral')
    points += {'bullish': 10, 'neutral': 5, 'bearish': 0}.get(ema_sig, 5)

    # Bollinger position (0-8 pts) — near lower band = good entry
    bb_sig = signals.get('bollinger', {}).get('signal', 'neutral')
    points += {'bullish': 8, 'neutral': 4, 'bearish': 0}.get(bb_sig, 4)

    return min(points, 40), ta.get('overall', 'neutral')


def score_fundamental(fa):
    """Extract 0-60 points from fundamental score."""
    if 'error' in fa or fa.get('fundamental_score') is None:
        return 0, 'unavailable'
    fs = fa['fundamental_score']
    return round(fs * 0.6), fa.get('overall', 'neutral')


def blend(ticker):
    ticker = ticker.upper()

    fa = run_script(FA_SCRIPT, ['analyze', ticker])
    ta = run_script(TA_SCRIPT, ['analyze', ticker])

    fa_pts, fa_overall = score_fundamental(fa)
    ta_pts, ta_overall = score_technical(ta)

    blended = fa_pts + ta_pts  # 0-100

    if blended >= 80:
        signal = 'strong_buy'
        action = 'High-conviction entry — strong fundamentals + favorable technicals'
    elif blended >= 65:
        signal = 'buy'
        action = 'Good setup — solid fundamentals with reasonable technicals'
    elif blended >= 45:
        signal = 'hold_watch'
        action = 'Watch list — wait for either fundamentals or technicals to improve'
    elif blended >= 30:
        signal = 'neutral'
        action = 'Mixed signals — no clear edge'
    else:
        signal = 'avoid'
        action = 'Weak fundamentals or overbought — not the right setup'

    # Ideal setup detection: strong fundamentals + technically oversold
    rsi_val = ta.get('signals', {}).get('rsi', {}).get('value', 50) if 'signals' in ta else 50
    fa_score = fa.get('fundamental_score', 0) or 0
    setup_note = None
    if fa_score >= 55 and isinstance(rsi_val, (int, float)) and rsi_val < 35:
        setup_note = (
            f'IDEAL SETUP: Fundamentally strong (score {fa_score}) + '
            f'technically oversold (RSI {rsi_val:.0f}) — blend strategy at its best'
        )

    return {
        'ticker': ticker,
        'name': fa.get('name') or ticker,
        'price': fa.get('price') or ta.get('price'),
        'blended_score': blended,
        'signal': signal,
        'action': action,
        'setup_note': setup_note,
        'breakdown': {
            'fundamental': {
                'score_contribution': fa_pts,
                'max': 60,
                'raw_score': fa.get('fundamental_score'),
                'overall': fa_overall,
                'piotroski': fa.get('piotroski', {}).get('score'),
                'peg': fa.get('peg', {}).get('peg'),
                'graham_mos_pct': fa.get('graham', {}).get('margin_of_safety_pct'),
                'roic_quality': fa.get('quality', {}).get('signal')
            },
            'technical': {
                'score_contribution': ta_pts,
                'max': 40,
                'overall': ta_overall,
                'rsi': rsi_val,
                'macd_signal': ta.get('signals', {}).get('macd', {}).get('signal') if 'signals' in ta else None,
                'ema_signal': ta.get('signals', {}).get('ema', {}).get('signal') if 'signals' in ta else None,
            }
        }
    }


def batch_blend(tickers):
    results = []
    for t in tickers:
        try:
            results.append(blend(t))
        except Exception as e:
            results.append({'ticker': t.upper(), 'error': str(e)})
    results.sort(key=lambda x: x.get('blended_score') or 0, reverse=True)
    return results


def main():
    parser = argparse.ArgumentParser(description='Blended Fundamental + Technical Stock Score')
    parser.add_argument('command', choices=['blend', 'batch'])
    parser.add_argument('tickers', nargs='+')
    args = parser.parse_args()

    if args.command == 'blend':
        result = blend(args.tickers[0])
    else:
        result = batch_blend(args.tickers)

    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()
