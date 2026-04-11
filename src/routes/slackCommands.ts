import crypto from "crypto";
import express, { Router, type Request, type Response } from "express";
import {
  createSlackCommandService,
  type SlackCommandPayload,
} from "../services/slackCommandService";
import {
  translationPlatformService,
} from "./v1Translations";
import { TranslationPlatformError } from "../services/translationPlatformService";

type RawBodyRequest = Request & {
  rawBody?: string;
};

const router = Router();
const slackCommandService = createSlackCommandService(translationPlatformService);

function verifySlackSignature(req: RawBodyRequest): boolean {
  const signingSecret = process.env["SLACK_SIGNING_SECRET"]?.trim();

  if (!signingSecret) {
    return false;
  }

  const signature = req.header("x-slack-signature");
  const timestamp = req.header("x-slack-request-timestamp");
  const rawBody = req.rawBody ?? "";

  if (!signature || !timestamp) {
    return false;
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto
    .createHmac("sha256", signingSecret)
    .update(base)
    .digest("hex")}`;

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

function handleSlackError(error: unknown, res: Response): Response {
  if (error instanceof TranslationPlatformError) {
    return res.status(error.statusCode).json({
      response_type: "ephemeral",
      text: error.message,
    });
  }

  console.error("Slack command error:", error);
  return res.status(500).json({
    response_type: "ephemeral",
    text: error instanceof Error ? error.message : "Unexpected Slack command error.",
  });
}

router.use(
  express.urlencoded({
    extended: false,
    verify: (req, _res, buffer) => {
      (req as RawBodyRequest).rawBody = buffer.toString("utf8");
    },
  })
);

router.post("/slack/commands", async (req: RawBodyRequest, res: Response) => {
  if (!process.env["SLACK_SIGNING_SECRET"]?.trim()) {
    return res.status(503).json({
      response_type: "ephemeral",
      text: "SLACK_SIGNING_SECRET is not configured.",
    });
  }

  if (!verifySlackSignature(req)) {
    return res.status(401).json({
      response_type: "ephemeral",
      text: "Invalid Slack request signature.",
    });
  }

  try {
    const execution = await slackCommandService.handleCommand(req.body as SlackCommandPayload);
    res.json(execution.immediateResponse);

    if (execution.deferredTask) {
      void execution.deferredTask().catch((error) => {
        console.error("Deferred Slack command task failed:", error);
      });
    }

    return res;
  } catch (error) {
    return handleSlackError(error, res);
  }
});

export default router;
