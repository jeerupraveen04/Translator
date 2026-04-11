import { platformConfig } from "../config/platformConfig";
import type { TranslationPlatformService } from "../services/translationPlatformService";

function millisecondsUntilNextRun(time: string): number {
  const [hoursRaw, minutesRaw] = time.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  const now = new Date();
  const nextRun = new Date(now);

  nextRun.setHours(hours, minutes, 0, 0);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    throw new Error(`Invalid DAILY_REMEDIATION_TIME value "${time}". Expected HH:mm.`);
  }

  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  return nextRun.getTime() - now.getTime();
}

export class DailyRemediationScheduler {
  private timeoutHandle: NodeJS.Timeout | undefined;

  constructor(private readonly translationService: TranslationPlatformService) {}

  start(): void {
    if (!platformConfig.remediation.enabled) {
      return;
    }

    this.scheduleNextRun();
  }

  stop(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  private scheduleNextRun(): void {
    const waitMs = millisecondsUntilNextRun(platformConfig.remediation.time);

    this.timeoutHandle = setTimeout(async () => {
      try {
        await this.translationService.remediateMissingTranslations({
          dry_run: false,
        });
      } catch (error) {
        console.error("Daily remediation job failed:", error);
      } finally {
        this.scheduleNextRun();
      }
    }, waitMs);
  }
}
