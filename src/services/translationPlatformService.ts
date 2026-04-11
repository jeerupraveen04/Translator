import { randomUUID } from "crypto";
import { platformConfig } from "../config/platformConfig";
import { SqliteTranslationRepository } from "../repository/sqliteTranslationRepository";
import type { TranslationRepository } from "../repository/translationRepository";
import type {
  BackfillLanguageRequest,
  BackfillLanguageResponse,
  LanguageStatusResponse,
  ProviderTranslationResult,
  RemediationLanguageSummary,
  RemediationRequest,
  RemediationResponse,
  StoredProviderName,
  TranslateAllLanguageSummary,
  TranslateAllRequest,
  TranslateAllResponse,
  TranslationLanguageRegistry,
  ValidateTranslationsResponse,
  ValidationLanguageSummary,
} from "../types/platform";
import type {
  TranslationObject,
  TranslationProviderName,
  TranslationStringItem,
} from "../types/translation";
import { NotificationService } from "./notificationService";
import { ProviderRouter } from "./providerRouter";

export class TranslationPlatformError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "TranslationPlatformError";
  }
}

type TranslateAllDependencies = {
  repository: TranslationRepository;
  providerRouter: ProviderRouter;
  notifications: NotificationService;
};

function createRequestId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function normalizeLanguageCode(languageCode: string): string {
  return languageCode.trim().toLowerCase();
}

function normalizeRegistry(
  registry: TranslationLanguageRegistry | undefined
): TranslationLanguageRegistry {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new TranslationPlatformError(
      "translation_languages must be an object of languageCode -> languageName.",
      400
    );
  }

  const normalizedEntries = Object.entries(registry).map(([code, name]) => [
    normalizeLanguageCode(code),
    String(name).trim(),
  ]);

  const uniqueCodes = new Set<string>();

  for (const [code] of normalizedEntries) {
    if (uniqueCodes.has(code)) {
      throw new TranslationPlatformError(`Duplicate language code "${code}" is not allowed.`, 400);
    }

    uniqueCodes.add(code);
  }

  return Object.fromEntries(normalizedEntries);
}

function normalizeStrings(
  strings: TranslationObject | TranslationStringItem[] | undefined
): TranslationObject {
  if (!strings) {
    throw new TranslationPlatformError("strings is required.", 400);
  }

  if (Array.isArray(strings)) {
    if (strings.length === 0) {
      throw new TranslationPlatformError("strings must be non-empty.", 400);
    }

    return Object.fromEntries(
      strings.map((item, index) => {
        const key = item.key?.trim();
        const value = item.value ?? item.string;

        if (!key) {
          throw new TranslationPlatformError(`strings[${index}].key is required.`, 400);
        }

        if (typeof value !== "string" || value.trim().length === 0) {
          throw new TranslationPlatformError(
            `strings[${index}] must include a non-empty string or value field.`,
            400
          );
        }

        return [key, value] as const;
      })
    );
  }

  const entries = Object.entries(strings);
  if (entries.length === 0) {
    throw new TranslationPlatformError("strings must be non-empty.", 400);
  }

  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (!key.trim()) {
        throw new TranslationPlatformError("All string keys must be non-empty.", 400);
      }

      if (typeof value !== "string" || value.trim().length === 0) {
        throw new TranslationPlatformError(
          `String "${key}" must contain a non-empty string value.`,
          400
        );
      }

      return [key, value] as const;
    })
  );
}

function mergeLanguageSummary(
  result: ProviderTranslationResult
): TranslateAllLanguageSummary {
  return {
    provider_used: result.primaryProvider,
    fallbacks_used: result.fallbacksUsed,
    attempts: result.attempts,
  };
}

function determinePrimaryProvider(
  providerSummary: Record<string, TranslateAllLanguageSummary>
): StoredProviderName {
  const nonSourceSummaries = Object.values(providerSummary).filter(
    (summary) => summary.provider_used !== "source"
  );
  const providers = Array.from(
    new Set(nonSourceSummaries.map((summary) => summary.provider_used))
  );

  if (providers.length === 0) {
    return "source";
  }

  return providers.length === 1 ? providers[0] : "mixed";
}

function determineFallbackProviders(
  providerSummary: Record<string, TranslateAllLanguageSummary>
): TranslationProviderName[] {
  const fallbacks = new Set<TranslationProviderName>();

  for (const summary of Object.values(providerSummary)) {
    if (summary.provider_used === "source") {
      continue;
    }

    for (const provider of summary.fallbacks_used) {
      fallbacks.add(provider);
    }
  }

  return Array.from(fallbacks);
}

