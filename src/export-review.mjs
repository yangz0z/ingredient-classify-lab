// 검수 CSV 내보내기 — 기존 분류 스냅샷과 SQLite 배치 결과 결합
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { buildReviewRows, formatReviewCsv } from "./lib/review-queue.mjs";
import { sanitizeError } from "./lib/llm.mjs";
import { createResultStore } from "./lib/result-store.mjs";

export function parseArgs(argv) {
  const options = {
    source: null,
    database: "data/classifications.sqlite3",
    runId: null,
    output: "data/review-queue.csv",
  };
  const keys = new Map([
    ["source", "source"],
    ["database", "database"],
    ["run-id", "runId"],
    ["output", "output"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = argument.startsWith("--") ? argument.slice(2) : "";
    if (!keys.has(key)) throw new Error(`알 수 없는 인자: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 값 누락`);
    options[keys.get(key)] = value;
    index += 1;
  }
  if (!options.source) throw new Error("--source 필수");
  if (!options.runId) throw new Error("--run-id 필수");
  return options;
}

export function parseReviewSources(text) {
  const sources = [];
  const ids = new Set();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let source;
    try {
      source = JSON.parse(line);
    } catch {
      throw new Error(`입력 스냅샷 ${index + 1}행 JSON 파싱 실패`);
    }
    const ingredientId = source?.ingredientId;
    const ingredientName = typeof source?.ingredientName === "string"
      ? source.ingredientName.trim()
      : "";
    if (!["string", "number"].includes(typeof ingredientId)) {
      throw new Error(`입력 스냅샷 ${index + 1}행 ingredientId 누락`);
    }
    const normalizedId = String(ingredientId).trim();
    if (!normalizedId || !ingredientName) {
      throw new Error(`입력 스냅샷 ${index + 1}행 ID 또는 이름 누락`);
    }
    if (ids.has(normalizedId)) throw new Error(`입력 스냅샷 ID 중복: ${normalizedId}`);
    if (!Array.isArray(source.existingCategoryKeys)
      || source.existingCategoryKeys.some((key) => typeof key !== "string")) {
      throw new Error(`입력 스냅샷 ${index + 1}행 existingCategoryKeys 형식 오류`);
    }
    ids.add(normalizedId);
    sources.push({ ingredientId: normalizedId, ingredientName, existingCategoryKeys: source.existingCategoryKeys });
  }
  if (sources.length === 0) throw new Error("입력 스냅샷이 비어 있음");
  return sources;
}

export function validatePaths(options, fileExists = existsSync) {
  const paths = {
    source: path.resolve(options.source),
    database: path.resolve(options.database),
    output: path.resolve(options.output),
  };
  if (new Set(Object.values(paths)).size !== 3) {
    throw new Error("입력 스냅샷, SQLite, 출력 CSV 경로는 서로 달라야 함");
  }
  if (!fileExists(paths.database)) {
    throw new Error(`SQLite 파일을 찾을 수 없음: ${paths.database}`);
  }
  return paths;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = validatePaths(options);
  const sourceText = await readFile(paths.source, "utf8");
  const sources = parseReviewSources(sourceText);
  const store = createResultStore(paths.database);
  try {
    const run = store.getRun(options.runId);
    if (!run) throw new Error(`배치 실행을 찾을 수 없음: ${options.runId}`);
    if (run.status !== "completed") throw new Error(`완료되지 않은 배치 실행: ${options.runId}`);
    if (run.repetitions !== 1) throw new Error("검수 큐는 1회 실행 배치만 지원");
    const rows = buildReviewRows({ sources, results: store.listResults(options.runId) });
    const outputPath = paths.output;
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, formatReviewCsv(rows), "utf8");
    console.log(JSON.stringify({
      runId: options.runId,
      count: rows.length,
      matchedCount: rows.filter((row) => row.reviewStatus === "matched").length,
      newClassificationConfirmationCount: rows.filter((row) => row.reviewStatus === "new_confirmation").length,
      attentionCount: rows.filter((row) => row.reviewStatus === "attention").length,
      operationalAutoCount: rows.filter((row) => row.operationalStatus === "auto").length,
      operationalNeedsReviewCount: rows.filter((row) => row.operationalStatus === "needs_review").length,
      operationalFailedCount: rows.filter((row) => row.operationalStatus === "failed").length,
      output: outputPath,
    }, null, 2));
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
