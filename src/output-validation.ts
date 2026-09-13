import type { OllamaCompletion } from './ollama-stream.js';

// Repetition is a heuristic, not proof of factual correctness. Allow occasional
// repeats (including a shared item in both translations); reject sustained loops.
const MAX_NORMALIZED_LINE_OCCURRENCES = 5;
const MIN_LINES_FOR_DUPLICATE_RATIO = 10;
const MAX_DUPLICATE_CONTENT_RATIO = 0.6;

export type ValidationOptions = {
  bilingual: boolean;
  targetLanguage: string;
  normalizedLanguage: string;
};

export function completionFailures(completion: OllamaCompletion, limit: number): string[] {
  const reasons: string[] = [];
  if (completion.done !== true) reasons.push('stream ended without a final done=true chunk');
  if (completion.done_reason && completion.done_reason !== 'stop') {
    reasons.push(`unexpected Ollama done_reason=${completion.done_reason}`);
  }
  if (completion.eval_count >= limit) {
    reasons.push(`generation reached num_predict: ${completion.eval_count}/${limit} tokens`);
  }
  if (!completion.done_reason && !Number.isFinite(completion.eval_count)) {
    reasons.push('completion has neither done_reason nor generated-token count');
  }
  return reasons;
}

export function outputFailures(notes: string, options: ValidationOptions): string[] {
  if (!notes.trim()) return ['empty release notes'];
  const reasons: string[] = [];
  const prose: string[] = [];
  let fence: string | undefined;
  for (const line of notes.split(/\r?\n/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())
        fence = undefined;
      continue;
    }
    if (!fence) prose.push(line);
  }
  if (fence) reasons.push('incomplete Markdown: unclosed code fence');
  const text = prose.join('\n');
  const last = text.trim().split('\n').at(-1) || '';
  const finalLine = notes.trim().split('\n').at(-1) || '';
  if (/^\s*(?:#{1,6}(?:\s.*)?|[-+*]|\d+[.)]|[-+*]\s+\[[ xX]\])\s*$/.test(finalLine)) {
    reasons.push('incomplete Markdown: dangling heading or empty list item');
  }
  const withoutEscapes = text.replace(/\\./g, '');
  const backticks = withoutEscapes.match(/`+/g) || [];
  let inlineDelimiter: string | undefined;
  for (const run of backticks) {
    if (!inlineDelimiter) inlineDelimiter = run;
    else if (inlineDelimiter === run) inlineDelimiter = undefined;
  }
  if (inlineDelimiter) reasons.push('incomplete Markdown: unclosed inline code');
  if (/\[[^\]\n]*$|\[[^\]\n]+\]\([^\)\n]*$/.test(last)) {
    reasons.push('incomplete Markdown: unfinished link');
  }
  if (/(?:\*\*|__)[^\n]*$/.test(last)) {
    for (const delimiter of ['**', '__']) {
      if ((withoutEscapes.split(delimiter).length - 1) % 2) {
        reasons.push('incomplete Markdown: unclosed emphasis');
        break;
      }
    }
  }

  const lines = prose
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s|^(?:---+|\*\*\*+|___+)$/.test(line));
  const counts = new Map<string, number>();
  let total = 0;
  let duplicate = 0;
  for (const line of lines) {
    const normalized = line
      .normalize('NFKC')
      .toLowerCase()
      .replace(/^(?:[-+*]|\d+[.)])\s+(?:\[[ x]\]\s*)?/, '')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[.!。！]+$/, '')
      .trim();
    if (normalized.length < (/^(?:[-+*]|\d+[.)])\s+/.test(line) ? 2 : 16)) continue;
    const count = (counts.get(normalized) || 0) + 1;
    counts.set(normalized, count);
    total += normalized.length;
    if (count > 1) duplicate += normalized.length;
    if (count === MAX_NORMALIZED_LINE_OCCURRENCES + 1)
      reasons.push(`abnormal repetition: same normalized line occurs ${count} times`);
  }
  if (
    lines.length >= MIN_LINES_FOR_DUPLICATE_RATIO &&
    total > 0 &&
    duplicate / total > MAX_DUPLICATE_CONTENT_RATIO
  ) {
    reasons.push(
      `abnormal repetition: duplicate content ratio=${Math.round((duplicate / total) * 100)}%`
    );
  }

  if (options.bilingual) {
    const headings = [...text.matchAll(/^#\s+(.+?)\s*#*\s*$/gm)];
    const sections = new Map<string, string[]>();
    headings.forEach((heading, index) => {
      const name = heading[1].toLowerCase();
      const body = text.slice(
        heading.index + heading[0].length,
        headings[index + 1]?.index ?? text.length
      );
      sections.set(name, [...(sections.get(name) || []), body]);
    });
    for (const name of ['English', options.targetLanguage]) {
      const bodies = sections.get(name.toLowerCase()) || [];
      if (
        bodies.length !== 1 ||
        !bodies[0].split('\n').some((line) => /[\p{L}\p{N}]/u.test(line) && !/^\s*#/.test(line))
      ) {
        reasons.push(`bilingual output requires one nonempty '# ${name}' section`);
      }
    }
    const localized = sections.get(options.targetLanguage.toLowerCase())?.[0] || '';
    const english = sections.get('english')?.[0] || '';
    if (
      !/[a-zA-Z]{2,}/.test(english.replace(/^\s*#.*$/gm, '').replace(/`[^`]*`|https?:\/\/\S+/g, ''))
    )
      reasons.push('bilingual output has no English text');
    const languageScripts = {
      ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
      ko: /\p{Script=Hangul}/u,
      zh: /\p{Script=Han}/u,
    };
    const script = languageScripts[options.normalizedLanguage.split('-')[0]];
    if (script && !script.test(localized.replace(/^\s*#.*$/gm, '')))
      reasons.push(`bilingual output has no ${options.targetLanguage} text`);
  }
  return reasons;
}

export function assertValidOutput(
  notes: string,
  options: ValidationOptions,
  completionReasons: string[] = []
) {
  const reasons = [...completionReasons, ...outputFailures(notes, options)];
  if (reasons.length)
    throw new Error(`Release-note output validation failed: ${reasons.join('; ')}`);
}
