import express from "express";
import dotenv from "dotenv";
import translateRouter from "./routes/translate";
import awsTranslateRouter from "./routes/awsTranslate";
import azureTranslateRouter from "./routes/azureTranslate";
import usageRouter from "./routes/usage";
import { initSupportedLanguages } from "./processor/translationProcessor";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (_req, res) => res.send("deepltranslator TypeScript server is running"));

app.use(translateRouter);
app.use(awsTranslateRouter);
app.use(azureTranslateRouter);
app.use(usageRouter);

// initialize supported languages then start server
initSupportedLanguages()
  .catch((e) => console.error(e))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  });
