import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Readable } from 'node:stream';
import { readOllamaStream } from '../src/ollama-stream.js';
import { completionFailures, outputFailures } from '../src/output-validation.js';

const options = { bilingual: false, targetLanguage: 'Japanese', normalizedLanguage: 'ja' };
const english = '# English\n\n## Changes\n- Added audio export.';
const bilingual = `${english}\n\n---\n\n# Japanese\n\n## 変更内容\n- 音声のエクスポートを追加しました。`;

it('rejects the reported v0.4.0 failure: capped Voicevox repetition without Japanese', async () => {
  const content =
    '# English\n\n## New Features\n' +
    '- Added support for generating audio from text using the voicevox API.\n'.repeat(20) +
    '- Added support for generating audio from text using';
  const result = await readOllamaStream(
    Readable.from([
      Buffer.from(
        JSON.stringify({
          message: { content },
          done: true,
          eval_count: 2048,
          prompt_eval_count: 23140,
        })
      ),
    ])
  );
  const failures = [
    ...completionFailures(result.completion, 2048),
    ...outputFailures(result.content, { ...options, bilingual: true }),
  ];
  assert.match(failures.join('; '), /num_predict/);
  assert.match(failures.join('; '), /repetition/);
  assert.match(failures.join('; '), /Japanese/);
});

it('detects repetition when a network chunk also contains the next partial line', async () => {
  const line = '- Added support for generating audio from text using the voicevox API.\n';
  let consumed = 0;
  async function* chunks() {
    consumed++;
    yield Buffer.from(
      JSON.stringify({ message: { content: line.repeat(6) + '- Added' }, done: false }) + '\n'
    );
    consumed++;
    yield Buffer.from(JSON.stringify({ message: { content: ' more' }, done: false }) + '\n');
  }
  await readOllamaStream(chunks(), (text) =>
    outputFailures(text, options).some((reason) => reason.startsWith('abnormal repetition:'))
  );
  assert.equal(consumed, 1);
});

it('interrupts a streaming repetition before exhausting the output allowance', async () => {
  let consumed = 0;
  async function* chunks() {
    for (let i = 0; i < 100; i++) {
      consumed++;
      yield Buffer.from(
        JSON.stringify({ done: false, message: { content: '- Added audio export support.\n' } }) +
          '\n'
      );
    }
  }
  const result = await readOllamaStream(chunks(), (text) =>
    outputFailures(text, options).some((reason) => reason.startsWith('abnormal repetition:'))
  );
  assert.equal(consumed, 6);
  assert.equal(result.completion.done, false);
  assert.match(outputFailures(result.content, options).join(), /repetition/);
});

it('accepts complete single-language and bilingual notes and occasional duplicates', () => {
  for (const notes of [
    '## Changes\n- Added audio export',
    '## 変更内容\n- 音声の出力を追加。',
    '- Shared compatibility information.\n- Shared compatibility information.',
  ]) {
    assert.deepEqual(outputFailures(notes, options), []);
  }
  assert.deepEqual(outputFailures(bilingual, { ...options, bilingual: true }), []);
  assert.deepEqual(outputFailures('- See [migration](https://example.com).', options), []);
  assert.deepEqual(outputFailures('- Use ``a ` b`` to escape a backtick.', options), []);
  assert.deepEqual(outputFailures('## Example\n```text\ncompleted\n```', options), []);
});

it('rejects empty, missing, empty or falsely labeled translations', () => {
  assert.match(outputFailures(' ', options).join(), /empty/);
  for (const notes of [
    english,
    `${english}\n# Japanese`,
    `${english}\n# Japanese\n- Added audio export.`,
  ]) {
    assert.match(outputFailures(notes, { ...options, bilingual: true }).join(), /bilingual/);
  }
});

it('detects normalized bullet repetition and excessive overall duplicates', () => {
  const notes = Array.from(
    { length: 12 },
    (_, i) => `${i + 1}. **Added audio export support.**`
  ).join('\n');
  assert.match(outputFailures(notes, options).join(), /repetition/);
  assert.match(
    outputFailures(Array(10).fill('- 修正しました。').join('\n'), options).join(),
    /repetition/
  );
  const block = [
    '- Added recording support for Android.',
    '- Added recording support for Unity.',
    '- Added recording support for browsers.',
  ].join('\n');
  assert.match(outputFailures(Array(4).fill(block).join('\n'), options).join(), /ratio/);
});

it('rejects clear Markdown truncation without requiring sentence punctuation', () => {
  for (const notes of [
    '## Changes\n```ts\nconst x = 1',
    '- Added `export',
    '- See [migration](https://example.com',
    '## Changes\n-',
    '## Changes\n- Added support\n## Fixes',
    '- Added **audio',
  ]) {
    assert.match(outputFailures(notes, options).join(), /incomplete Markdown/, notes);
  }
  assert.deepEqual(
    outputFailures('## Changes\n- Added `export`\n\n```text\nexample\n```', options),
    []
  );
});

it('rejects token caps even with stop, length stops and absent final chunks', () => {
  for (const completion of [
    { done: true, done_reason: 'stop', eval_count: 2048 },
    { done: true, done_reason: 'length', eval_count: 12 },
    { done: false },
    { done: true },
  ]) {
    assert.ok(completionFailures(completion, 2048).length);
  }
  assert.deepEqual(
    completionFailures({ done: true, done_reason: 'stop', eval_count: 100 }, 2048),
    []
  );
  assert.deepEqual(completionFailures({ done: true, eval_count: 100 }, 2048), []);
});

it('retains final metrics across byte boundaries and an unterminated final JSON line', async () => {
  const completion = {
    done: true,
    done_reason: 'length',
    eval_count: 2048,
    prompt_eval_count: 23140,
    eval_duration: 1842370000000,
  };
  const bytes = Buffer.from(
    JSON.stringify({ message: { content: '日本語' }, done: false }) +
      '\n' +
      JSON.stringify(completion)
  );
  const result = await readOllamaStream(
    Readable.from([...bytes].map((byte) => Buffer.from([byte])))
  );
  assert.equal(result.content, '日本語');
  assert.deepEqual(result.completion, completion);
  assert.equal(
    (await readOllamaStream(Readable.from([Buffer.from('{"message":{"content":"partial"}}\n')])))
      .completion.done,
    false
  );
  await assert.rejects(
    readOllamaStream(Readable.from([Buffer.from('invalid\n')])),
    /invalid streaming/
  );
});
