import {
  TranslateClient,
  TranslateTextCommand,
  ListLanguagesCommand,
} from "@aws-sdk/client-translate";
let clientInstance: TranslateClient | null | undefined;

function getAwsClient(): TranslateClient | null {
  if (clientInstance !== undefined) {
    return clientInstance;
  }

  const awsRegion = process.env.AWS_REGION;
  const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!awsRegion || !awsAccessKeyId || !secretAccessKey) {
    clientInstance = null;
    return clientInstance;
  }

  clientInstance = new TranslateClient({
    region: awsRegion,
    credentials: {
      accessKeyId: awsAccessKeyId,
      secretAccessKey,
    },
  });

  return clientInstance;
}

export async function awsTranslate(
  languageCode: string,
  data: string | Record<string, string>
): Promise<string | Record<string, string>> {
  const client = getAwsClient();

  if (!client) {
    throw new Error("AWS Translate client is not configured (missing AWS credentials)");
  }

  const normalizedLanguageCode = languageCode.trim();

  if (typeof data === "string") {
    const cmd = new TranslateTextCommand({
      Text: data,
      SourceLanguageCode: "auto",
      TargetLanguageCode: normalizedLanguageCode,
    });

    const resp = await client.send(cmd);
    return resp.TranslatedText ?? "";
  }

  if (typeof data !== "object" || data === null) {
    throw new Error("Input must be a non-null object or a string.");
  }

  const supportedLanguages = await getAwsSupportedLanguages();
  if (!supportedLanguages.includes(normalizedLanguageCode)) {
    throw new Error(`Language code "${languageCode}" is not supported.`);
  }

  const translatedObject: Record<string, string> = {};

  for (const [key, value] of Object.entries(data)) {
    const translateCommand = new TranslateTextCommand({
      Text: value,
      SourceLanguageCode: "en",
      TargetLanguageCode: normalizedLanguageCode,
    });

    const response = await client.send(translateCommand);
    translatedObject[key] = response.TranslatedText ?? "";
  }

  return translatedObject;
}

export async function getAwsSupportedLanguages(): Promise<string[]> {
  const client = getAwsClient();

  if (!client) {
    return [];
  }

  const cmd = new ListLanguagesCommand({ DisplayLanguageCode: "en" });
  const resp = await client.send(cmd);
  return (resp.Languages ?? [])
    .map((language) => language.LanguageCode)
    .filter((languageCode): languageCode is string => Boolean(languageCode));
}
