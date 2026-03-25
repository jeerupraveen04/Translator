# Translation Porting Guide

Business flow:

1. Accept a `POST` request with:
   - `strings`: array of `{ key, string }`
   - may be a specific langauge langugae:code 
2. Convert the array into an object:
   - `{ welcome: "Welcome", logout: "Logout" }`
3. For each target language:
   -Try Azure if langue support ,if not next
   - Fall back to AWS Translate when Azure is unsupported or fails.
   - Try DeepL first when supported and quota is available and fallback for the .
   - Fall back to Gemini when both fail.

4. Retry untranslated languages in a loop.
5. Stop retrying a language after 5 failed rounds.
6. Retun tranlations into configured languages is set of langaues added in the format of `{en:"english,hi:Hindi}
7.output : langauecode :{transaled object}
7. Send Slack notifications for:
   - start
   - missed languages
   - insert start
   - completion
   - failure

Core business rules:

- Keys must never be translated.
- English is treated as the source language.
- One language translation result is a flat object:
  - `hi :{ "welcome": "Bienvenido", "logout": "Cerrar sesi\u00f3n" }`


## 2. What The Country-Language Update Flow Does

Source: `supabase/functions/translation-update-country-language/index.ts`, `updateCountryLanguageMapping.ts`, `AItranslator.ts`

Business flow:

1. Accept a `POST` request with:
   - `langaue code`
   - `language_ids`
2. Load current languages mapped to the country.
3. Compute:
   - languages to add
   - languages to remove
4. For each language to remove:
   - delete the `country_language` mapping
5. For each language to add:
   - create a new `country_language` mapping if it does not exist
   - if another country already uses that same language, clone its strings into the new mapping
   - otherwise use English base strings and generate translations with Gemini in batches
6. Insert the generated strings for the new mapping.

Core business rules:

- Prefer cloning existing strings for the same language over generating new ones.
- If no existing translated source is available, fall back to English and generate.
- Translation is batched to reduce model payload size.
- Translated records keep the original key and most metadata, but change:
  - `value`
  - `country_language_id`
  - `updated_at`

## 3. Reusable Services To Carry Into Another Project

For a cleaner design in the new project, split the logic into four services:

1. `TranslationOrchestrator`
   - controls provider fallback and retries
2. `PromptBuilder`
   - creates LLM prompts for object translation and batch translation
3. `LanguageSyncService`
   - compares current vs requested languages and performs add/remove
4. `StringRepository`
   - reads/writes mappings and strings

Recommended flow boundaries:

- Route layer:
  - validate request
  - call service
  - return immediate response
- Service layer:
  - business decisions
  - retry logic
  - batching
  - fallback rules
- Repository layer:
  - database reads/writes only
- Provider layer:
  - DeepL / AWS / Gemini adapters

## 4. Prompt Patterns Worth Reusing

### A. Flat object translation prompt

Use when input is:

```json
{
  "welcome": "Welcome",
  "logout": "Logout"
}
```

Rules:

- translate values only
- keep keys unchanged
- return valid JSON only
- wrap by language code if the parser expects it

### B. Array batch translation prompt

Use when input is:

```json
[
  { "key": "welcome", "value": "Welcome" },
  { "key": "logout", "value": "Logout" }
]
```

Rules:

- preserve the full array structure
- keep `key` unchanged
- replace only `value`
- return JSON array only

## 5. Route Design For The Other Project

Recommended routes:

### `POST /translations/bulk`

Purpose:
- translate a set of source strings into target languages

Suggested request body:

```json
{
  "moduleFileId": 12,
  "sourceLanguage": "en",
  "targetLanguages": ["fr", "de", "es"],
  "strings": [
    { "key": "welcome", "value": "Welcome" },
    { "key": "logout", "value": "Logout" }
  ]
}
```

Suggested behavior:

- validate input
- transform array to object
- translate with fallback providers
- persist results if needed
- return a job summary or the translated payload

### `POST /countries/:countryId/languages/sync`

Purpose:
- align a country's active languages with a requested list

Suggested request body:

```json
{
  "languageIds": [1, 2, 5, 9]
}
```

Suggested behavior:

- read existing mappings
- diff old vs new
- remove stale mappings
- add missing mappings
- clone strings when a same-language source exists
- otherwise generate translations from English base strings

## 6. Recommended Cleanups While Porting

These are useful improvements over the current implementation:

1. Cache AWS supported languages instead of calling `ListLanguagesCommand` for every translation request.
2. Treat missing Gemini API key as an error, not as a response object inside translation logic.
3. Normalize target language handling so one canonical code is used across providers.
4. Move Slack notifications outside the core translation logic so the service is reusable.
5. Batch database writes and provider requests more aggressively for large jobs.
6. Add idempotency around language sync jobs so retries do not duplicate work.
7. Validate that provider responses preserve all keys before accepting them.

## 7. Files Added For Reuse

See:

- `docs/translation-route-template.ts`

That file contains:

- portable prompt builders
- translation orchestrator template
z- generic route handler examples
