import path from "path";
import { languages as defaultLanguages } from "../utils/languages";
import type { TranslationLanguageRegistry } from "../types/platform";

const DEFAULT_SOURCE_LANGUAGE = "en";
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const DEFAULT_PROVIDER_RETRIES = 2;
const DEFAULT_REMEDIATION_TIME = "02:00";
const DEFAULT_DATABASE_FILE = "./data/translation-platform.db";
const DEFAULT_LEGACY_DATA_FILE = "./data/translation-platform-db.json";

function parseNumber(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(rawValue: string | undefined, fallback: boolean): boolean {
  if (!rawValue) {
    return fallback;
  }

  return rawValue.trim().toLowerCase() === "true";
}

function normalizeLanguageRegistry(registry: TranslationLanguageRegistry): TranslationLanguageRegistry {
  return Object.fromEntries(
    Object.entries(registry).map(([code, name]) => [code.trim().toLowerCase(), name.trim()])
  );
}

function parseLanguageRegistry(): TranslationLanguageRegistry {
  const rawRegistry = process.env["TRANSLATION_LANGUAGES"]?.trim();

  if (!rawRegistry) {
    return normalizeLanguageRegistry({
      [DEFAULT_SOURCE_LANGUAGE]: "English",
      ...defaultLanguages,
    });
  }

  try {
    const parsed = JSON.parse(rawRegistry) as TranslationLanguageRegistry;
    return normalizeLanguageRegistry(parsed);
  } catch (error) {
    console.warn("Failed to parse TRANSLATION_LANGUAGES. Falling back to built-in language map.", error);
    return normalizeLanguageRegistry({
      [DEFAULT_SOURCE_LANGUAGE]: "English",
      ...defaultLanguages,
    });
  }
}

function resolvePath(rawPath: string | undefined, fallback: string): string {
  const configuredPath = rawPath?.trim() || fallback;
  return path.resolve(process.cwd(), configuredPath);
}

export const platformConfig = {
  sourceLanguage: (process.env["SOURCE_LANGUAGE"]?.trim().toLowerCase() || DEFAULT_SOURCE_LANGUAGE),
  translationLanguages: parseLanguageRegistry(),
  databaseFilePath: resolvePath(
    process.env["TRANSLATION_DB_FILE"],
    DEFAULT_DATABASE_FILE
  ),
  legacyDataFilePath: resolvePath(
    process.env["TRANSLATION_DATA_FILE"],
    DEFAULT_LEGACY_DATA_FILE
  ),
  batchSize: parseNumber(process.env["TRANSLATION_BATCH_SIZE"], DEFAULT_BATCH_SIZE),
  providerTimeoutMs: parseNumber(
    process.env["TRANSLATION_PROVIDER_TIMEOUT_MS"],
    DEFAULT_PROVIDER_TIMEOUT_MS
  ),
  providerRetries: parseNumber(process.env["TRANSLATION_PROVIDER_RETRIES"], DEFAULT_PROVIDER_RETRIES),
  allowOverwriteApproved: parseBoolean(
    process.env["TRANSLATION_ALLOW_OVERWRITE_APPROVED"],
    false
  ),
  remediation: {
    enabled: parseBoolean(process.env["ENABLE_DAILY_REMEDIATION"], false),
    time: process.env["DAILY_REMEDIATION_TIME"]?.trim() || DEFAULT_REMEDIATION_TIME,
  },
};
