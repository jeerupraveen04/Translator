import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTranslationRepository } from "../repository/sqliteTranslationRepository";
import type { NotificationService } from "../services/notificationService";
import { TranslationPlatformService } from "../services/translationPlatformService";
import type {
  ProviderTranslationResult,
  TranslateAllLanguageSummary,
} from "../types/platform";
import type { TranslationObject } from "../types/translation";

export type ProviderCall = {
  sourceLanguage: string;
  targetLanguage: string;
  strings: TranslationObject;
};

export type HarnessOptions = {
  responseFactory?: (call: ProviderCall) => ProviderTranslationResult;
};

export class StubProviderRouter {
  readonly calls: ProviderCall[] = [];

  constructor(private readonly responseFactory: (call: ProviderCall) => ProviderTranslationResult) {}

  async translateObject(input: ProviderCall): Promise<ProviderTranslationResult> {
    const call: ProviderCall = {
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      strings: { ...input.strings },
    };

    this.calls.push(call);
    return this.responseFactory(call);
  }
}

export class StubNotifications implements Pick<
  NotificationService,
  "notify" | "notifyValidationSummary" | "notifyRemediationSummary"
> {
  readonly events: Array<{ kind: string; payload: unknown }> = [];

  async notify(eventType: any, payload: Record<string, unknown>): Promise<void> {
    this.events.push({ kind: eventType, payload });
  }

  async notifyValidationSummary(payload: unknown): Promise<void> {
    this.events.push({ kind: "validation", payload });
  }

  async notifyRemediationSummary(payload: unknown): Promise<void> {
    this.events.push({ kind: "remediation", payload });
  }
}

export type TestHarness = {
  filePath: string;
  repository: SqliteTranslationRepository;
  providerRouter: StubProviderRouter;
  notifications: StubNotifications;
  service: TranslationPlatformService;
  cleanup: () => Promise<void>;
};

export async function createTestHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const tempDir = await mkdtemp(join(tmpdir(), "translator-platform-tests-"));
  const filePath = join(tempDir, "translation-store.db");
  const repository = new SqliteTranslationRepository(filePath);
  const providerRouter = new StubProviderRouter(
    options.responseFactory ??
      ((call) => ({
        translations: Object.fromEntries(
          Object.entries(call.strings).map(([key, value]) => [key, `translated:${value}`])
        ),
        providerUsedByKey: Object.fromEntries(
          Object.keys(call.strings).map((key) => [key, "gemini"])
        ),
        primaryProvider: "gemini",
        fallbacksUsed: [],
        attempts: [],
      }))
  );
  const notifications = new StubNotifications();
  const service = new TranslationPlatformService({
    repository,
    providerRouter: providerRouter as never,
    notifications: notifications as never,
  });

  return {
    filePath,
    repository,
    providerRouter,
    notifications,
    service,
    cleanup: async () => {
      repository.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export function mapProviderUsage(
  strings: TranslationObject,
  provider: TranslateAllLanguageSummary["provider_used"]
): Record<string, TranslateAllLanguageSummary["provider_used"]> {
  return Object.fromEntries(Object.keys(strings).map((key) => [key, provider]));
}
