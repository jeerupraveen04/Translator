import { awsTranslate, getAwsSupportedLanguages } from "../utils/awsTranslate";
import { azureTranslate, getAzureSupportedLanguages } from "../utils/azureTranslate";
import { deeplTranslateObject, deepLSupportsLanguage } from "../utils/deeplTranslate";
import { geminiTranslate } from "../utils/geminiTranslate";
import { getConfiguredTargetLanguages } from "../utils/languageConfig";
import { sendSlackNotification } from "../utils/slackNotifier";
import type {
  BulkTranslateRequestBody,
  BulkTranslateResponseBody,
  TranslationAttempt,
  TranslationObject,
  TranslationProviderName,
  TranslationStringItem,
} from "../types/translation";

const MAX_LANGUAGE_ROUNDS = 5;

export class BulkTranslationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BulkTranslationError";
  }
}

export async function translateBulkStrings(
  request: BulkTranslateRequestBody
): Promise<BulkTranslateResponseBody> {
  validateSourceLanguage(request.sourceLanguage);

  const sourceObject = toTranslationObject(request.strings);
  const targetLanguages = resolveTargetLanguages(request);

  await sendSlackNotification("start", {
    targetLanguages,
    stringCount: Object.keys(sourceObject).length,
  });

  const translations: BulkTranslateResponseBody = {};
  const failureMessages: Record<string, string> = {};
  let remainingLanguages = [...targetLanguages];

  for (let round = 1; round <= MAX_LANGUAGE_ROUNDS && remainingLanguages.length > 0; round += 1) {
    const failedThisRound: string[] = [];

    for (const language of remainingLanguages) {
      try {
        translations[language] = await translateSingleLanguage(language, sourceObject);
        delete failureMessages[language];
      } catch (error) {
        failedThisRound.push(language);
        failureMessages[language] = error instanceof Error ? error.message : "Unknown failure";
      }
    }

    remainingLanguages = failedThisRound;

    if (remainingLanguages.length > 0 && round < MAX_LANGUAGE_ROUNDS) {
      await sendSlackNotification("missed languages", {
        round,
        languages: remainingLanguages,
        failures: failureMessages,
      });
    }
  }

  if (remainingLanguages.length > 0) {
    await sendSlackNotification("failure", {
      untranslatedLanguages: remainingLanguages,
      failures: failureMessages,
    });

    throw new BulkTranslationError(
      "Some languages could not be translated after 5 rounds.",
      502,
      {
        translations,
        untranslatedLanguages: remainingLanguages,
        failures: failureMessages,
      }
    );
  }

  await sendSlackNotification("insert start", {
    translatedLanguages: Object.keys(translations),
  });

  await sendSlackNotification("completion", {
    translatedLanguages: Object.keys(translations),
  });

  return translations;
}

function resolveTargetLanguages(request: BulkTranslateRequestBody): string[] {
  const requestedLanguage = (request.languageCode ?? request.language)?.trim().toLowerCase();

  if (requestedLanguage) {
    return [requestedLanguage];
  }

  const configuredLanguages = Object.keys(getConfiguredTargetLanguages());
  if (configuredLanguages.length === 0) {
    throw new BulkTranslationError(
      "No target language provided and TRANSLATION_TARGET_LANGUAGES is not configured.",
      400
    );
  }

  return configuredLanguages;
}

function validateSourceLanguage(sourceLanguage: string | undefined): void {
  const normalizedSourceLanguage = sourceLanguage?.trim().toLowerCase() ?? "en";

  if (normalizedSourceLanguage !== "en") {
    throw new BulkTranslationError("Only English source strings are supported.", 400);
  }
}

function toTranslationObject(strings: TranslationStringItem[] | undefined): TranslationObject {
  if (!Array.isArray(strings) || strings.length === 0) {
    throw new BulkTranslationError("strings must be a non-empty array.", 400);
  }

  const entries = strings.map((item, index) => {
    const key = item?.key?.trim();
    const value = item?.string ?? item?.value;

    if (!key) {
      throw new BulkTranslationError(`strings[${index}].key is required.`, 400);
    }

    if (typeof value !== "string") {
      throw new BulkTranslationError(
        `strings[${index}] must include a string or value field.`,
        400
      );
    }

    return [key, value] as const;
  });

  return Object.fromEntries(entries);
}

async function translateSingleLanguage(
  language: string,
  sourceObject: TranslationObject
): Promise<TranslationObject> {
  if (language === "en") {
    return sourceObject;
  }

  const attempts: TranslationAttempt[] = [];

  const azureLanguages = await getAzureSupportedLanguages();
  if (azureLanguages.some((item) => item.code.toLowerCase() === language)) {
    try {
      return ensureTranslationKeys(
        sourceObject,
        await asObjectTranslation("azure", azureTranslate(language, sourceObject))
      );
    } catch (error) {
      attempts.push({
        provider: "azure",
        success: false,
        message: getErrorMessage(error),
      });
    }
  } else {
    attempts.push({
      provider: "azure",
      success: false,
      message: `Azure does not support language "${language}".`,
    });
  }

  const awsLanguages = await getAwsSupportedLanguages();
  if (awsLanguages.includes(language)) {
    try {
      return ensureTranslationKeys(
        sourceObject,
        await asObjectTranslation("aws", awsTranslate(language, sourceObject))
      );
    } catch (error) {
      attempts.push({
        provider: "aws",
        success: false,
        message: getErrorMessage(error),
      });
    }
  } else {
    attempts.push({
      provider: "aws",
      success: false,
      message: `AWS does not support language "${language}".`,
    });
  }

  if (await deepLSupportsLanguage(language)) {
    try {
      return ensureTranslationKeys(sourceObject, await deeplTranslateObject(language, sourceObject));
    } catch (error) {
      attempts.push({
        provider: "deepl",
        success: false,
        message: getErrorMessage(error),
      });
    }
  } else {
    attempts.push({
      provider: "deepl",
      success: false,
      message: `DeepL does not support language "${language}" or is unavailable.`,
    });
  }

  try {
    return ensureTranslationKeys(
      sourceObject,
      await asObjectTranslation("gemini", geminiTranslate(language, sourceObject))
    );
  } catch (error) {
    attempts.push({
      provider: "gemini",
      success: false,
      message: getErrorMessage(error),
    });
  }

  throw new Error(
    `All providers failed for language "${language}": ${attempts
      .map((attempt) => `${attempt.provider}: ${attempt.message}`)
      .join(" | ")}`
  );
}

async function asObjectTranslation(
  provider: TranslationProviderName,
  resultPromise: Promise<string | TranslationObject>
): Promise<TranslationObject> {
  const result = await resultPromise;

  if (typeof result === "string") {
    throw new Error(`${provider} returned a string response for an object translation request.`);
  }

  return result;
}

function ensureTranslationKeys(
  sourceObject: TranslationObject,
  translatedObject: TranslationObject
): TranslationObject {
  const sourceKeys = Object.keys(sourceObject);
  const translatedKeys = Object.keys(translatedObject);

  const hasAllKeys = sourceKeys.every((key) => translatedKeys.includes(key));
  if (!hasAllKeys) {
    throw new Error("Provider response did not preserve all source keys.");
  }

  return Object.fromEntries(sourceKeys.map((key) => [key, translatedObject[key]]));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown translation error";
}
