import type { TranslationRepository } from "../repository/platformRepository";
import type {
  RemediationResult,
  TranslationJob,
  TranslationProviderName,
  ValidationReport,
} from "../types/platform";
import { sendSlackNotification } from "../utils/slackNotifier";

export type NotificationPayload = Record<string, unknown>;

export class NotificationService {
  constructor(private readonly repository: TranslationRepository) {}

  async notify(
    event: string,
    details: NotificationPayload,
    options: {
      jobId?: string;
      languageCode?: string;
      provider?: TranslationProviderName;
      message?: string;
    } = {}
  ): Promise<void> {
    const message = options.message ?? event;
    let success = true;

    try {
      await sendSlackNotification(event as Parameters<typeof sendSlackNotification>[0], details);
    } catch (error) {
      success = false;
      console.error(`Notification failed for ${event}:`, error);
    }

    await this.repository.logNotification({
      event,
      success,
      message,
      details,
      jobId: options.jobId,
      languageCode: options.languageCode,
      provider: options.provider,
    });
  }

  async notifyJob(job: TranslationJob, details: NotificationPayload = {}): Promise<void> {
    await this.notify(job.type, { ...details, job }, { jobId: job.id, message: job.status });
  }

  async notifyValidation(report: ValidationReport): Promise<void> {
    await this.notify("validation", report as NotificationPayload, { message: report.overallStatus });
  }

  async notifyRemediation(summary: RemediationResult): Promise<void> {
    await this.notify("remediation", summary as NotificationPayload, {
      message: summary.dryRun ? "dry_run" : "completed",
    });
  }
}

export function createNotificationService(repository: TranslationRepository): NotificationService {
  return new NotificationService(repository);
}
