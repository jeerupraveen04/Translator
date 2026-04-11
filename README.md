# DeeplTranslator

TypeScript + Express translation service with:

- DeepL translation endpoints
- AWS Translate endpoints
- Azure Translator endpoints
- Gemini translation endpoint
- Bulk translation endpoint with provider fallback and retries

**Setup**

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

3. Update `.env` with the credentials you want to use:

```env
DEEPL_API_KEY=your_deepl_api_key_here
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AZURE_TRANSLATOR_ENDPOINT=https://your-resource-name.cognitiveservices.azure.com
AZURE_TRANSLATOR_KEY=your_azure_translator_key
AZURE_TRANSLATOR_REGION=your_azure_region
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/your/webhook/url
SLACK_SIGNING_SECRET=your_slack_signing_secret
SLACK_ALLOWED_USER_IDS=U12345,U67890
SOURCE_LANGUAGE=en
TRANSLATION_LANGUAGES={"en":"English","fr":"French","hi":"Hindi"}
TRANSLATION_DB_FILE=./data/translation-platform.db
TRANSLATION_DATA_FILE=./data/translation-platform-db.json
TRANSLATION_BATCH_SIZE=25
TRANSLATION_PROVIDER_TIMEOUT_MS=10000
TRANSLATION_PROVIDER_RETRIES=2
TRANSLATION_ALLOW_OVERWRITE_APPROVED=false
TRANSLATION_PLATFORM_API_KEY=
ENABLE_DAILY_REMEDIATION=false
DAILY_REMEDIATION_TIME=02:00
```

Notes:

- `DEEPL_API_KEY` is required for DeepL endpoints.
- AWS variables are required only for AWS Translate endpoints.
- Azure variables are required only for Azure Translator endpoints.
- Gemini variables are required only for the Gemini endpoint.
- `SLACK_WEBHOOK_URL` enables start/missed/insert/completion/failure notifications for bulk jobs.
- `SLACK_SIGNING_SECRET` enables verified Slack slash-command requests.
- `SLACK_ALLOWED_USER_IDS` optionally limits mutating Slack commands such as backfill and remediation.
- `TRANSLATION_LANGUAGES` defines the platform language registry used by the new `v1` routes.
- `TRANSLATION_DB_FILE` is the SQLite database used by the translation platform.
- `TRANSLATION_DATA_FILE` is now an optional legacy JSON import source for first-run migration into SQLite.
- `TRANSLATION_PLATFORM_API_KEY` optionally protects the new `v1` platform routes through `x-translation-platform-key` or `Authorization: Bearer ...`.
- `ENABLE_DAILY_REMEDIATION` and `DAILY_REMEDIATION_TIME` control the built-in daily repair scheduler.

Configured target languages for the bulk route are defined in [languages.ts](/d:/PersonalProject/Translator/src/utils/languages.ts).

**Run**

Start in development:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Start the compiled app:

```bash
npm start
```

By default the server runs on `http://localhost:3000`.

**Endpoints**

- `GET /`
  Returns a simple health response.

- `POST /deepl/translate`
  Translates text using DeepL.

- `GET /deepl/languages`
  Returns supported DeepL target languages.

- `GET /deepl/usage`
  Returns DeepL usage details and whether the API limit has been reached.

- `POST /translate/aws`
  Translates text or object values using AWS Translate.

- `GET /aws/languages`
  Returns supported AWS Translate languages.

- `POST /translate/azure`
  Translates text or object values using Azure Translator.

- `GET /azure/languages`
  Returns supported Azure Translator languages.

- `POST /translate/gemini`
  Translates text or object values using Gemini.

- `POST /translations/bulk`
  Translates an array of source strings into one or more target languages using retries and provider fallback.

- `POST /v1/translations/translate-all`
  Translates a source string map into every configured language, optionally persisting source and target rows.

- `POST /v1/translations/backfill-language`
  Reads persisted source strings and translates only the missing keys for a newly added language.

- `GET /v1/translations/validate`
  Compares every active language against the source language and returns missing/extra key details.

- `GET /v1/translations/status/:languageCode`
  Returns per-language status for Slack-style operational checks, including missing keys and provider stats.

- `POST /v1/translations/remediate`
  Runs manual remediation or a dry run against missing translations across active languages.

**Translation Platform**

The new platform layer follows the design spec with:

- Azure -> AWS -> DeepL -> Gemini provider routing with retries and timeout handling.
- SQLite-backed persistence for languages, translations, jobs, audit rows, and notification logs.
- Translation validation, language backfill, and daily remediation support.
- Agent wrappers in [platformAgents.ts](/d:/PersonalProject/Translator/src/jobs/platformAgents.ts) for write/test/verify/validate workflows.
- A scheduler in [remediationScheduler.ts](/d:/PersonalProject/Translator/src/jobs/remediationScheduler.ts) that runs daily when enabled.
- Slack slash-command support through `POST /slack/commands` for validate, status, backfill, and remediate actions.

The runtime persistence database defaults to [translation-platform.db](/d:/PersonalProject/Translator/data/translation-platform.db).

Translate all configured languages:

