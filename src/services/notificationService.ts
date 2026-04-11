import { randomUUID } from "crypto";
import type {
  NotificationEventType,
  NotificationStatus,
  RemediationResponse,
  ValidateTranslationsResponse,
} from "../types/platform";
import type { TranslationRepository } from "../repository/translationRepository";

export class NotificationService {
  constructor(private readonly repository: TranslationRepository) {}

  async notify(eventType: NotificationEventType, payload: Record<string, unknown>): Promise<void> {
    const webhookUrl = process.env["SLACK_WEBHOOK_URL"]?.trim();
    let status: NotificationStatus = "skipped";

    if (webhookUrl) {
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: this.formatPayload(eventType, payload),
          }),
        });

        status = response.ok ? "sent" : "failed";

        if (!response.ok) {
          console.error(`Slack notification failed (${eventType}): ${response.status}`);
        }
      } catch (error) {
        status = "failed";
        console.error(`Slack notification error (${eventType}):`, error);
      }
    }

    await this.repository.logNotification({
      notificationId: randomUUID(),
      channel: "slack",
      eventType,
      payload,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  async notifyValidationSummary(validation: ValidateTranslationsResponse): Promise<void> {
    const mismatches = validation.languages.filter((language) => language.status === "mismatch");

    if (mismatches.length === 0) {
      return;
    }

    await this.notify("validation_mismatch", {
      source_language: validation.source_language,
      source_count: validation.source_count,
      mismatches: mismatches.map((item) => ({
        language: item.language,
        count: item.count,
        missing: item.missing,
        extra: item.extra,
        missing_keys_sample: item.missing_keys.slice(0, 10),
      })),
    });
  }

  async notifyRemediationSummary(summary: RemediationResponse): Promise<void> {
    await this.notify("daily_remediation", {
      request_id: summary.request_id,
      dry_run: summary.dry_run,
      summary: summary.summary.map((item) => ({
        language: item.language,
        detected_missing: item.detected_missing,
        translated: item.translated,
        failed: item.failed,
        skipped: item.skipped,
        missing_keys_sample: item.missing_keys_sample,
      })),
    });
  }

  private formatPayload(eventType: NotificationEventType, payload: Record<string, unknown>): string {
    return [
      `translation event: ${eventType}`,
      ...Object.entries(payload).map(([key, value]) => `${key}: ${this.formatValue(value)}`),
    ].join("\n");
  }

  private formatValue(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    return JSON.stringify(value);
  }
}
