import assert from "node:assert/strict";
import test from "node:test";
import { platformConfig } from "../config/platformConfig";
import type { TranslationObject } from "../types/translation";
import { createTestHarness } from "./translationPlatformTestHarness";

function getSourceLanguage(): string {
  return platformConfig.sourceLanguage;
}

function getTargetLanguage(): string {
  const target = Object.keys(platformConfig.translationLanguages).find(
    (languageCode) => languageCode !== platformConfig.sourceLanguage
  );

  if (!target) {
    throw new Error("Expected at least one target language in platformConfig.translationLanguages.");
  }

  return target;
}

function buildRegistry(sourceLanguage: string, targetLanguage: string): Record<string, string> {
  return {
    [sourceLanguage]: platformConfig.translationLanguages[sourceLanguage] ?? "English",
    [targetLanguage]: platformConfig.translationLanguages[targetLanguage] ?? targetLanguage.toUpperCase(),
  };
}

function assertRecordShape(record: {
  stringKey: string;
  languageCode: string;
  translatedText: string;
  sourceText: string;
  status: string;
  providerUsed: string;
  version: number;
  hash: string;
  createdAt: string;
  updatedAt: string;
}): void {
  assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(record.hash, /^[a-f0-9]{64}$/);
}

test("translateAll persists source and target translations with a stable response shape", async (t) => {
  const harness = await createTestHarness({
    responseFactory: (call) => ({
      translations: Object.fromEntries(
        Object.entries(call.strings).map(([key, value]) => [key, `translated:${value}`])
      ),
      providerUsedByKey: Object.fromEntries(Object.keys(call.strings).map((key) => [key, "gemini"])),
      primaryProvider: "gemini",
      fallbacksUsed: ["azure"],
      attempts: [
        {
          provider: "azure",
          attemptCount: 1,
          success: false,
          transient: true,
          message: "temporary failure",
        },
        {
          provider: "gemini",
          attemptCount: 1,
          success: true,
        },
      ],
    }),
  });

  t.after(async () => {
    await harness.cleanup();
  });

  const sourceLanguage = getSourceLanguage();
  const targetLanguage = getTargetLanguage();
  const sourceStrings: TranslationObject = {
    hello: "Hello",
    bye: "Bye",
  };

  const response = await harness.service.translateAll({
    source_language: sourceLanguage,
    translation_languages: buildRegistry(sourceLanguage, targetLanguage),
    strings: sourceStrings,
  });

  assert.equal(response.status, "success");
  assert.match(response.request_id, /^trn_/);
  assert.deepEqual(Object.keys(response).sort(), [
    "provider_summary",
    "request_id",
    "status",
    "translations",
  ]);
  assert.deepEqual(response.translations[sourceLanguage], sourceStrings);
  assert.deepEqual(response.translations[targetLanguage], {
    hello: "translated:Hello",
    bye: "translated:Bye",
  });
  assert.deepEqual(response.provider_summary.languages[sourceLanguage], {
    provider_used: "source",
    fallbacks_used: [],
    attempts: [],
  });
  assert.equal(response.provider_summary.languages[targetLanguage].provider_used, "gemini");
  assert.deepEqual(response.provider_summary.languages[targetLanguage].fallbacks_used, ["azure"]);
  assert.equal(response.provider_summary.languages[targetLanguage].attempts.length, 2);
  assert.equal(response.provider_summary.primary, "gemini");

  const sourceRecords = await harness.repository.getStringsByLanguage(sourceLanguage);
  const targetRecords = await harness.repository.getStringsByLanguage(targetLanguage);

  assert.equal(sourceRecords.length, 2);
  assert.equal(targetRecords.length, 2);
  assert.deepEqual(
    sourceRecords.map((record) => record.stringKey),
    ["bye", "hello"]
  );
  assert.deepEqual(
    targetRecords.map((record) => record.stringKey),
    ["bye", "hello"]
  );

  for (const record of sourceRecords) {
    assertRecordShape(record);
    assert.equal(record.status, "source");
    assert.equal(record.providerUsed, "source");
  }

  for (const record of targetRecords) {
    assertRecordShape(record);
    assert.equal(record.status, "auto_generated");
    assert.equal(record.providerUsed, "gemini");
  }
});

