"""Only synthetic TEST data and mocked invocations. No news/model/auth requests."""
import copy
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import codex_editorial as c

CURATED = c.ROOT if (c.ROOT / 'build_edition.py').is_file() else c.ROOT.parent / 'cloud-private'
ORIGINAL_LOAD = c.load
ORIGINAL_SPEC = c.importlib.util.spec_from_file_location

def mapped_load(path):
    p=Path(path)
    if p.name == 'cloud_config.json': return {'model_isolation_verified': False}
    if p.name == 'editorial.schema.json': return ORIGINAL_LOAD(CURATED/p.name)
    return ORIGINAL_LOAD(path)

def mapped_spec(name,path):
    return ORIGINAL_SPEC(name, CURATED/'build_edition.py')

def fixtures():
    td='20200102'; claims=['indices.COMP','indices.SPX','indices..DJI','up.TESTU','down.TESTD','headline','subheadline','summary','korea.0','korea.1','korea.2']
    source={'id':'TEST','title':'TEST synthetic fixture, not financial news','url':'https://example.invalid/TEST-only','supports':claims,'published_at':'2020-01-02T17:00:00-05:00'}
    cross={s:{'date':td,'close':'110','change_pct':'10.00','source_ids':['TEST']} for s in ('COMP','SPX','.DJI')}
    picks=[{'exchange':'NAS','symbol':'TESTU','name':'TEST Up','direction':'up','close':'110','change_pct':'10.00','source_ids':['TEST']},{'exchange':'NYS','symbol':'TESTD','name':'TEST Down','direction':'down','close':'90','change_pct':'-10.00','source_ids':['TEST']}]
    facts=[{'claim':p['direction']+'.'+p['symbol'],'statement':'TEST synthetic cause only','event_at':'2020-01-02T10:00:00-05:00','source_ids':['TEST']} for p in picks]
    r={'trade_date':td,'session':'regular close','crosscheck':cross,'picks':picks,'sources':[source],'facts':facts}
    def quote(sym,name,close,change,exchange=None):
        q={'symbol':sym,'name':name,'date':td,'previous_date':'20191231','close':close,'previous_close':'100','change_pct':change}
        if exchange:q['exchange']=exchange
        return q
    m={'trade_date':td,'indices':[quote(s,'TEST index','110','10.00') for s in cross]}
    movers={'trade_date':td,'stocks':[quote(p['symbol'],p['name'],p['close'],p['change_pct'],p['exchange']) for p in picks]}
    e={'trade_date':td,'kst_briefing_date':'2020-01-03','reviewed':True,'headline':'TEST fixture\n합성 테스트','subheadline':'TEST','summary':'TEST','up':[],'down':[],'korea':[{'title':'TEST','body':'TEST 조건일 경우 가능'} for _ in range(3)],'sources':[source],'crosscheck':cross,'research_facts':facts,'hashtags':['#TEST']}
    for p in picks:e[p['direction']].append({'symbol':p['symbol'],'name':p['name'],'change_pct':p['change_pct'],'tag':'TEST','why':'TEST synthetic cause only','source_ids':['TEST']})
    return r,m,movers,e

