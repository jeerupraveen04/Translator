import { Router, Request, Response } from "express";
import { awsTranslate, getAwsSupportedLanguages } from "../utils/awsTranslate";

const router = Router();

// POST /translate/aws
// body: { languageCode: string, text: string }
router.post("/translate/aws", async (req: Request, res: Response) => {
  const { languageCode, text, data } = req.body as {
    languageCode?: string;
    text?: string;
    data?: Record<string, string>;
  };

  if (!languageCode || (!text && !data)) {
    return res.status(400).json({ error: "languageCode and either text or data are required" });
  }

  try {
    const input = data ?? text!; // prefer object data, otherwise string text
    const translated = await awsTranslate(languageCode, input as any);

    if (translated === null) {
      return res.status(500).json({ error: "Translation failed" });
    }

    return res.json({ translated });
  } catch (err: any) {
    console.error("AWS translation error:", err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

router.get("/aws/languages", async (_req: Request, res: Response) => {
    try {
      const langs = await getAwsSupportedLanguages();

      res.json({ languages: langs });
    } catch (error) {
      console.error("Failed to load AWS Translate languages:", error);
      res.status(500).json({ error: "Failed to fetch languages" });
    }
  });
  
export default router;
