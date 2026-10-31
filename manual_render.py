"""Render an explicitly dated, independently checked private edition. No providers or publishing."""
import argparse
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP, localcontext
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from zoneinfo import ZoneInfo

import build_edition as builder

SOURCE = Path(__file__).resolve().parent
ACCOUNT = 'daily.nasdaq.kr'
SESSION = 'regular close'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def checked_date(value, now=None):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value), 'Explicit ISO trade date required')
    day = datetime.strptime(value, '%Y-%m-%d').date()
    require(day.isoformat() == value, 'Invalid ISO trade date')
    now = now or datetime.now(timezone.utc)
    require(now.tzinfo is not None, 'Clock must be timezone aware')
    close = datetime.combine(day, time(16), ZoneInfo('America/New_York'))
    age = now.astimezone(timezone.utc) - close.astimezone(timezone.utc)
    require(day.weekday() < 5 and timedelta(0) <= age <= timedelta(hours=120), 'Trade date weekend, unclosed, or older than 120h')
    return day


def regular(root, target, directory=False):
    """Reject symlinks in every private path component and hardlinked inputs."""
    require(target.is_relative_to(root), 'Path outside private root')
    current = root
    parts = (Path('.'), *target.relative_to(root).parts)
    for part in parts:
        current = current / part
        mode = current.lstat()
        require(not stat.S_ISLNK(mode.st_mode), 'Symlink rejected')
        is_directory = current != target or directory
        require(stat.S_ISDIR(mode.st_mode) if is_directory else stat.S_ISREG(mode.st_mode) and mode.st_nlink == 1, 'Nonregular private path')


def load(root, target):
    regular(root, target)
    value = builder.load(target)
    require(isinstance(value, dict), 'JSON object required')
    return value


def reserved(root, day):
    compact = day.replace('-', '')
    seed = load(root, root / 'cloud_state.seed.json')
    local = load(root, root / '.instagram-auto/state.json')
    states = [seed, local]
    cloud = root / 'cloud_state.json'
    if cloud.exists() or cloud.is_symlink():
        states.append(load(root, cloud))
    require(local.get('version') == 1 and local.get('account') == ACCOUNT and local.get('root') == str(root), 'Materialized private state required')
    for state in states:
        baseline = state.get('baseline')
        jobs = state.get('jobs', {})
        receipts = state.get('receipts', [])
        require(isinstance(baseline, list) and isinstance(jobs, dict) and isinstance(receipts, list), 'Invalid reservation state')
        require(all(isinstance(name, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}-[a-z0-9-]+cards', name) for name in baseline), 'Invalid baseline')
        require(not any(name.startswith(day + '-') for name in baseline), 'Trade date already in baseline')
        for job in [*jobs.values(), *receipts]:
            require(isinstance(job, dict), 'Invalid reservation job')
            edition = job.get('edition', '')
            require(isinstance(edition, str), 'Invalid reservation edition')
            require(job.get('trade_date') not in (day, compact) and not Path(edition).name.startswith(day + '-'), 'Trade date already reserved')


def verify_quotes(market, movers, editorial, day):
    compact = day.strftime('%Y%m%d')
    for data in (market, movers, editorial):
        require(data.get('trade_date') == compact and data.get('session') == SESSION, 'Input date/session mismatch')
    require(editorial.get('reviewed') is True, 'Literal editorial reviewed true required')
    verification = movers.get('verification')
    require(isinstance(verification, dict) and verification.get('verified') is True and verification.get('session') == SESSION, 'Independent quote verification required')
    stocks, quotes = movers.get('stocks'), verification.get('quotes')
    require(isinstance(stocks, list) and stocks and isinstance(quotes, list) and len(quotes) == len(stocks), 'Every mover requires one verified quote')
    lookup = {}
    for quote in quotes:
        require(isinstance(quote, dict) and isinstance(quote.get('symbol'), str) and quote['symbol'] not in lookup, 'Invalid or duplicate verified symbol')
        lookup[quote['symbol']] = quote
    require({row['symbol'] for row in stocks} == set(lookup) and len({row['symbol'] for row in stocks}) == len(stocks), 'Verified mover symbols mismatch')
    sources = {source['id']: source for source in editorial['sources']}
    selected = {item['symbol']: direction for direction in ('up', 'down') for item in editorial[direction]}
    for row in stocks:
        quote = lookup[row['symbol']]
        require(quote.get('date') == compact and row.get('date') == compact, 'Verified quote date mismatch')
        for key in ('close', 'previous_close', 'change_pct'):
            require(builder.number(row[key]) == builder.number(quote[key]), 'Independent mover quote mismatch')
        close, previous = builder.number(quote['close']), builder.number(quote['previous_close'])
        require(min(close, previous) > 0, 'Verified prices must be positive')
        with localcontext() as ctx:
            ctx.prec = 60
            change = ((close / previous - 1) * 100).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
        require(change == builder.number(quote['change_pct']), 'Verified mover return arithmetic mismatch')
        ids = quote.get('source_ids')
        require(isinstance(ids, list) and ids and all(isinstance(sid, str) and sid in sources for sid in ids) and len(set(ids)) == len(ids), 'Verified mover source references required')
        if row['symbol'] in selected:
            claim = selected[row['symbol']] + '.' + row['symbol']
            require(all(claim in sources[sid]['supports'] for sid in ids), 'Verified mover source coverage mismatch')
    # Keep all existing index thresholds, source coverage, caption, and arithmetic gates.
    builder.validate(market, editorial, movers)


def render(day_string, root=None, now=None):
    day = checked_date(day_string, now)
    root = Path(root if root is not None else Path.cwd()).absolute()
    regular(root, root, directory=True)
    require(root.resolve() == root, 'Private root must be canonical')
    reserved(root, day.isoformat())
    editions = root / 'editions'
    regular(root, editions, directory=True)
    # Any final edition for this date, including a dangling symlink, is a conflict.
    require(not any(p.name.startswith(day.isoformat() + '-') and p.name.endswith('cards') for p in editions.iterdir()), 'Completed edition exists; refusing overwrite')
    market = editions / day.isoformat() / 'market.json'
    work = editions / (day.isoformat() + '-korea')
    movers, editorial = work / 'movers.json', work / 'editorial.json'
    verify_quotes(load(root, market), load(root, movers), load(root, editorial), day)
    final = editions / (day.isoformat() + '-five-cards')
    # No inherited HOME, model/provider credentials, Python injection, or auth/session env.
    safe = {'PATH': os.defpath, 'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'LANG': 'en_US.UTF-8'}
    result = subprocess.run([sys.executable, '-I', str(SOURCE / 'build_edition.py'), '--market', str(market), '--editorial', str(editorial), '--movers', str(movers), '--output', str(final)], cwd=root, env=safe, capture_output=True, timeout=120)
    require(result.returncode == 0, 'Reviewed render failed; no checkpoint permitted')
    regular(root, final, directory=True)
    validation = load(root, final / 'validation.json')
    require(validation.get('status') == 'passed' and validation.get('trade_date') == day.strftime('%Y%m%d') and validation.get('session') == SESSION, 'Rendered validation mismatch')
    return final


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', required=True)
    args = parser.parse_args()
    try:
        final = render(args.date)
        print(json.dumps({'status': 'rendered', 'edition': final.name, 'providers_called': False, 'published': False}))
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        parser.exit(1, 'Manual render rejected; inspect reviewed inputs and private reservation state. No checkpoint or publishing.\n')


if __name__ == '__main__':
    main()
