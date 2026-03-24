import { Router, Request, Response } from "express";
import { azureTranslate, getAzureSupportedLanguages } from "../utils/azureTranslate";
import type { LanguageResponseItem } from "../types/translation";

const router = Router();

router.post("/translate/azure", async (req: Request, res: Response) => {
  const { languageCode, text, data } = req.body as {
    languageCode?: string;
    text?: string;
    data?: Record<string, string>;
  };

  if (!languageCode || (!text && !data)) {
    return res.status(400).json({ error: "languageCode and either text or data are required" });
  }

  try {
    const input = data ?? text!;
    const translated = await azureTranslate(languageCode, input);
    return res.json({ translated });
  } catch (err: any) {
    console.error("Azure translation error:", err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

router.get("/azure/languages", async (_req: Request, res: Response) => {
  try {
    const langs = await getAzureSupportedLanguages();

    const list: LanguageResponseItem[] = langs.map((lang) => ({
      code: lang.code.toLowerCase(),
      name: lang.name,
    }));

    return res.json({ languages: list });
  } catch (error) {
    console.error("Failed to load Azure Translator languages:", error);
    return res.status(500).json({ error: "Failed to fetch languages" });
  }
});

export default router;
