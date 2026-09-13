export type OllamaCompletion = {
  done: boolean;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
  eval_duration?: number;
  prompt_eval_duration?: number;
};

export async function readOllamaStream(response, isRepetition?: (content: string) => boolean) {
  const decoder = new TextDecoder();
  let buffered = '';
  let content = '';
  let completion: OllamaCompletion = { done: false };
  let checkedThrough = 0;
  const startedAt = Date.now();
  const progressTimer = setInterval(() => {
    console.log(
      `Ollama generation in progress: elapsed=${Math.floor((Date.now() - startedAt) / 1000)}s received-chars=${content.length}`
    );
  }, 15000);

  const consumeLine = (line) => {
    if (!line.trim()) return;
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch (error) {
      throw new Error(`Ollama returned an invalid streaming response: ${line.slice(0, 200)}`, {
        cause: error,
      });
    }
    if (chunk.error) throw new Error(`Ollama inference failed: ${chunk.error}`);
    if (typeof chunk.message?.content === 'string') content += chunk.message.content;
    if (completion.done) throw new Error('Ollama sent data after its final chunk');
    if (chunk.done === true) {
      completion = chunk;
      const promptSeconds = Number(chunk.prompt_eval_duration || 0) / 1_000_000_000;
      const generationSeconds = Number(chunk.eval_duration || 0) / 1_000_000_000;
      console.log(
        `Ollama token metrics: prompt-tokens=${chunk.prompt_eval_count || 0} prompt-seconds=${promptSeconds.toFixed(2)} generated-tokens=${chunk.eval_count || 0} generation-seconds=${generationSeconds.toFixed(2)}`
      );
    }
  };

  try {
    for await (const value of response) {
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() || '';
      for (const line of lines) consumeLine(line);
      // Stop a confirmed loop without waiting for thousands more tokens. The
      // incomplete result is returned for regeneration, never for publication.
      // Returning from for-await closes the HTTP response stream.
      const completeLinesEnd = content.lastIndexOf('\n') + 1;
      const checkRepetition = !completion.done && completeLinesEnd > checkedThrough;
      checkedThrough = completeLinesEnd;
      if (checkRepetition && isRepetition?.(content.slice(0, completeLinesEnd))) {
        console.log(
          'Ollama attempt interrupted by client: repetitive output; regenerating required'
        );
        return { content: content.trim(), completion };
      }
    }
  } finally {
    clearInterval(progressTimer);
  }

  buffered += decoder.decode();
  if (buffered.trim()) consumeLine(buffered);
  return { content: content.trim(), completion };
}
