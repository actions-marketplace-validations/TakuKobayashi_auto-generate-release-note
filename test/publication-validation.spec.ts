import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { it } from 'node:test';

it('the built Action publishes only validated output for POST/PATCH and both failure policies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-validation-'));
  const bundle = resolve('dist/index.js');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  let content = '';
  let completion = { done: true, done_reason: 'stop', eval_count: 100 };
  let calls = 0;
  let attemptCalls = 0;
  let recover = false;
  let good = '';
  let originalPrompt = '';
  const server = createServer(async (req, res) => {
    if (req.url === '/api/chat') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (attemptCalls === 0) {
        assert.equal(request.options.num_predict, 4096);
        originalPrompt = request.messages[1].content;
      } else {
        assert.ok(request.messages[1].content.endsWith(originalPrompt));
        assert.match(request.messages[1].content, /Problems to correct/);
        assert.equal(request.options.repeat_penalty, 1.15);
        assert.equal(request.options.repeat_last_n, 256);
      }
      calls++;
      const recovered = attemptCalls++ > 0 && recover;
      res.end(
        JSON.stringify({
          message: { content: recovered ? good : content },
          ...(recovered
            ? { done: true, done_reason: 'stop', eval_count: 100 }
            : {
                ...completion,
                eval_count:
                  completion.eval_count === 4096
                    ? request.options.num_predict
                    : completion.eval_count,
              }),
        }) + '\n'
      );
    } else res.end(JSON.stringify({ models: [], model_info: { 'test.context_length': 32768 } }));
  });
  try {
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'feature.txt'), 'audio export\n');
    git('add', '.');
    git('commit', '-m', 'Add audio export');
    git('tag', 'v1.0.0');
    git('remote', 'add', 'origin', dir);
    const preload = join(dir, 'mock.mjs');
    writeFileSync(
      preload,
      `import { writeFileSync } from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).startsWith('https://api.github.com/')) return original(url, options);
  if (!options.method) return process.env.TEST_EXISTING === 'true' ? new Response(JSON.stringify({ id: 12 })) : new Response('', { status: 404 });
  writeFileSync(process.env.TEST_PAYLOAD, JSON.stringify({ method: options.method, payload: JSON.parse(options.body) }));
  return new Response(JSON.stringify({ html_url: 'https://example.com/release' }));
};`
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    good =
      '# English\n\n## Changes\n- Added audio export.\n\n# Japanese\n\n## 変更内容\n- 音声出力を追加しました。';
    const cases = [
      { text: good, reason: 'stop', count: 100, error: '' },
      {
        text: Array(20).fill('- Added audio export support.').join('\n'),
        reason: 'stop',
        count: 400,
        error: 'repetition',
      },
      { text: good, reason: 'stop', count: 4096, error: 'num_predict' },
      { text: good, reason: 'length', count: 30, error: 'done_reason=length' },
      { text: '# English\n- Added audio export.', reason: 'stop', count: 100, error: 'bilingual' },
      { text: '', reason: 'stop', count: 0, error: 'empty' },
      {
        text: good + '\n```text\npartial',
        reason: 'stop',
        count: 100,
        error: 'unclosed code fence',
      },
    ];
    for (const [index, sample] of cases.entries()) {
      for (const recovery of [false, true]) {
        recover = recovery;
        for (const fail of [false, true]) {
          attemptCalls = 0;
          content = sample.text;
          completion = { done: true, done_reason: sample.reason, eval_count: sample.count };
          const payloadPath = join(dir, `payload-${index}-${fail}-${recovery}.json`);
          const before = calls;
          const result = await new Promise<{ code: number; log: string }>((resolve) => {
            const child = spawn(
              process.execPath,
              ['--import', pathToFileURL(preload).href, bundle],
              {
                cwd: dir,
                env: {
                  ...process.env,
                  GITHUB_REPOSITORY: 'test/repo',
                  INPUT_GITHUB_TOKEN: 'test',
                  INPUT_TAG: 'v1.0.0',
                  INPUT_LANGUAGE: 'ja',
                  INPUT_BILINGUAL: 'true',
                  INPUT_FAIL_ON_LLM_ERROR: String(fail),
                  INPUT_OLLAMA_HOST: `http://127.0.0.1:${address.port}`,
                  TEST_PAYLOAD: payloadPath,
                  TEST_EXISTING: String(fail),
                  GITHUB_OUTPUT: '',
                  GITHUB_STEP_SUMMARY: '',
                },
              }
            );
            let log = '';
            child.stdout.on('data', (chunk) => (log += chunk));
            child.stderr.on('data', (chunk) => (log += chunk));
            child.on('close', (code) => resolve({ code, log }));
          });
          assert.equal(calls - before, sample.error ? 2 : 1, result.log);
          if (sample.error) assert.ok(result.log.includes(sample.error), result.log);
          if (sample.error && fail && !recovery) {
            assert.notEqual(result.code, 0, result.log);
            assert.throws(() => readFileSync(payloadPath));
            assert.match(result.log, /Fallback used=false/);
          } else {
            assert.equal(result.code, 0, result.log);
            const published = JSON.parse(readFileSync(payloadPath, 'utf8'));
            assert.equal(published.method, fail ? 'PATCH' : 'POST');
            assert.match(published.payload.body, /# Japanese/);
            if (sample.error && !recovery) {
              assert.notEqual(published.payload.body, sample.text);
              assert.match(result.log, /Fallback used=true/);
            } else {
              assert.equal(published.payload.body, good);
              assert.match(result.log, /Fallback used=false/);
            }
          }
        }
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
