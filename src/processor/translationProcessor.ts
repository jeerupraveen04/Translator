import * as deepl from "deepl-node";
import { getTranslator } from "../utils/deeplClient";
import {
  formatSupportedLanguages,
  getCachedSupportedLanguageCodes,
  setCachedSupportedLanguages,
} from "../utils/translator";
import type { SupportedLanguage } from "../types/translation";
import { getAwsSupportedLanguages } from "../utils/awsTranslate";

export async function loadSupportedLanguages(): Promise<SupportedLanguage[]> {
  const translator = getTranslator();

  if (!translator) {
    return [];
  }

  const languages = await translator.getTargetLanguages();
  const formattedLanguages = formatSupportedLanguages(languages);

  setCachedSupportedLanguages(formattedLanguages);

  return formattedLanguages;
}

export async function initSupportedLanguages(): Promise<void> {
  const translator = getTranslator();

  if (!translator) {
    console.warn("DeepL translator is not configured (missing DEEPL_API_KEY)");
    return;
  }

  try {
    const supportedLanguages = await loadSupportedLanguages();
    console.log(`Loaded ${supportedLanguages.length} supported DeepL target languages at startup.`);

    await logUsage(translator, "startup");

    // Also list AWS Translate supported languages (if configured)
    try {
      const awsLangs = await getAwsSupportedLanguages();
      if (awsLangs.length > 0) {
        console.log(`Loaded ${awsLangs.length} supported AWS Translate languages at startup.`);
      } else {
        console.log("No AWS Translate languages available or AWS client not configured");
      }
    } catch (err) {
      console.error("Failed to list AWS Translate languages at startup:", err);
    }
  } catch (error) {
    console.error("Failed to initialize DeepL supported languages:", error);
  }
}

export async function translateText(languageCode: string, input: string): Promise<string> {
  const translator = getTranslator();

  if (!translator) {
    throw new Error("DeepL translator is not configured (missing DEEPL_API_KEY)");
  }

  await ensureSupportedLanguagesLoaded();
  await validateUsageLimit(translator);

  const normalizedLanguageCode = languageCode.trim().toLowerCase();
  if (!getCachedSupportedLanguageCodes().includes(normalizedLanguageCode)) {
    throw new Error(`Unsupported DeepL language code: ${languageCode}`);
  }

  const result = await translator.translateText(
    input,
    null,
    normalizedLanguageCode.toUpperCase() as deepl.TargetLanguageCode
  );

  return result.text;
}

async function ensureSupportedLanguagesLoaded(): Promise<void> {
  if (getCachedSupportedLanguageCodes().length > 0) {
    return;
  }

  await loadSupportedLanguages();
}

async function validateUsageLimit(translator: deepl.Translator): Promise<void> {
  const usage = await translator.getUsage();

  if (usage.anyLimitReached()) {
    throw new Error("DeepL API usage limit reached");
  }

  console.log(
    `DeepL characters used: ${usage.character?.count ?? 0}/${usage.character?.limit ?? 0}`
  );
}

async function logUsage(translator: deepl.Translator, context: string): Promise<void> {
  try {
    const usage = await translator.getUsage();

    if (usage.anyLimitReached()) {
      console.error(`DeepL API usage limit reached (${context} check)`);
      return;
    }

    console.log(
      `DeepL characters used (${context}): ${usage.character?.count ?? 0}/${usage.character?.limit ?? 0}`
    );
  } catch (error) {
    console.error(`Failed to retrieve DeepL usage during ${context}:`, error);
  }
}
