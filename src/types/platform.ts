import type { TranslationObject, TranslationStringItem } from "./translation";
export type TranslationProviderName = import("./translation").TranslationProviderName;

export type TranslationLanguageRegistry = Record<string, string>;

export type StoredTranslationStatus =
  | "source"
  | "auto_generated"
  | "approved"
  | "manual"
  | "failed";

export type TranslationJobType = "translate_all" | "backfill_language" | "daily_remediation";

export type TranslationJobStatus =
  | "running"
  | "success"
  | "partial_failure"
  | "failed"
  | "dry_run";

export type NotificationChannel = "slack";

export type NotificationStatus = "sent" | "skipped" | "failed";

export type NotificationEventType =
  | "translation_started"
  | "translation_completed"
  | "translation_failed"
  | "validation_mismatch"
  | "daily_remediation"
  | "backfill_completed";

export type TranslationAuditAction = "insert" | "update" | "skip";

export type StoredProviderName = TranslationProviderName | "mixed";

export type ProviderAttempt = {
  provider: TranslationProviderName;
  success: boolean;
  attemptCount: number;
  message?: string;
  transient?: boolean;
};

export type ProviderTranslationResult = {
  translations: TranslationObject;
  providerUsedByKey: Record<string, TranslationProviderName>;
  primaryProvider: StoredProviderName;
  fallbacksUsed: TranslationProviderName[];
  attempts: ProviderAttempt[];
};

