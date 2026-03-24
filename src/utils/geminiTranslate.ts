import { GoogleGenAI } from "@google/genai";

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

let clientInstance: GoogleGenAI | null | undefined;

function getGeminiClient(): GoogleGenAI | null {
  if (clientInstance !== undefined) {
    return clientInstance;
  }

  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    clientInstance = null;
    return clientInstance;
  }

  clientInstance = new GoogleGenAI({ apiKey });
  return clientInstance;
}

export async function geminiTranslate(
  languageCode: string,
  input: string | Record<string, string>
): Promise<string | Record<string, string>> {
  const client = getGeminiClient();

  if (!client) {
    throw new Error("Gemini client is not configured (missing GEMINI_API_KEY)");
  }

  const model = process.env["GEMINI_MODEL"]?.trim() || DEFAULT_GEMINI_MODEL;
  const normalizedLanguageCode = languageCode.trim();

  if (typeof input === "string") {
    const parsed = await generateJsonWithRetries<GeminiTextResponse>(
      client,
      model,
      buildTextPrompt(normalizedLanguageCode, input)
    );

    if (typeof parsed.translated !== "string") {
      throw new Error("Gemini returned an invalid translation payload for text input.");
    }

    return parsed.translated;
  }

  if (typeof input !== "object" || input === null) {
    throw new Error("Input must be a string or a non-null object.");
  }

  const parsed = await generateJsonWithRetries<GeminiObjectResponse>(
    client,
    model,
    buildObjectPrompt(normalizedLanguageCode, input)
  );

  if (!parsed.translated || typeof parsed.translated !== "object") {
    throw new Error("Gemini returned an invalid translation payload for object input.");
  }

  const translatedEntries = Object.entries(parsed.translated).filter(
    ([, value]) => typeof value === "string"
  );

  return Object.fromEntries(translatedEntries);
}

async function generateJsonWithRetries<T>(
  client: GoogleGenAI,
  model: string,
  prompt: string
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await client.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.2,
        },
      });

      return parseGeminiJson<T>(response.text ?? "");
    } catch (error) {
      lastError = error;

      if (attempt === MAX_RETRIES) {
        break;
      }

      await delay(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Gemini translation failed.");
}

function buildTextPrompt(languageCode: string, text: string): string {
  return [
    "Translate the provided text into the target language.",
    `Target language code: ${languageCode}`,
    'Return only valid JSON in this exact shape: {"translated":"<translated text>"}',
    "Do not add explanations, markdown, or extra keys.",
    `Text: ${JSON.stringify(text)}`,
  ].join("\n");
}

function buildObjectPrompt(languageCode: string, input: Record<string, string>): string {
  return [
    "Translate every value in the provided JSON object into the target language.",
    `Target language code: ${languageCode}`,
    'Return only valid JSON in this exact shape: {"translated":{"key":"translated value"}}',
    "Preserve every original key exactly as-is.",
    "Translate only the string values.",
    `Input JSON: ${JSON.stringify(input)}`,
  ].join("\n");
}

function parseGeminiJson<T>(rawText: string): T {
  const trimmed = rawText.trim();
  const withoutCodeFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return JSON.parse(withoutCodeFence) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GeminiTextResponse = {
  translated?: string;
};

type GeminiObjectResponse = {
  translated?: Record<string, string>;
};
