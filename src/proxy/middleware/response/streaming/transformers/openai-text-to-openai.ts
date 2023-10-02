import { SSEResponseTransformArgs } from "../index";
import { parseEvent } from "../parse-sse";
import { logger } from "../../../../../logger";

const log = logger.child({
  module: "sse-transformer",
  transformer: "openai-text-to-openai",
});

type OpenAITextCompletionStreamEvent = {
  id: string;
  object: "text_completion";
  created: number;
  choices: {
    text: string;
    index: number;
    logprobs: null;
    finish_reason: string | null;
  }[];
  model: string;
};

export const openAITextToOpenAIChat = (params: SSEResponseTransformArgs) => {
  const { data } = params;

  const rawEvent = parseEvent(data);
  if (!rawEvent.data || rawEvent.data === "[DONE]") {
    return { position: -1 };
  }

  const completionEvent = asCompletionEvent(rawEvent.data);
  if (!completionEvent) {
    return { position: -1 };
  }

  const newEvent = {
    id: completionEvent.id,
    object: "chat.completion.chunk" as const,
    created: completionEvent.created,
    model: completionEvent.model,
    choices: [
      {
        index: completionEvent.choices[0].index,
        delta: { content: completionEvent.choices[0].text },
        finish_reason: completionEvent.choices[0].finish_reason,
      },
    ],
  };

  return { position: -1, event: newEvent };
};

function asCompletionEvent(
  event: string
): OpenAITextCompletionStreamEvent | null {
  try {
    const parsed = JSON.parse(event);
    if (Array.isArray(parsed.choices) && parsed.choices[0].text) {
      return parsed;
    } else {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error("Missing required fields");
    }
  } catch (error) {
    log.warn({ error, event }, "Received invalid data event");
  }
  return null;
}
