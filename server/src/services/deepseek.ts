import type { z } from 'zod';
import { config } from '../config.js';
import { usage, deepseekCostCents } from './usage.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResult {
  content: string;
  /** 'length' means the model was cut off mid-sentence — JSON will never parse. */
  finishReason: string;
}

async function chat(
  messages: ChatMessage[],
  jsonMode: boolean,
  temperature = 0.9,
): Promise<ChatResult> {
  if (!config.deepseekApiKey) {
    throw Object.assign(new Error('DeepSeek API key not configured'), { statusCode: 503 });
  }
  const res = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      messages,
      temperature: Math.min(Math.max(temperature, 0), 1.5),
      // A 24-tile concept (long art direction + 24 names + collision list)
      // ran into the old 4000-token ceiling and came back cut off, which
      // reads downstream as "not valid JSON" with no clue why.
      max_tokens: 8000,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`DeepSeek error ${res.status}: ${body.slice(0, 500)}`), {
      statusCode: 502,
    });
  }
  const data = (await res.json()) as {
    choices: { message: { content: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices[0]?.message?.content;
  if (!content) throw Object.assign(new Error('DeepSeek returned empty response'), { statusCode: 502 });
  usage.add('deepseek', deepseekCostCents(data.usage?.prompt_tokens, data.usage?.completion_tokens));
  return { content, finishReason: data.choices[0]?.finish_reason ?? 'stop' };
}

/**
 * Pull a JSON object out of a reply that may be wrapped in ```json fences or
 * padded with prose. JSON mode usually prevents both, but a retry turn that
 * quotes the model's own bad output can knock it out of that habit — and a
 * recoverable answer should not be thrown away over punctuation.
 */
export function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

export async function generateText(
  systemPrompt: string,
  userPrompt: string,
  temperature?: number,
): Promise<string> {
  const { content } = await chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    false,
    temperature,
  );
  return content;
}

/**
 * JSON-mode generation validated against a zod schema.
 * On validation failure, retries once with the errors appended.
 */
export async function generateJson<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodType<T>,
  temperature?: number,
): Promise<T> {
  const messages: ChatMessage[] = [
    { role: 'system', content: `${systemPrompt}\n\nRespond ONLY with a single JSON object.` },
    { role: 'user', content: userPrompt },
  ];
  let lastError = '';
  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content: raw, finishReason } = await chat(messages, true, temperature);
    lastRaw = raw;
    let parsed: unknown;
    try {
      // Tolerate fences and stray prose: a recoverable answer should not be
      // discarded over punctuation.
      parsed = JSON.parse(extractJson(raw));
    } catch {
      // Say WHY it failed. "Not valid JSON" after a cut-off reply sent us
      // hunting for a parser bug when the answer was simply too long.
      lastError =
        finishReason === 'length'
          ? 'The reply hit the token limit and was cut off mid-JSON — ask for a smaller answer.'
          : 'Response was not valid JSON.';
      if (finishReason === 'length') break; // retrying the same request just truncates again
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: `That was not valid JSON. ${lastError} Try again.` });
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    lastError = JSON.stringify(result.error.flatten());
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `The JSON did not match the required schema. Errors: ${lastError}. Return a corrected JSON object.`,
    });
  }
  throw Object.assign(
    new Error(`AI output failed schema validation: ${lastError} Model said: ${lastRaw.slice(0, 300)}`),
    { statusCode: 502 },
  );
}
