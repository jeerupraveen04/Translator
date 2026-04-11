import { awsTranslate, getAwsSupportedLanguages } from "../utils/awsTranslate";
import { azureTranslate, getAzureSupportedLanguages } from "../utils/azureTranslate";
import { deeplTranslateObject, deepLSupportsLanguage } from "../utils/deeplTranslate";
import { geminiTranslate } from "../utils/geminiTranslate";
import type {
  ProviderAttempt,
  ProviderTranslationResult,
} from "../types/platform";
import type { TranslationObject, TranslationProviderName } from "../types/translation";

export type ProviderCallInput = {
  sourceLanguage: string;
  targetLanguage: string;
  strings: TranslationObject;
};

export type ProviderConfig = {
  batchSize: number;
  timeoutMs: number;
  retries: number;
};

type TranslateProviderFn = (
  input: ProviderCallInput
) => Promise<TranslationObject>;

export type ProviderAdapter = {
  name: TranslationProviderName;
  supports: (targetLanguage: string) => Promise<boolean>;
  translate: TranslateProviderFn;
};

type ProviderRouterDependencies = {
  adapters?: ProviderAdapter[];
  sleep?: (ms: number) => Promise<void>;
};

function chunkEntries(input: TranslationObject, batchSize: number): Array<[string, string][]> {
  const entries = Object.entries(input);
  const chunks: Array<[string, string][]> = [];

  for (let index = 0; index < entries.length; index += batchSize) {
    chunks.push(entries.slice(index, index + batchSize));
  }

  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureObjectResponse(
  providerName: TranslationProviderName,
  result: string | TranslationObject
): TranslationObject {
  if (typeof result === "string") {
    throw new Error(`${providerName} returned a string for an object translation request.`);
  }

  return result;
}

function ensureTranslationKeys(
  sourceObject: TranslationObject,
  translatedObject: TranslationObject
): TranslationObject {
  const sourceKeys = Object.keys(sourceObject);
  const translatedKeys = new Set(Object.keys(translatedObject));

  for (const key of sourceKeys) {
    if (!translatedKeys.has(key)) {
      throw new Error("Provider response did not preserve all source keys.");
    }
  }

  return Object.fromEntries(sourceKeys.map((key) => [key, translatedObject[key]]));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, providerName: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${providerName} timed out after ${timeoutMs}ms.`)), timeoutMs);
    }),
  ]);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown translation error";
}

function isTransientError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();

  return [
    "timeout",
    "429",
    "rate limit",
    "tempor",
    "503",
    "502",
    "500",
    "network",
    "econn",
    "etimedout",
    "socket",
  ].some((fragment) => message.includes(fragment));
}

async function retryProviderCall(
  providerName: TranslationProviderName,
  translate: () => Promise<TranslationObject>,
  config: ProviderConfig,
  sleep: (ms: number) => Promise<void>
): Promise<{ result: TranslationObject; attempts: number }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.retries + 1; attempt += 1) {
    try {
      const result = await withTimeout(translate(), config.timeoutMs, providerName);
      return {
        result,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;

      if (!isTransientError(error) || attempt > config.retries) {
        break;
      }

      await sleep(Math.min(1_000 * attempt, 3_000));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${providerName} translation failed.`);
}

function createDefaultAdapters(): ProviderAdapter[] {
  return [
    {
      name: "azure",
      supports: async (targetLanguage) => {
        const languages = await getAzureSupportedLanguages();
        return languages.some((language) => language.code.toLowerCase() === targetLanguage);
      },
      translate: async ({ targetLanguage, strings }) =>
        ensureTranslationKeys(
          strings,
          ensureObjectResponse("azure", await azureTranslate(targetLanguage, strings))
        ),
    },
    {
      name: "aws",
      supports: async (targetLanguage) => {
        const languages = await getAwsSupportedLanguages();
        return languages.includes(targetLanguage);
      },
      translate: async ({ targetLanguage, strings }) =>
        ensureTranslationKeys(
          strings,
          ensureObjectResponse("aws", await awsTranslate(targetLanguage, strings))
        ),
    },
    {
      name: "deepl",
      supports: async (targetLanguage) => deepLSupportsLanguage(targetLanguage),
      translate: async ({ targetLanguage, strings }) =>
        ensureTranslationKeys(strings, await deeplTranslateObject(targetLanguage, strings)),
    },
    {
      name: "gemini",
      supports: async () => true,
      translate: async ({ targetLanguage, strings }) =>
        ensureTranslationKeys(
          strings,
          ensureObjectResponse("gemini", await geminiTranslate(targetLanguage, strings))
        ),
    },
  ];
}

