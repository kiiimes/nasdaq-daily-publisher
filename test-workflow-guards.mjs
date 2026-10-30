import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const workflow=fs.readFileSync(new URL('./.github/workflows/daily.yml',import.meta.url),'utf8');
test('session home uses runtime environment, not unavailable job runner context',()=>{
 assert.equal(workflow.includes('CODEX_HOME: $'+'{{ runner.temp }}'),false);
 assert.ok(workflow.includes('printf \'CODEX_HOME=%s/nasdaq-codex-home\\n\' "$RUNNER_TEMP" >> "$GITHUB_ENV"'));
 assert.ok(workflow.indexOf('Initialize isolated session home')<workflow.indexOf('Checkout latest private state'));
});
