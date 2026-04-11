import { azureTranslate } from "../utils/azureTranslate";
import { awsTranslate } from "../utils/awsTranslate";
import { deeplTranslateObject } from "../utils/deeplTranslate";
import { geminiTranslate } from "../utils/geminiTranslate";
import { platformConfig } from "../config/platformConfig";
import type { ProviderRoutingAttempt, TranslationProviderName } from "../types/platform";

export type ProviderRouteOptions = {
  batchSize?: number;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  backoffMultiplier?: number;
  requestId?: string;
  jobId?: string;
};

export type ProviderRouteResult = {
  languageCode: string;
  result: string | Record<string, string>;
  provider: TranslationProviderName;
  attempts: ProviderRoutingAttempt[];
  fallbackUsed: boolean;
};

export class ProviderRouter {
  private readonly providerOrder: TranslationProviderName[];

  constructor(
    private readonly config = {
      batchSize: platformConfig.batchSize,
      timeoutMs: platformConfig.providerTimeoutMs,
      maxRetries: platformConfig.providerRetries,
      backoffMs: 400,
      backoffMultiplier: 2,
    }
  ) {
    this.providerOrder = ["azure", "aws", "deepl", "gemini"];
  }

  async translate(
    languageCode: string,
    input: string | Record<string, string>,
    options: ProviderRouteOptions = {}
  ): Promise<ProviderRouteResult> {
    return typeof input === "string"
      ? this.translateText(languageCode, input, options)
      : this.translateObject(languageCode, input, options);
  }