class EditorialTests(unittest.TestCase):
    def setUp(self):
        self.loader=patch.object(c,'load',side_effect=mapped_load); self.loader.start()
        self.spec=patch.object(c.importlib.util,'spec_from_file_location',side_effect=mapped_spec); self.spec.start()
        self.addCleanup(self.loader.stop);self.addCleanup(self.spec.stop)
    def test_compose_renderer_validates_and_preserves_independent_evidence(self):
        r,m,v,e=fixtures();calls=[]
        m['access_token']='TEST-SECRET-NOT-PUBLIC';v['stocks'][0]['broker_private']='TEST-SECRET-NOT-PUBLIC'
        def mock(prompt,schema):calls.append(prompt);return copy.deepcopy(e)
        self.assertEqual(c.compose('2020-01-02',r,m,v,mock),e);self.assertEqual(len(calls),1)
        self.assertNotIn('TEST-SECRET-NOT-PUBLIC',calls[0])
    def test_mismatch_prevents_model_call(self):
        for field in ('close','change_pct'):
            r,m,v,e=fixtures();m['indices'][0][field]='999'
            with self.assertRaises(ValueError):c.compose('2020-01-02',r,m,v,lambda *_:self.fail('must not call model'))
    def test_mover_sign_exchange_and_source_coverage(self):
        for mutate in (lambda r,m,v:r['sources'][0].update(supports=[]),lambda r,m,v:v['stocks'][0].update(exchange='AMS'),lambda r,m,v:v['stocks'][0].update(change_pct='-10')):
            r,m,v,e=fixtures();mutate(r,m,v)
            with self.assertRaises(ValueError):c.compose('2020-01-02',r,m,v,lambda *_:self.fail('must not call'))
    def test_research_rejects_afterclose_future_and_ambiguity(self):
        r,*_=fixtures();r['facts'][0]['event_at']='2020-01-02T16:01:00-05:00'
        with self.assertRaises(ValueError):c.research_check(r,'2020-01-02')
        with self.assertRaises(ValueError):c.day('2099-01-02')
        r,*_=fixtures();r['session']='intraday'
        with self.assertRaises(ValueError):c.research_check(r,'2020-01-02')
    def test_no_output_replacement_or_source_invention(self):
        for mutate in (lambda e:e['crosscheck']['COMP'].update(close='110.01'),lambda e:e['sources'][0].update(title='NEW'),lambda e:e.update(headline='ONE LINE'),lambda e:e.update(summary='x'*3000)):
            r,m,v,e=fixtures();e=copy.deepcopy(e);mutate(e)
            with self.assertRaises(ValueError):c.compose('2020-01-02',r,m,v,lambda *_:e)
    def test_invocation_hygiene_is_not_tool_isolation_verification(self):
        r,*_=fixtures();record={}
        class Process:
            pid=123;returncode=0
            def __init__(self,cmd,**kwargs):
                record.update(cmd=cmd,**kwargs); self.output=Path(cmd[cmd.index('-o')+1])
            def communicate(self,prompt=None,timeout=None):
                record.update(prompt=prompt,timeout=timeout);self.output.write_text(json.dumps(r));return None,None
        with tempfile.TemporaryDirectory(prefix='TEST-auth-') as tmp:
            home=Path(tmp)/'dedicated';home.mkdir(mode=0o700);auth=home/'auth.json';auth.write_text('TEST-ONLY');auth.chmod(0o600)
            secrets={k:'TEST-SECRET-DO-NOT-PASS' for k in ('KIS_APP_KEY','IG_TOKEN','GITHUB_TOKEN','ASSETS_DEPLOY_KEY','CODEX_AUTH_KEY','OPENAI_API_KEY','NODE_OPTIONS')}
            with patch.dict(os.environ,{**secrets,'CODEX_HOME':str(home),'CODEX_MODEL':'TEST-model'},clear=False),patch.object(c,'load',side_effect=lambda p: {'model_isolation_verified': True} if Path(p).name == 'cloud_config.json' else mapped_load(p)),patch.object(c.shutil,'which',return_value='/TEST/codex'),patch.object(c.subprocess,'Popen',Process),patch.object(c.subprocess,'check_output',return_value='codex-cli 0.166.0'):
                self.assertEqual(c.run_codex('PUBLIC TEST',ORIGINAL_LOAD(c.ROOT/'research.schema.json')),r)
            self.assertFalse(set(secrets)&set(record['env']));self.assertEqual(record['env']['CODEX_HOME'],str(home));self.assertLessEqual(record['timeout'],180)
            self.assertIn('features.shell_tool=false',record['cmd']);self.assertIn('web_search="live"',record['cmd']);self.assertNotIn('--full-auto',record['cmd'])
            self.assertNotEqual(record['cwd'],c.ROOT);self.assertFalse(Path(record['cwd']).exists());self.assertEqual(record['prompt'],b'PUBLIC TEST')
    def test_unverified_isolation_blocks_before_any_auth_or_codex_access(self):
        for config in ({}, {'model_isolation_verified': False},
                       {'model_isolation_verified': 'true'}, {'model_isolation_verified': 1}, None):
            with self.subTest(config=config), patch.object(c, 'load', return_value=config), \
                    patch.object(c, 'secure_home') as auth, patch.object(c.shutil, 'which') as which, \
                    patch.object(c.subprocess, 'Popen') as process:
                with self.assertRaisesRegex(c.ModelIsolationError, 'strict web-only tool isolation is not verified'):
                    c.run_codex('TEST PUBLIC', {})
                auth.assert_not_called(); which.assert_not_called(); process.assert_not_called()

    def test_missing_or_invalid_config_blocks_before_auth(self):
        for error in (FileNotFoundError(), ValueError('TEST invalid JSON')):
            with patch.object(c, 'load', side_effect=error), patch.object(c, 'secure_home') as auth:
                with self.assertRaisesRegex(c.ModelIsolationError, 'Model execution disabled'):
                    c.run_codex('TEST PUBLIC', {})
                auth.assert_not_called()

    def test_cli_reports_unverified_isolation_without_auth_or_output(self):
        with tempfile.TemporaryDirectory(prefix='TEST-output-') as tmp:
            target = Path(tmp) / 'research.json'
            error = io.StringIO()
            with patch('sys.argv', ['codex_editorial.py', 'research', '--date', '2020-01-02', '--output', str(target)]), \
                    patch.object(c, 'secure_home') as auth, patch.object(c.subprocess, 'Popen') as process, \
                    patch.object(c, 'load', side_effect=mapped_load), contextlib.redirect_stderr(error):
                with self.assertRaises(SystemExit) as stopped:
                    c.main()
            self.assertEqual(stopped.exception.code, 1)
            self.assertIn('strict web-only tool isolation is not verified', error.getvalue())
            auth.assert_not_called(); process.assert_not_called()
            self.assertFalse(target.exists())

    def test_strict_schema_rejects_unknown_fields(self):
        r,*_=fixtures();r['secret']='TEST'
        with self.assertRaises(ValueError):c.research_check(r,'2020-01-02')

if __name__=='__main__':unittest.main()
