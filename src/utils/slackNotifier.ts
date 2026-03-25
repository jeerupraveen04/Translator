type SlackEvent =
  | "start"
  | "missed languages"
  | "insert start"
  | "completion"
  | "failure";

export async function sendSlackNotification(
  event: SlackEvent,
  details: Record<string, unknown>
): Promise<void> {
  const webhookUrl = process.env["SLACK_WEBHOOK_URL"];

  if (!webhookUrl) {
    return;
  }

  const text = [
    `translation event: ${event}`,
    ...Object.entries(details).map(([key, value]) => `${key}: ${formatValue(value)}`),
  ].join("\n");

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      console.error(`Slack notification failed (${event}): ${response.status}`);
    }
  } catch (error) {
    console.error(`Slack notification error (${event}):`, error);
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}