  async translateText(
    languageCode: string,
    input: string,
    options: ProviderRouteOptions = {}
  ): Promise<ProviderRouteResult> {
    const attempts: ProviderRoutingAttempt[] = [];

    for (const [index, provider] of this.providerOrder.entries()) {
      const providerResult = await this.tryProvider(provider, languageCode, input, 1, index, options);
      attempts.push(...providerResult.attempts);

      if (providerResult.success) {
        return {
          languageCode: normalizeLanguageCode(languageCode),
          result: providerResult.result as string,
          provider,
          attempts,
          fallbackUsed: index > 0,
        };
      }
    }

    throw new Error(
      `All providers failed for ${languageCode}: ${attempts
        .map((attempt) => `${attempt.provider}#${attempt.attempt}: ${attempt.errorMessage ?? "failed"}`)
        .join(" | ")}`
    );
  }

  async translateObject(
    languageCode: string,
    input: Record<string, string>,
    options: ProviderRouteOptions = {}
  ): Promise<ProviderRouteResult> {
    const batchSize = options.batchSize ?? this.config.batchSize;
    const entries = Object.entries(input);
    const batches = chunkEntries(entries, Math.max(1, batchSize));
    const attempts: ProviderRoutingAttempt[] = [];
    const translatedEntries: Array<[string, string]> = [];
    let winningProvider: TranslationProviderName | undefined;
    let fallbackUsed = false;

    for (const batch of batches) {
      const batchInput = Object.fromEntries(batch);
      let batchSucceeded = false;

      for (const [index, provider] of this.providerOrder.entries()) {
        const providerResult = await this.tryProvider(
          provider,
          languageCode,
          batchInput,
          batch.length,
          index,
          options
        );
        attempts.push(...providerResult.attempts);

        if (providerResult.success) {
          const normalized = normalizeObjectResponse(batchInput, providerResult.result as Record<string, string>);
          translatedEntries.push(...Object.entries(normalized));
          winningProvider = provider;
          fallbackUsed = fallbackUsed || index > 0;
          batchSucceeded = true;
          break;
        }
      }

      if (!batchSucceeded) {
        throw new Error(
          `All providers failed for batch in ${languageCode}: ${attempts
            .slice(-this.providerOrder.length)
            .map((attempt) => `${attempt.provider}#${attempt.attempt}: ${attempt.errorMessage ?? "failed"}`)
            .join(" | ")}`
        );
      }
    }

    const result = Object.fromEntries(
      entries.map(([key]) => [key, translatedEntries.find(([translatedKey]) => translatedKey === key)?.[1] ?? ""])
    );

    return {
      languageCode: normalizeLanguageCode(languageCode),
      result,
      provider: winningProvider ?? this.providerOrder[0],
      attempts,
      fallbackUsed,
    };
  }

  private async tryProvider(
    provider: TranslationProviderName,
    languageCode: string,
    input: string | Record<string, string>,
    batchSize: number,
    fallbackIndex: number,
    options: ProviderRouteOptions
  ): Promise<{ success: boolean; result?: string | Record<string, string>; attempts: ProviderRoutingAttempt[] }> {
    const maxRetries = options.maxRetries ?? this.config.maxRetries;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const backoffMs = options.backoffMs ?? this.config.backoffMs;
    const backoffMultiplier = options.backoffMultiplier ?? this.config.backoffMultiplier;
    const attempts: ProviderRoutingAttempt[] = [];

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      const startedAt = new Date().toISOString();
      let timedOut = false;

      try {
        const rawResult = await withTimeout(
          this.invokeProvider(provider, languageCode, input),
          timeoutMs,
          () => {
            timedOut = true;
            throw new Error(`Provider ${provider} timed out after ${timeoutMs}ms`);
          }
        );
        const result = normalizeResult(input, rawResult);
        const completedAt = new Date().toISOString();

        attempts.push({
          provider,
          attempt,
          success: true,
          transient: false,
          timedOut: false,
          batchSize,
          startedAt,
          completedAt,
          durationMs: Date.parse(completedAt) - Date.parse(startedAt),
          errorMessage: undefined,
          fallbackUsed: fallbackIndex > 0,
          preservedKeys: typeof input !== "string",
          responseKeyCount: typeof result === "string" ? 0 : Object.keys(result).length,
        });

        return { success: true, result, attempts };
      } catch (error) {
        const transient = timedOut || isTransientError(error);
        const completedAt = new Date().toISOString();

        attempts.push({
          provider,
          attempt,
          success: false,
          transient,
          timedOut,
          batchSize,
          startedAt,
          completedAt,
          durationMs: Date.parse(completedAt) - Date.parse(startedAt),
          errorMessage: error instanceof Error ? error.message : String(error),
          fallbackUsed: fallbackIndex > 0,
          preservedKeys: typeof input !== "string",
        });

        if (!transient || attempt === maxRetries + 1) {
          break;
        }

        await delay(backoffMs * backoffMultiplier ** (attempt - 1));
      }
    }

    return { success: false, attempts };
  }

  private async invokeProvider(
    provider: TranslationProviderName,
    languageCode: string,
    input: string | Record<string, string>
  ): Promise<string | Record<string, string>> {
    switch (provider) {
      case "azure":
        return azureTranslate(languageCode, input);
      case "aws":
        return awsTranslate(languageCode, input);
      case "deepl":
        return typeof input === "string"
          ? deeplTranslateObject(languageCode, { value: input }).then((result) => result.value)
          : deeplTranslateObject(languageCode, input);
      case "gemini":
        return geminiTranslate(languageCode, input);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}

function normalizeLanguageCode(languageCode: string): string {
  return languageCode.trim().toLowerCase();
}

function chunkEntries(entries: Array<[string, string]>, batchSize: number): Array<Array<[string, string]>> {
  const batches: Array<Array<[string, string]>> = [];
  for (let index = 0; index < entries.length; index += batchSize) {
    batches.push(entries.slice(index, index + batchSize));
  }
  return batches;
}

function normalizeResult(
  input: string | Record<string, string>,
  output: string | Record<string, string>
): string | Record<string, string> {
  if (typeof input === "string") {
    if (typeof output !== "string") {
      throw new Error("Provider returned an object for a text translation request.");
    }

    return output;
  }

  if (typeof output === "string") {
    throw new Error("Provider returned a string for an object translation request.");
  }

  return normalizeObjectResponse(input, output);
}

function normalizeObjectResponse(
  source: Record<string, string>,
  translated: Record<string, string>
): Record<string, string> {
  const sourceKeys = Object.keys(source);
  const translatedKeys = new Set(Object.keys(translated));
  const missingKeys = sourceKeys.filter((key) => !translatedKeys.has(key));

  if (missingKeys.length > 0) {
    throw new Error(`Provider response did not preserve all source keys: ${missingKeys.join(", ")}`);
  }

  return Object.fromEntries(sourceKeys.map((key) => [key, translated[key] ?? ""]));
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("timeout") || message.includes("temporar") || message.includes("rate limit")) {
      return true;
    }
  }

  const candidate = error as {
    statusCode?: number;
    status?: number;
    code?: string;
    body?: { status?: number; code?: string };
  };

  const status = candidate?.statusCode ?? candidate?.status ?? candidate?.body?.status;
  if (typeof status === "number" && [408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const code = candidate?.code ?? candidate?.body?.code;
  return typeof code === "string" && ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENETUNREACH"].includes(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => never): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      try {
        onTimeout();
      } catch (error) {
        reject(error);
      }
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
