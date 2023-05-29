import type * as http from "http";
import { AnthropicKeyProvider } from "./anthropic/provider";
import { Key, AIService, Model, KeyProvider } from "./index";
import { OpenAIKeyProvider } from "./openai/provider";

export class KeyPool {
  private keyProviders: KeyProvider[] = [];

  constructor() {
    this.keyProviders.push(new OpenAIKeyProvider());
    this.keyProviders.push(new AnthropicKeyProvider());
  }

  public init() {
    this.keyProviders.forEach((provider) => provider.init());
    const availableKeys = this.available();
    if (availableKeys === 0) {
      throw new Error(
        "No keys loaded. Ensure either OPENAI_KEY or ANTHROPIC_KEY is set."
      );
    }
  }

  public get(model: Model): Key {
    const service = this.getService(model);
    return this.getKeyProvider(service).get(model);
  }

  public list(): Omit<Key, "key">[] {
    return this.keyProviders.flatMap((provider) => provider.list());
  }

  public disable(key: Key): void {
    const service = this.getKeyProvider(key.service);
    service.disable(key);
  }

  // TODO: this probably needs to be scoped to a specific provider. I think the
  // only code calling this is the error handler which needs to know how many
  // more keys are available for the provider the user tried to use.
  public available(): number {
    return this.keyProviders.reduce(
      (sum, provider) => sum + provider.available(),
      0
    );
  }

  public anyUnchecked(): boolean {
    return this.keyProviders.some((provider) => provider.anyUnchecked());
  }

  public incrementPrompt(key: Key): void {
    const provider = this.getKeyProvider(key.service);
    provider.incrementPrompt(key.hash);
  }

  public getLockoutPeriod(model: Model): number {
    const service = this.getService(model);
    return this.getKeyProvider(service).getLockoutPeriod(model);
  }

  public markRateLimited(key: Key): void {
    const provider = this.getKeyProvider(key.service);
    provider.markRateLimited(key.hash);
  }

  public updateRateLimits(key: Key, headers: http.IncomingHttpHeaders): void {
    const provider = this.getKeyProvider(key.service);
    if (provider instanceof OpenAIKeyProvider) {
      provider.updateRateLimits(key.hash, headers);
    }
  }

  public remainingQuota(service: AIService): number {
    return this.getKeyProvider(service).remainingQuota();
  }

  public usageInUsd(service: AIService): string {
    return this.getKeyProvider(service).usageInUsd();
  }

  private getService(model: Model): AIService {
    if (model.startsWith("gpt")) {
      // https://platform.openai.com/docs/models/model-endpoint-compatibility
      return "openai";
    } else if (model.startsWith("claude-")) {
      // https://console.anthropic.com/docs/api/reference#parameters
      return "anthropic";
    }
    throw new Error(`Unknown service for model ${model}`);
  }

  private getKeyProvider(service: AIService): KeyProvider {
    return this.keyProviders.find((provider) => provider.service === service)!;
  }
}