function toTranslationObject(records: Array<{ stringKey: string; translatedText: string }>): TranslationObject {
  return Object.fromEntries(records.map((record) => [record.stringKey, record.translatedText]));
}

function toProviderMap(
  sourceObject: TranslationObject,
  provider: TranslationProviderName
): Record<string, TranslationProviderName> {
  return Object.fromEntries(Object.keys(sourceObject).map((key) => [key, provider]));
}

function ensureSourceLanguageConfigured(
  sourceLanguage: string,
  translationLanguages: TranslationLanguageRegistry
): void {
  if (!(sourceLanguage in translationLanguages)) {
    throw new TranslationPlatformError(
      "source_language must be included in translation_languages.",
      400
    );
  }
}

function normalizeTargetLanguages(
  targetLanguages: string[] | undefined
): string[] | undefined {
  if (targetLanguages === undefined) {
    return undefined;
  }

  if (!Array.isArray(targetLanguages) || targetLanguages.some((item) => typeof item !== "string")) {
    throw new TranslationPlatformError("target_languages must be an array of strings.", 400);
  }

  return targetLanguages.map(normalizeLanguageCode);
}

export class TranslationPlatformService {
  constructor(private readonly dependencies: TranslateAllDependencies) {}

  async translateAll(request: TranslateAllRequest): Promise<TranslateAllResponse> {
    const requestId = request.requestId ?? createRequestId("trn");
    const sourceLanguage = normalizeLanguageCode(
      request.source_language || platformConfig.sourceLanguage
    );
    const translationLanguages = normalizeRegistry(
      request.translation_languages || platformConfig.translationLanguages
    );
    const sourceStrings = normalizeStrings(request.strings);
    const persist = request.persist ?? true;
    const allowOverwriteApproved =
      request.allow_overwrite_approved ?? platformConfig.allowOverwriteApproved;

    ensureSourceLanguageConfigured(sourceLanguage, translationLanguages);

    await this.dependencies.repository.syncLanguages(translationLanguages, sourceLanguage);

    const targetLanguages = Object.keys(translationLanguages);
    const job = await this.dependencies.repository.createJob({
      jobId: randomUUID(),
      requestId,
      jobType: "translate_all",
      status: "running",
      totalKeys: Object.keys(sourceStrings).length * targetLanguages.length,
      translatedKeys: 0,
      failedKeys: 0,
      skippedKeys: 0,
      dryRun: !persist,
      summary: {
        source_language: sourceLanguage,
        target_languages: targetLanguages,
      },
    });

    await this.dependencies.notifications.notify("translation_started", {
      request_id: requestId,
      source_language: sourceLanguage,
      target_languages: targetLanguages,
      string_count: Object.keys(sourceStrings).length,
    });

    const translations: Record<string, TranslationObject> = {
      [sourceLanguage]: sourceStrings,
    };
    const providerSummary: Record<string, TranslateAllLanguageSummary> = {};

    try {
      if (persist) {
        await this.dependencies.repository.upsertTranslations({
          requestId,
          jobId: job.jobId,
          sourceLanguage,
          languageCode: sourceLanguage,
          strings: sourceStrings,
          sourceStrings,
          status: "source",
          providerUsedByKey: toProviderMap(sourceStrings, "source"),
          allowOverwriteApproved,
        });
      }

      for (const languageCode of targetLanguages) {
        if (languageCode === sourceLanguage) {
          providerSummary[languageCode] = {
            provider_used: "source",
            fallbacks_used: [],
            attempts: [],
          };
          continue;
        }

        const result = await this.dependencies.providerRouter.translateObject({
          sourceLanguage,
          targetLanguage: languageCode,
          strings: sourceStrings,
        });

        translations[languageCode] = result.translations;
        providerSummary[languageCode] = mergeLanguageSummary(result);

        if (persist) {
          const upsertResult = await this.dependencies.repository.upsertTranslations({
            requestId,
            jobId: job.jobId,
            sourceLanguage,
            languageCode,
            strings: result.translations,
            sourceStrings,
            status: "auto_generated",
            providerUsedByKey: result.providerUsedByKey,
            allowOverwriteApproved,
          });

          job.translatedKeys += upsertResult.inserted + upsertResult.updated;
          job.skippedKeys += upsertResult.skipped;
        } else {
          job.translatedKeys += Object.keys(result.translations).length;
        }
      }

      await this.dependencies.repository.completeJob(job.jobId, {
        status: "success",
        translatedKeys: job.translatedKeys,
        skippedKeys: job.skippedKeys,
      });

      const response: TranslateAllResponse = {
        request_id: requestId,
        status: "success",
        translations,
        provider_summary: {
          primary: determinePrimaryProvider(providerSummary),
          fallbacks_used: determineFallbackProviders(providerSummary),
          languages: providerSummary,
        },
      };

      await this.dependencies.notifications.notify("translation_completed", {
        request_id: requestId,
        translated_languages: Object.keys(translations),
      });

      return response;
    } catch (error) {
      await this.dependencies.repository.completeJob(job.jobId, {
        status: "failed",
        failedKeys: Object.keys(sourceStrings).length,
      });

      await this.dependencies.notifications.notify("translation_failed", {
        request_id: requestId,
        error: error instanceof Error ? error.message : "Unknown translation failure",
      });

      throw error;
    }
  }

