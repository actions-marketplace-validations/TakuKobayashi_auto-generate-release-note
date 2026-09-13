import assert from 'node:assert/strict';
import { it } from 'node:test';
import { generateCompleteNotes } from '../src/generation-recovery.js';

const validation = { bilingual: false, targetLanguage: 'English', normalizedLanguage: 'en' };
const complete = {
  content: '## Changes\n- Added audio export.',
  completion: { done: true, done_reason: 'stop', eval_count: 100 },
};

it('regenerates token-limited output with more room, respecting the model context', async () => {
  for (const contextLength of [32768, 26000]) {
    const attempts = [];
    const notes = await generateCompleteNotes({
      initialLimit: 2048,
      contextLength,
      validation,
      log: () => {},
      generate: async (attempt) => {
        attempts.push(attempt);
        return attempts.length === 1
          ? {
              content: '- Added audio',
              completion: {
                done: true,
                done_reason: 'length',
                eval_count: 2048,
                prompt_eval_count: 23140,
              },
            }
          : complete;
      },
    });
    assert.equal(notes, complete.content);
    assert.equal(attempts[1].limit, Math.min(4096, contextLength - 23140 - 512));
    assert.match(attempts[1].correction, /fresh complete document/);
    assert.equal(attempts[1].retry, true);
  }
});

it('does not retry successful generation or retry indefinitely when recovery fails', async () => {
  let calls = 0;
  assert.equal(
    await generateCompleteNotes({
      initialLimit: 2048,
      validation,
      log: () => {},
      generate: async () => {
        calls++;
        return complete;
      },
    }),
    complete.content
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    generateCompleteNotes({
      initialLimit: 2048,
      validation,
      log: () => {},
      generate: async () => {
        calls++;
        return { ...complete, content: '' };
      },
    }),
    /after regeneration.*empty/
  );
  assert.equal(calls, 2);
});
