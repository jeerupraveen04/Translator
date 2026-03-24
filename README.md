# DeeplTranslator

TypeScript + Express translation service with:

- DeepL translation endpoints
- AWS Translate endpoints

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
```

Notes:

- `DEEPL_API_KEY` is required for DeepL endpoints.
- AWS variables are required only for AWS Translate endpoints.

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

**Common Errors**

- DeepL not configured:
  Set `DEEPL_API_KEY` in `.env`.

- AWS not configured:
  Set `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`.

- `400` bad request:
  Check that `languageCode` is present and that you sent `text` or `data` depending on the endpoint.
