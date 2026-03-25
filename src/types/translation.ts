export type SupportedLanguage = {
  code: string;
  name: string;
  supportsFormality?: boolean;
};

export type TranslationStringItem = {
  key: string;
  string?: string;
  value?: string;
};

export type TranslateRequestBody = {
  languageCode?: string;
  text?: string;
};

export type BulkTranslateRequestBody = {
  strings?: TranslationStringItem[];
  language?: string;
  languageCode?: string;
  sourceLanguage?: string;
};

export type TranslationObject = Record<string, string>;

export type BulkTranslateResponseBody = Record<string, TranslationObject>;

export type TranslationProviderName = "source" | "azure" | "aws" | "deepl" | "gemini";

export type TranslationAttempt = {
  provider: TranslationProviderName;
  success: boolean;
  message?: string;
};

export type LanguageResponseItem = {
  code: string;
  name: string;
};