export class ProviderRouter {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly adapterOverrides?: ProviderAdapter[];

  constructor(
    private readonly config: ProviderConfig,
    dependencies: ProviderRouterDependencies = {}
  ) {
    this.adapterOverrides = dependencies.adapters;
    this.sleep = dependencies.sleep ?? delay;
  }

  async translateObject(input: ProviderCallInput): Promise<ProviderTranslationResult> {
    const translated: TranslationObject = {};
    const providerUsedByKey: Record<string, TranslationProviderName> = {};
    const attempts: ProviderAttempt[] = [];
    const usedProviders: TranslationProviderName[] = [];

    if (input.targetLanguage === input.sourceLanguage) {
      return {
        translations: input.strings,
        providerUsedByKey: Object.fromEntries(
          Object.keys(input.strings).map((key) => [key, "source"])
        ),
        primaryProvider: "source",
        fallbacksUsed: [],
        attempts: [],
      };
    }

    const batches = chunkEntries(input.strings, this.config.batchSize);

    for (const batchEntries of batches) {
      const batchObject = Object.fromEntries(batchEntries);
      const batchResult = await this.translateBatch({
        ...input,
        strings: batchObject,
      });

      Object.assign(translated, batchResult.translations);
      Object.assign(providerUsedByKey, batchResult.providerUsedByKey);
      attempts.push(...batchResult.attempts);

      const providersForBatch = Array.from(
        new Set(Object.values(batchResult.providerUsedByKey))
      );

      for (const provider of providersForBatch) {
        if (provider !== "source" && !usedProviders.includes(provider)) {
          usedProviders.push(provider);
        }
      }
    }

    const primaryProvider = usedProviders.length === 0
      ? "source"
      : usedProviders.length === 1
        ? usedProviders[0]
        : "mixed";
    const fallbacksUsed = primaryProvider === "mixed"
      ? usedProviders
      : usedProviders.slice(1);

    return {
      translations: translated,
      providerUsedByKey,
      primaryProvider,
      fallbacksUsed,
      attempts,
    };
  }

  private async translateBatch(input: ProviderCallInput): Promise<ProviderTranslationResult> {
    const attempts: ProviderAttempt[] = [];

    for (const provider of this.getAdapters()) {
      const supported = await provider.supports(input.targetLanguage);

      if (!supported) {
        attempts.push({
          provider: provider.name,
          success: false,
          attemptCount: 0,
          transient: false,
          message: `${provider.name} does not support language "${input.targetLanguage}".`,
        });
        continue;
      }

      try {
        const { result, attempts: attemptCount } = await retryProviderCall(
          provider.name,
          async () => provider.translate(input),
          this.config,
          this.sleep
        );

        const providerUsedByKey = Object.fromEntries(
          Object.keys(result).map((key) => [key, provider.name])
        );

        attempts.push({
          provider: provider.name,
          success: true,
          attemptCount,
        });

        return {
          translations: result,
          providerUsedByKey,
          primaryProvider: provider.name,
          fallbacksUsed: attempts
            .filter((attempt) => !attempt.success)
            .map((attempt) => attempt.provider),
          attempts,
        };
      } catch (error) {
        attempts.push({
          provider: provider.name,
          success: false,
          attemptCount: this.config.retries + 1,
          transient: isTransientError(error),
          message: getErrorMessage(error),
        });
      }
    }

    throw new Error(
      `All providers failed for language "${input.targetLanguage}": ${attempts
        .map((attempt) => `${attempt.provider}: ${attempt.message ?? "failed"}`)
        .join(" | ")}`
    );
  }

  private getAdapters(): ProviderAdapter[] {
    return this.adapterOverrides ?? createDefaultAdapters();
  }
}
