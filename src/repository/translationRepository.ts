import type {
  LanguageRecord,
  NotificationLogRecord,
  TranslationJobRecord,
  TranslationStringRecord,
  TranslationLanguageRegistry,
  UpsertTranslationInput,
  UpsertTranslationResult,
} from "../types/platform";

export interface TranslationRepository {
  syncLanguages(
    registry: TranslationLanguageRegistry,
    sourceLanguage: string
  ): Promise<LanguageRecord[]>;
  getActiveLanguages(): Promise<LanguageRecord[]>;
  getStringsByLanguage(languageCode: string): Promise<TranslationStringRecord[]>;
  upsertTranslations(input: UpsertTranslationInput): Promise<UpsertTranslationResult>;
  createJob(
    job: Omit<TranslationJobRecord, "startedAt">
  ): Promise<TranslationJobRecord>;
  completeJob(
    jobId: string,
    patch: Partial<Omit<TranslationJobRecord, "jobId" | "requestId" | "jobType" | "startedAt">>
  ): Promise<TranslationJobRecord | undefined>;
  getLatestJob(
    jobType: TranslationJobRecord["jobType"],
    targetLanguage?: string
  ): Promise<TranslationJobRecord | undefined>;
  logNotification(entry: NotificationLogRecord): Promise<void>;
  getProviderUsageStats(
    languageCode: string
  ): Promise<Partial<Record<TranslationStringRecord["providerUsed"], number>>>;
  close?(): Promise<void> | void;
}
