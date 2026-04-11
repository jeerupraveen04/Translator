# Translation Platform Implementation Notes

## What was added

- `src/config/platformConfig.ts` exports `platformConfig` with source language, translation registry, persistence path, provider retry/timeout/batch settings, and remediation scheduler settings.
- `src/types/platform.ts` defines stored translations, jobs, audit rows, validation summaries, remediation results, provider routing attempts, and request/result shapes.
- `src/repository/translationRepository.ts` defines the repository contract and `src/repository/fileTranslationRepository.ts` provides the file-backed implementation.
- `src/services/providerRouter.ts` implements Azure -> AWS -> DeepL -> Gemini fallback with retries, timeouts, key preservation, and batch handling.
- `src/services/translationPlatformService.ts` implements translate-all, backfill-language, validation, status summary, and daily remediation.
- `src/services/notificationService.ts` wraps Slack notifications and logs them to the repository.
- `src/jobs/dailyRemediationScheduler.ts` provides a lightweight daily HH:mm scheduler.
- `src/jobs/platformAgents.ts` adds the agent-style wrappers requested for write, test, verify, validate-all-cases, and backfill flows.

## Assumptions

- English is the default source language unless `TRANSLATION_SOURCE_LANGUAGE` is set.
- `TRANSLATION_LANGUAGES` can be a JSON registry or a comma-separated fallback list.
- The file-backed store is the default persistence mechanism for this repo today.
- Approved rows are protected from overwrite unless an explicit override is passed.
- Slack notification failures are logged but do not block translation persistence.

## Integration points

- Route handlers can instantiate `createTranslationPlatformService()` and call its methods directly once you are ready to wire endpoints.
- `src/index.ts` is not modified here, so scheduler startup is still opt-in.
- If you want live API exposure, the next step is to add route handlers that forward request bodies into `TranslationPlatformService`.

## Notes on verification

- The first-pass implementation is intentionally self-contained in the owned `src/config`, `src/types`, `src/repository`, `src/services`, and `src/jobs` paths.
- If the app should boot the scheduler automatically, that wiring belongs in `src/index.ts`, which I left untouched per your instruction.
