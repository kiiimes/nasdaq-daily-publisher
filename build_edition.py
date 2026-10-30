"""Offline, date-explicit five-card renderer. No network, credentials, or publishing."""
import argparse
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
import html
import json
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import urlsplit
import zipfile
from PIL import Image, ImageDraw, ImageFont

FONT = '/System/Library/Fonts/AppleSDGothicNeo.ttc'
NAVY, BLUE, RED, WHITE, GRAY, PALE = '#132447', '#2459D3', '#D83C44', '#FFFFFF', '#66738A', '#F2F5F9'
INDEX_NAMES = {'COMP': '나스닥', 'SPX': 'S&P 500', '.DJI': '다우'}
DISCLAIMER = '한국장 영향은 뉴스에 기반한 해석이며 이후 국내 실제 반응은 미반영했습니다.'
FILES = {*(f'{i:02d}.png' for i in range(1, 6)), 'caption.txt', 'sources.txt', 'preview.jpg', 'validation.json', 'index.html', 'cards.zip', 'api-images'}
ZIP_FILES = [*(f'{i:02d}.png' for i in range(1, 6)), 'caption.txt', 'sources.txt']


def require(ok, message):
    if not ok:
        raise ValueError(message)


def date(value, fmt):
    require(isinstance(value, str) and re.fullmatch(r'\d{8}' if fmt == '%Y%m%d' else r'\d{4}-\d{2}-\d{2}', value), 'Malformed date')
    result = datetime.strptime(value, fmt).date()
    require(result.strftime(fmt) == value, 'Malformed date')
    return result


def number(value):
    require(not isinstance(value, bool) and isinstance(value, (str, int, float, Decimal)) and len(str(value)) <= 40, 'Invalid number')
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError('Invalid number') from exc
    require(result.is_finite() and abs(result) <= Decimal('1e15') and result.as_tuple().exponent >= -12, 'Unbounded or nonfinite number')
    return result


def text(value, label):
    require(isinstance(value, str) and 0 < len(value.strip()) <= 4000 and '\x00' not in value, 'Invalid text: ' + label)
    return value


def load(path):
    p = Path(path)
    require(p.stat().st_size <= 1_000_000, 'Input exceeds 1 MB')
    return json.loads(p.read_text(encoding='utf-8'), parse_float=Decimal)


def pct(row):
    return f"{number(row['change_pct']):+.2f}%"


