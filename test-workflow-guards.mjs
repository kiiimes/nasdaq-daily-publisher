import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const workflow=fs.readFileSync(new URL('./.github/workflows/daily.yml',import.meta.url),'utf8');
test('session home uses runtime environment, not unavailable job runner context',()=>{
 assert.equal(workflow.includes('CODEX_HOME: $'+'{{ runner.temp }}'),false);
 assert.ok(workflow.includes('printf \'CODEX_HOME=%s/nasdaq-codex-home\\n\' "$RUNNER_TEMP" >> "$GITHUB_ENV"'));
 assert.ok(workflow.indexOf('Initialize isolated session home')<workflow.indexOf('Checkout latest private state'));
});
test('manual render requires explicit date and trusted manual main dispatch only',()=>{
 assert.match(workflow,/options: \[health, connections, editorial, generate, daily, publish, render, repost\]/);
 assert.match(workflow,/trade_date:\n        description: [^\n]+\n        type: string\n        default: ''\n        required: false/);
 const render=workflow.split('\n  render:')[1];
 assert.ok(render);
 for(const gate of ["github.repository == 'kiiimes/nasdaq-daily-publisher'", "github.ref == 'refs/heads/main'", "github.event_name == 'workflow_dispatch'", "inputs.mode == 'render'"]) assert.ok(render.includes(gate));
 assert.match(render,/permissions:\n      contents: read/);
 assert.match(render,/runs-on: macos-latest/);
 assert.match(render,/python-version: '3.13'/);
 assert.match(render,/node-version: '22'/);
 assert.match(render,/Pillow==13.0.0/);
 assert.match(render,/ref: \$\{\{ github.sha \}\}\n          path: source\n          persist-credentials: false/);
 assert.match(render,/repository: kiiimes\/nasdaq-instagram-automation\n          ref: main\n          path: runtime\n          ssh-key: \$\{\{ secrets.STATE_DEPLOY_KEY \}\}/);
 assert.match(render,/run: node source\/stage-runtime.mjs source runtime/);
 assert.match(render,/TRADE_DATE: \$\{\{ inputs.trade_date \}\}/);
 assert.match(render,/run: python3 ..\/source\/manual_render.py --date "\$TRADE_DATE"/);
 assert.match(render,/run: node ..\/source\/manual_render_checkpoint.mjs --date "\$TRADE_DATE"/);
 assert.equal(render.match(/secrets\.[A-Z_]+/g).join(','),'secrets.STATE_DEPLOY_KEY');
 assert.doesNotMatch(render,/vars\.|AUTOMATION_ENABLED|PUBLISH_ENABLED|MODEL_ISOLATION_VERIFIED|CODEX_HOME|CODEX_AUTH_KEY|KIS_APP|IG_ACCESS_TOKEN|ASSETS_DEPLOY_KEY|providerSecrets|codex_session|upload-media|cloud_publish\.mjs (scan|publish|checkpoint)|cloud_daily\.py generate|npm install/);
 assert.doesNotMatch(render,/if: always\(\)|continue-on-error|--overwrite|needs: generate|inputs\.trade_date \}\}[^\n]*run:/);
 assert.ok(render.indexOf('stage-runtime.mjs')<render.indexOf('await materialize(process.cwd())'));
 assert.ok(render.indexOf('await materialize(process.cwd())')<render.indexOf('manual_render.py'));
 assert.ok(render.indexOf('manual_render.py')<render.indexOf('manual_render_checkpoint.mjs'));
});

test('repost requires manual dispatch and passes date through environment',()=>{
 const publish=workflow.slice(workflow.indexOf('  publish:'),workflow.indexOf('  render:'));
 assert.match(publish,/github.event_name == 'workflow_dispatch' && inputs.mode == 'repost'/);
 assert.match(publish,/REPOST_DATE: \$\{\{ inputs.trade_date \}\}/);
 assert.match(publish,/authorize-repost "\$REPOST_DATE"/);
 assert.ok(publish.indexOf('authorize-repost') < publish.indexOf('node cloud_publish.mjs scan'));
});
