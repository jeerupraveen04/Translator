import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { platformConfig } from "../config/platformConfig";
import type {
  NotificationLogEntry,
  PlatformLanguageRegistry,
  StoredTranslation,
  TranslationAuditRow,
  TranslationJob,
  ValidationReport,
  ValidationSummary,
  TranslationContract,
} from "../types/platform";
import type {
  RepositorySnapshot,
  TranslationRepository,
  UpsertTranslationInput,
  UpsertTranslationResult,
} from "./platformRepository";

type PersistedStore = {
  sourceLanguageCode: string;
  translationLanguages: PlatformLanguageRegistry;
  translations: StoredTranslation[];
  audits: TranslationAuditRow[];
  jobs: TranslationJob[];
  notifications: NotificationLogEntry[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeLanguageCode(languageCode: string): string {
  return languageCode.trim().toLowerCase();
}

function normalizeKey(key: string): string {
  return key.trim();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createInitialStore(): PersistedStore {
  return {
    sourceLanguageCode: platformConfig.sourceLanguage,
    translationLanguages: buildRegistry(platformConfig.translationLanguages, platformConfig.sourceLanguage),
    translations: [],
    audits: [],
    jobs: [],
    notifications: [],
  };
}

function translationMatches(left: StoredTranslation, right: StoredTranslation): boolean {
  return (
    left.stringKey === right.stringKey &&
    left.languageCode === right.languageCode &&
    left.sourceLanguageCode === right.sourceLanguageCode &&
    left.sourceText === right.sourceText &&
    left.translatedText === right.translatedText &&
    left.status === right.status &&
    left.approvalState === right.approvalState &&
    left.providerUsed === right.providerUsed &&
    left.approvedAt === right.approvedAt &&
    left.approvedBy === right.approvedBy &&
    left.requestId === right.requestId &&
    left.jobId === right.jobId &&
    left.fallbackUsed === right.fallbackUsed &&
    JSON.stringify(left.metadata ?? {}) === JSON.stringify(right.metadata ?? {})
  );
}

export class FileTranslationRepository implements TranslationRepository {
  private readonly storePath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(storePath: string = platformConfig.dataFilePath) {
    this.storePath = resolve(storePath);
  }

  async syncLanguageRegistry(registry: PlatformLanguageRegistry): Promise<void> {
    await this.mutate(async (store) => {
      for (const [code, entry] of Object.entries(registry)) {
        store.translationLanguages[normalizeLanguageCode(code)] = {
          ...entry,
          code: normalizeLanguageCode(entry.code),
        };
      }
      this.appendAuditInStore(store, {
        action: "registry-sync",
        message: "Language registry synchronized",
        metadata: { languageCodes: Object.keys(registry) },
      });
    });
  }

  async listLanguages(): Promise<PlatformLanguageRegistry> {
    const store = await this.readStore();
    return clone(store.translationLanguages);
  }

  async getLanguage(languageCode: string): Promise<PlatformLanguageRegistry[string] | undefined> {
    const store = await this.readStore();
    return store.translationLanguages[normalizeLanguageCode(languageCode)];
  }

  async getSourceStrings(sourceLanguageCode?: string): Promise<Record<string, string>> {
    const code = normalizeLanguageCode(sourceLanguageCode ?? platformConfig.sourceLanguage);
    const store = await this.readStore();
    return Object.fromEntries(
      store.translations
        .filter((row) => row.languageCode === code)
        .map((row) => [row.stringKey, row.translatedText])
    );
  }

  async getTargetStrings(languageCode: string): Promise<Record<string, string>> {
    return this.getSourceStrings(languageCode);
  }

  async listTranslations(languageCode?: string): Promise<StoredTranslation[]> {
    const store = await this.readStore();
    const rows = languageCode
      ? store.translations.filter((row) => row.languageCode === normalizeLanguageCode(languageCode))
      : store.translations;
    return clone(rows);
  }

  async getTranslation(languageCode: string, stringKey: string): Promise<StoredTranslation | undefined> {
    const store = await this.readStore();
    return store.translations.find(
      (row) => row.languageCode === normalizeLanguageCode(languageCode) && row.stringKey === normalizeKey(stringKey)
    );
  }

  async upsertTranslation(
    input: UpsertTranslationInput,
    options: {
      allowApprovedOverwrite?: boolean;
      auditMessage?: string;
      actor?: string;
    } = {}
  ): Promise<UpsertTranslationResult> {
    return this.mutate(async (store) => this.upsertTranslationInStore(store, input, options));
  }

  async bulkUpsertTranslations(
    inputs: UpsertTranslationInput[],
    options: {
      allowApprovedOverwrite?: boolean;
      auditMessage?: string;
      actor?: string;
    } = {}
  ): Promise<UpsertTranslationResult[]> {
    return this.mutate(async (store) => Promise.all(inputs.map((input) => this.upsertTranslationInStore(store, input, options))));
  }

  async appendAudit(row: Omit<TranslationAuditRow, "id" | "timestamp">): Promise<TranslationAuditRow> {
    return this.mutate(async (store) => this.appendAuditInStore(store, row));
  }

  async listAudits(): Promise<TranslationAuditRow[]> {
    const store = await this.readStore();
    return clone(store.audits);
  }

  async createJob(job: Omit<TranslationJob, "id" | "createdAt">): Promise<TranslationJob> {
    return this.mutate(async (store) => {
      const created: TranslationJob = {
        ...job,
        id: randomUUID(),
        createdAt: nowIso(),
      };
      store.jobs.unshift(created);
      this.appendAuditInStore(store, {
        action: "job-created",
        jobId: created.id,
        message: `Job created: ${created.type}`,
        metadata: created,
      });
      return created;
    });
  }

  async updateJob(jobId: string, patch: Partial<TranslationJob>): Promise<TranslationJob | undefined> {
    return this.mutate(async (store) => {
      const job = store.jobs.find((item) => item.id === jobId);
      if (!job) {
        return undefined;
      }
      Object.assign(job, patch);
      this.appendAuditInStore(store, {
        action: "job-updated",
        jobId,
        message: `Job updated: ${job.type}`,
        metadata: patch,
      });
      return clone(job);
    });
  }

  async getJob(jobId: string): Promise<TranslationJob | undefined> {
    const store = await this.readStore();
    const job = store.jobs.find((item) => item.id === jobId);
    return job ? clone(job) : undefined;
  }

  async listJobs(): Promise<TranslationJob[]> {
    const store = await this.readStore();
    return clone(store.jobs);
  }

  async logNotification(entry: Omit<NotificationLogEntry, "id" | "timestamp">): Promise<NotificationLogEntry> {
    return this.mutate(async (store) => {
      const created: NotificationLogEntry = {
        ...entry,
        id: randomUUID(),
        timestamp: nowIso(),
      };
      store.notifications.unshift(created);
      this.appendAuditInStore(store, {
        action: "notification",
        message: created.message ?? created.event,
        jobId: created.jobId,
        languageCode: created.languageCode,
        metadata: created.details,
      });
      return created;
    });
  }

  async listNotifications(): Promise<NotificationLogEntry[]> {
    const store = await this.readStore();
    return clone(store.notifications);
  }

  async validateLanguage(
    languageCode: string,
    sourceLanguageCode: string = platformConfig.sourceLanguage
  ): Promise<ValidationSummary> {
    const store = await this.readStore();
    const sourceKeys = store.translations
      .filter((row) => row.languageCode === normalizeLanguageCode(sourceLanguageCode))
      .map((row) => row.stringKey);
    const targetKeys = store.translations
      .filter((row) => row.languageCode === normalizeLanguageCode(languageCode))
      .map((row) => row.stringKey);

    const sourceSet = new Set(sourceKeys);
    const targetSet = new Set(targetKeys);
    const missingKeys = sourceKeys.filter((key) => !targetSet.has(key));
    const extraKeys = targetKeys.filter((key) => !sourceSet.has(key));
    const matchedCount = sourceKeys.length - missingKeys.length;
    const coveragePercent = sourceKeys.length === 0 ? 100 : Math.round((matchedCount / sourceKeys.length) * 10000) / 100;
    const summary: ValidationSummary = {
      sourceLanguageCode: normalizeLanguageCode(sourceLanguageCode),
      targetLanguageCode: normalizeLanguageCode(languageCode),
      sourceCount: sourceKeys.length,
      targetCount: targetKeys.length,
      missingCount: missingKeys.length,
      extraCount: extraKeys.length,
      matchedCount,
      coveragePercent,
      missingKeys,
      extraKeys,
      status: missingKeys.length === 0 && extraKeys.length === 0 ? "match" : "mismatch",
    };

    await this.appendAudit({
      action: "validation",
      languageCode: summary.targetLanguageCode,
      message: `Validated ${summary.targetLanguageCode}`,
      metadata: summary,
    });

    return summary;
  }

  async getValidationReport(sourceLanguageCode: string = platformConfig.sourceLanguage): Promise<ValidationReport> {
    const store = await this.readStore();
    const activeLanguages = Object.values(store.translationLanguages)
      .filter((entry) => entry.active !== false && entry.code !== normalizeLanguageCode(sourceLanguageCode))
      .map((entry) => entry.code);

    const summaries: ValidationSummary[] = [];
    for (const languageCode of activeLanguages) {
      summaries.push(await this.validateLanguage(languageCode, sourceLanguageCode));
    }

    return {
      sourceLanguageCode: normalizeLanguageCode(sourceLanguageCode),
      generatedAt: nowIso(),
      activeLanguages: summaries,
      overallStatus: summaries.every((summary) => summary.status === "match") ? "match" : "mismatch",
    };
  }

  async snapshot(): Promise<RepositorySnapshot> {
    const store = await this.readStore();
    return clone(store);
  }

  async syncLanguages(registry: Record<string, string>, sourceLanguage: string): Promise<unknown> {
    const nextRegistry: PlatformLanguageRegistry = {};
    for (const [code, name] of Object.entries(registry)) {
      nextRegistry[normalizeLanguageCode(code)] = {
        code: normalizeLanguageCode(code),
        name,
        active: true,
        remediationEnabled: true,
      };
    }

    nextRegistry[normalizeLanguageCode(sourceLanguage)] = {
      code: normalizeLanguageCode(sourceLanguage),
      name: sourceLanguage.toUpperCase(),
      active: true,
      isSource: true,
      remediationEnabled: true,
    };

    await this.syncLanguageRegistry(nextRegistry);
    return this.getActiveLanguages();
  }

  async getActiveLanguages(): Promise<unknown> {
    const languages = await this.listLanguages();
    return Object.values(languages)
      .filter((entry) => entry.active !== false)
      .map((entry) => ({
        languageCode: entry.code,
        languageName: entry.name,
        isSource: Boolean(entry.isSource),
        isActive: entry.active !== false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }));
  }

  async getStringsByLanguage(languageCode: string): Promise<unknown> {
    const rows = await this.listTranslations(languageCode);
    return rows.map((row) => ({
      stringKey: row.stringKey,
      languageCode: row.languageCode,
      translatedText: row.translatedText,
      sourceText: row.sourceText,
      status: row.status,
      providerUsed: row.providerUsed,
      version: row.version,
      hash: row.metadata ? JSON.stringify(row.metadata) : "",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async upsertTranslations(input: any): Promise<unknown> {
    if (input && typeof input === "object" && "strings" in input && "languageCode" in input) {
      const strings = input.strings as Record<string, string>;
      const sourceStrings = (input.sourceStrings ?? strings) as Record<string, string>;
      const entries = Object.entries(strings).map(([stringKey, translatedText]) => ({
        stringKey,
        languageCode: input.languageCode,
        sourceLanguageCode: input.sourceLanguage ?? platformConfig.sourceLanguage,
        sourceText: sourceStrings[stringKey] ?? translatedText,
        translatedText,
        status: input.status ?? "translated",
        approvalState: "unapproved" as const,
        providerUsed: input.providerUsedByKey?.[stringKey] ?? "source",
        requestId: input.requestId,
        jobId: input.jobId,
        fallbackUsed: false,
      }));

      const results = await this.bulkUpsertTranslations(entries, {
        allowApprovedOverwrite: Boolean(input.allowOverwriteApproved),
      });
      return {
        inserted: results.filter((result) => result.inserted).length,
        updated: results.filter((result) => result.updated).length,
        skipped: results.filter((result) => result.skipped).length,
        records: results.map((result) => result.translation),
      };
    }

    return this.upsertTranslation(input as UpsertTranslationInput);
  }

  async completeJob(jobId: string, patch: any): Promise<unknown> {
    return this.updateJob(jobId, patch);
  }

  async getLatestJob(jobType: any, targetLanguage?: string): Promise<unknown> {
    const jobs = await this.listJobs();
    return jobs.find(
      (job) =>
        job.type === jobType ||
        job.metadata?.["jobType"] === jobType ||
        (targetLanguage ? job.targetLanguageCode === targetLanguage : true)
    );
  }

  async getProviderUsageStats(languageCode: string): Promise<unknown> {
    const translations = await this.listTranslations(languageCode);
    return translations.reduce<Record<string, number>>((acc, row) => {
      const provider = String(row.providerUsed);
      acc[provider] = (acc[provider] ?? 0) + 1;
      return acc;
    }, {});
  }

  private async readStore(): Promise<PersistedStore> {
    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedStore>;
      return {
        ...createInitialStore(),
        ...parsed,
        translationLanguages: {
          ...createInitialStore().translationLanguages,
          ...(parsed.translationLanguages ?? {}),
        },
        translations: Array.isArray(parsed.translations) ? parsed.translations : [],
        audits: Array.isArray(parsed.audits) ? parsed.audits : [],
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
        notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const store = createInitialStore();
        await this.writeStore(store);
        return store;
      }

      throw error;
    }
  }

  private async writeStore(store: PersistedStore): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  private async mutate<T>(callback: (store: PersistedStore) => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const store = await this.readStore();
      const result = await callback(store);
      await this.writeStore(store);
      return result;
    });

    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  private appendAuditInStore(
    store: PersistedStore,
    row: Omit<TranslationAuditRow, "id" | "timestamp">
  ): TranslationAuditRow {
    const audit: TranslationAuditRow = {
      ...row,
      id: randomUUID(),
      timestamp: nowIso(),
    };
    store.audits.unshift(audit);
    return audit;
  }

  private async upsertTranslationInStore(
    store: PersistedStore,
    input: UpsertTranslationInput,
    options: {
      allowApprovedOverwrite?: boolean;
      auditMessage?: string;
      actor?: string;
    }
  ): Promise<UpsertTranslationResult> {
    const languageCode = normalizeLanguageCode(input.languageCode);
    const stringKey = normalizeKey(input.stringKey);
    const existingIndex = store.translations.findIndex(
      (row) => row.languageCode === languageCode && row.stringKey === stringKey
    );
    const now = nowIso();

    const nextTranslation: StoredTranslation = {
      stringKey,
      languageCode,
      sourceLanguageCode: normalizeLanguageCode(input.sourceLanguageCode),
      sourceText: input.sourceText,
      translatedText: input.translatedText,
      status: input.status,
      approvalState: input.approvalState ?? "unapproved",
      providerUsed: input.providerUsed,
      version: 1,
      createdAt: now,
      updatedAt: now,
      approvedAt: input.approvedAt,
      approvedBy: input.approvedBy,
      requestId: input.requestId,
      jobId: input.jobId,
      fallbackUsed: input.fallbackUsed,
      providerAttempts: input.providerAttempts,
      metadata: input.metadata,
    };

    if (existingIndex < 0) {
      store.translations.unshift(nextTranslation);
      this.appendAuditInStore(store, {
        action: "insert",
        stringKey,
        languageCode,
        jobId: input.jobId,
        requestId: input.requestId,
        actor: options.actor,
        message: options.auditMessage ?? `Inserted translation ${languageCode}.${stringKey}`,
        before: null,
        after: nextTranslation,
        metadata: input.metadata,
      });
      return { translation: nextTranslation, inserted: true, updated: false, skipped: false, skippedBecauseApproved: false };
    }

    const current = store.translations[existingIndex];
    if (
      current.approvalState === "approved" &&
      normalizeLanguageCode(input.sourceLanguageCode) !== languageCode &&
      !options.allowApprovedOverwrite &&
      current.translatedText !== nextTranslation.translatedText
    ) {
      this.appendAuditInStore(store, {
        action: "skip-approved",
        stringKey,
        languageCode,
        jobId: input.jobId,
        requestId: input.requestId,
        actor: options.actor,
        message: options.auditMessage ?? `Skipped approved translation ${languageCode}.${stringKey}`,
        before: current,
        after: current,
        metadata: input.metadata,
      });
      return { translation: current, inserted: false, updated: false, skipped: true, skippedBecauseApproved: true };
    }

    const updatedTranslation: StoredTranslation = {
      ...current,
      ...nextTranslation,
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: now,
      approvalState: input.approvalState ?? current.approvalState,
      approvedAt: input.approvedAt ?? current.approvedAt,
      approvedBy: input.approvedBy ?? current.approvedBy,
    };

    if (translationMatches(current, updatedTranslation)) {
      return { translation: current, inserted: false, updated: false, skipped: false, skippedBecauseApproved: false };
    }

    store.translations[existingIndex] = updatedTranslation;
    this.appendAuditInStore(store, {
      action: "update",
      stringKey,
      languageCode,
      jobId: input.jobId,
      requestId: input.requestId,
      actor: options.actor,
      message: options.auditMessage ?? `Updated translation ${languageCode}.${stringKey}`,
      before: current,
      after: updatedTranslation,
      metadata: input.metadata,
    });

    return { translation: updatedTranslation, inserted: false, updated: true, skipped: false, skippedBecauseApproved: false };
  }
}

export function createDefaultFileTranslationRepository(): FileTranslationRepository {
  return new FileTranslationRepository(platformConfig.dataFilePath);
}

function buildRegistry(
  translationLanguages: Record<string, string>,
  sourceLanguage: string
): PlatformLanguageRegistry {
  const registry: PlatformLanguageRegistry = {};

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
