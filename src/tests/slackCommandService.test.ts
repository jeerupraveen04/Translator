import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSlackSlashCommandPayload,
  loadSlackCommandModule,
} from "./slackCommandHarness";

test("Slack slash-command runtime matches the assumed export contract", async (t) => {
  const runtime = await loadSlackCommandModule();

  if (!runtime) {
    t.skip("Slack command module is not available.");
    return;
  }

  assert.equal(typeof runtime.createSlackCommandService, "function");
  assert.equal(typeof runtime.parseSlackCommand, "function");
  assert.equal(typeof runtime.authorizeSlackCommand, "function");
  assert.equal(typeof runtime.handleSlackCommand, "function");
});

test("Slack slash-command parsing and authorization scaffold uses the same assumed exports", async (t) => {
  const runtime = await loadSlackCommandModule();

  if (!runtime) {
    t.skip("Slack command module is not available.");
    return;
  }

  const payload = buildSlackSlashCommandPayload({
    command: "/translate",
    text: "status fr",
  });

  const parseSlackCommand = runtime.parseSlackCommand as
    | ((value: typeof payload) => Promise<unknown> | unknown)
    | undefined;
  const authorizeSlackCommand = runtime.authorizeSlackCommand as
    | ((value: typeof payload) => Promise<boolean> | boolean)
    | undefined;

  const parsed = await parseSlackCommand?.(payload);
  assert.ok(parsed);
  assert.equal(typeof parsed, "object");
  assert.deepEqual(parsed, {
    action: "status",
    args: ["fr"],
  });

  const authorized = await authorizeSlackCommand?.(payload);
  assert.equal(authorized, true);
});

test("Slack slash-command authorization blocks mutating commands for users outside the allow-list", async (t) => {
  const runtime = await loadSlackCommandModule();

  if (!runtime) {
    t.skip("Slack command module is not available.");
    return;
  }

  const previousAllowedUsers = process.env["SLACK_ALLOWED_USER_IDS"];
  process.env["SLACK_ALLOWED_USER_IDS"] = "U999";

  t.after(() => {
    if (previousAllowedUsers === undefined) {
      delete process.env["SLACK_ALLOWED_USER_IDS"];
      return;
    }

    process.env["SLACK_ALLOWED_USER_IDS"] = previousAllowedUsers;
  });

  const payload = buildSlackSlashCommandPayload({
    command: "/translate-backfill",
    text: "fr",
    user_id: "U123",
  });

  const parseSlackCommand = runtime.parseSlackCommand as (value: typeof payload) => unknown;
  const authorizeSlackCommand = runtime.authorizeSlackCommand as (
    value: typeof payload,
    parsed: unknown
  ) => boolean;

  const parsed = parseSlackCommand(payload);
  const authorized = authorizeSlackCommand(payload, parsed);

  assert.equal(authorized, false);
});

test("Slack slash-command handler returns a formatted status message", async (t) => {
  const runtime = await loadSlackCommandModule();

  if (!runtime) {
    t.skip("Slack command module is not available.");
    return;
  }

  const payload = buildSlackSlashCommandPayload({
    command: "/translate-status",
    text: "fr",
  });

  const handleSlackCommand = runtime.handleSlackCommand as (
    service: {
      getLanguageStatus: (languageCode: string) => Promise<{
        language: string;
        count: number;
        missing_keys: string[];
        extra_keys: string[];
        last_job_status?: string;
        provider_stats: Record<string, number>;
      }>;
    },
    value: typeof payload
  ) => Promise<{ immediateResponse: { response_type: string; text: string } }>;

  const execution = await handleSlackCommand(
    {
      getLanguageStatus: async (languageCode: string) => ({
        language: languageCode,
        count: 4,
        missing_keys: ["logout"],
        extra_keys: [],
        last_job_status: "success",
        provider_stats: {
          azure: 4,
        },
      }),
    } as never,
    payload
  );

  assert.equal(execution.immediateResponse.response_type, "ephemeral");
  assert.match(execution.immediateResponse.text, /status for fr/i);
  assert.match(execution.immediateResponse.text, /missing=logout/i);
  assert.match(execution.immediateResponse.text, /provider_stats=azure=4/i);
});
