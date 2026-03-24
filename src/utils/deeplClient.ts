import * as deepl from "deepl-node";

let translatorInstance: deepl.Translator | null | undefined;

export function getTranslator(): deepl.Translator | null {
  if (translatorInstance !== undefined) {
    return translatorInstance;
  }

  const authKey = process.env["DEEPL_API_KEY"];
  translatorInstance = authKey ? new deepl.Translator(authKey) : null;

  return translatorInstance;
}