test("backfillLanguage translates only missing keys", async (t) => {
  const harness = await createTestHarness();

  t.after(async () => {
    await harness.cleanup();
  });

  const sourceLanguage = getSourceLanguage();
  const targetLanguage = getTargetLanguage();
  const sourceStrings: TranslationObject = {
    a: "Alpha",
    b: "Bravo",
    c: "Charlie",
  };

  await harness.repository.syncLanguages(buildRegistry(sourceLanguage, targetLanguage), sourceLanguage);
  await harness.repository.upsertTranslations({
    requestId: "seed-source",
    jobId: "seed-source-job",
    sourceLanguage,
    languageCode: sourceLanguage,
    strings: sourceStrings,
    sourceStrings,
    status: "source",
    providerUsedByKey: Object.fromEntries(Object.keys(sourceStrings).map((key) => [key, "source"])),
    allowOverwriteApproved: true,
  });
  await harness.repository.upsertTranslations({
    requestId: "seed-target",
    jobId: "seed-target-job",
    sourceLanguage,
    languageCode: targetLanguage,
    strings: {
      a: "Alpha-fr",
    },
    sourceStrings,
    status: "auto_generated",
    providerUsedByKey: { a: "gemini" },
    allowOverwriteApproved: true,
  });

  const response = await harness.service.backfillLanguage({
    source_language: sourceLanguage,
    target_language: targetLanguage,
    translation_languages: buildRegistry(sourceLanguage, targetLanguage),
  });

  assert.equal(response.translated_count, 2);
  assert.equal(response.skipped_existing_count, 1);
  assert.deepEqual(harness.providerRouter.calls[0]?.strings, {
    b: "Bravo",
    c: "Charlie",
  });
  assert.deepEqual(response.translations[targetLanguage], {
    b: "translated:Bravo",
    c: "translated:Charlie",
  });

  const targetRecords = await harness.repository.getStringsByLanguage(targetLanguage);
  assert.equal(targetRecords.length, 3);
  assert.deepEqual(
    targetRecords.map((record) => [record.stringKey, record.translatedText]),
    [
      ["a", "Alpha-fr"],
      ["b", "translated:Bravo"],
      ["c", "translated:Charlie"],
    ]
  );
});

test("validateTranslations and getLanguageStatus summarize missing and extra keys", async (t) => {
  const harness = await createTestHarness();

  t.after(async () => {
    await harness.cleanup();
  });

  const sourceLanguage = getSourceLanguage();
  const targetLanguage = getTargetLanguage();
  const sourceStrings: TranslationObject = {
    one: "One",
    two: "Two",
    three: "Three",
  };

  await harness.repository.syncLanguages(buildRegistry(sourceLanguage, targetLanguage), sourceLanguage);
  await harness.repository.upsertTranslations({
    requestId: "seed-source",
    jobId: "seed-source-job",
    sourceLanguage,
    languageCode: sourceLanguage,
    strings: sourceStrings,
    sourceStrings,
    status: "source",
    providerUsedByKey: Object.fromEntries(Object.keys(sourceStrings).map((key) => [key, "source"])),
    allowOverwriteApproved: true,
  });
  await harness.repository.upsertTranslations({
    requestId: "seed-target",
    jobId: "seed-target-job",
    sourceLanguage,
    languageCode: targetLanguage,
    strings: {
      one: "Uno",
      two: "Dos",
      extra: "Extra",
    },
    sourceStrings: {
      one: "One",
      two: "Two",
      extra: "Extra",
    },
    status: "auto_generated",
    providerUsedByKey: Object.fromEntries(["one", "two", "extra"].map((key) => [key, "gemini"])),
    allowOverwriteApproved: true,
  });

  const seededJob = await harness.repository.createJob({
    jobId: "manual-backfill-job",
    requestId: "manual-request",
    jobType: "backfill_language",
    targetLanguage,
    status: "running",
    totalKeys: 3,
    translatedKeys: 2,
    failedKeys: 0,
    skippedKeys: 0,
    dryRun: false,
    summary: {
      source_language: sourceLanguage,
      target_language: targetLanguage,
    },
  });
  await harness.repository.completeJob(seededJob.jobId, {
    status: "success",
    translatedKeys: 2,
    skippedKeys: 0,
  });

  const validation = await harness.service.validateTranslations(sourceLanguage);
  const targetValidation = validation.languages.find((language) => language.language === targetLanguage);

  assert.equal(validation.source_count, 3);
  assert.ok(targetValidation);
  assert.equal(targetValidation?.status, "mismatch");
  assert.equal(targetValidation?.missing, 1);
  assert.equal(targetValidation?.extra, 1);
  assert.deepEqual(targetValidation?.missing_keys, ["three"]);
  assert.deepEqual(targetValidation?.extra_keys, ["extra"]);

  const status = await harness.service.getLanguageStatus(targetLanguage, sourceLanguage);
  assert.equal(status.language, targetLanguage);
  assert.equal(status.count, 3);
  assert.deepEqual(status.missing_keys, ["three"]);
  assert.deepEqual(status.extra_keys, ["extra"]);
  assert.equal(status.last_job_status, "success");
  assert.deepEqual(status.provider_stats, {
    gemini: 3,
  });
});

