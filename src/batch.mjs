// 배치 명령행 진입점 — JSONL 로드, 런타임 조립, SQLite 결과 저장
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { loadCatalog, loadPromptSpec } from "./lib/catalog.mjs";
import { runBatch } from "./lib/batch.mjs";
import { createClassifier, sanitizeError } from "./lib/llm.mjs";
import { createResultStore } from "./lib/result-store.mjs";
import { resolveConfigPath } from "./server.mjs";

/**
 * 배치 명령행 인자 파싱
 * @param argv process.argv에서 실행 파일을 제외한 배열
 * @return 정규화된 옵션
 */
export function parseArgs(argv) {
  const options = {
    input: null,
    database: "data/classifications.sqlite3",
    repetitions: 1,
    concurrency: 2,
    limit: 10000,
  };
  const allowed = new Set(["input", "database", "repetitions", "concurrency", "limit"]);
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

  if (!options.input) throw new Error("--input 필수");
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 20) {
    throw new Error("--repetitions는 1~20 정수여야 함");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 10) {
    throw new Error("--concurrency는 1~10 정수여야 함");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10000) {
    throw new Error("--limit는 1~10000 정수여야 함");
  }
  return options;
}

/**
 * 범용 JSONL 데이터셋 로드
 * 각 행은 고유 id와 1~300자 name 필수
 * @param inputPath 입력 파일 경로
 * @param limit 최대 로드 건수
 * @return 정규화된 항목 배열
 */
export async function loadDataset(inputPath, limit) {
  const lines = (await readFile(inputPath, "utf8")).split(/\r?\n/);
  const items = [];
  const ids = new Set();
  for (let index = 0; index < lines.length && items.length < limit; index += 1) {
    if (!lines[index].trim()) continue;
    let row;
    try {
      row = JSON.parse(lines[index]);
    } catch {
      throw new Error(`데이터셋 ${index + 1}행 JSON 파싱 실패`);
    }
    const id = ["string", "number"].includes(typeof row?.id) ? String(row.id).trim() : "";
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    if (!id) throw new Error(`데이터셋 ${index + 1}행 id 누락`);
    if (!name || name.length > 300) throw new Error(`데이터셋 ${index + 1}행 name은 1~300자여야 함`);
    if (ids.has(id)) throw new Error(`데이터셋 id 중복: ${id}`);
    ids.add(id);
    items.push({ id, name });
  }
  if (items.length === 0) throw new Error("데이터셋이 비어 있음");
  return items;
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
  const [catalog, promptSpec, items] = await Promise.all([
    loadCatalog(catalogPath),
    loadPromptSpec(promptPath),
    loadDataset(path.resolve(options.input), options.limit),
  ]);
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
    const report = await runBatch({
      items,
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
    console.log(JSON.stringify({ ...report, database: store.path }, null, 2));
    if (report.errorCount > 0 || report.contractViolationCount > 0) process.exitCode = 2;
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
