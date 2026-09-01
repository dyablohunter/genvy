import type { z } from 'zod';
import { config } from '../config.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chat(messages: ChatMessage[], jsonMode: boolean, temperature = 0.9): Promise<string> {
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
      max_tokens: 4000,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`DeepSeek error ${res.status}: ${body.slice(0, 500)}`), {
      statusCode: 502,
    });
  }
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const content = data.choices[0]?.message?.content;
  if (!content) throw Object.assign(new Error('DeepSeek returned empty response'), { statusCode: 502 });
  return content;
}

export async function generateText(
  systemPrompt: string,
  userPrompt: string,
  temperature?: number,
): Promise<string> {
  return chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    false,
    temperature,
  );
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(messages, true, temperature);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      lastError = 'Response was not valid JSON.';
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
  throw Object.assign(new Error(`AI output failed schema validation: ${lastError}`), {
    statusCode: 502,
  });
}
