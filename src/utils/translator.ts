import type { Language } from "deepl-node";
import type { SupportedLanguage } from "../types/translation";

let deeplSupportedLanguages: string[] = [];
let deeplLanguages: SupportedLanguage[] = [];

export function formatSupportedLanguages(languages: readonly Language[]): SupportedLanguage[] {
  return languages.map((language) => ({
    code: language.code,
    name: language.name,
    supportsFormality: language.supportsFormality,
  }));
}

export function setCachedSupportedLanguages(languages: SupportedLanguage[]): void {
  deeplLanguages = languages;
  deeplSupportedLanguages = languages.map((language) => language.code.toLowerCase());
}

export function getCachedSupportedLanguages(): SupportedLanguage[] {
  return deeplLanguages;
}

export function getCachedSupportedLanguageCodes(): string[] {
  return deeplSupportedLanguages;
}
