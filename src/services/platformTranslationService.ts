import { platformConfig } from "../config/platformConfig";
import { FileTranslationRepository } from "../repository/platformFileTranslationRepository";
import { normalizeTranslationInput } from "../repository/platformRepository";
import type {
  TranslationRepository,
  UpsertTranslationInput,
} from "../repository/platformRepository";
import type {
  BackfillLanguageResult,
  ProviderRoutingAttempt,
  RemediationLanguageResult,
  RemediationResult,
  TranslationContract,
  TranslationStatusSummary,
  TranslateAllRequest,
  TranslateAllResult,
  ValidationSummary,
} from "../types/platform";
import type { TranslationProviderName } from "../types/translation";
import { createNotificationService, NotificationService } from "./platformNotificationService";
import { ProviderRouter } from "./platformProviderRouter";

export type TranslationPlatformDependencies = {
  repository?: TranslationRepository;
  providerRouter?: ProviderRouter;
  notificationService?: NotificationService;
};

export class TranslationPlatformService {
  constructor(
    private readonly repository: TranslationRepository,
    private readonly providerRouter: ProviderRouter,
    private readonly notificationService: NotificationService
  ) {}

  async translateAll(request: TranslateAllRequest): Promise<TranslateAllResult> {
    const sourceLanguageCode = normalizeLanguageCode(
      request.sourceLanguageCode ?? request.source_language ?? platformConfig.sourceLanguage
    );
    const sourceStrings = normalizeTranslationInput(request.strings ?? {});
    const targetLanguages = this.resolveTargetLanguages(
      request.languages ?? Object.keys(request.translation_languages ?? platformConfig.translationLanguages),
      sourceLanguageCode
    );
    const persist = request.persist ?? true;
    const allowApprovedOverwrite = request.allowApprovedOverwrite ?? request.allow_overwrite_approved ?? false;
    const job = await this.repository.createJob({
      type: "translate-all",
      status: "running",
      sourceLanguageCode,
      targetLanguageCode: undefined,
      dryRun: !persist,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      requestId: request.requestId,
      metadata: {
        allowApprovedOverwrite,
        sourceKeyCount: Object.keys(sourceStrings).length,
        targetLanguages,
      },
    } as any);

    if (persist) {
      await this.repository.syncLanguageRegistry(buildRegistry(platformConfig.translationLanguages, platformConfig.sourceLanguage));
      await this.persistSourceStrings(sourceLanguageCode, sourceStrings, job.id, request.requestId);
    }

    const translations: TranslationContract = {};
    const providerAttempts: Record<string, ProviderRoutingAttempt[]> = {};

    for (const languageCode of targetLanguages) {
      if (languageCode === sourceLanguageCode && !request.includeSourceLanguage) {
        continue;
      }

      if (languageCode === sourceLanguageCode) {
        translations[languageCode] = { ...sourceStrings };
        providerAttempts[languageCode] = [];
        continue;
      }

      const route = await this.providerRouter.translateObject(languageCode, sourceStrings, {
        batchSize: platformConfig.batchSize,
        timeoutMs: platformConfig.providerTimeoutMs,
        maxRetries: platformConfig.providerRetries,
        backoffMs: 400,
        backoffMultiplier: 2,
        requestId: request.requestId,
        jobId: job.id,
      });

      translations[languageCode] = preserveKeyOrder(sourceStrings, route.result as Record<string, string>);
      providerAttempts[languageCode] = route.attempts;

      if (persist) {
        await this.persistTargetStrings(
          sourceLanguageCode,
          languageCode,
          sourceStrings,
          route.result as Record<string, string>,
          route.provider,
          job.id,
          request.requestId,
          allowApprovedOverwrite,
          route.attempts
        );
      }
    }

    await this.repository.updateJob(job.id, {
      status: persist ? "succeeded" : "dry_run",
      completedAt: new Date().toISOString(),
      translatedCount: Object.values(translations).reduce((count, value) => count + Object.keys(value).length, 0),
      processedCount: Object.keys(sourceStrings).length * targetLanguages.length,
    } as any);

    return {
      sourceLanguageCode,
      translations,
      providerAttempts,
      persisted: persist,
      jobId: job.id,
    };
  }

