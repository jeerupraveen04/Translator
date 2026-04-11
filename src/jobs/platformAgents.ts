import type {
  BackfillLanguageRequest,
  BackfillLanguageResponse,
  LanguageStatusResponse,
  RemediationRequest,
  RemediationResponse,
  TranslateAllRequest,
  TranslateAllResponse,
  ValidateTranslationsResponse,
} from "../types/platform";
import { TranslationPlatformService } from "../services/translationPlatformService";

export type PlatformAgent<TInput, TOutput> = {
  name: string;
  run: (input: TInput) => Promise<TOutput>;
};

export function createWriteCodeAgent(
  service: TranslationPlatformService
): PlatformAgent<TranslateAllRequest, TranslateAllResponse> {
  return {
    name: "write-code-agent",
    run: (input) => service.translateAll(input),
  };
}

export function createTestCodeAgent(
  service: TranslationPlatformService
): PlatformAgent<string | undefined, ValidateTranslationsResponse> {
  return {
    name: "test-code-agent",
    run: (sourceLanguage) => service.validateTranslations(sourceLanguage),
  };
}

export function createVerifyCodeAgent(
  service: TranslationPlatformService
): PlatformAgent<{ languageCode: string; sourceLanguage?: string }, LanguageStatusResponse> {
  return {
    name: "verify-code-agent",
    run: (input) => service.getLanguageStatus(input.languageCode, input.sourceLanguage),
  };
}

export function createValidateAllCasesAgent(
  service: TranslationPlatformService
): PlatformAgent<RemediationRequest, RemediationResponse> {
  return {
    name: "validate-all-cases-agent",
    run: (input) => service.remediateMissingTranslations(input),
  };
}

export function createBackfillAgent(
  service: TranslationPlatformService
): PlatformAgent<string | BackfillLanguageRequest, BackfillLanguageResponse> {
  return {
    name: "backfill-language-agent",
    run: (input) =>
      service.backfillLanguage(
        typeof input === "string" ? { target_language: input } : input
      ),
  };
}