  async backfillLanguage(request: BackfillLanguageRequest): Promise<BackfillLanguageResponse> {
    const requestId = request.requestId ?? createRequestId("trn");
    const sourceLanguage = normalizeLanguageCode(
      request.source_language || platformConfig.sourceLanguage
    );
    const targetLanguage = normalizeLanguageCode(request.target_language || "");
    const translationLanguages = normalizeRegistry(
      request.translation_languages || platformConfig.translationLanguages
    );
    const persist = request.persist ?? true;
    const allowOverwriteApproved =
      request.allow_overwrite_approved ?? platformConfig.allowOverwriteApproved;

    if (!targetLanguage) {
      throw new TranslationPlatformError("target_language is required.", 400);
    }

    ensureSourceLanguageConfigured(sourceLanguage, translationLanguages);

    if (!(targetLanguage in translationLanguages)) {
      throw new TranslationPlatformError(
        "target_language must be included in translation_languages.",
        400
      );
    }

    await this.dependencies.repository.syncLanguages(translationLanguages, sourceLanguage);

    const sourceRecords = await this.dependencies.repository.getStringsByLanguage(sourceLanguage);

    if (sourceRecords.length === 0) {
      throw new TranslationPlatformError(
        `No source strings found for language "${sourceLanguage}" in the repository.`,
        400
      );
    }

    const targetRecords = await this.dependencies.repository.getStringsByLanguage(targetLanguage);
    const sourceStrings = toTranslationObject(sourceRecords);
    const existingTargetKeys = new Set(targetRecords.map((record) => record.stringKey));
    const missingStrings = Object.fromEntries(
      Object.entries(sourceStrings).filter(([key]) => !existingTargetKeys.has(key))
    );

    const job = await this.dependencies.repository.createJob({
      jobId: randomUUID(),
      requestId,
      jobType: "backfill_language",
      targetLanguage,
      status: "running",
      totalKeys: Object.keys(sourceStrings).length,
      translatedKeys: 0,
      failedKeys: 0,
      skippedKeys: targetRecords.length,
      dryRun: !persist,
      summary: {
        source_language: sourceLanguage,
        target_language: targetLanguage,
      },
    });

    if (Object.keys(missingStrings).length === 0) {
      await this.dependencies.repository.completeJob(job.jobId, {
        status: "success",
        translatedKeys: 0,
        skippedKeys: targetRecords.length,
      });

      return {
        request_id: requestId,
        status: "success",
        target_language: targetLanguage,
        translated_count: 0,
        skipped_existing_count: targetRecords.length,
        failed_count: 0,
        translations: {
          [targetLanguage]: {},
        },
      };
    }

    const result = await this.dependencies.providerRouter.translateObject({
      sourceLanguage,
      targetLanguage,
      strings: missingStrings,
    });

    if (persist) {
      const upsertResult = await this.dependencies.repository.upsertTranslations({
        requestId,
        jobId: job.jobId,
        sourceLanguage,
        languageCode: targetLanguage,
        strings: result.translations,
        sourceStrings: missingStrings,
        status: "auto_generated",
        providerUsedByKey: result.providerUsedByKey,
        allowOverwriteApproved,
      });

      job.translatedKeys = upsertResult.inserted + upsertResult.updated;
      job.skippedKeys += upsertResult.skipped;
    } else {
      job.translatedKeys = Object.keys(result.translations).length;
    }

    await this.dependencies.repository.completeJob(job.jobId, {
      status: "success",
      translatedKeys: job.translatedKeys,
      skippedKeys: job.skippedKeys,
    });

    const response: BackfillLanguageResponse = {
      request_id: requestId,
      status: "success",
      target_language: targetLanguage,
      translated_count: job.translatedKeys,
      skipped_existing_count: job.skippedKeys,
      failed_count: 0,
      translations: {
        [targetLanguage]: result.translations,
      },
    };

    await this.dependencies.notifications.notify("backfill_completed", {
      request_id: requestId,
      target_language: targetLanguage,
      translated_count: response.translated_count,
      skipped_existing_count: response.skipped_existing_count,
    });

    return response;
  }

