import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type {
  LanguageRecord,
  NotificationLogRecord,
  TranslationAuditRecord,
  TranslationJobRecord,
  TranslationLanguageRegistry,
  TranslationStore,
  TranslationStringRecord,
  UpsertTranslationInput,
  UpsertTranslationResult,
} from "../types/platform";
import type { TranslationRepository } from "./translationRepository";

const EMPTY_STORE: TranslationStore = {
  languages: [],
  translationStrings: [],
  translationJobs: [],
  translationAudit: [],
  notificationLog: [],
};

function normalizeLanguageCode(languageCode: string): string {
  return languageCode.trim().toLowerCase();
}

function createValueHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class FileTranslationRepository implements TranslationRepository {
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async syncLanguages(
    registry: TranslationLanguageRegistry,
    sourceLanguage: string
  ): Promise<LanguageRecord[]> {
    const normalizedSource = normalizeLanguageCode(sourceLanguage);

    return this.withStore(async (store) => {
      const now = new Date().toISOString();
      const seenCodes = new Set<string>();

      for (const [code, name] of Object.entries(registry)) {
        const normalizedCode = normalizeLanguageCode(code);

        if (seenCodes.has(normalizedCode)) {
          continue;
        }

        seenCodes.add(normalizedCode);

        const existing = store.languages.find((language) => language.languageCode === normalizedCode);
        if (existing) {
          existing.languageName = name;
          existing.isSource = existing.languageCode === normalizedSource;
          existing.isActive = true;
          existing.updatedAt = now;
          continue;
        }

        store.languages.push({
          languageCode: normalizedCode,
          languageName: name,
          isSource: normalizedCode === normalizedSource,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
      }

      for (const language of store.languages) {
        if (!seenCodes.has(language.languageCode)) {
          language.isActive = false;
          language.isSource = false;
          language.updatedAt = now;
        }
      }

      return store.languages
        .filter((language) => language.isActive)
        .sort((left, right) => left.languageCode.localeCompare(right.languageCode));
    });
  }

  async getActiveLanguages(): Promise<LanguageRecord[]> {
    const store = await this.readStore();
    return store.languages
      .filter((language) => language.isActive)
      .sort((left, right) => left.languageCode.localeCompare(right.languageCode));
  }

  async getStringsByLanguage(languageCode: string): Promise<TranslationStringRecord[]> {
    const normalizedCode = normalizeLanguageCode(languageCode);
    const store = await this.readStore();

    return store.translationStrings
      .filter((record) => record.languageCode === normalizedCode)
      .sort((left, right) => left.stringKey.localeCompare(right.stringKey));
  }

  async upsertTranslations(input: UpsertTranslationInput): Promise<UpsertTranslationResult> {
    const normalizedLanguage = normalizeLanguageCode(input.languageCode);
    const now = new Date().toISOString();

    return this.withStore(async (store) => {
      const records: TranslationStringRecord[] = [];
      let inserted = 0;
      let updated = 0;
      let skipped = 0;

      for (const [stringKey, translatedText] of Object.entries(input.strings)) {
        const sourceText = input.sourceStrings[stringKey];
        const providerUsed = input.providerUsedByKey[stringKey] ?? "gemini";
        const existing = store.translationStrings.find(
          (record) => record.stringKey === stringKey && record.languageCode === normalizedLanguage
        );

        if (existing && existing.status === "approved" && !input.allowOverwriteApproved) {
          skipped += 1;

          store.translationAudit.push(this.createAuditEntry({
            jobId: input.jobId,
            action: "skip",
            stringKey,
            languageCode: normalizedLanguage,
            providerUsed: existing.providerUsed,
            oldValue: existing.translatedText,
            newValue: existing.translatedText,
          }));

          records.push(existing);
          continue;
        }

        if (existing) {
          if (
            existing.translatedText === translatedText &&
            existing.sourceText === sourceText &&
            existing.status === input.status &&
            existing.providerUsed === providerUsed
          ) {
            skipped += 1;
            records.push(existing);
            continue;
          }

          store.translationAudit.push(this.createAuditEntry({
            jobId: input.jobId,
            action: "update",
            stringKey,
            languageCode: normalizedLanguage,
            providerUsed,
            oldValue: existing.translatedText,
            newValue: translatedText,
          }));

          existing.translatedText = translatedText;
          existing.sourceText = sourceText;
          existing.status = input.status;
          existing.providerUsed = providerUsed;
          existing.version += 1;
          existing.hash = createValueHash(translatedText);
          existing.updatedAt = now;
          records.push(existing);
          updated += 1;
          continue;
        }

        const createdRecord: TranslationStringRecord = {
          stringKey,
          languageCode: normalizedLanguage,
          translatedText,
          sourceText,
          status: input.status,
          providerUsed,
          version: 1,
          hash: createValueHash(translatedText),
          createdAt: now,
          updatedAt: now,
        };

        store.translationStrings.push(createdRecord);
        store.translationAudit.push(this.createAuditEntry({
          jobId: input.jobId,
          action: "insert",
          stringKey,
          languageCode: normalizedLanguage,
          providerUsed,
          newValue: translatedText,
        }));
        records.push(createdRecord);
        inserted += 1;
      }

      return {
        inserted,
        updated,
        skipped,
        records,
      };
    });
  }

  async createJob(job: Omit<TranslationJobRecord, "startedAt">): Promise<TranslationJobRecord> {
    const startedAt = new Date().toISOString();

    return this.withStore(async (store) => {
      const createdJob: TranslationJobRecord = {
        ...job,
        startedAt,
      };

      store.translationJobs.push(createdJob);
      return createdJob;
    });
  }

  async completeJob(
    jobId: string,
    patch: Partial<Omit<TranslationJobRecord, "jobId" | "requestId" | "jobType" | "startedAt">>
  ): Promise<TranslationJobRecord | undefined> {
    return this.withStore(async (store) => {
      const existing = store.translationJobs.find((job) => job.jobId === jobId);
      if (!existing) {
        return undefined;
      }

      Object.assign(existing, patch, {
        completedAt: patch.completedAt ?? new Date().toISOString(),
      });

      return existing;
    });
  }

  async getLatestJob(
    jobType: TranslationJobRecord["jobType"],
    targetLanguage?: string
  ): Promise<TranslationJobRecord | undefined> {
    const store = await this.readStore();

    return store.translationJobs
      .filter(
        (job) =>
          job.jobType === jobType &&
          (targetLanguage ? job.targetLanguage === normalizeLanguageCode(targetLanguage) : true)
      )
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  }

  async logNotification(entry: NotificationLogRecord): Promise<void> {
    await this.withStore(async (store) => {
      store.notificationLog.push(entry);
      return undefined;
    });
  }

  async getProviderUsageStats(
    languageCode: string
  ): Promise<Partial<Record<TranslationStringRecord["providerUsed"], number>>> {
    const normalizedLanguage = normalizeLanguageCode(languageCode);
    const store = await this.readStore();
    const stats: Partial<Record<TranslationStringRecord["providerUsed"], number>> = {};

    for (const record of store.translationStrings) {
      if (record.languageCode !== normalizedLanguage) {
        continue;
      }

      stats[record.providerUsed] = (stats[record.providerUsed] ?? 0) + 1;
    }

    return stats;
  }

  private createAuditEntry(input: {
    jobId?: string;
    action: TranslationAuditRecord["action"];
    stringKey: string;
    languageCode: string;
    providerUsed: TranslationStringRecord["providerUsed"];
    oldValue?: string;
    newValue?: string;
  }): TranslationAuditRecord {
    return {
      auditId: randomUUID(),
      jobId: input.jobId,
      action: input.action,
      stringKey: input.stringKey,
      languageCode: input.languageCode,
      providerUsed: input.providerUsed,
      oldValue: input.oldValue,
      newValue: input.newValue,
      timestamp: new Date().toISOString(),
    };
  }

  private async withStore<T>(mutator: (store: TranslationStore) => Promise<T> | T): Promise<T> {
    let result: T | undefined;
    const runMutation = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
      const store = await this.readStore();
      result = await mutator(store);
      await this.writeStore(store);
    });

    this.pendingWrite = runMutation;
    await runMutation;

    return result as T;
  }

  private async readStore(): Promise<TranslationStore> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return {
        ...EMPTY_STORE,
        ...JSON.parse(raw),
      } as TranslationStore;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(EMPTY_STORE);
      }

      throw error;
    }
  }

  private async writeStore(store: TranslationStore): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(store, null, 2), "utf8");
  }
}
