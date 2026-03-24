import { Router, Request, Response } from "express";
import { geminiTranslate } from "../utils/geminiTranslate";

const router = Router();

router.post("/translate/gemini", async (req: Request, res: Response) => {
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
    const translated = await geminiTranslate(languageCode, input);
    return res.json({ translated });
  } catch (err: any) {
    console.error("Gemini translation error:", err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

export default router;
