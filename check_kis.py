"""Authenticate with KIS and check overseas quotes; contains no order endpoints."""
import hashlib
import json
import os
import re
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).parent
BASE = 'https://openapi.koreainvestment.com:9443'


class BrokerHTTPError(RuntimeError):
    def __init__(self, status, detail):
        self.status = status
        super().__init__(f'HTTP {status}: {detail}')


def retry_read(operation, pause=time.sleep):
    # All callers are authentication or read-only quotations; never order APIs.
    for attempt in range(3):
        try:
            return operation()
        except BrokerHTTPError as error:
            if error.status not in (429, 500, 502, 503, 504) or attempt == 2:
                raise
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
        pause(2 ** (attempt + 1))


def connect():
    config = dict(line.split('=', 1) for line in (ROOT / '.env').read_text().splitlines()
                  if line.strip() and not line.startswith('#'))
    key, secret = config['KIS_APP_KEY'], config['KIS_APP_SECRET']
    sensitive = [key, secret]

    def safe(value):
        value = str(value)
        for item in sensitive:
            value = value.replace(item, '[REDACTED]')
        return value[:300]

    def request_once(path, headers=None, payload=None, params=None):
        url = BASE + path + ('?' + urlencode(params) if params else '')
        req = Request(url, headers={'Content-Type': 'application/json; charset=utf-8', **(headers or {})},
                      data=json.dumps(payload).encode() if payload else None)
        try:
            with urlopen(req, timeout=25) as res:
                body = json.load(res)
        except HTTPError as exc:
            try:
                body = json.loads(exc.read())
                code = str(body.get('error_code') or body.get('msg_cd') or 'UNKNOWN')
                if re.fullmatch(r'[A-Z0-9_]{1,16}', code): print(f'KIS_ERROR {exc.code} {code}', file=sys.stderr)
                detail = safe(body.get('error_description') or body.get('msg1') or body.get('error_code') or '')
            except (ValueError, TypeError):
                detail = 'Non-JSON error response'
            raise BrokerHTTPError(exc.code, detail) from None
        if body.get('rt_cd') not in (None, '0') or 'error_code' in body:
            raise RuntimeError(safe(body.get('msg_cd', body.get('error_code'))) + ': ' + safe(body.get('msg1', body.get('error_description', ''))))
        return body

    def request(path, headers=None, payload=None, params=None):
        return retry_read(lambda: request_once(path, headers, payload, params))

    fingerprint = hashlib.sha256((key + secret).encode()).hexdigest()
    cache_path = ROOT / '.kis-token.json'
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    if cache.get('fingerprint') == fingerprint and cache.get('expires_at', 0) > time.time() + 60:
        token = cache['access_token']
    else:
        auth = request('/oauth2/tokenP', payload={'grant_type': 'client_credentials', 'appkey': key, 'appsecret': secret})
        token = auth.get('access_token')
        if not token:
            raise RuntimeError('Authentication returned no access token')
        cache = {'access_token': token, 'expires_at': time.time() + int(auth.get('expires_in', 86400)), 'fingerprint': fingerprint}
        fd = os.open(cache_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(cache, f)
    sensitive.append(token)
    print('Authentication: OK (production endpoint; token hidden)', flush=True)
    headers = {'authorization': 'Bearer ' + token, 'appkey': key, 'appsecret': secret, 'custtype': 'P'}
    def query(path, tr_id, params):
        return request(path, headers={**headers, 'tr_id': tr_id}, params=params)
    return query


def main():
    query = connect()
    results = []
    for symbol in ('AAPL', 'NVDA', 'MSFT'):
        quote = query('/uapi/overseas-price/v1/quotations/price',
                        'HHDFS00000300', {'AUTH': '', 'EXCD': 'NAS', 'SYMB': symbol})
        out = quote.get('output', {})
        if not out.get('last'):
            raise RuntimeError(f'{symbol}: quote response contains no last price')
        time.sleep(0.2)
        daily = query('/uapi/overseas-price/v1/quotations/dailyprice',
                        'HHDFS76240000',
                        {'AUTH': '', 'EXCD': 'NAS', 'SYMB': symbol, 'GUBN': '0', 'BYMD': '', 'MODP': '0'})
        rows = daily.get('output2') or []
        if not rows:
            raise RuntimeError(f'{symbol}: daily-price response contains no dated rows')
        result = {'symbol': symbol, 'exchange': 'NAS', 'quote': {k: out.get(k) for k in ('last', 'base', 'sign', 'diff', 'rate')},
                  'latest_daily_rows': [{k: row.get(k) for k in ('xymd', 'clos', 'sign', 'diff', 'rate', 'tvol')} for row in rows[:2]]}
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        time.sleep(0.2)
    (ROOT / 'kis-check-result.json').write_text(json.dumps({'checked_at_unix': time.time(), 'results': results}, ensure_ascii=False, indent=2))
    print('PASS: authentication, 3 quotes, and 3 dated daily-price responses.')


if __name__ == '__main__':
    try:
        main()
    except URLError as exc:
        print('Network connection failed: ' + type(exc.reason).__name__, file=sys.stderr)
        sys.exit(2)
    except (RuntimeError, ValueError, KeyError, OSError) as exc:
        print(str(exc) if isinstance(exc, RuntimeError) else 'Local/configuration error: ' + type(exc).__name__, file=sys.stderr)
        sys.exit(1)
