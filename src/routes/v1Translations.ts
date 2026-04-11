import { Router, Request, Response } from "express";
import {
  createTranslationPlatformService,
  TranslationPlatformError,
} from "../services/translationPlatformService";
import type {
  BackfillLanguageRequest,
  RemediationRequest,
  TranslateAllRequest,
} from "../types/platform";

const router = Router();
const translationPlatformService = createTranslationPlatformService();

function isAuthorized(req: Request): boolean {
  const configuredApiKey = process.env["TRANSLATION_PLATFORM_API_KEY"]?.trim();

  if (!configuredApiKey) {
    return true;
  }

  const headerApiKey = req.header("x-translation-platform-key")?.trim();
  const authorization = req.header("authorization")?.trim();
  const bearerToken = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : undefined;

  return headerApiKey === configuredApiKey || bearerToken === configuredApiKey;
}

function handleRouteError(error: unknown, res: Response): Response {
  if (error instanceof TranslationPlatformError) {
    return res.status(error.statusCode).json({
      error: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }

  console.error("Translation platform route error:", error);
  return res.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected translation platform error.",
  });
}

router.use((req: Request, res: Response, next) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      error: "Unauthorized for translation platform routes.",
    });
  }

  next();
});

router.post("/v1/translations/translate-all", async (req: Request, res: Response) => {
  try {
    const response = await translationPlatformService.translateAll(req.body as TranslateAllRequest);
    return res.json(response);
  } catch (error) {
    return handleRouteError(error, res);
  }
});

router.post("/v1/translations/backfill-language", async (req: Request, res: Response) => {
  try {
    const response = await translationPlatformService.backfillLanguage(
      req.body as BackfillLanguageRequest
    );
    return res.json(response);
  } catch (error) {
    return handleRouteError(error, res);
  }
});

router.get("/v1/translations/validate", async (req: Request, res: Response) => {
  try {
    const sourceLanguage = typeof req.query["source_language"] === "string"
      ? req.query["source_language"]
      : undefined;
    const response = await translationPlatformService.validateTranslations(sourceLanguage);
    return res.json(response);
  } catch (error) {
    return handleRouteError(error, res);
  }
});

router.get("/v1/translations/status/:languageCode", async (req: Request, res: Response) => {
  try {
    const sourceLanguage = typeof req.query["source_language"] === "string"
      ? req.query["source_language"]
      : undefined;
    const response = await translationPlatformService.getLanguageStatus(
      String(req.params["languageCode"]),
      sourceLanguage
    );
    return res.json(response);
  } catch (error) {
    return handleRouteError(error, res);
  }
});

router.post("/v1/translations/remediate", async (req: Request, res: Response) => {
  try {
    const response = await translationPlatformService.remediateMissingTranslations(
      req.body as RemediationRequest
    );
    return res.json(response);
  } catch (error) {
    return handleRouteError(error, res);
  }
});

export { translationPlatformService };
export default router;
