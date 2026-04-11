import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
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

type SqliteRepositoryOptions = {
  legacyJsonPath?: string;
};

function normalizeLanguageCode(languageCode: string): string {
  return languageCode.trim().toLowerCase();
}

function createValueHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as T;
}

export class SqliteTranslationRepository implements TranslationRepository {
  private readonly database: DatabaseSync;

  constructor(
    private readonly filePath: string,
    private readonly options: SqliteRepositoryOptions = {}
  ) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.initializeSchema();
    this.importLegacyJsonIfNeeded();
  }

  async syncLanguages(
    registry: TranslationLanguageRegistry,
    sourceLanguage: string
  ): Promise<LanguageRecord[]> {
    const normalizedSource = normalizeLanguageCode(sourceLanguage);
    const now = new Date().toISOString();

    return this.inTransaction(() => {
      const seenCodes = new Set<string>();

      for (const [code, name] of Object.entries(registry)) {
        const normalizedCode = normalizeLanguageCode(code);
        if (seenCodes.has(normalizedCode)) {
          continue;
        }

        seenCodes.add(normalizedCode);

        this.database.prepare(
          `
            INSERT INTO languages (
              language_code,
              language_name,
              is_source,
              is_active,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT(language_code) DO UPDATE SET
              language_name = excluded.language_name,
              is_source = excluded.is_source,
              is_active = 1,
              updated_at = excluded.updated_at
          `
        ).run(
          normalizedCode,
          name,
          normalizedCode === normalizedSource ? 1 : 0,
          now,
          now
        );
      }

      if (seenCodes.size > 0) {
        const placeholders = Array.from(seenCodes, () => "?").join(", ");
        this.database.prepare(
          `
            UPDATE languages
            SET is_active = 0, is_source = 0, updated_at = ?
            WHERE language_code NOT IN (${placeholders})
          `
        ).run(now, ...Array.from(seenCodes));
      }

      return this.getActiveLanguagesSync();
    });
  }

  async getActiveLanguages(): Promise<LanguageRecord[]> {
    return this.getActiveLanguagesSync();
  }

  async getStringsByLanguage(languageCode: string): Promise<TranslationStringRecord[]> {
    const normalizedLanguage = normalizeLanguageCode(languageCode);
    const rows = this.database.prepare(
      `
        SELECT
          string_key,
          language_code,
          translated_text,
          source_text,
          status,
          provider_used,
          version,
          hash,
          created_at,
          updated_at
        FROM translation_strings
        WHERE language_code = ?
        ORDER BY string_key ASC
      `
    ).all(normalizedLanguage) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapTranslationStringRecord(row));
  }

  async upsertTranslations(input: UpsertTranslationInput): Promise<UpsertTranslationResult> {
    const normalizedLanguage = normalizeLanguageCode(input.languageCode);
    const now = new Date().toISOString();

    return this.inTransaction(() => {
      const records: TranslationStringRecord[] = [];
      let inserted = 0;
      let updated = 0;
      let skipped = 0;

      for (const [stringKey, translatedText] of Object.entries(input.strings)) {
        const sourceText = input.sourceStrings[stringKey];
        const providerUsed = input.providerUsedByKey[stringKey] ?? "gemini";
        const existingRow = this.database.prepare(
          `
            SELECT
              string_key,
              language_code,
              translated_text,
              source_text,
              status,
              provider_used,
              version,
              hash,
              created_at,
              updated_at
            FROM translation_strings
            WHERE string_key = ? AND language_code = ?
          `
        ).get(stringKey, normalizedLanguage) as Record<string, unknown> | undefined;

        const existing = existingRow ? this.mapTranslationStringRecord(existingRow) : undefined;

        if (existing && existing.status === "approved" && !input.allowOverwriteApproved) {
          skipped += 1;
          this.insertAudit({
            jobId: input.jobId,
            action: "skip",
            stringKey,
            languageCode: normalizedLanguage,
            providerUsed: existing.providerUsed,
            oldValue: existing.translatedText,
            newValue: existing.translatedText,
          });
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

          this.database.prepare(
            `
              UPDATE translation_strings
              SET
                translated_text = ?,
                source_text = ?,
                status = ?,
                provider_used = ?,
                version = ?,
                hash = ?,
                updated_at = ?
              WHERE string_key = ? AND language_code = ?
            `
          ).run(
            translatedText,
            sourceText,
            input.status,
            providerUsed,
            existing.version + 1,
            createValueHash(translatedText),
            now,
            stringKey,
            normalizedLanguage
          );

          this.insertAudit({
            jobId: input.jobId,
            action: "update",
            stringKey,
            languageCode: normalizedLanguage,
            providerUsed,
            oldValue: existing.translatedText,
            newValue: translatedText,
          });

          records.push({
            ...existing,
            translatedText,
            sourceText,
            status: input.status,
            providerUsed,
            version: existing.version + 1,
            hash: createValueHash(translatedText),
            updatedAt: now,
          });
          updated += 1;
          continue;
        }

        this.database.prepare(
          `
            INSERT INTO translation_strings (
              string_key,
              language_code,
              translated_text,
              source_text,
              status,
              provider_used,
              version,
              hash,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          `
        ).run(
          stringKey,
          normalizedLanguage,
          translatedText,
          sourceText,
          input.status,
          providerUsed,
          createValueHash(translatedText),
          now,
          now
        );

        this.insertAudit({
          jobId: input.jobId,
          action: "insert",
          stringKey,
          languageCode: normalizedLanguage,
          providerUsed,
          newValue: translatedText,
        });

        records.push({
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
        });
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

    this.database.prepare(
      `
        INSERT INTO translation_jobs (
          job_id,
          request_id,
          job_type,
          target_language,
          status,
          started_at,
          completed_at,
          total_keys,
          translated_keys,
          failed_keys,
          skipped_keys,
          dry_run,
          summary
        )
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      job.jobId,
      job.requestId,
      job.jobType,
      job.targetLanguage ?? null,
      job.status,
      startedAt,
      job.totalKeys,
      job.translatedKeys,
      job.failedKeys,
      job.skippedKeys,
      job.dryRun ? 1 : 0,
      JSON.stringify(job.summary ?? null)
    );

    return {
      ...job,
      startedAt,
    };
  }

  async completeJob(
    jobId: string,
    patch: Partial<Omit<TranslationJobRecord, "jobId" | "requestId" | "jobType" | "startedAt">>
  ): Promise<TranslationJobRecord | undefined> {
    const existing = this.database.prepare(
      `
        SELECT
          job_id,
          request_id,
          job_type,
          target_language,
          status,
          started_at,
          completed_at,
          total_keys,
          translated_keys,
          failed_keys,
          skipped_keys,
          dry_run,
          summary
        FROM translation_jobs
        WHERE job_id = ?
      `
    ).get(jobId) as Record<string, unknown> | undefined;

    if (!existing) {
      return undefined;
    }

    const current = this.mapTranslationJobRecord(existing);
    const completedAt = patch.completedAt ?? new Date().toISOString();
    const next = {
      ...current,
      ...patch,
      completedAt,
    };

    this.database.prepare(
      `
        UPDATE translation_jobs
        SET
          target_language = ?,
          status = ?,
          completed_at = ?,
          total_keys = ?,
          translated_keys = ?,
          failed_keys = ?,
          skipped_keys = ?,
          dry_run = ?,
          summary = ?
        WHERE job_id = ?
      `
    ).run(
      next.targetLanguage ?? null,
      next.status,
      next.completedAt ?? null,
      next.totalKeys,
      next.translatedKeys,
      next.failedKeys,
      next.skippedKeys,
      next.dryRun ? 1 : 0,
      JSON.stringify(next.summary ?? null),
      jobId
    );

    return next;
  }

  async getLatestJob(
    jobType: TranslationJobRecord["jobType"],
    targetLanguage?: string
  ): Promise<TranslationJobRecord | undefined> {
    const normalizedTargetLanguage = targetLanguage ? normalizeLanguageCode(targetLanguage) : undefined;
    const row = normalizedTargetLanguage
      ? this.database.prepare(
          `
            SELECT
              job_id,
              request_id,
              job_type,
              target_language,
              status,
              started_at,
              completed_at,
              total_keys,
              translated_keys,
              failed_keys,
              skipped_keys,
              dry_run,
              summary
            FROM translation_jobs
            WHERE job_type = ? AND target_language = ?
            ORDER BY started_at DESC
            LIMIT 1
          `
        ).get(jobType, normalizedTargetLanguage)
      : this.database.prepare(
          `
            SELECT
              job_id,
              request_id,
              job_type,
              target_language,
              status,
              started_at,
              completed_at,
              total_keys,
              translated_keys,
              failed_keys,
              skipped_keys,
              dry_run,
              summary
            FROM translation_jobs
            WHERE job_type = ?
            ORDER BY started_at DESC
            LIMIT 1
          `
        ).get(jobType);

    return row ? this.mapTranslationJobRecord(row as Record<string, unknown>) : undefined;
  }

  async logNotification(entry: NotificationLogRecord): Promise<void> {
    this.database.prepare(
      `
        INSERT INTO notification_log (
          notification_id,
          channel,
          event_type,
          payload,
          status,
          timestamp
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `
    ).run(
      entry.notificationId,
      entry.channel,
      entry.eventType,
      JSON.stringify(entry.payload),
      entry.status,
      entry.timestamp
    );
  }

  async getProviderUsageStats(
    languageCode: string
  ): Promise<Partial<Record<TranslationStringRecord["providerUsed"], number>>> {
    const normalizedLanguage = normalizeLanguageCode(languageCode);
    const rows = this.database.prepare(
      `
        SELECT provider_used, COUNT(*) AS total
        FROM translation_strings
        WHERE language_code = ?
        GROUP BY provider_used
      `
    ).all(normalizedLanguage) as Array<Record<string, unknown>>;

    return rows.reduce<Partial<Record<TranslationStringRecord["providerUsed"], number>>>(
      (stats, row) => {
        stats[String(row["provider_used"]) as TranslationStringRecord["providerUsed"]] = Number(
          row["total"]
        );
        return stats;
      },
      {}
    );
  }

  close(): void {
    this.database.close();
  }

  private getActiveLanguagesSync(): LanguageRecord[] {
    const rows = this.database.prepare(
      `
        SELECT
          language_code,
          language_name,
          is_source,
          is_active,
          created_at,
          updated_at
        FROM languages
        WHERE is_active = 1
        ORDER BY language_code ASC
      `
    ).all() as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapLanguageRecord(row));
  }

  private insertAudit(input: {
    jobId?: string;
    action: TranslationAuditRecord["action"];
    stringKey: string;
    languageCode: string;
    providerUsed: TranslationStringRecord["providerUsed"];
    oldValue?: string;
    newValue?: string;
  }): void {
    this.database.prepare(
      `
        INSERT INTO translation_audit (
          audit_id,
          job_id,
          string_key,
          language_code,
          action,
          provider_used,
          old_value,
          new_value,
          timestamp
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      randomUUID(),
      input.jobId ?? null,
      input.stringKey,
      input.languageCode,
      input.action,
      input.providerUsed,
      input.oldValue ?? null,
      input.newValue ?? null,
      new Date().toISOString()
    );
  }

  private mapLanguageRecord(row: Record<string, unknown>): LanguageRecord {
    return {
      languageCode: String(row["language_code"]),
      languageName: String(row["language_name"]),
      isSource: Number(row["is_source"]) === 1,
      isActive: Number(row["is_active"]) === 1,
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  private mapTranslationStringRecord(row: Record<string, unknown>): TranslationStringRecord {
    return {
      stringKey: String(row["string_key"]),
      languageCode: String(row["language_code"]),
      translatedText: String(row["translated_text"]),
      sourceText: String(row["source_text"]),
      status: String(row["status"]) as TranslationStringRecord["status"],
      providerUsed: String(row["provider_used"]) as TranslationStringRecord["providerUsed"],
      version: Number(row["version"]),
      hash: String(row["hash"]),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  private mapTranslationJobRecord(row: Record<string, unknown>): TranslationJobRecord {
    return {
      jobId: String(row["job_id"]),
      requestId: String(row["request_id"]),
      jobType: String(row["job_type"]) as TranslationJobRecord["jobType"],
      targetLanguage: row["target_language"] ? String(row["target_language"]) : undefined,
      status: String(row["status"]) as TranslationJobRecord["status"],
      startedAt: String(row["started_at"]),
      completedAt: row["completed_at"] ? String(row["completed_at"]) : undefined,
      totalKeys: Number(row["total_keys"]),
      translatedKeys: Number(row["translated_keys"]),
      failedKeys: Number(row["failed_keys"]),
      skippedKeys: Number(row["skipped_keys"]),
      dryRun: Number(row["dry_run"]) === 1,
      summary: parseJson<Record<string, unknown>>(row["summary"] as string | null),
    };
  }

  private inTransaction<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");

    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // noop
      }
      throw error;
    }
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS languages (
        language_code TEXT PRIMARY KEY,
        language_name TEXT NOT NULL,
        is_source INTEGER NOT NULL,
        is_active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS translation_strings (
        string_key TEXT NOT NULL,
        language_code TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        source_text TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_used TEXT NOT NULL,
        version INTEGER NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (string_key, language_code)
      );

      CREATE TABLE IF NOT EXISTS translation_jobs (
        job_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        target_language TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        total_keys INTEGER NOT NULL,
        translated_keys INTEGER NOT NULL,
        failed_keys INTEGER NOT NULL,
        skipped_keys INTEGER NOT NULL,
        dry_run INTEGER NOT NULL,
        summary TEXT
      );

      CREATE TABLE IF NOT EXISTS translation_audit (
        audit_id TEXT PRIMARY KEY,
        job_id TEXT,
        string_key TEXT NOT NULL,
        language_code TEXT NOT NULL,
        action TEXT NOT NULL,
        provider_used TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_log (
        notification_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
    `);
  }

  private importLegacyJsonIfNeeded(): void {
    const legacyJsonPath = this.options.legacyJsonPath?.trim();

    if (
      !legacyJsonPath ||
      path.extname(legacyJsonPath).toLowerCase() !== ".json" ||
      !existsSync(legacyJsonPath)
    ) {
      return;
    }

    const counts = this.database.prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM languages) AS language_count,
          (SELECT COUNT(*) FROM translation_strings) AS string_count,
          (SELECT COUNT(*) FROM translation_jobs) AS job_count
      `
    ).get() as Record<string, unknown>;

    if (
      Number(counts["language_count"]) > 0 ||
      Number(counts["string_count"]) > 0 ||
      Number(counts["job_count"]) > 0
    ) {
      return;
    }

    let parsed: TranslationStore;

    try {
      parsed = JSON.parse(readFileSync(legacyJsonPath, "utf8")) as TranslationStore;
    } catch (error) {
      console.warn(`Skipping legacy translation import from ${legacyJsonPath}:`, error);
      return;
    }

    this.inTransaction(() => {
      for (const language of parsed.languages ?? []) {
        this.database.prepare(
          `
            INSERT OR REPLACE INTO languages (
              language_code,
              language_name,
              is_source,
              is_active,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `
        ).run(
          language.languageCode,
          language.languageName,
          language.isSource ? 1 : 0,
          language.isActive ? 1 : 0,
          language.createdAt,
          language.updatedAt
        );
      }

      for (const record of parsed.translationStrings ?? []) {
        this.database.prepare(
          `
            INSERT OR REPLACE INTO translation_strings (
              string_key,
              language_code,
              translated_text,
              source_text,
              status,
              provider_used,
              version,
              hash,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          record.stringKey,
          record.languageCode,
          record.translatedText,
          record.sourceText,
          record.status,
          record.providerUsed,
          record.version,
          record.hash,
          record.createdAt,
          record.updatedAt
        );
      }

      for (const job of parsed.translationJobs ?? []) {
        this.database.prepare(
          `
            INSERT OR REPLACE INTO translation_jobs (
              job_id,
              request_id,
              job_type,
              target_language,
              status,
              started_at,
              completed_at,
              total_keys,
              translated_keys,
              failed_keys,
              skipped_keys,
              dry_run,
              summary
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          job.jobId,
          job.requestId,
          job.jobType,
          job.targetLanguage ?? null,
          job.status,
          job.startedAt,
          job.completedAt ?? null,
          job.totalKeys,
          job.translatedKeys,
          job.failedKeys,
          job.skippedKeys,
          job.dryRun ? 1 : 0,
          JSON.stringify(job.summary ?? null)
        );
      }

      for (const audit of parsed.translationAudit ?? []) {
        this.database.prepare(
          `
            INSERT OR REPLACE INTO translation_audit (
              audit_id,
              job_id,
              string_key,
              language_code,
              action,
              provider_used,
              old_value,
              new_value,
              timestamp
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          audit.auditId,
          audit.jobId ?? null,
          audit.stringKey,
          audit.languageCode,
          audit.action,
          audit.providerUsed,
          audit.oldValue ?? null,
          audit.newValue ?? null,
          audit.timestamp
        );
      }

      for (const notification of parsed.notificationLog ?? []) {
        this.database.prepare(
          `
            INSERT OR REPLACE INTO notification_log (
              notification_id,
              channel,
              event_type,
              payload,
              status,
              timestamp
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `
        ).run(
          notification.notificationId,
          notification.channel,
          notification.eventType,
          JSON.stringify(notification.payload),
          notification.status,
          notification.timestamp
        );
      }
    });
  }
}
