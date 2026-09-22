// 배치 명령행 입력 테스트 — 인자와 범용 JSONL 데이터셋 검증
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDataset, parseArgs } from "../src/batch.mjs";

test("배치 인자 기본값과 명시값 파싱", () => {
  const defaults = parseArgs(["--input", "data/items.jsonl"]);
  assert.equal(defaults.repetitions, 1);
  assert.equal(defaults.concurrency, 2);
  assert.equal(defaults.database, "data/classifications.sqlite3");

  const explicit = parseArgs([
    "--input", "custom.jsonl",
    "--database", "results/test.sqlite3",
    "--repetitions", "3",
    "--concurrency", "4",
    "--limit", "20",
  ]);
  assert.equal(explicit.repetitions, 3);
  assert.equal(explicit.concurrency, 4);
  assert.equal(explicit.limit, 20);
});

test("배치 인자는 입력 누락과 범위 초과를 거부", () => {
  assert.throws(() => parseArgs([]), /--input 필수/);
  assert.throws(() => parseArgs(["--input", "a", "--concurrency", "11"]), /--concurrency/);
  assert.throws(() => parseArgs(["--input", "a", "--repetitions", "0"]), /--repetitions/);
  assert.throws(() => parseArgs(["--input", "a", "--unknown", "1"]), /알 수 없는 인자/);
});

test("JSONL 데이터셋의 id와 name을 정규화", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "classification-data-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, "items.jsonl");
  await writeFile(inputPath, [
    JSON.stringify({ id: 1, name: "  쌀가루  " }),
    JSON.stringify({ id: "two", name: "천연향" }),
  ].join("\n"));

  const items = await loadDataset(inputPath, 10);
  assert.deepEqual(items, [
    { id: "1", name: "쌀가루" },
    { id: "two", name: "천연향" },
  ]);
});

test("JSONL 데이터셋은 중복 id와 잘못된 행을 거부", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "classification-data-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const duplicatePath = path.join(directory, "duplicate.jsonl");
  const invalidPath = path.join(directory, "invalid.jsonl");
  await writeFile(duplicatePath, [
    JSON.stringify({ id: "same", name: "쌀" }),
    JSON.stringify({ id: "same", name: "향료" }),
  ].join("\n"));
  await writeFile(invalidPath, JSON.stringify({ id: "missing-name" }));

  await assert.rejects(loadDataset(duplicatePath, 10), /id 중복/);
  await assert.rejects(loadDataset(invalidPath, 10), /name/);
});
