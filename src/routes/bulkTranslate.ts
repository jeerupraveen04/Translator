import { Router, Request, Response } from "express";
import { BulkTranslationError, translateBulkStrings } from "../processor/bulkTranslationProcessor";
import type { BulkTranslateRequestBody } from "../types/translation";

const router = Router();

router.post("/translations/bulk", async (req: Request, res: Response) => {
  try {
    const translated = await translateBulkStrings(req.body as BulkTranslateRequestBody);
    return res.json(translated);
  } catch (error) {
    if (error instanceof BulkTranslationError) {
      return res.status(error.statusCode).json({
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    console.error("Bulk translation error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unexpected translation error.",
    });
  }
});

export default router;
