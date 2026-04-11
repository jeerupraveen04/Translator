import type {
  BackfillLanguageResponse,
  LanguageStatusResponse,
  RemediationResponse,
  ValidateTranslationsResponse,
} from "../types/platform";
import { TranslationPlatformError, type TranslationPlatformService } from "./translationPlatformService";

type SlackResponseType = "ephemeral" | "in_channel";

export type SlackCommandPayload = {
  command?: string;
  text?: string;
  user_id?: string;
  user_name?: string;
  response_url?: string;
  channel_id?: string;
  channel_name?: string;
  team_id?: string;
  team_domain?: string;
};

export type SlackMessage = {
  response_type: SlackResponseType;
  text: string;
};

export type SlackCommandExecution = {
  immediateResponse: SlackMessage;
  deferredTask?: () => Promise<void>;
};

type SlackAction = "validate" | "status" | "backfill" | "remediate" | "help";

export type ParsedSlackAction = {
  action: SlackAction;
  args: string[];
};

function normalizeText(text: string | undefined): string {
  return text?.trim() ?? "";
}

export function parseSlackCommand(payload: SlackCommandPayload): ParsedSlackAction {
  const command = payload.command;
  const text = payload.text;
  const normalizedCommand = (command ?? "").trim().toLowerCase();
  const tokens = normalizeText(text)
    .split(/\s+/)
    .filter(Boolean);

  if (normalizedCommand === "/translate-validate") {
    return { action: "validate", args: tokens };
  }

  if (normalizedCommand === "/translate-status") {
    return { action: "status", args: tokens };
  }

  if (normalizedCommand === "/translate-backfill") {
    return { action: "backfill", args: tokens };
  }

  if (normalizedCommand === "/translate-remediate") {
    return { action: "remediate", args: tokens };
  }

  if (normalizedCommand === "/translate" || normalizedCommand === "") {
    const [firstToken, ...rest] = tokens;
    const action = (firstToken?.toLowerCase() ?? "help") as SlackAction;
    if (["validate", "status", "backfill", "remediate", "help"].includes(action)) {
      return { action, args: rest };
    }
  }

  return { action: "help", args: [] };
}

function parseAllowedUsers(): Set<string> {
  const raw = process.env["SLACK_ALLOWED_USER_IDS"]?.trim();
  if (!raw) {
    return new Set<string>();
  }

  return new Set(
    raw
      .split(",")
      .map((userId) => userId.trim())
      .filter(Boolean)
  );
}

export function authorizeSlackCommand(
  payload: SlackCommandPayload,
  parsed: ParsedSlackAction = parseSlackCommand(payload)
): boolean {
  if (!["backfill", "remediate"].includes(parsed.action)) {
    return true;
  }

  const allowedUsers = parseAllowedUsers();
  if (allowedUsers.size === 0) {
    return true;
  }

  return Boolean(payload.user_id && allowedUsers.has(payload.user_id));
}

function formatValidationSummary(validation: ValidateTranslationsResponse): string {
  const mismatches = validation.languages.filter((language) => language.status === "mismatch");
  const header = `Validation for ${validation.source_language}: source count ${validation.source_count}`;

  if (mismatches.length === 0) {
    return `${header}\nAll active languages match the source language.`;
  }

  const lines = mismatches.map(
    (language) =>
      `${language.language}: count=${language.count}, missing=${language.missing}, extra=${language.extra}, sample_missing=${language.missing_keys.slice(0, 5).join(", ") || "none"}`
  );

  return [header, ...lines].join("\n");
}

function formatLanguageStatus(status: LanguageStatusResponse): string {
  const providerStats = Object.entries(status.provider_stats)
    .map(([provider, count]) => `${provider}=${count}`)
    .join(", ") || "none";

  return [
    `Status for ${status.language}:`,
    `count=${status.count}`,
    `missing=${status.missing_keys.length ? status.missing_keys.join(", ") : "none"}`,
    `extra=${status.extra_keys.length ? status.extra_keys.join(", ") : "none"}`,
    `last_job_status=${status.last_job_status ?? "none"}`,
    `provider_stats=${providerStats}`,
  ].join("\n");
}

function formatBackfillSummary(result: BackfillLanguageResponse): string {
  return [
    `Backfill completed for ${result.target_language}.`,
    `translated=${result.translated_count}`,
    `skipped_existing=${result.skipped_existing_count}`,
    `failed=${result.failed_count}`,
  ].join("\n");
}

