export type SupportedLanguage = {
  code: string;
  name: string;
  supportsFormality?: boolean;
};

export type TranslateRequestBody = {
  languageCode?: string;
  text?: string;
};

export type LanguageResponseItem = {
  code: string;
  name: string;
};
