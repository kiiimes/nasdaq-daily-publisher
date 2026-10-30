"""Fetch date-aligned KIS daily prices, calculating changes from dated closes."""
import argparse
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
import json
from pathlib import Path
import time
from urllib.error import URLError
from check_kis import connect

ROOT = Path(__file__).parent

def normalize(rows, date_key, price_key, day):
    rows = sorted((r for r in rows if r.get(date_key) and r[date_key] <= day), key=lambda r:r[date_key], reverse=True)
    if len(rows)<2 or rows[0][date_key]!=day:
        raise ValueError('Requested trading date missing, or prior close unavailable')
    current, previous = Decimal(rows[0][price_key]), Decimal(rows[1][price_key])
    if not current.is_finite() or not previous.is_finite() or min(current,previous)<=0:
        raise ValueError('Invalid closing price')
    rate=((current/previous-1)*100).quantize(Decimal('.01'),rounding=ROUND_HALF_UP)
    return {'date':day,'previous_date':rows[1][date_key], 'close':str(current), 'previous_close':str(previous),
            'change_pct':str(rate), 'daily_history':[{'date':r[date_key],'close':r[price_key]} for r in rows]}

def fetch(day):
    parsed=datetime.strptime(day,'%Y%m%d')
    start=(parsed-timedelta(days=20)).strftime('%Y%m%d')
    query=connect()
    data={'trade_date':day,'retrieved_at':datetime.now(timezone.utc).isoformat(),'source':'KIS Open API','indices':[],'stocks':[]}
    for symbol,name in [('COMP','나스닥 종합'),('SPX','S&P 500'),('.DJI','다우존스')]:
        r=query('/uapi/overseas-price/v1/quotations/inquire-daily-chartprice','FHKST03030100',{'FID_COND_MRKT_DIV_CODE':'N','FID_INPUT_ISCD':symbol,'FID_INPUT_DATE_1':start,'FID_INPUT_DATE_2':day,'FID_PERIOD_DIV_CODE':'D'})
        item={'symbol':symbol,'name':name,**normalize(r.get('output2') or [],'stck_bsop_date','ovrs_nmix_prpr',day)}
        data['indices'].append(item)
        print(name,item['close'],item['change_pct'],flush=True)
        time.sleep(.3)
    for symbol,name in [('AAPL','애플'),('NVDA','엔비디아'),('MSFT','마이크로소프트')]:
        r=query('/uapi/overseas-price/v1/quotations/dailyprice','HHDFS76240000',{'AUTH':'','EXCD':'NAS','SYMB':symbol,'GUBN':'0','BYMD':day,'MODP':'0'})
        item={'symbol':symbol,'name':name,**normalize(r.get('output2') or [],'xymd','clos',day)}
        data['stocks'].append(item)
        print(name,item['close'],item['change_pct'],flush=True)
        time.sleep(.3)
    out=ROOT/'editions'/parsed.strftime('%Y-%m-%d');out.mkdir(parents=True,exist_ok=True)
    (out/'market.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Saved:',out/'market.json')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--date',required=True,help='US trading date YYYY-MM-DD');args=parser.parse_args()
    try:
        fetch(datetime.strptime(args.date,'%Y-%m-%d').strftime('%Y%m%d'))
    except URLError:
        raise SystemExit('Network unavailable; no edition saved.')
    except (ValueError,RuntimeError) as e:
        raise SystemExit(str(e))