  async validateTranslations(sourceLanguageInput?: string): Promise<ValidateTranslationsResponse> {
    const sourceLanguage = normalizeLanguageCode(sourceLanguageInput || platformConfig.sourceLanguage);
    ensureSourceLanguageConfigured(sourceLanguage, platformConfig.translationLanguages);
    await this.dependencies.repository.syncLanguages(platformConfig.translationLanguages, sourceLanguage);

    const activeLanguages = await this.dependencies.repository.getActiveLanguages();
    const sourceRecords = await this.dependencies.repository.getStringsByLanguage(sourceLanguage);

    if (sourceRecords.length === 0) {
      throw new TranslationPlatformError(
        `No source strings found for language "${sourceLanguage}" in the repository.`,
        400
      );
    }

    const sourceKeys = sourceRecords.map((record) => record.stringKey);
    const sourceKeySet = new Set(sourceKeys);
    const languages: ValidationLanguageSummary[] = [];

    for (const language of activeLanguages) {
      if (language.languageCode === sourceLanguage) {
        continue;
      }

      const targetRecords = await this.dependencies.repository.getStringsByLanguage(language.languageCode);
      const targetKeys = targetRecords.map((record) => record.stringKey);
      const targetKeySet = new Set(targetKeys);
      const missingKeys = sourceKeys.filter((key) => !targetKeySet.has(key));
      const extraKeys = targetKeys.filter((key) => !sourceKeySet.has(key));

      languages.push({
        language: language.languageCode,
        count: targetKeys.length,
        missing: missingKeys.length,
        extra: extraKeys.length,
        missing_keys: missingKeys,
        extra_keys: extraKeys,
        status: missingKeys.length === 0 && extraKeys.length === 0 ? "match" : "mismatch",
      });
    }

    const response: ValidateTranslationsResponse = {
      source_language: sourceLanguage,
      source_count: sourceKeys.length,
      languages,
    };

    await this.dependencies.notifications.notifyValidationSummary(response);

    return response;
  }

  async getLanguageStatus(
    languageCodeInput: string,
    sourceLanguageInput?: string
  ): Promise<LanguageStatusResponse> {
    const languageCode = normalizeLanguageCode(languageCodeInput);
    const validation = await this.validateTranslations(sourceLanguageInput);
    const languageValidation = validation.languages.find((language) => language.language === languageCode);

    if (!languageValidation) {
      throw new TranslationPlatformError(`Language "${languageCode}" is not active.`, 404);
    }

    const latestJob = await this.dependencies.repository.getLatestJob(
      "backfill_language",
      languageCode
    );
    const providerStats = await this.dependencies.repository.getProviderUsageStats(languageCode);

    return {
      language: languageCode,
      count: languageValidation.count,
      missing_keys: languageValidation.missing_keys,
      extra_keys: languageValidation.extra_keys,
      last_job_status: latestJob?.status,
      provider_stats: providerStats,
    };
  }

