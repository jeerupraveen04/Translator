export type SlackSlashCommandPayload = {
  token: string;
  team_id: string;
  team_domain: string;
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
};

export type SlackCommandModuleShape = {
  createSlackCommandService?: unknown;
  parseSlackCommand?: unknown;
  authorizeSlackCommand?: unknown;
  handleSlackCommand?: unknown;
};

export const expectedSlackCommandExports = {
  modulePath: "../services/slackCommandService",
  createSlackCommandService: "createSlackCommandService",
  parseSlackCommand: "parseSlackCommand",
  authorizeSlackCommand: "authorizeSlackCommand",
  handleSlackCommand: "handleSlackCommand",
} as const;

export function buildSlackSlashCommandPayload(
  overrides: Partial<SlackSlashCommandPayload> = {}
): SlackSlashCommandPayload {
  return {
    token: "test-token",
    team_id: "T123",
    team_domain: "translator",
    channel_id: "C123",
    channel_name: "general",
    user_id: "U123",
    user_name: "tester",
    command: "/translate",
    text: "status fr",
    response_url: "https://example.invalid/slack-response",
    trigger_id: "1337.42",
    ...overrides,
  };
}

export async function loadSlackCommandModule(): Promise<SlackCommandModuleShape | null> {
  try {
    return require("../services/slackCommandService") as SlackCommandModuleShape;
  } catch {
    return null;
  }
}
