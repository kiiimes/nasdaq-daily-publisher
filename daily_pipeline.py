"""Date-explicit adapter only. Existing fetcher owns network and KIS setup."""
import argparse
from datetime import datetime
import re
import sys
import traceback
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    f = sub.add_parser('fetch'); f.add_argument('--date', required=True, help='US trade date YYYY-MM-DD')
    a = p.parse_args()
    try:
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', a.date):
            raise ValueError('Date must be YYYY-MM-DD')
        day = datetime.strptime(a.date, '%Y-%m-%d')
        if day.weekday() >= 5:
            raise ValueError('US trade date cannot be a weekend')
        from fetch_market import fetch  # Lazy import: --help never accesses credentials.
        fetch(day.strftime('%Y%m%d'))  # Existing signature is fetch(day); no refresh parameter.
    except (ValueError, RuntimeError, OSError, ImportError) as exc:
        locations = ','.join(f'{Path(f.filename).stem}:{f.name}:{f.lineno}' for f in traceback.extract_tb(exc.__traceback__) if Path(f.filename).name in ('daily_pipeline.py','fetch_market.py','check_kis.py'))
        print(f'BROKER_DIAGNOSTIC {type(exc).__name__} {locations}', file=sys.stderr)
        p.exit(1, 'Fetch failed; no verified edition saved.\n')


if __name__ == '__main__':
    main()
