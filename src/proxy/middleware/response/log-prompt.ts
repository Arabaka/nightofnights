import { Request } from "express";
import { config } from "../../../config";
import { logQueue } from "../../../shared/prompt-logging";
import {
  getCompletionFromBody,
  getModelFromBody,
  isImageGenerationRequest,
  isTextGenerationRequest,
} from "../common";
import { ProxyResHandlerWithBody } from ".";
import { assertNever } from "../../../shared/utils";

/** If prompt logging is enabled, enqueues the prompt for logging. */
export const logPrompt: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  responseBody
) => {
  if (!config.promptLogging) {
    return;
  }
  if (typeof responseBody !== "object") {
    throw new Error("Expected body to be an object");
  }

  const loggable =
    isTextGenerationRequest(req) || isImageGenerationRequest(req);
  if (!loggable) return;

  const promptPayload = getPromptForRequest(req);
  const promptFlattened = flattenMessages(promptPayload);
  const response = getCompletionFromBody(req, responseBody);
  const model = getModelFromBody(req, responseBody);

  logQueue.enqueue({
    endpoint: req.inboundApi,
    promptRaw: JSON.stringify(promptPayload),
    promptFlattened,
    model,
    response,
  });
};

type OaiMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type OaiImageResult = {
  prompt: string;
  size: string;
  style: string;
  quality: string;
};

const getPromptForRequest = (
  req: Request
): string | OaiMessage[] | OaiImageResult => {
  // Since the prompt logger only runs after the request has been proxied, we
  // can assume the body has already been transformed to the target API's
  // format.
  switch (req.outboundApi) {
    case "openai":
      return req.body.messages;
    case "openai-text":
      return req.body.prompt;
    case "openai-image":
      return {
        prompt: req.body.prompt,
        size: req.body.size,
        style: req.body.style,
        quality: req.body.quality,
      };
    case "anthropic":
      return req.body.prompt;
    case "google-palm":
      return req.body.prompt.text;
    default:
      assertNever(req.outboundApi);
  }
};

const flattenMessages = (
  val: string | OaiMessage[] | OaiImageResult
): string => {
  if (typeof val === "string") {
    return val.trim();
  }
  if (Array.isArray(val)) {
    return val.map((m) => `${m.role}: ${m.content}`).join("\n");
  }
  return val.prompt.trim();
};
