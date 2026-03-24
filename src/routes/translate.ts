import { Router, Request, Response } from "express";
import { loadSupportedLanguages, translateText } from "../processor/translationProcessor";
import type { LanguageResponseItem, TranslateRequestBody } from "../types/translation";

const router = Router();

router.post("/deepl/translate", async (req: Request, res: Response) => {
  const { languageCode, text } = req.body as TranslateRequestBody;

  if (!languageCode || !text) {
    return res.status(400).json({ error: "Both languageCode and text are required" });
  }

  try {
    const translated = await translateText(languageCode, text);
    return res.json({ translated });
  } catch (err: any) {
    console.error("Translation error:", err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

router.get("/deepl/languages", async (_req: Request, res: Response) => {
  try {
    const langs = await loadSupportedLanguages();

    const list: LanguageResponseItem[] = langs.map((lang) => ({
      code: lang.code.toLowerCase(),
      name: lang.name,
    }));

    res.json({ languages: list });
  } catch (error) {
    console.error("Failed to load DeepL languages:", error);
    res.status(500).json({ error: "Failed to fetch languages" });
  }
});

export default router;
