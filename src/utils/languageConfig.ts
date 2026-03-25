import { languages } from "./languages";

export function getConfiguredTargetLanguages(): Record<string, string> {
  return languages;
}