def validate(m, e, movers=None):
    td = date(m['trade_date'], '%Y%m%d')
    require(td.weekday() < 5, 'Trade date is a weekend')
    require(e['reviewed'] is True and m['trade_date'] == e['trade_date'], 'Review missing or date mismatch')
    require(date(e['trade_date'], '%Y%m%d') == td and date(e['kst_briefing_date'], '%Y-%m-%d') > td, 'KST briefing must follow US trade date')
    for key in ('headline', 'subheadline', 'summary'):
        text(e[key], key)
    require(len(e['headline'].splitlines()) <= 2, 'Headline exceeds two lines')
    require(all(isinstance(e[k], list) and 1 <= len(e[k]) <= 2 for k in ('up', 'down')), 'Need 1..2 movers per direction')
    require(isinstance(e['korea'], list) and len(e['korea']) == 3, 'Need exactly three Korea items')
    require(isinstance(e['sources'], list) and 1 <= len(e['sources']) <= 100, 'Invalid sources')
    sources, coverage = {}, {}
    for s in e['sources']:
        sid = text(s['id'], 'source id')
        require(sid not in sources, 'Duplicate source ID')
        text(s['title'], 'source title')
        url = urlsplit(text(s['url'], 'source URL'))
        require(url.scheme == 'https' and url.hostname and not url.username and not url.password and not any(c.isspace() for c in s['url']), 'Sources require HTTPS URLs without credentials')
        require(isinstance(s['supports'], list) and s['supports'] and all(isinstance(x, str) for x in s['supports']), 'supports must list claim keys')
        sources[sid] = s
        for claim in s['supports']:
            coverage.setdefault(claim, set()).add(sid)

    def evidence(claim, ids=None):
        ids = list(coverage.get(claim, ())) if ids is None else ids
        require(isinstance(ids, list) and ids and len(ids) == len(set(ids)) and all(isinstance(x, str) and x in sources and claim in sources[x]['supports'] for x in ids), 'Missing source coverage: ' + claim)

    for key in ('headline', 'subheadline', 'summary'):
        evidence(key)
    for i, item in enumerate(e['korea']):
        text(item['title'], 'Korea title'); text(item['body'], 'Korea body')
        evidence(f'korea.{i}')
    indices = m['indices']
    require(isinstance(indices, list) and len(indices) == 3 and {r['symbol'] for r in indices} == set(INDEX_NAMES), 'Need COMP, SPX, .DJI exactly once')
    if movers is not None:
        marker = movers.get('trade_date', movers.get('date'))
        require(marker == m['trade_date'], 'Movers date mismatch')
        date(marker, '%Y%m%d')
    stocks = (movers if movers is not None else m).get('stocks', [])
    require(isinstance(stocks, list) and len(stocks) <= 100, 'Invalid stock collection')
    lookup = {}
    for r in indices + stocks:
        require(date(r['date'], '%Y%m%d') == td and date(r['previous_date'], '%Y%m%d') < td, 'Price date mismatch or invalid prior date')
        close, prev, change = number(r['close']), number(r['previous_close']), number(r['change_pct'])
        require(min(close, prev) > 0, 'Prices must be positive')
        with localcontext() as ctx:
            ctx.prec = 60
            computed = ((close / prev - 1) * 100).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
        require(computed == change, 'Return arithmetic mismatch: ' + r['symbol'])
        if 'daily_history' in r:
            history = r['daily_history']
            require(isinstance(history, list) and len(history) <= 10000, 'Invalid daily history')
            seen = {}
            for h in history:
                hd = date(h['date'], '%Y%m%d'); hc = number(h['close'])
                require(hd <= td and hc > 0 and h['date'] not in seen, 'Invalid history date or close')
                seen[h['date']] = hc
            require(seen.get(r['date']) == close and seen.get(r['previous_date']) == prev, 'History disagrees with closes')
        text(r['symbol'], 'symbol'); text(r['name'], 'instrument name')
        require(r['symbol'] not in lookup, 'Duplicate market symbol')
        lookup[r['symbol']] = r
    require(set(e['crosscheck']) == set(INDEX_NAMES), 'Need three independent index crosschecks')
    crosschecks = []
    for r in indices:
        sym = r['symbol']; c = e['crosscheck'][sym]
        require(date(c['date'], '%Y%m%d') == td, 'Crosscheck date mismatch')
        require(abs(number(c['close']) - number(r['close'])) <= Decimal('.02') and abs(number(c['change_pct']) - number(r['change_pct'])) <= Decimal('.01'), 'Index crosscheck mismatch: ' + sym)
        evidence('indices.' + sym, c['source_ids'])
        crosschecks.append(f"{sym}: close {c['close']}, change {c['change_pct']}%, sources {','.join(c['source_ids'])}")
    selected = set()
    for direction in ('up', 'down'):
        for item in e[direction]:
            sym = item['symbol']
            require(sym in lookup and sym not in INDEX_NAMES and sym not in selected, 'Missing or reused selected symbol')
            selected.add(sym)
            for key in ('name', 'tag', 'why'):
                text(item[key], key)
            require(item['name'] == lookup[sym]['name'] and number(item['change_pct']) == number(lookup[sym]['change_pct']), 'Editorial quote mismatch')
            require(number(item['change_pct']) > 0 if direction == 'up' else number(item['change_pct']) < 0, 'Mover direction mismatch')
            evidence(direction + '.' + sym, item['source_ids'])
    tags = e.get('hashtags', ['#매일나스닥', '#미국증시', '#나스닥', '#한국증시', '#미국주식'])
    require(isinstance(tags, list) and len(tags) <= 5 and all(isinstance(t, str) and re.fullmatch(r'#[\w]+', t) for t in tags), 'Invalid hashtags')
    caption = f"미국 거래일 (US Trade Date): {td.isoformat()} 정규장 마감\n한국 브리핑 (KST Briefing Date): {e['kst_briefing_date']}\n\n{e['headline']}\n{e['subheadline']}\n{e['summary']}\n\n"
    caption += ' · '.join(INDEX_NAMES[s] + ' ' + pct(lookup[s]) for s in INDEX_NAMES) + '\n'
    for direction, label in (('up', '강세 종목'), ('down', '약세 종목')):
        caption += '\n' + label + '\n' + '\n'.join(f"{r['name']} ({r['symbol']}) {pct(r)} | {r['tag']}\n{r['why']}" for r in e[direction]) + '\n'
    caption += '\n한국장 영향\n' + '\n'.join(r['title'] + ': ' + r['body'] for r in e['korea'])
    caption += '\n\n※ 전 거래일 정규장 종가 대비 · 시간외 제외 · 종목은 선정 사례, 전체 시장 순위 아님.\n※ ' + DISCLAIMER
    caption += '\n출처: ' + ', '.join(s['title'] for s in e['sources']) + '\n\n' + ' '.join(tags)
    count = len(re.findall(r'(?<!\w)#[\w]+', caption))
    require(len(caption) <= 2200 and len(caption.encode('utf-16-le')) // 2 <= 2200, 'Caption exceeds 2200 characters')
    require(count <= 5, 'Caption exceeds five hashtags')
    return caption, crosschecks, count


def font(size, bold=False):
    try:
        return ImageFont.truetype(FONT, size, index=6 if bold else 0)
    except OSError as exc:
        raise RuntimeError('Original AppleSDGothicNeo.ttc font unavailable; no substitute silently used') from exc


def fit(draw, box, value, size=32, color=NAVY, bold=False, max_lines=None):
    x, y, right, bottom = box
    for point in range(size, 24, -1):
        f = font(point, bold); lines = []
        # Prefer word boundaries; character fallback handles Korean/unspaced text without loss.
        for paragraph in str(value).split('\n'):
            line = ''
            for char in paragraph:
                candidate = line + char
                b = draw.textbbox((0, 0), candidate, font=f)
                if b[2] - b[0] > right - x and line:
                    cut = line.rfind(' ')
                    if cut > 0:
                        lines.append(line[:cut + 1]); line = line[cut + 1:] + char
                    else:
                        lines.append(line); line = char
                else:
                    line = candidate
            lines.append(line)
        step = max(round(point * 1.4), max((draw.textbbox((0, 0), line, font=f)[3] - draw.textbbox((0, 0), line, font=f)[1] for line in lines), default=0))
        bounds = [draw.textbbox((0, 0), line, font=f) for line in lines]
        if (max_lines is None or len(lines) <= max_lines) and all(b[2] - b[0] <= right - x for b in bounds) and step * len(lines) <= bottom - y:
            for i, (line, b) in enumerate(zip(lines, bounds)):
                draw.text((x - b[0], y + i * step - b[1]), line, font=f, fill=color)
            return
    raise ValueError('Text overflow at minimum 25px: ' + str(value)[:80])


def render_cards(out, m, e):
    trade = date(e['trade_date'], '%Y%m%d')
    weekdays = '월화수목금토일'
    trade_label = trade.strftime('%Y.%m.%d') + '(' + weekdays[trade.weekday()] + ')'
    briefing = '한국시간 ' + e['kst_briefing_date'] + ' 브리핑'
    footer = '미국 ' + trade_label + ' 정규장 마감 · 전 거래일 대비'

    def base(n, title=None):
        dark = n in (1, 5)
        im = Image.new('RGB', (1080, 1350), NAVY if dark else WHITE)
        d = ImageDraw.Draw(im); ink = WHITE if dark else NAVY
        fit(d, (60, 42, 800, 100), 'AFTER / HOURS', 32, ink, True)
        fit(d, (870, 46, 1020, 95), f'{n:02d} / 05', 25, '#A7B8D4' if dark else GRAY)
        if not dark:
            d.line((60, 106, 1020, 106), fill='#DDE3EB', width=2)
            fit(d, (60, 143, 1020, 190), 'KOREA IMPACT' if n == 4 else 'STOCK MOVERS', 26, BLUE, True)
            fit(d, (57, 205, 1020, 310), title, 67, NAVY, True)
            d.line((60, 1218, 1020, 1218), fill='#DDE3EB', width=2)
        fit(d, (60, 1240, 1020, 1286), footer, 25, '#A7B8D4' if dark else GRAY)
        fit(d, (60, 1290, 1020, 1335), briefing + ' · 출처 목록 참조', 25, '#A7B8D4' if dark else GRAY)
        return im, d

    def panel(d, rect):
        d.rounded_rectangle(rect, radius=20, fill=PALE)

    def save(im, n):
        im.save(out / f'{n:02d}.png')
        im.save(out / 'api-images' / f'{n:02d}.jpg', quality=95, subsampling=0)

    im, d = base(1)
    fit(d, (60, 140, 1020, 205), '미국 ' + trade_label + ' 정규장 마감', 40, WHITE, True)
    fit(d, (60, 213, 1020, 265), briefing, 25, '#A7B8D4')
    fit(d, (55, 285, 1020, 558), e['headline'], 79, WHITE, True, 2)
    fit(d, (60, 577, 1020, 680), e['subheadline'], 36, WHITE, True)
    for x, item, col in ((60, e['up'][0], RED), (554, e['down'][0], BLUE)):
        d.rounded_rectangle((x, 710, x + 466, 1007), radius=20, fill=WHITE)
        fit(d, (x + 30, 740, x + 436, 830), item['name'], 32, NAVY, True)
        fit(d, (x + 30, 835, x + 436, 880), item['symbol'], 27, GRAY)
        fit(d, (x + 26, 902, x + 436, 1000), pct(item), 70, col, True)
    quotes = {r['symbol']: r for r in m['indices']}
    fit(d, (60, 1065, 1020, 1205), ' · '.join(INDEX_NAMES[s] + ' ' + pct(quotes[s]) for s in INDEX_NAMES), 33, WHITE, True)
    save(im, 1)
    for n, direction, title, col in ((2, 'up', '강세 종목', RED), (3, 'down', '약세 종목', BLUE)):
        im, d = base(n, title)
        fit(d, (60, 320, 1020, 375), '정규장 · 선정 사례 · 전체 시장 순위 아님', 27, GRAY)
        items = e[direction]
        for y, item in zip((405, 785), items):
            panel(d, (60, y, 1020, y + 345))
            fit(d, (88, y + 22, 735, y + 92), item['name'] + ' · ' + item['symbol'], 33, NAVY, True)
            fit(d, (760, y + 22, 992, y + 92), pct(item), 45, col, True)
            fit(d, (88, y + 102, 992, y + 174), item['tag'], 29, col, True)
            fit(d, (88, y + 184, 992, y + 330), item['why'], 31, GRAY)
        fit(d, (60, 1158, 1020, 1210), '등락 배경은 기업 발표와 보도에 기반한 해석입니다.', 25, GRAY)
        save(im, n)
    im, d = base(4, '한국장에 미칠 영향')
    for i, item in enumerate(e['korea']):
        y = 340 + i * 268
        panel(d, (60, y, 1020, y + 244))
        fit(d, (84, y + 22, 132, y + 75), f'{i + 1:02d}', 26, BLUE, True)
        fit(d, (145, y + 18, 992, y + 86), item['title'], 34, NAVY, True)
        fit(d, (84, y + 94, 992, y + 232), item['body'], 29, GRAY)
    fit(d, (60, 1158, 1020, 1210), '한국장 영향은 뉴스에 기반한 해석입니다.', 25, GRAY)
    save(im, 4)
    im, d = base(5)
    fit(d, (60, 155, 1020, 240), '미국장 마무리', 32, '#A7B8D4')
    fit(d, (55, 275, 1020, 535), '미국장의 움직임,\n한국장의 맥락까지.', 81, WHITE, True, 2)
    d.rounded_rectangle((60, 576, 1020, 970), radius=20, fill=WHITE)
    fit(d, (90, 605, 990, 668), trade.strftime('%m월 %d일') + '을 한 문장으로', 29, GRAY, True)
    fit(d, (90, 694, 990, 940), e['summary'], 42, NAVY, True)
    fit(d, (60, 1025, 1020, 1120), '필요할 때 다시 볼 수 있게 저장해두세요.', 36, WHITE, True)
    fit(d, (60, 1145, 1020, 1210), '강세·약세 / 이유 / 한국장 영향', 29, '#A7B8D4')
    save(im, 5)


def safe_existing(out):
    require(out.is_dir() and not out.is_symlink(), 'Existing output is not a plain edition directory')
    require(all(p.name in FILES and not p.is_symlink() for p in out.iterdir()), 'Refusing overwrite: unknown files or receipts present')
    for p in out.iterdir():
        if p.is_dir():
            require(p.name == 'api-images' and all(q.name in {f'{i:02d}.jpg' for i in range(1, 6)} and q.is_file() and not q.is_symlink() for q in p.iterdir()), 'Refusing overwrite: unknown nested files or receipts')


def build(m, e, output, movers=None, overwrite=False):
    caption, crosschecks, hashtags = validate(m, e, movers)
    out = Path(output).absolute()
    require(not out.is_symlink(), 'Output must not be a symlink')
    out.parent.mkdir(parents=True, exist_ok=True)
    lock = out.parent / ('.' + out.name + '.build-lock')
    lock.mkdir()  # Serialize cooperating builders; fail closed on a stale lock.
    stage = None; backup = None
    try:
        if out.exists():
            require(overwrite, 'Output exists; use --overwrite explicitly')
            safe_existing(out)
        stage = Path(tempfile.mkdtemp(prefix='.' + out.name + '.staging-', dir=out.parent))
        (stage / 'api-images').mkdir()
        render_cards(stage, m, e)
        (stage / 'caption.txt').write_text(caption, encoding='utf-8')
        sources = f"US Trade Date: {e['trade_date']}\nKST Briefing Date: {e['kst_briefing_date']}\nReviewed: source checked by editorial agent, not human approval or automated truth verification.\n" + '\n\n'.join(f"[{s['id']}] {s['title']}\n{s['url']}\nSupports: {', '.join(s['supports'])}" for s in e['sources']) + '\n\nCrosscheck (close tolerance 0.02, pct tolerance 0.01pp):\n' + '\n'.join(crosschecks)
        (stage / 'sources.txt').write_text(sources, encoding='utf-8')
        preview = Image.new('RGB', (1668, 1420), '#E5E9F0')
        for i in range(5):
            with Image.open(stage / f'{i + 1:02d}.png') as card:
                require(card.size == (1080, 1350), 'Wrong image dimensions')
                thumb = card.copy(); thumb.thumbnail((528, 660)); preview.paste(thumb, (24 + i % 3 * 552, 24 + i // 3 * 704))
        preview.save(stage / 'preview.jpg', quality=95)
        images = ''.join(f'<img src="{i:02d}.png" alt="카드 {i}">' for i in range(1, 6))
        (stage / 'index.html').write_text('<!doctype html><html lang="ko"><meta charset="utf-8"><title>' + html.escape(e['trade_date']) + ' 미국장 브리핑</title><style>body{background:#e5e9f0;font-family:system-ui}main{display:flex;gap:20px;overflow:auto}img{width:460px}</style><h1>' + html.escape(e['trade_date']) + ' 미국 정규장 마감</h1><p>KST Briefing Date: ' + html.escape(e['kst_briefing_date']) + '</p><main>' + images + '</main><a href="cards.zip">카드·캡션·출처</a></html>', encoding='utf-8')
        with zipfile.ZipFile(stage / 'cards.zip', 'w', zipfile.ZIP_DEFLATED) as z:
            for name in ZIP_FILES:
                z.write(stage / name, name)
        validation = {'status': 'passed', 'trade_date': e['trade_date'], 'kst_briefing_date': e['kst_briefing_date'], 'session': 'regular close', 'dimensions': [1080, 1350], 'date_return_arithmetic': 'passed', 'hashtags': hashtags, 'crosscheck': '; '.join(crosschecks), 'text_bounds': 'passed; smart wrap, minimum 25px, overflow rejected', 'editorial_mode': 'source checked by agent; not human approval', 'publication_status': 'ready for external publishing checks'}
        (stage / 'validation.json').write_text(json.dumps(validation, ensure_ascii=False, indent=2), encoding='utf-8')
        if out.exists():
            require(overwrite, 'Output appeared during build')
            safe_existing(out)
            backup = Path(tempfile.mkdtemp(prefix='.' + out.name + '.old-', dir=out.parent)); backup.rmdir(); out.rename(backup)
        try:
            stage.rename(out); stage = None
        except BaseException:
            if backup is not None:
                backup.rename(out); backup = None
            raise
        if backup is not None:
            shutil.rmtree(backup)
        return out
    finally:
        if stage is not None:
            shutil.rmtree(stage)
        lock.rmdir()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--market', required=True); p.add_argument('--editorial', required=True)
    p.add_argument('--movers'); p.add_argument('--output', required=True); p.add_argument('--overwrite', action='store_true')
    a = p.parse_args()
    try:
        print(build(load(a.market), load(a.editorial), a.output, load(a.movers) if a.movers else None, a.overwrite))
    except (ValueError, KeyError, TypeError, OSError, RuntimeError) as exc:
        p.exit(1, f'Build rejected: {exc}\n')


if __name__ == '__main__':
    main()
