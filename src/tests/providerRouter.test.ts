import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRouter } from "../services/providerRouter";
import type { TranslationObject } from "../types/translation";
import { withProviderOverrides } from "./providerRouterHarness";

function createRouter(maxRetries = 0): ProviderRouter {
  return new ProviderRouter({
    batchSize: 10,
    timeoutMs: 100,
    retries: maxRetries,
  }, {
    sleep: async () => undefined,
  });
}

function buildInput(): TranslationObject {
  return {
    hello: "Hello",
    bye: "Bye",
  };
}

test("provider router tries Azure, AWS, DeepL, then Gemini in order", async () => {
  const router = createRouter();

  const result: any = await withProviderOverrides(
    {
      getAzureSupportedLanguages: async () => [{ code: "fr", name: "French" }],
      getAwsSupportedLanguages: async () => ["fr"],
      deepLSupportsLanguage: async () => true,
      azureTranslate: async () => {
        throw new Error("azure hard failure");
      },
      awsTranslate: async () => {
        throw new Error("aws hard failure");
      },
      deeplTranslateObject: async () => {
        throw new Error("deepl hard failure");
      },
      geminiTranslate: async (_languageCode, input) =>
        Object.fromEntries(
          Object.entries(input).map(([key, value]) => [key, `gemini:${value}`])
        ),
    },
    async () =>
      router.translateObject({
        sourceLanguage: "en",
        targetLanguage: "fr",
        strings: buildInput(),
      })
  );

  assert.deepEqual(result.translations, {
    hello: "gemini:Hello",
    bye: "gemini:Bye",
  });
  assert.deepEqual(
    result.attempts.map((attempt: { provider: string }) => attempt.provider),
    ["azure", "aws", "deepl", "gemini"]
  );
  assert.deepEqual(
    result.attempts.map((attempt: { success: boolean }) => attempt.success),
    [false, false, false, true]
  );
});

test("provider router retries transient provider failures before falling back", async () => {
  const router = createRouter(2);
  let azureCalls = 0;

  const result: any = await withProviderOverrides(
    {
      getAzureSupportedLanguages: async () => [{ code: "fr", name: "French" }],
      getAwsSupportedLanguages: async () => [],
      deepLSupportsLanguage: async () => false,
      azureTranslate: async () => {
        azureCalls += 1;

        if (azureCalls < 3) {
          throw new Error("temporary outage");
        }

        return {
          hello: "azure:Hello",
          bye: "azure:Bye",
        };
      },
    },
    async () =>
      router.translateObject({
        sourceLanguage: "en",
        targetLanguage: "fr",
        strings: buildInput(),
      })
  );

  assert.deepEqual(result.translations, {
    hello: "azure:Hello",
    bye: "azure:Bye",
  });
  assert.equal(azureCalls, 3);
  assert.deepEqual(
    result.attempts.map(
      (attempt: { provider: string; attemptCount: number; success: boolean }) => [
        attempt.provider,
        attempt.attemptCount,
        attempt.success,
      ]
    ),
    [["azure", 3, true]]
  );
  assert.equal(result.attempts[0]?.attemptCount, 3);
});

test("provider router rejects incomplete provider payloads and falls back to the next provider", async () => {
  const router = createRouter();

  const result: any = await withProviderOverrides(
    {
      getAzureSupportedLanguages: async () => [{ code: "fr", name: "French" }],
      getAwsSupportedLanguages: async () => ["fr"],
      deepLSupportsLanguage: async () => false,
      azureTranslate: async () => ({
        hello: "azure:Hello",
      }),
      awsTranslate: async (_languageCode, input) =>
        Object.fromEntries(
          Object.entries(input).map(([key, value]) => [key, `aws:${value}`])
        ),
    },
    async () =>
      router.translateObject({
        sourceLanguage: "en",
        targetLanguage: "fr",
        strings: buildInput(),
      })
  );

  assert.equal(result.primaryProvider, "aws");
  assert.deepEqual(result.translations, {
    hello: "aws:Hello",
    bye: "aws:Bye",
  });
  assert.equal(result.attempts[0]?.provider, "azure");
  assert.equal(result.attempts[0]?.success, false);
  assert.match(result.attempts[0]?.message ?? "", /preserve all source keys/i);
  assert.equal(result.attempts[1]?.provider, "aws");
  assert.equal(result.attempts[1]?.success, true);
});
