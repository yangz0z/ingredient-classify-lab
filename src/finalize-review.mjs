// 기획 검수 CSV를 확정값 전용 CSV로 변환하는 명령행 진입점
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  buildFinalClassifications,
  formatFinalClassifications,
  parseFinalClassifications,
  validateFinalClassifications,
} from "./lib/final-classifications.mjs";
import { loadCatalog } from "./lib/catalog.mjs";
import { sanitizeError } from "./lib/llm.mjs";

export function parseArgs(argv) {
  const defaultCatalog = existsSync("config/catalog.json")
    ? "config/catalog.json"
    : "config/catalog.example.json";
  const options = {
    input: null,
    output: "data/final-classifications.csv",
    catalog: process.env.CATALOG_PATH || defaultCatalog,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = argument.startsWith("--") ? argument.slice(2) : "";
    if (!(["input", "output", "catalog"].includes(key))) throw new Error(`알 수 없는 인자: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 값 누락`);
    options[key] = value;
    index += 1;
  }
  if (!options.input) throw new Error("--input 필수");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  if (inputPath === outputPath) throw new Error("입력 CSV와 출력 CSV 경로는 달라야 함");
  const [source, catalog] = await Promise.all([
    readFile(inputPath, "utf8"),
    loadCatalog(path.resolve(options.catalog)),
  ]);
  const excluded = [];
  const items = buildFinalClassifications(source, {
    onExcluded(item) {
      excluded.push(item);
    },
  });
  validateFinalClassifications(items, catalog);
  const output = formatFinalClassifications(items);
  validateFinalClassifications(parseFinalClassifications(output), catalog);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, "utf8");
  const decisions = {};
  for (const item of items) decisions[item.decisionSource] = (decisions[item.decisionSource] ?? 0) + 1;
  console.log(JSON.stringify({
    count: items.length,
    excludedCount: excluded.length,
    excludedIds: excluded.map((item) => item.externalId),
    decisions,
    output: outputPath,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
