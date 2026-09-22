// 확정 정답 평가 진입점 — 배치 분류, SQLite 저장, 정확도 집계, CSV 출력
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { runBatch } from "./lib/batch.mjs";
import { loadCatalog, loadPromptSpec } from "./lib/catalog.mjs";
import {
  parseFinalClassifications,
  validateFinalClassifications,
} from "./lib/final-classifications.mjs";
import { evaluateClassifications, formatEvaluationCsv } from "./lib/evaluation.mjs";
import { createClassifier, sanitizeError } from "./lib/llm.mjs";
import { createResultStore } from "./lib/result-store.mjs";
import { resolveConfigPath } from "./server.mjs";

/**
 * 평가 명령행 인자 파싱
 * @param argv process.argv에서 실행 파일을 제외한 배열
 * @return 정규화된 옵션
 */
export function parseArgs(argv) {
  const options = {
    input: "data/final-classifications.csv",
    database: "data/evaluations.sqlite3",
    output: "data/evaluation-results.csv",
    repetitions: 1,
    concurrency: 2,
    limit: 10000,
  };
  const allowed = new Set(["input", "database", "output", "repetitions", "concurrency", "limit"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = argument.startsWith("--") ? argument.slice(2) : "";
    if (!allowed.has(key)) throw new Error(`알 수 없는 인자: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 값 누락`);
    index += 1;
    if (["repetitions", "concurrency", "limit"].includes(key)) options[key] = Number(value);
    else options[key] = value;
  }

  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 20) {
    throw new Error("--repetitions는 1~20 정수여야 함");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 10) {
    throw new Error("--concurrency는 1~10 정수여야 함");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10000) {
    throw new Error("--limit는 1~10000 정수여야 함");
  }
  const inputPath = path.resolve(options.input);
  const databasePath = path.resolve(options.database);
  const outputPath = path.resolve(options.output);
  if (inputPath === outputPath) {
    throw new Error("입력과 출력 경로는 달라야 함");
  }
  if (inputPath === databasePath) {
    throw new Error("입력과 데이터베이스 경로는 달라야 함");
  }
  if (databasePath === outputPath) {
    throw new Error("데이터베이스와 출력 경로는 달라야 함");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalogPath = resolveConfigPath(
    process.env.CATALOG_PATH,
    "config/catalog.json",
    "config/catalog.example.json",
  );
  const promptPath = resolveConfigPath(
    process.env.PROMPT_PATH,
    "config/prompt.json",
    "config/prompt.example.json",
  );
  const [catalog, promptSpec, inputText] = await Promise.all([
    loadCatalog(catalogPath),
    loadPromptSpec(promptPath),
    readFile(path.resolve(options.input), "utf8"),
  ]);
  const expectedItems = validateFinalClassifications(
    parseFinalClassifications(inputText),
    catalog,
  ).slice(0, options.limit);
  const apiKey = process.env.OPENAI_API_KEY || null;
  const dryRun = process.env.DRY_RUN === "1" || !apiKey;
  const classifier = createClassifier({
    catalog,
    promptSpec,
    apiKey,
    dryRun,
    model: process.env.OPENAI_MODEL || "gpt-5-mini",
    reasoningEffort: process.env.REASONING_EFFORT || "minimal",
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 30000,
    maxAttempts: Number(process.env.LLM_MAX_ATTEMPTS) || 3,
  });
  const store = createResultStore(options.database);
  try {
    const batchReport = await runBatch({
      items: expectedItems.map((item) => ({ id: item.externalId, name: item.name })),
      repetitions: options.repetitions,
      concurrency: options.concurrency,
      classifier,
      catalog,
      promptVersion: promptSpec.version,
      store,
      onResult(row, completed, total) {
        console.log(`${completed}/${total}\t${row.itemId}\t${row.repetition}\t${row.status}\t${row.elapsedMs}ms`);
      },
    });
    const evaluation = evaluateClassifications({
      expectedItems,
      results: store.listResults(batchReport.runId),
    });
    const outputPath = path.resolve(options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, formatEvaluationCsv(evaluation.rows), "utf8");
    console.log(JSON.stringify({
      runId: batchReport.runId,
      dryRun,
      ...evaluation.summary,
      database: store.path,
      output: outputPath,
    }, null, 2));
    if (batchReport.errorCount > 0 || batchReport.contractViolationCount > 0) process.exitCode = 2;
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