function formatRemediationSummary(result: RemediationResponse): string {
  const lines = result.summary.map(
    (entry) =>
      `${entry.language}: detected=${entry.detected_missing}, translated=${entry.translated}, skipped=${entry.skipped}, failed=${entry.failed}`
  );

  return [
    `Remediation ${result.dry_run ? "dry-run" : "completed"}.`,
    ...lines,
  ].join("\n");
}

async function postSlackResponse(responseUrl: string, message: SlackMessage): Promise<void> {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`Slack response_url post failed with status ${response.status}.`);
  }
}

export class SlackCommandService {
  constructor(private readonly translationService: TranslationPlatformService) {}

  async handleCommand(payload: SlackCommandPayload): Promise<SlackCommandExecution> {
    const parsed = parseSlackCommand(payload);

    switch (parsed.action) {
      case "validate": {
        const validation = await this.translationService.validateTranslations();
        return {
          immediateResponse: {
            response_type: "ephemeral",
            text: formatValidationSummary(validation),
          },
        };
      }
      case "status": {
        const languageCode = parsed.args[0];
        if (!languageCode) {
          throw new TranslationPlatformError("Usage: /translate-status <language>", 400);
        }

        const status = await this.translationService.getLanguageStatus(languageCode);
        return {
          immediateResponse: {
            response_type: "ephemeral",
            text: formatLanguageStatus(status),
          },
        };
      }
      case "backfill": {
        this.ensureMutationAllowed(payload, parsed);
        const languageCode = parsed.args[0];
        if (!languageCode) {
          throw new TranslationPlatformError("Usage: /translate-backfill <language>", 400);
        }

        return this.buildDeferredExecution(
          payload.response_url,
          `Backfill started for ${languageCode}.`,
          async () => {
            const result = await this.translationService.backfillLanguage({
              target_language: languageCode,
            });
            return {
              response_type: "ephemeral",
              text: formatBackfillSummary(result),
            };
          }
        );
      }
      case "remediate": {
        this.ensureMutationAllowed(payload, parsed);
        const dryRun = parsed.args.includes("--dry-run");
        const targetLanguages = parsed.args
          .filter((arg) => arg !== "--dry-run")
          .map((arg) => arg.trim().toLowerCase())
          .filter(Boolean);

        return this.buildDeferredExecution(
          payload.response_url,
          `Remediation ${dryRun ? "dry-run" : "job"} started${targetLanguages.length ? ` for ${targetLanguages.join(", ")}` : ""}.`,
          async () => {
            const result = await this.translationService.remediateMissingTranslations({
              dry_run: dryRun,
              ...(targetLanguages.length ? { target_languages: targetLanguages } : {}),
            });
            return {
              response_type: "ephemeral",
              text: formatRemediationSummary(result),
            };
          }
        );
      }
      case "help":
      default:
        return {
          immediateResponse: {
            response_type: "ephemeral",
            text: [
              "Available commands:",
              "/translate-validate",
              "/translate-status <language>",
              "/translate-backfill <language>",
              "/translate-remediate [--dry-run] [language ...]",
            ].join("\n"),
          },
        };
    }
  }

  private async buildDeferredExecution(
    responseUrl: string | undefined,
    startedText: string,
    task: () => Promise<SlackMessage>
  ): Promise<SlackCommandExecution> {
    if (!responseUrl) {
      return {
        immediateResponse: await task(),
      };
    }

    return {
      immediateResponse: {
        response_type: "ephemeral",
        text: startedText,
      },
      deferredTask: async () => {
        const message = await task();
        await postSlackResponse(responseUrl, message);
      },
    };
  }

  private ensureMutationAllowed(
    payload: SlackCommandPayload,
    parsed: ParsedSlackAction
  ): void {
    if (!authorizeSlackCommand(payload, parsed)) {
      throw new TranslationPlatformError(
        "You are not allowed to run mutating translation commands.",
        403
      );
    }
  }
}

export function createSlackCommandService(
  translationService: TranslationPlatformService
): SlackCommandService {
  return new SlackCommandService(translationService);
}

export async function handleSlackCommand(
  translationService: TranslationPlatformService,
  payload: SlackCommandPayload
): Promise<SlackCommandExecution> {
  return createSlackCommandService(translationService).handleCommand(payload);
}
