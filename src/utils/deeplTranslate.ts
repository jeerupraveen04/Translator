import * as deepl from "deepl-node";
import { getTranslator } from "./deeplClient";
import {
  formatSupportedLanguages,
  getCachedSupportedLanguageCodes,
  setCachedSupportedLanguages,
} from "./translator";
import type { TranslationObject, SupportedLanguage } from "../types/translation";

export async function getDeepLSupportedLanguages(): Promise<SupportedLanguage[]> {
  const translator = getTranslator();

  if (!translator) {
    return [];
  }

  const languages = await translator.getTargetLanguages();
  const formattedLanguages = formatSupportedLanguages(languages);

  setCachedSupportedLanguages(formattedLanguages);

  return formattedLanguages;
}

export async function deepLSupportsLanguage(languageCode: string): Promise<boolean> {
  const translator = getTranslator();

  if (!translator) {
    return false;
  }

  if (getCachedSupportedLanguageCodes().length === 0) {
    await getDeepLSupportedLanguages();
  }

  return getCachedSupportedLanguageCodes().includes(languageCode.trim().toLowerCase());
}

export async function deeplTranslateObject(
  languageCode: string,
  input: TranslationObject
): Promise<TranslationObject> {
  const translator = getTranslator();

  if (!translator) {
    throw new Error("DeepL translator is not configured (missing DEEPL_API_KEY)");
  }

  await validateUsageLimit(translator);

  const normalizedLanguageCode = languageCode.trim().toLowerCase();
  const isSupported = await deepLSupportsLanguage(normalizedLanguageCode);
  if (!isSupported) {
    throw new Error(`Unsupported DeepL language code: ${languageCode}`);
  }

  const entries = Object.entries(input);
  const results = await translator.translateText(
    entries.map(([, value]) => value),
    "en",
    normalizedLanguageCode.toUpperCase() as deepl.TargetLanguageCode
  );

  const translations = Array.isArray(results) ? results : [results];

  return Object.fromEntries(
    entries.map(([key], index) => [key, translations[index]?.text ?? ""])
  );
}

async function validateUsageLimit(translator: deepl.Translator): Promise<void> {
  const usage = await translator.getUsage();

  if (usage.anyLimitReached()) {
    throw new Error("DeepL API usage limit reached");
  }
}