test("remediation dry-run does not persist while persisted remediation writes missing translations", async (t) => {
  const dryRunHarness = await createTestHarness();
  const persistedHarness = await createTestHarness();

  t.after(async () => {
    await dryRunHarness.cleanup();
    await persistedHarness.cleanup();
  });

  const sourceLanguage = getSourceLanguage();
  const targetLanguage = getTargetLanguage();
  const sourceStrings: TranslationObject = {
    keep: "Keep",
    fill: "Fill",
  };

  for (const harness of [dryRunHarness, persistedHarness]) {
    await harness.repository.syncLanguages(buildRegistry(sourceLanguage, targetLanguage), sourceLanguage);
    await harness.repository.upsertTranslations({
      requestId: "seed-source",
      jobId: "seed-source-job",
      sourceLanguage,
      languageCode: sourceLanguage,
      strings: sourceStrings,
      sourceStrings,
      status: "source",
      providerUsedByKey: Object.fromEntries(Object.keys(sourceStrings).map((key) => [key, "source"])),
      allowOverwriteApproved: true,
    });
    await harness.repository.upsertTranslations({
      requestId: "seed-target",
      jobId: "seed-target-job",
      sourceLanguage,
      languageCode: targetLanguage,
      strings: {
        keep: "Keep-fr",
      },
      sourceStrings,
      status: "auto_generated",
      providerUsedByKey: { keep: "gemini" },
      allowOverwriteApproved: true,
    });
  }

  const dryRunResponse = await dryRunHarness.service.remediateMissingTranslations({
    source_language: sourceLanguage,
    target_languages: [targetLanguage],
    dry_run: true,
  });

  assert.equal(dryRunResponse.dry_run, true);
  assert.equal(dryRunHarness.providerRouter.calls.length, 0);
  assert.deepEqual(dryRunResponse.summary, [
    {
      language: targetLanguage,
      detected_missing: 1,
      translated: 0,
      failed: 0,
      skipped: 1,
      missing_keys_sample: ["fill"],
    },
  ]);

  const dryRunTargetRecords = await dryRunHarness.repository.getStringsByLanguage(targetLanguage);
  assert.equal(dryRunTargetRecords.length, 1);
  assert.deepEqual(
    dryRunTargetRecords.map((record) => [record.stringKey, record.translatedText]),
    [["keep", "Keep-fr"]]
  );

  const persistedResponse = await persistedHarness.service.remediateMissingTranslations({
    source_language: sourceLanguage,
    target_languages: [targetLanguage],
    dry_run: false,
  });

  assert.equal(persistedResponse.dry_run, false);
  assert.equal(persistedHarness.providerRouter.calls.length, 1);
  assert.deepEqual(persistedHarness.providerRouter.calls[0], {
    sourceLanguage,
    targetLanguage,
    strings: {
      fill: "Fill",
    },
  });
  assert.deepEqual(persistedResponse.summary, [
    {
      language: targetLanguage,
      detected_missing: 1,
      translated: 1,
      failed: 0,
      skipped: 0,
      missing_keys_sample: ["fill"],
    },
  ]);

  const persistedTargetRecords = await persistedHarness.repository.getStringsByLanguage(targetLanguage);
  assert.equal(persistedTargetRecords.length, 2);
  assert.deepEqual(
    persistedTargetRecords.map((record) => [record.stringKey, record.translatedText]),
    [
      ["fill", "translated:Fill"],
      ["keep", "Keep-fr"],
    ]
  );
});
