import type {
  NotificationLogEntry,
  PlatformLanguageRegistry,
  StoredTranslation,
  TranslationAuditRow,
  TranslationJob,
  ValidationReport,
  ValidationSummary,
  TranslateAllRequest,
} from "../types/platform";
import type { TranslationStringInput } from "../types/translation";

export type UpsertTranslationInput = {
  stringKey: string;
  languageCode: string;
  sourceLanguageCode: string;
  sourceText: string;
  translatedText: string;
  status: StoredTranslation["status"];
  approvalState?: StoredTranslation["approvalState"];
  providerUsed: StoredTranslation["providerUsed"];
  requestId?: string;
  jobId?: string;
  approvedAt?: string;
  approvedBy?: string;
  fallbackUsed?: boolean;
  providerAttempts?: StoredTranslation["providerAttempts"];
  metadata?: Record<string, unknown>;
};

export type UpsertTranslationResult = {
  translation: StoredTranslation;
  inserted: boolean;
  updated: boolean;
  skipped: boolean;
  skippedBecauseApproved: boolean;
};

export type RepositorySnapshot = {
  sourceLanguageCode: string;
  translationLanguages: PlatformLanguageRegistry;
  translations: StoredTranslation[];
  audits: TranslationAuditRow[];
  jobs: TranslationJob[];
  notifications: NotificationLogEntry[];
};

export interface TranslationRepository {
  syncLanguageRegistry(registry: PlatformLanguageRegistry): Promise<void>;
  listLanguages(): Promise<PlatformLanguageRegistry>;
  getLanguage(languageCode: string): Promise<PlatformLanguageRegistry[string] | undefined>;
  getSourceStrings(sourceLanguageCode?: string): Promise<Record<string, string>>;
  getTargetStrings(languageCode: string): Promise<Record<string, string>>;
  listTranslations(languageCode?: string): Promise<StoredTranslation[]>;
  getTranslation(languageCode: string, stringKey: string): Promise<StoredTranslation | undefined>;
  upsertTranslation(
    input: UpsertTranslationInput,
    options?: {
      allowApprovedOverwrite?: boolean;
      auditMessage?: string;
      actor?: string;
    }
  ): Promise<UpsertTranslationResult>;
  bulkUpsertTranslations(
    inputs: UpsertTranslationInput[],
    options?: {
      allowApprovedOverwrite?: boolean;
      auditMessage?: string;
      actor?: string;
    }
  ): Promise<UpsertTranslationResult[]>;
  appendAudit(row: Omit<TranslationAuditRow, "id" | "timestamp">): Promise<TranslationAuditRow>;
  listAudits(): Promise<TranslationAuditRow[]>;
  createJob(job: Omit<TranslationJob, "id" | "createdAt">): Promise<TranslationJob>;
  updateJob(jobId: string, patch: Partial<TranslationJob>): Promise<TranslationJob | undefined>;
  getJob(jobId: string): Promise<TranslationJob | undefined>;
  listJobs(): Promise<TranslationJob[]>;
  logNotification(entry: Omit<NotificationLogEntry, "id" | "timestamp">): Promise<NotificationLogEntry>;
  listNotifications(): Promise<NotificationLogEntry[]>;
  validateLanguage(languageCode: string, sourceLanguageCode?: string): Promise<ValidationSummary>;
  getValidationReport(sourceLanguageCode?: string): Promise<ValidationReport>;
  snapshot(): Promise<RepositorySnapshot>;
}

export function normalizeTranslationInput(
  input: TranslateAllRequest["strings"] | TranslationStringInput[] | Record<string, string>
): Record<string, string> {
  if (Array.isArray(input)) {
    return Object.fromEntries(input.map((item) => [item.key, item.value]));
  }

  return { ...input };
}
