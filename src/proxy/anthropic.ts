import { Request, RequestHandler, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  addAnthropicPreamble,
  createPreprocessorMiddleware,
  finalizeBody,
  createOnProxyReqHandler,
} from "./middleware/request";
import {
  ProxyResHandlerWithBody,
  createOnProxyResHandler,
} from "./middleware/response";

let modelsCache: any = null;
let modelsCacheTime = 0;

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.anthropicKey) return { object: "list", data: [] };

  const claudeVariants = [
    "claude-v1",
    "claude-v1-100k",
    "claude-instant-v1",
    "claude-instant-v1-100k",
    "claude-v1.3",
    "claude-v1.3-100k",
    "claude-v1.2",
    "claude-v1.0",
    "claude-instant-v1.1",
    "claude-instant-v1.1-100k",
    "claude-instant-v1.0",
    "claude-2",
    "claude-2.0",
    "claude-2.1",
    "claude-3-opus-20240229",
    "claude-3-sonnet-20240229",
  ];

  const models = claudeVariants.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "anthropic",
    permission: [],
    root: "claude",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

/** Only used for non-streaming requests. */
const anthropicResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  if (config.promptLogging) {
    const host = req.get("host");
    body.proxy_note = `Prompts are logged on this proxy instance. See ${host} for more information.`;
  }

  if (req.inboundApi === "openai") {
    req.log.info("Transforming Anthropic text to OpenAI format");
    body = transformAnthropicTextResponseToOpenAI(body, req);
  }

  if (
    req.inboundApi === "anthropic-text" &&
    req.outboundApi === "anthropic-chat"
  ) {
    req.log.info("Transforming Anthropic text to Anthropic chat format");
    body = transformAnthropicChatResponseToAnthropicText(body, req);
  }

  if (req.tokenizerInfo) {
    body.proxy_tokenizer = req.tokenizerInfo;
  }

  res.status(200).json(body);
};

function transformAnthropicChatResponseToAnthropicText(
  anthropicBody: Record<string, any>,
  req: Request
): Record<string, any> {
  return {
    type: "completion",
    id: "trans-" + anthropicBody.id,
    completion: anthropicBody.content
      .map((part: { type: string; text: string }) =>
        part.type === "text" ? part.text : ""
      )
      .join(""),
    stop_reason: anthropicBody.stop_reason,
    stop: anthropicBody.stop_sequence,
    model: anthropicBody.model,
    usage: anthropicBody.usage,
  };
}

/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformAnthropicTextResponseToOpenAI(
  anthropicBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  return {
    id: "ant-" + anthropicBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: anthropicBody.model,
    usage: {
      prompt_tokens: req.promptTokens,
      completion_tokens: req.outputTokens,
      total_tokens: totalTokens,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: anthropicBody.completion?.trim(),
        },
        finish_reason: anthropicBody.stop_reason,
        index: 0,
      },
    ],
  };
}

const anthropicProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.anthropic.com",
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({
        pipeline: [addKey, addAnthropicPreamble, finalizeBody],
      }),
      proxyRes: createOnProxyResHandler([anthropicResponseHandler]),
      error: handleProxyError,
    },
    // Abusing pathFilter to rewrite the paths dynamically.
    pathFilter: (pathname, req) => {
      const isText = req.outboundApi === "anthropic-text";
      const isChat = req.outboundApi === "anthropic-chat";
      if (isChat && pathname === "/v1/complete") {
        req.url = "/v1/messages";
      }
      if (isText && pathname === "/v1/chat/completions") {
        req.url = "/v1/complete";
      }
      if (isChat && pathname === "/v1/claude-3/complete") {
        req.url = "/v1/messages";
      }
      return true;
    },
  }),
});

const nativeTextPreprocessor = createPreprocessorMiddleware({
  inApi: "anthropic-text",
  outApi: "anthropic-text",
  service: "anthropic",
});

const textToChatPreprocessor = createPreprocessorMiddleware({
  inApi: "anthropic-text",
  outApi: "anthropic-chat",
  service: "anthropic",
});

/**
 * Routes text completion prompts to anthropic-chat if they need translation
 * (claude-3 based models do not support the old text completion endpoint).
 */
const claudeTextCompletionRouter: RequestHandler = (req, res, next) => {
  if (req.body.model?.startsWith("claude-3")) {
    textToChatPreprocessor(req, res, next);
  } else {
    nativeTextPreprocessor(req, res, next);
  }
};

const anthropicRouter = Router();
anthropicRouter.get("/v1/models", handleModelRequest);
// Anthropic text completion endpoint. Dynamic routing based on model.
anthropicRouter.post(
  "/v1/complete",
  ipLimiter,
  claudeTextCompletionRouter,
  anthropicProxy
);
// Native Anthropic chat completion endpoint.
anthropicRouter.post(
  "/v1/messages",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "anthropic-chat",
    outApi: "anthropic-chat",
    service: "anthropic",
  }),
  anthropicProxy
);
// OpenAI-to-Anthropic Text compatibility endpoint.
anthropicRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "anthropic-text", service: "anthropic" },
    { afterTransform: [maybeReassignModel] }
  ),
  anthropicProxy
);
// Temporary force Anthropic Text to Anthropic Chat for frontends which do not
// yet support the new model. Forces claude-3. Will be removed once common
// frontends have been updated.
anthropicRouter.post(
  "/v1/claude-3/complete",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "anthropic-text", outApi: "anthropic-chat", service: "anthropic" },
    {
      beforeTransform: [
        (req) => {
          req.body.model = "claude-3-sonnet-20240229";
        },
      ],
    }
  ),
  anthropicProxy
);

function maybeReassignModel(req: Request) {
  const model = req.body.model;
  if (!model.startsWith("gpt-")) return;
  req.body.model = "claude-2.1";
}

export const anthropic = anthropicRouter;