export type LanguageRecord = {
  languageCode: string;
  languageName: string;
  isSource: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TranslationStringRecord = {
  stringKey: string;
  languageCode: string;
  translatedText: string;
  sourceText: string;
  status: StoredTranslationStatus;
  providerUsed: TranslationProviderName;
  version: number;
  hash: string;
  createdAt: string;
  updatedAt: string;
};

export type TranslationJobRecord = {
  jobId: string;
  requestId: string;
  jobType: TranslationJobType;
  targetLanguage?: string;
  status: TranslationJobStatus;
  startedAt: string;
  completedAt?: string;
  totalKeys: number;
  translatedKeys: number;
  failedKeys: number;
  skippedKeys: number;
  dryRun: boolean;
  summary?: Record<string, unknown>;
};

export type TranslationAuditRecord = {
  auditId: string;
  jobId?: string;
  stringKey: string;
  languageCode: string;
  action: TranslationAuditAction;
  providerUsed: TranslationProviderName;
  oldValue?: string;
  newValue?: string;
  timestamp: string;
};

export type NotificationLogRecord = {
  notificationId: string;
  channel: NotificationChannel;
  eventType: NotificationEventType;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  timestamp: string;
};

export type TranslationStore = {
  languages: LanguageRecord[];
  translationStrings: TranslationStringRecord[];
  translationJobs: TranslationJobRecord[];
  translationAudit: TranslationAuditRecord[];
  notificationLog: NotificationLogRecord[];
};

export type UpsertTranslationInput = {
  requestId: string;
  jobId?: string;
  sourceLanguage: string;
  languageCode: string;
  strings: TranslationObject;
  sourceStrings: TranslationObject;
  status: StoredTranslationStatus;
  providerUsedByKey: Record<string, TranslationProviderName>;
  allowOverwriteApproved: boolean;
};

export type UpsertTranslationResult = {
  inserted: number;
  updated: number;
  skipped: number;
  records: TranslationStringRecord[];
};

export type TranslateAllRequest = {
  source_language?: string;
  sourceLanguageCode?: string;
  translation_languages?: TranslationLanguageRegistry;
  languages?: string[];
  strings?: TranslationObject | TranslationStringItem[];
  persist?: boolean;
  allow_overwrite_approved?: boolean;
  allowApprovedOverwrite?: boolean;
  includeSourceLanguage?: boolean;
  requestId?: string;
  jobMetadata?: Record<string, unknown>;
};

export type TranslateAllLanguageSummary = {
  provider_used: StoredProviderName;
  fallbacks_used: TranslationProviderName[];
  attempts: ProviderAttempt[];
};

export type TranslateAllResponse = {
  request_id: string;
  status: "success";
  translations: Record<string, TranslationObject>;
  provider_summary: {
    primary: StoredProviderName;
    fallbacks_used: TranslationProviderName[];
    languages: Record<string, TranslateAllLanguageSummary>;
  };
};

export type BackfillLanguageRequest = {
  source_language?: string;
  target_language?: string;
  sourceLanguageCode?: string;
  targetLanguageCode?: string;
  translation_languages?: TranslationLanguageRegistry;
  persist?: boolean;
  allow_overwrite_approved?: boolean;
  allowApprovedOverwrite?: boolean;
  requestId?: string;
};

export type BackfillLanguageResponse = {
  request_id: string;
  status: "success";
  target_language: string;
  translated_count: number;
  skipped_existing_count: number;
  failed_count: number;
  translations: Record<string, TranslationObject>;
};

export type ValidationLanguageSummary = {
  language: string;
  count: number;
  missing: number;
  extra: number;
  missing_keys: string[];
  extra_keys: string[];
  status: "match" | "mismatch";
};

export type ValidateTranslationsResponse = {
  source_language: string;
  source_count: number;
  languages: ValidationLanguageSummary[];
};

export type LanguageStatusResponse = {
  language: string;
  count: number;
  missing_keys: string[];
  extra_keys: string[];
  last_job_status?: TranslationJobStatus;
  provider_stats: Partial<Record<TranslationProviderName, number>>;
};

export type RemediationRequest = {
  source_language?: string;
  sourceLanguageCode?: string;
  target_languages?: string[];
  targetLanguageCodes?: string[];
  dry_run?: boolean;
  dryRun?: boolean;
  allow_overwrite_approved?: boolean;
  allowApprovedOverwrite?: boolean;
  requestId?: string;
};

export type RemediationLanguageSummary = {
  language: string;
  detected_missing: number;
  translated: number;
  failed: number;
  skipped: number;
  missing_keys_sample: string[];
};

export type RemediationResponse = {
  request_id: string;
  status: "success";
  dry_run: boolean;
  summary: RemediationLanguageSummary[];
};

export type PlatformLanguageRegistryEntry = {
  code: string;
  name: string;
  active: boolean;
  isSource?: boolean;
  remediationEnabled?: boolean;
};

export type PlatformLanguageRegistry = Record<string, PlatformLanguageRegistryEntry>;

export type PlatformConfig = {
  sourceLanguage: PlatformLanguageRegistryEntry;
  translationLanguages: PlatformLanguageRegistry;
  persistence: {
    enabled: boolean;
    path: string;
  };
  provider: {
    order: TranslationProviderName[];
    timeoutMs: number;
    maxRetries: number;
    batchSize: number;
    backoffMs: number;
    backoffMultiplier: number;
  };
  remediation: {
    enabled: boolean;
    dailyTime: string;
    activeLanguageCodes: string[];
  };
};

export type ProviderRoutingAttempt = {
  provider: TranslationProviderName;
  attempt: number;
  success: boolean;
  transient: boolean;
  timedOut: boolean;
  batchSize: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  errorMessage?: string;
  fallbackUsed: boolean;
  preservedKeys: boolean;
  responseKeyCount?: number;
};

export type StoredTranslation = {
  stringKey: string;
  languageCode: string;
  sourceLanguageCode: string;
  sourceText: string;
  translatedText: string;
  status: "source" | "pending" | "translated" | "approved" | "manual" | "needs_review" | "skipped";
  approvalState: "unapproved" | "approved";
  providerUsed: TranslationProviderName | "source" | "manual";
  version: number;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  requestId?: string;
  jobId?: string;
  fallbackUsed?: boolean;
  providerAttempts?: ProviderRoutingAttempt[];
  metadata?: Record<string, unknown>;
};

export type TranslationJob = {
  id: string;
  type: "translate-all" | "backfill-language" | "validation" | "remediation" | "scheduler";
  status: "queued" | "running" | "succeeded" | "failed" | "partial" | "dry_run";
  sourceLanguageCode: string;
  targetLanguageCode?: string;
  dryRun: boolean;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  sourceCount?: number;
  targetCount?: number;
  missingCount?: number;
  extraCount?: number;
  processedCount?: number;
  skippedCount?: number;
  translatedCount?: number;
  failureMessage?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

export type TranslationAuditRow = {
  id: string;
  timestamp: string;
  action: "insert" | "update" | "skip-approved" | "registry-sync" | "job-created" | "job-updated" | "validation" | "notification";
  stringKey?: string;
  languageCode?: string;
  jobId?: string;
  requestId?: string;
  actor?: string;
  message?: string;
  before?: StoredTranslation | null;
  after?: StoredTranslation | null;
  metadata?: Record<string, unknown>;
};

export type ValidationSummary = {
  sourceLanguageCode: string;
  targetLanguageCode: string;
  sourceCount: number;
  targetCount: number;
  missingCount: number;
  extraCount: number;
  matchedCount: number;
  coveragePercent: number;
  missingKeys: string[];
  extraKeys: string[];
  status: "match" | "mismatch";
};

export type TranslationContract = Record<string, Record<string, string>>;

export type TranslationStatusSummary = {
  generatedAt: string;
  sourceLanguageCode: string;
  lines: string[];
  report: {
    sourceLanguageCode: string;
    generatedAt: string;
    activeLanguages: ValidationSummary[];
    overallStatus: "match" | "mismatch";
  };
};

export type BackfillLanguageResult = {
  sourceLanguageCode: string;
  targetLanguageCode: string;
  translations: Record<string, string>;
  missingKeys: string[];
  persisted: boolean;
  jobId?: string;
  providerAttempts: ProviderRoutingAttempt[];
};

export type TranslateAllResult = {
  sourceLanguageCode: string;
  translations: TranslationContract;
  providerAttempts: Record<string, ProviderRoutingAttempt[]>;
  persisted: boolean;
  jobId?: string;
};

export type RemediationLanguageResult = {
  languageCode: string;
  dryRun: boolean;
  missingKeys: string[];
  translatedCount: number;
  skippedCount: number;
  providerAttempts: ProviderRoutingAttempt[];
  jobId?: string;
};

export type RemediationResult = {
  dryRun: boolean;
  generatedAt: string;
  sourceLanguageCode: string;
  totalLanguages: number;
  totalMissing: number;
  totalTranslated: number;
  totalSkipped: number;
  languageResults: RemediationLanguageResult[];
};

export type NotificationLogEntry = {
  id: string;
  timestamp: string;
  event: string;
  success: boolean;
  message?: string;
  details?: Record<string, unknown>;
  jobId?: string;
  languageCode?: string;
  provider?: TranslationProviderName;
};

export type ValidationReport = {
  sourceLanguageCode: string;
  generatedAt: string;
  activeLanguages: ValidationSummary[];
  overallStatus: "match" | "mismatch";
};
