import azureModule = require("../utils/azureTranslate");
import awsModule = require("../utils/awsTranslate");
import deeplModule = require("../utils/deeplTranslate");
import geminiModule = require("../utils/geminiTranslate");

export type ProviderOverrideMap = {
  getAzureSupportedLanguages?: typeof azureModule.getAzureSupportedLanguages;
  azureTranslate?: typeof azureModule.azureTranslate;
  getAwsSupportedLanguages?: typeof awsModule.getAwsSupportedLanguages;
  awsTranslate?: typeof awsModule.awsTranslate;
  deepLSupportsLanguage?: typeof deeplModule.deepLSupportsLanguage;
  deeplTranslateObject?: typeof deeplModule.deeplTranslateObject;
  geminiTranslate?: typeof geminiModule.geminiTranslate;
};

export function withProviderOverrides<T>(
  overrides: ProviderOverrideMap,
  run: () => Promise<T>
): Promise<T> {
  const restoreAzure = patchModule(azureModule, {
    getAzureSupportedLanguages: azureModule.getAzureSupportedLanguages,
    azureTranslate: azureModule.azureTranslate,
  });
  const restoreAws = patchModule(awsModule, {
    getAwsSupportedLanguages: awsModule.getAwsSupportedLanguages,
    awsTranslate: awsModule.awsTranslate,
  });
  const restoreDeepl = patchModule(deeplModule, {
    deepLSupportsLanguage: deeplModule.deepLSupportsLanguage,
    deeplTranslateObject: deeplModule.deeplTranslateObject,
  });
  const restoreGemini = patchModule(geminiModule, {
    geminiTranslate: geminiModule.geminiTranslate,
  });

  if (overrides.getAzureSupportedLanguages) {
    azureModule.getAzureSupportedLanguages = overrides.getAzureSupportedLanguages;
  }
  if (overrides.azureTranslate) {
    azureModule.azureTranslate = overrides.azureTranslate;
  }
  if (overrides.getAwsSupportedLanguages) {
    awsModule.getAwsSupportedLanguages = overrides.getAwsSupportedLanguages;
  }
  if (overrides.awsTranslate) {
    awsModule.awsTranslate = overrides.awsTranslate;
  }
  if (overrides.deepLSupportsLanguage) {
    deeplModule.deepLSupportsLanguage = overrides.deepLSupportsLanguage;
  }
  if (overrides.deeplTranslateObject) {
    deeplModule.deeplTranslateObject = overrides.deeplTranslateObject;
  }
  if (overrides.geminiTranslate) {
    geminiModule.geminiTranslate = overrides.geminiTranslate;
  }

  return run().finally(() => {
    restoreAzure();
    restoreAws();
    restoreDeepl();
    restoreGemini();
  });
}

function patchModule<T extends Record<string, unknown>>(
  moduleObject: T,
  current: Partial<T>
): () => void {
  const previous = new Map<keyof T, T[keyof T]>();

  for (const key of Object.keys(current) as Array<keyof T>) {
    previous.set(key, moduleObject[key]);
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      moduleObject[key] = value;
    }
  };
}
