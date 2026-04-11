import express from "express";
import dotenv from "dotenv";
import translateRouter from "./routes/translate";
import awsTranslateRouter from "./routes/awsTranslate";
import azureTranslateRouter from "./routes/azureTranslate";
import bulkTranslateRouter from "./routes/bulkTranslate";
import geminiTranslateRouter from "./routes/geminiTranslate";
import usageRouter from "./routes/usage";
import { initSupportedLanguages } from "./processor/translationProcessor";
import v1TranslationsRouter, { translationPlatformService } from "./routes/v1Translations";
import { DailyRemediationScheduler } from "./jobs/remediationScheduler";
import slackCommandsRouter from "./routes/slackCommands";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (_req, res) => res.send("deepltranslator TypeScript server is running"));

app.use(translateRouter);
app.use(awsTranslateRouter);
app.use(azureTranslateRouter);
app.use(bulkTranslateRouter);
app.use(geminiTranslateRouter);
app.use(usageRouter);
app.use(v1TranslationsRouter);
app.use(slackCommandsRouter);

const remediationScheduler = new DailyRemediationScheduler(translationPlatformService);

initSupportedLanguages()
  .then(() => {
    remediationScheduler.start();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Application bootstrap failed:", error);
    process.exit(1);
  });