  async backfillLanguage(
    targetLanguageCode: string,
    options: { requestId?: string; dryRun?: boolean } = {}
  ): Promise<BackfillLanguageResult> {
    const sourceLanguageCode = platformConfig.sourceLanguage;
    const targetCode = normalizeLanguageCode(targetLanguageCode);
    const sourceStrings = await this.repository.getSourceStrings(sourceLanguageCode);
    const existingTargetStrings = await this.repository.getTargetStrings(targetCode);
    const missingKeys = Object.keys(sourceStrings).filter((key) => !(key in existingTargetStrings));
    const dryRun = options.dryRun ?? false;

    const job = await this.repository.createJob({
      type: "backfill-language",
      status: dryRun ? "dry_run" : "running",
      sourceLanguageCode,
      targetLanguageCode: targetCode,
      dryRun,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      requestId: options.requestId,
      metadata: { missingKeys },
    } as any);

    if (missingKeys.length === 0) {
      await this.repository.updateJob(job.id, {
        status: dryRun ? "dry_run" : "succeeded",
        completedAt: new Date().toISOString(),
        translatedCount: 0,
        skippedCount: 0,
      } as any);

      return {
        sourceLanguageCode,
        targetLanguageCode: targetCode,
        translations: existingTargetStrings,
        missingKeys: [],
        persisted: !dryRun,
        jobId: job.id,
        providerAttempts: [],
      };
    }

    const missingStrings = Object.fromEntries(missingKeys.map((key) => [key, sourceStrings[key]]));
    const route = await this.providerRouter.translateObject(targetCode, missingStrings, {
      batchSize: platformConfig.batchSize,
      timeoutMs: platformConfig.providerTimeoutMs,
      maxRetries: platformConfig.providerRetries,
      backoffMs: 400,
      backoffMultiplier: 2,
      requestId: options.requestId,
      jobId: job.id,
    });

    if (!dryRun) {
      await this.persistTargetStrings(
        sourceLanguageCode,
        targetCode,
        sourceStrings,
        route.result as Record<string, string>,
        route.provider,
        job.id,
        options.requestId,
        false,
        route.attempts,
        missingKeys
      );
    }

    await this.repository.updateJob(job.id, {
      status: dryRun ? "dry_run" : "succeeded",
      completedAt: new Date().toISOString(),
      translatedCount: missingKeys.length,
      skippedCount: 0,
      missingCount: missingKeys.length,
    } as any);

    return {
      sourceLanguageCode,
      targetLanguageCode: targetCode,
      translations: {
        ...existingTargetStrings,
        ...preserveKeyOrder(missingStrings, route.result as Record<string, string>),
      },
      missingKeys,
      persisted: !dryRun,
      jobId: job.id,
      providerAttempts: route.attempts,
    };
  }

  async validateLanguage(languageCode: string): Promise<ValidationSummary> {
    return this.repository.validateLanguage(languageCode, platformConfig.sourceLanguage);
  }

  async getLanguageStatusSummary(): Promise<TranslationStatusSummary> {
    const report = await this.repository.getValidationReport(platformConfig.sourceLanguage);
    return {
      generatedAt: report.generatedAt,
      sourceLanguageCode: report.sourceLanguageCode,
      lines: report.activeLanguages.map(
        (summary) =>
          `${summary.targetLanguageCode}: ${summary.coveragePercent}% coverage, ${summary.missingCount} missing, ${summary.extraCount} extra`
      ),
      report,
    };
  }

  async runDailyRemediation(options: { dryRun?: boolean } = {}): Promise<RemediationResult> {
    const dryRun = options.dryRun ?? !platformConfig.remediation.enabled;
    const sourceLanguageCode = platformConfig.sourceLanguage;
    const registry = await this.repository.listLanguages();
    const activeTargetCodes = Object.values(registry)
      .filter((entry) => entry.active !== false && !entry.isSource)
      .map((entry) => entry.code)
      .filter((code) => Object.keys(platformConfig.translationLanguages).includes(code));

    const languageResults: RemediationLanguageResult[] = [];
    let totalMissing = 0;
    let totalTranslated = 0;
    let totalSkipped = 0;

    for (const languageCode of activeTargetCodes) {
      const validation = await this.validateLanguage(languageCode);
      totalMissing += validation.missingCount;

      if (validation.missingCount === 0) {
        languageResults.push({
          languageCode,
          dryRun,
          missingKeys: [],
          translatedCount: 0,
          skippedCount: 0,
          providerAttempts: [],
        });
        continue;
      }

      if (dryRun) {
        totalSkipped += validation.missingCount;
        languageResults.push({
          languageCode,
          dryRun,
          missingKeys: validation.missingKeys,
          translatedCount: 0,
          skippedCount: validation.missingCount,
          providerAttempts: [],
        });
        continue;
      }

      const backfill = await this.backfillLanguage(languageCode, { dryRun: false });
      totalTranslated += backfill.missingKeys.length;
      languageResults.push({
        languageCode,
        dryRun,
        missingKeys: backfill.missingKeys,
        translatedCount: backfill.missingKeys.length,
        skippedCount: 0,
        providerAttempts: backfill.providerAttempts,
        jobId: backfill.jobId,
      });
    }

    const summary: RemediationResult = {
      dryRun,
      generatedAt: new Date().toISOString(),
      sourceLanguageCode,
      totalLanguages: languageResults.length,
      totalMissing,
      totalTranslated,
      totalSkipped,
      languageResults,
    };

    await this.notificationService.notifyRemediation(summary);

    return summary;
  }

