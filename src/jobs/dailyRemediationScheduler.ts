import { platformConfig } from "../config/platformConfig";
import { TranslationPlatformService } from "../services/translationPlatformService";

export type DailyRemediationSchedulerOptions = {
  enabled?: boolean;
  dailyTime?: string;
  onRun?: (startedAt: string) => Promise<unknown>;
};

export class DailyRemediationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly service: TranslationPlatformService,
    private readonly options: DailyRemediationSchedulerOptions = {}
  ) {}

  start(): void {
    if (this.options.enabled ?? platformConfig.remediation.enabled) {
      this.scheduleNextRun();
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getNextRunAt(reference: Date = new Date()): Date {
    const time = this.options.dailyTime ?? platformConfig.remediation.time;
    return computeNextRunAt(reference, time);
  }

  private scheduleNextRun(): void {
    this.stop();

    const nextRunAt = this.getNextRunAt();
    const delayMs = Math.max(0, nextRunAt.getTime() - Date.now());

    this.timer = setTimeout(async () => {
      if (this.running) {
        this.scheduleNextRun();
        return;
      }

      this.running = true;
      const startedAt = new Date().toISOString();

      try {
        if (this.options.onRun) {
          await this.options.onRun(startedAt);
        } else {
          await this.service.remediateMissingTranslations({ dry_run: false });
        }
      } catch (error) {
        console.error("Daily remediation scheduler failed:", error);
      } finally {
        this.running = false;
        this.scheduleNextRun();
      }
    }, delayMs);
  }
}

function computeNextRunAt(reference: Date, hhmm: string): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) {
    throw new Error(`Invalid HH:mm time value: ${hhmm}`);
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const next = new Date(reference);
  next.setSeconds(0, 0);
  next.setHours(hours, minutes, 0, 0);

  if (next.getTime() <= reference.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}
