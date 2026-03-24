import TextTranslationClient, {
  isUnexpected,
  type TranslatorCredential,
} from "@azure-rest/ai-translation-text";
import type { SupportedLanguage } from "../types/translation";

let clientInstance:
  | ReturnType<typeof TextTranslationClient>
  | null
  | undefined;
let cachedSupportedLanguageCodes: string[] = [];

function getAzureClient(): ReturnType<typeof TextTranslationClient> | null {
  if (clientInstance !== undefined) {
    return clientInstance;
  }

  const endpoint = process.env["AZURE_TRANSLATOR_ENDPOINT"];
  const apiKey = process.env["AZURE_TRANSLATOR_KEY"];
  const region = process.env["AZURE_TRANSLATOR_REGION"];

  if (!endpoint || !apiKey || !region) {
    clientInstance = null;
    return clientInstance;
  }

  const credential: TranslatorCredential = {
    key: apiKey,
    region,
  };

  clientInstance = TextTranslationClient(endpoint, credential);

  return clientInstance;
}

export async function getAzureSupportedLanguages(): Promise<SupportedLanguage[]> {
  const client = getAzureClient();

  if (!client) {
    return [];
  }

  const response = await client.path("/languages").get({
    queryParameters: {
      scope: "translation",
    },
  });

  if (isUnexpected(response)) {
    throw response.body;
  }

  const languageMap = response.body.translation ?? {};
  const languages = Object.entries(languageMap).map(([code, language]) => ({
    code,
    name: language.name,
  }));

  cachedSupportedLanguageCodes = languages.map((language) => language.code.toLowerCase());

  return languages;
}

export async function azureTranslate(
  languageCode: string,
  data: string | Record<string, string>
): Promise<string | Record<string, string>> {
  const client = getAzureClient();

  if (!client) {
    throw new Error(
      "Azure Translator client is not configured (missing AZURE_TRANSLATOR_ENDPOINT, AZURE_TRANSLATOR_KEY, or AZURE_TRANSLATOR_REGION)"
    );
  }

  const normalizedLanguageCode = languageCode.trim();
  await ensureAzureLanguageSupported(normalizedLanguageCode);

  if (typeof data === "string") {
    const translatedValues = await translateBatch(client, [data], normalizedLanguageCode);
    return translatedValues[0] ?? "";
  }

  if (typeof data !== "object" || data === null) {
    throw new Error("Input must be a non-null object or a string.");
  }

  const entries = Object.entries(data);
  const translatedValues = await translateBatch(
    client,
    entries.map(([, value]) => value),
    normalizedLanguageCode
  );

  return Object.fromEntries(
    entries.map(([key], index) => [key, translatedValues[index] ?? ""])
  );
}

async function ensureAzureLanguageSupported(languageCode: string): Promise<void> {
  const normalizedLanguageCode = languageCode.toLowerCase();

  if (cachedSupportedLanguageCodes.length === 0) {
    await getAzureSupportedLanguages();
  }

  if (!cachedSupportedLanguageCodes.includes(normalizedLanguageCode)) {
    throw new Error(`Language code "${languageCode}" is not supported by Azure Translator.`);
  }
}

async function translateBatch(
  client: ReturnType<typeof TextTranslationClient>,
  texts: string[],
  targetLanguage: string
): Promise<string[]> {
  const response = await client.path("/translate").post({
    body: texts.map((text) => ({ text })),
    queryParameters: {
      to: targetLanguage,
    },
  });

  if (isUnexpected(response)) {
    throw response.body;
  }

  return response.body.map((item) => item.translations?.[0]?.text ?? "");
}