```bash
curl -X POST http://localhost:3000/v1/translations/translate-all \
  -H "Content-Type: application/json" \
  -d '{
    "source_language": "en",
    "translation_languages": {
      "en": "English",
      "fr": "French",
      "hi": "Hindi"
    },
    "strings": {
      "home": "Home",
      "logout": "Logout"
    },
    "persist": true
  }'
```

Backfill a newly added language from persisted source strings:

```bash
curl -X POST http://localhost:3000/v1/translations/backfill-language \
  -H "Content-Type: application/json" \
  -d '{
    "source_language": "en",
    "target_language": "fr",
    "translation_languages": {
      "en": "English",
      "fr": "French",
      "hi": "Hindi"
    },
    "persist": true
  }'
```

Validate translation counts:

```bash
curl "http://localhost:3000/v1/translations/validate?source_language=en"
```

Run dry-run remediation:

```bash
curl -X POST http://localhost:3000/v1/translations/remediate \
  -H "Content-Type: application/json" \
  -d '{
    "source_language": "en",
    "dry_run": true
  }'
```

Slack slash commands supported:

```text
/translate-validate
/translate-status fr
/translate-backfill fr
/translate-remediate --dry-run fr hi
```

**Test DeepL**

List DeepL languages:

```bash
curl http://localhost:3000/deepl/languages
```

Translate text with DeepL:

```bash
curl -X POST http://localhost:3000/deepl/translate \
  -H "Content-Type: application/json" \
  -d '{
    "languageCode": "de",
    "text": "Hello world"
  }'
```

Example response:

```json
{
  "translated": "Hallo Welt"
}
```

Check DeepL usage limit:

```bash
curl http://localhost:3000/deepl/usage
```

Example response:

```json
{
  "character": {
    "count": 123,
    "limit": 500000
  },
  "anyLimitReached": false
}
```

**Test AWS Translate**

List AWS languages:

```bash
curl http://localhost:3000/aws/languages
```

Translate a plain string with AWS:

```bash
curl -X POST http://localhost:3000/translate/aws \
  -H "Content-Type: application/json" \
  -d '{
    "languageCode": "fr",
    "text": "Hello world"
  }'
```

Translate object values with AWS:

```bash
curl -X POST http://localhost:3000/translate/aws \
  -H "Content-Type: application/json" \
  -d '{
    "languageCode": "es",
    "data": {
      "title": "Welcome",
      "description": "This is a sample translation"
    }
  }'
```

Example object response:

```json
{
  "translated": {
    "title": "Bienvenido",
    "description": "Esta es una traduccion de ejemplo"
  }
}
```

**Test Azure Translator**

List Azure languages:

```bash
curl http://localhost:3000/azure/languages
```

Translate a plain string with Azure:

```bash
curl -X POST http://localhost:3000/translate/azure \
  -H "Content-Type: application/json" \
  -d '{
    "languageCode": "fr",
    "text": "Hello world"
  }'
```

Translate object values with Azure:

```bash
curl -X POST http://localhost:3000/translate/azure \
  -H "Content-Type: application/json" \
  -d '{
    "languageCode": "es",
    "data": {
      "title": "Welcome",
      "description": "This is a sample translation"
    }
  }'
```

**Test Gemini**

Translate a plain string with Gemini:

```bash
curl -X POST http://localhost:3000/translate/gemini \
  -H "Content-Type: application/json" \
  -d '{
    "languageCode": "fr",
    "text": "Hello world"
  }'
```

**Test Bulk Translation**

Translate into one specific language:

```bash
curl -X POST http://localhost:3000/translations/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "languageCode": "hi",
    "strings": [
      { "key": "welcome", "string": "Welcome" },
      { "key": "logout", "string": "Logout" }
    ]
  }'
```

Translate into all configured languages from [languages.ts](/d:/PersonalProject/Translator/src/utils/languages.ts):

```bash
curl -X POST http://localhost:3000/translations/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "strings": [
      { "key": "welcome", "string": "Welcome" },
      { "key": "logout", "string": "Logout" }
    ]
  }'
```

Example response:

```json
{
  "hi": {
    "welcome": "स्वागत है",
    "logout": "लॉग आउट"
  }
}
```

Translate object values with Gemini:

```bash
curl -X POST http://localhost:3000/translate/gemini \
  -H "Content-Type: application/json" \
  -d '{
    "languageCode": "es",
    "data": {
      "title": "Welcome",
      "description": "This is a sample translation"
    }
  }'
```

**Common Errors**

- DeepL not configured:
  Set `DEEPL_API_KEY` in `.env`.

- AWS not configured:
  Set `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`.

- Azure not configured:
  Set `AZURE_TRANSLATOR_ENDPOINT`, `AZURE_TRANSLATOR_KEY`, and `AZURE_TRANSLATOR_REGION`.

- Gemini not configured:
  Set `GEMINI_API_KEY`. Optionally set `GEMINI_MODEL`.

- `400` bad request:
  Check that `languageCode` is present and that you sent `text` or `data` depending on the endpoint.

- Bulk route has no target languages:
  Provide `languageCode` in the request or add languages in [languages.ts](/d:/PersonalProject/Translator/src/utils/languages.ts).