  async remediateMissingTranslations(request: RemediationRequest): Promise<RemediationResponse> {
    const requestId = ("requestId" in request && typeof request.requestId === "string")
      ? request.requestId
      : createRequestId("rem");
    const sourceLanguage = normalizeLanguageCode(
      request.source_language || platformConfig.sourceLanguage
    );
    const dryRun = request.dry_run ?? false;
    const allowOverwriteApproved =
      request.allow_overwrite_approved ?? platformConfig.allowOverwriteApproved;
    const targetLanguages = normalizeTargetLanguages(request.target_languages);

    ensureSourceLanguageConfigured(sourceLanguage, platformConfig.translationLanguages);
    await this.dependencies.repository.syncLanguages(platformConfig.translationLanguages, sourceLanguage);

    const validation = await this.validateTranslations(sourceLanguage);
    const resolvedTargetLanguages = targetLanguages ?? validation.languages.map((language) => language.language);

    const sourceRecords = await this.dependencies.repository.getStringsByLanguage(sourceLanguage);
    const sourceStrings = toTranslationObject(sourceRecords);
    const job = await this.dependencies.repository.createJob({
      jobId: randomUUID(),
      requestId,
      jobType: "daily_remediation",
      status: "running",
      totalKeys: sourceRecords.length * resolvedTargetLanguages.length,
      translatedKeys: 0,
      failedKeys: 0,
      skippedKeys: 0,
      dryRun,
      summary: {
        source_language: sourceLanguage,
        target_languages: resolvedTargetLanguages,
      },
    });

    const summary: RemediationLanguageSummary[] = [];

    for (const targetLanguage of resolvedTargetLanguages) {
      const status = validation.languages.find((language) => language.language === targetLanguage);

      if (!status) {
        continue;
      }

      if (status.missing_keys.length === 0) {
        summary.push({
          language: targetLanguage,
          detected_missing: 0,
          translated: 0,
          failed: 0,
          skipped: 0,
          missing_keys_sample: [],
        });
        continue;
      }

      const missingStrings = Object.fromEntries(
        status.missing_keys.map((key) => [key, sourceStrings[key]])
      );

      if (dryRun) {
        summary.push({
          language: targetLanguage,
          detected_missing: status.missing_keys.length,
          translated: 0,
          failed: 0,
          skipped: status.missing_keys.length,
          missing_keys_sample: status.missing_keys.slice(0, 10),
        });
        job.skippedKeys += status.missing_keys.length;
        continue;
      }

      try {
        const result = await this.dependencies.providerRouter.translateObject({
          sourceLanguage,
          targetLanguage,
          strings: missingStrings,
        });

        const upsertResult = await this.dependencies.repository.upsertTranslations({
          requestId,
          jobId: job.jobId,
          sourceLanguage,
          languageCode: targetLanguage,
          strings: result.translations,
          sourceStrings: missingStrings,
          status: "auto_generated",
          providerUsedByKey: result.providerUsedByKey,
          allowOverwriteApproved,
        });

        summary.push({
          language: targetLanguage,
          detected_missing: status.missing_keys.length,
          translated: upsertResult.inserted + upsertResult.updated,
          failed: 0,
          skipped: upsertResult.skipped,
          missing_keys_sample: status.missing_keys.slice(0, 10),
        });

        job.translatedKeys += upsertResult.inserted + upsertResult.updated;
        job.skippedKeys += upsertResult.skipped;
      } catch (error) {
        summary.push({
          language: targetLanguage,
          detected_missing: status.missing_keys.length,
          translated: 0,
          failed: status.missing_keys.length,
          skipped: 0,
          missing_keys_sample: status.missing_keys.slice(0, 10),
        });
        job.failedKeys += status.missing_keys.length;
      }
    }

    await this.dependencies.repository.completeJob(job.jobId, {
      status: dryRun
        ? "dry_run"
        : job.failedKeys > 0
          ? "partial_failure"
          : "success",
      translatedKeys: job.translatedKeys,
      failedKeys: job.failedKeys,
      skippedKeys: job.skippedKeys,
    });

    const response: RemediationResponse = {
      request_id: requestId,
      status: "success",
      dry_run: dryRun,
      summary,
    };

    await this.dependencies.notifications.notifyRemediationSummary(response);

    return response;
  }
}

export function createTranslationPlatformService(
  overrides: Partial<TranslateAllDependencies> = {}
): TranslationPlatformService {
  const repository =
    overrides.repository ??
    new SqliteTranslationRepository(platformConfig.databaseFilePath, {
      legacyJsonPath: platformConfig.legacyDataFilePath,
    });
  const providerRouter = overrides.providerRouter ?? new ProviderRouter({
    batchSize: platformConfig.batchSize,
    timeoutMs: platformConfig.providerTimeoutMs,
    retries: platformConfig.providerRetries,
  });
  const notifications = overrides.notifications ?? new NotificationService(repository);

  return new TranslationPlatformService({
    repository,
    providerRouter,
    notifications,
  });
}