  private resolveTargetLanguages(requested: string[], sourceLanguageCode: string): string[] {
    const values = requested.length > 0 ? requested : Object.keys(platformConfig.translationLanguages);
    return Array.from(new Set(values.map(normalizeLanguageCode))).filter((code) => code !== sourceLanguageCode);
  }

  private async persistSourceStrings(
    sourceLanguageCode: string,
    sourceStrings: Record<string, string>,
    jobId: string,
    requestId?: string
  ): Promise<void> {
    const payload: UpsertTranslationInput[] = Object.entries(sourceStrings).map(([stringKey, sourceText]) => ({
      stringKey,
      languageCode: sourceLanguageCode,
      sourceLanguageCode,
      sourceText,
      translatedText: sourceText,
      status: "source",
      approvalState: "approved",
      providerUsed: "source",
      requestId,
      jobId,
    }));

      await this.repository.bulkUpsertTranslations(payload, { allowApprovedOverwrite: true, auditMessage: "Persisted source string" });
  }

  private async persistTargetStrings(
    sourceLanguageCode: string,
    targetLanguageCode: string,
    sourceStrings: Record<string, string>,
    translatedStrings: Record<string, string>,
    providerUsed: TranslationProviderName,
    jobId?: string,
    requestId?: string,
    allowApprovedOverwrite = false,
    providerAttempts: ProviderRoutingAttempt[] = [],
    onlyKeys?: string[]
  ): Promise<void> {
    const keys = onlyKeys ?? Object.keys(translatedStrings);
    const payload: UpsertTranslationInput[] = keys.map((stringKey) => ({
      stringKey,
      languageCode: targetLanguageCode,
      sourceLanguageCode,
      sourceText: sourceStrings[stringKey],
      translatedText: translatedStrings[stringKey],
      status: "translated",
      approvalState: "unapproved",
      providerUsed,
      requestId,
      jobId,
      providerAttempts,
    }));

    await this.repository.bulkUpsertTranslations(payload, { allowApprovedOverwrite, auditMessage: "Persisted translated string" });
  }
}

export function createTranslationPlatformService(
  dependencies: TranslationPlatformDependencies = {}
): TranslationPlatformService {
  const repository = dependencies.repository ?? new FileTranslationRepository(platformConfig.dataFilePath);
  const providerRouter = dependencies.providerRouter ?? new ProviderRouter();
  const notificationService = dependencies.notificationService ?? createNotificationService(repository);
  return new TranslationPlatformService(repository, providerRouter, notificationService);
}

function normalizeLanguageCode(languageCode: string): string {
  return languageCode.trim().toLowerCase();
}

function preserveKeyOrder(
  source: Record<string, string>,
  translated: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(Object.keys(source).map((key) => [key, translated[key] ?? ""]));
}

function buildRegistry(
  translationLanguages: Record<string, string>,
  sourceLanguage: string
): Record<string, { code: string; name: string; active: boolean; isSource?: boolean; remediationEnabled?: boolean }> {
  const registry: Record<string, { code: string; name: string; active: boolean; isSource?: boolean; remediationEnabled?: boolean }> = {};
  for (const [code, name] of Object.entries(translationLanguages)) {
    registry[normalizeLanguageCode(code)] = {
      code: normalizeLanguageCode(code),
      name,
      active: true,
      remediationEnabled: true,
    };
  }

  registry[normalizeLanguageCode(sourceLanguage)] = {
    code: normalizeLanguageCode(sourceLanguage),
    name: sourceLanguage.toUpperCase(),
    active: true,
    isSource: true,
    remediationEnabled: true,
  };

  return registry;
}
