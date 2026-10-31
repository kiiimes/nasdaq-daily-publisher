"""Collect explicitly selected editorial examples; never ranks or publishes stocks."""
import argparse
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import json
from pathlib import Path
import re
import time
import sys
import traceback
import uuid

ROOT = Path(__file__).parent


def parse_day(value):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('Use YYYY-MM-DD')
    d = datetime.strptime(value, '%Y-%m-%d')
    if d.weekday() >= 5:
        raise ValueError('Trade date is a weekend')
    return d.strftime('%Y%m%d')


def selection(value):
    parts = value.split(':', 2)
    if len(parts) != 3:
        raise ValueError('Use EXCHANGE:SYMBOL:NAME')
    exchange, symbol, name = parts
    if exchange not in ('NAS', 'NYS', 'AMS') or not re.fullmatch(r'[A-Z][A-Z0-9.-]{0,9}', symbol) or not name.strip() or len(name) > 100:
        raise ValueError('Invalid exchange, symbol or name')
    return exchange, symbol, name.strip()


def collect(day, picks, query, pause=time.sleep):
    if len(picks) < 2 or len(picks) > 8 or len({p[1] for p in picks}) != len(picks):
        raise ValueError('Select 2..8 unique editorial examples')
    from fetch_market import normalize
    stocks = []
    for exchange, symbol, name in picks:
        print(f'BROKER_SELECTION {exchange} {symbol}', file=sys.stderr)
        response = query('/uapi/overseas-price/v1/quotations/dailyprice', 'HHDFS76240000', {'AUTH': '', 'EXCD': exchange, 'SYMB': symbol, 'GUBN': '0', 'BYMD': day, 'MODP': '0'})
        row = {'symbol': symbol, 'name': name, 'exchange': exchange, **normalize(response.get('output2') or [], 'xymd', 'clos', day)}
        current, previous = Decimal(row['close']), Decimal(row['previous_close'])
        if row['date'] != day or current <= 0 or previous <= 0 or ((current / previous - 1) * 100).quantize(Decimal('.01'), rounding=ROUND_HALF_UP) != Decimal(row['change_pct']):
            raise ValueError('Date or return verification failed')
        stocks.append(row)
        pause(.3)
    return {'trade_date': day, 'retrieved_at': datetime.now(timezone.utc).isoformat(), 'selection': 'source-backed editorial examples; not full-market ranking', 'stocks': stocks}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--date', required=True)
    p.add_argument('--symbol', action='append', required=True, help='e.g. NAS:NVDA:엔비디아; repeat 2..8 times')
    p.add_argument('--refresh', action='store_true')
    args = p.parse_args()
    try:
        day = parse_day(args.date)
        picks = [selection(x) for x in args.symbol]
        target = ROOT / 'editions' / (args.date + '-korea') / 'movers.json'
        if target.exists() and not args.refresh:
            raise ValueError('Movers file exists; explicit --refresh required')
        from check_kis import connect
        data = collect(day, picks, connect())
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name('.movers-' + uuid.uuid4().hex + '.tmp')
        try:
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
        print(json.dumps({'status': 'collected', 'trade_date': day, 'symbols': [x['symbol'] for x in data['stocks']], 'output': str(target)}, ensure_ascii=False))
    except (ValueError, RuntimeError, OSError, KeyError, ArithmeticError) as error:
        locations = ','.join(f'{Path(f.filename).stem}:{f.name}:{f.lineno}' for f in traceback.extract_tb(error.__traceback__) if Path(f.filename).name in ('collect_movers.py','fetch_market.py','check_kis.py'))
        print(f'BROKER_DIAGNOSTIC {type(error).__name__} {locations}', file=sys.stderr)
        p.exit(1, 'Selected-mover collection failed; no complete movers file saved. Check date, symbols, network and data availability.\n')


if __name__ == '__main__':
    main()
