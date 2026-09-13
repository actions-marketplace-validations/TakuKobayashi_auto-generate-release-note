import type { OllamaCompletion } from './ollama-stream.js';
import { completionFailures, outputFailures, type ValidationOptions } from './output-validation.js';

type Generation = { content: string; completion: OllamaCompletion };
type Attempt = { limit: number; correction: string; retry: boolean };

// A second attempt is a replacement of the final document, not another analysis
// stage. Both attempts receive the same complete source evidence.
export async function generateCompleteNotes({
  generate,
  initialLimit,
  contextLength,
  validation,
  log = console.log,
}: {
  generate: (attempt: Attempt) => Promise<Generation>;
  initialLimit: number;
  contextLength?: number;
  validation: ValidationOptions;
  log?: (message: string) => void;
}): Promise<string> {
  let limit = initialLimit;
  let correction = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await generate({ limit, correction, retry: attempt > 0 });
    log(
      `Ollama completion: attempt=${attempt + 1} done=${result.completion.done} done_reason=${result.completion.done_reason || 'unknown'} generated-tokens=${result.completion.eval_count ?? 'unknown'} num_predict=${limit}`
    );
    const failures = [
      ...completionFailures(result.completion, limit),
      ...outputFailures(result.content, validation),
    ];
    if (!failures.length) {
      log(`Release notes completed: attempt=${attempt + 1} regenerated=${attempt > 0}`);
      return result.content;
    }
    log(`Release-note output validation failed: ${failures.join('; ')}`);
    if (attempt === 1)
      throw new Error(`Release-note generation failed after regeneration: ${failures.join('; ')}`);

    const capped =
      result.completion.done_reason === 'length' || result.completion.eval_count >= limit;
    // Reserve room for the corrective instruction as well as the unchanged
    // prompt. A model's context contains input AND generated tokens.
    const promptTokens = result.completion.prompt_eval_count;
    const available =
      contextLength && Number.isFinite(promptTokens)
        ? Math.max(1, contextLength - promptTokens - 512)
        : limit * 2;
    limit = Math.min(capped ? limit * 2 : limit, available);
    correction = [
      'The previous attempt did not produce a complete publishable release note.',
      `Problems to correct: ${failures.join('; ')}.`,
      'Write a fresh complete document from the full evidence below. Do not continue the previous text.',
      'Describe each underlying change once per language. Consolidate duplicate evidence, not distinct changes.',
      'Keep every supported change represented; avoid repeating wording or padding sections.',
      validation.bilingual
        ? `Plan space for BOTH complete versions: '# English' and '# ${validation.targetLanguage}'. Finish the translation before stopping.`
        : `Finish the complete ${validation.targetLanguage} document before stopping.`,
      'Close all Markdown constructs. Preserve the requested template and report only supported facts.',
      `Output allowance: ${limit} tokens. Use concise descriptions to complete the document within this allowance.`,
    ].join('\n');
    log(
      `Regenerating complete release notes: num_predict=${limit} repeat_penalty=1.15; full semantic digest preserved`
    );
  }
  throw new Error('Release-note generation did not complete');
}
