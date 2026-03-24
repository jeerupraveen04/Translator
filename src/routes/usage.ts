import { Router, Request, Response } from "express";
import { getTranslator } from "../utils/deeplClient";

const router = Router();

// GET /deepl/usage - returns DeepL usage info (characters used/limit, anyLimitReached)
router.get("/deepl/usage", async (_req: Request, res: Response) => {
  const translator = getTranslator();
  if (!translator) {
    return res.status(500).json({ error: "DeepL translator is not configured (missing DEEPL_API_KEY)" });
  }

  try {
    const usage = await translator.getUsage();
    return res.json({
      character: usage.character ?? null,
      anyLimitReached: usage.anyLimitReached(),
    });
  } catch (err: any) {
    console.error("Failed to fetch DeepL usage:", err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

export default router;
