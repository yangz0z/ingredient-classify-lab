// SQLite 결과 저장소 테스트 — 실행·결과·일관성 요약 영속 검증
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createResultStore } from "../src/lib/result-store.mjs";

test("실행 정보와 분류 결과를 SQLite에 저장하고 다시 조회", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "classification-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createResultStore(path.join(directory, "results.sqlite3"));
  t.after(() => store.close());

  store.createRun({
    id: "run-1",
    startedAt: "2026-09-22T00:00:00.000Z",
    model: "synthetic-model",
    dryRun: false,
    promptVersion: "1",
    catalogCount: 2,
    inputCount: 1,
    repetitions: 2,
    concurrency: 1,
  });
  store.saveResult({
    runId: "run-1",
    itemId: "item-1",
    itemName: "쌀가루",
    repetition: 1,
    status: "success",
    classification: {
      name: "쌀가루",
      primary_category_key: "곡물::쌀",
      additional_category_keys: [],
      needs_review: false,
      reason: "쌀 기반",
    },
    contractViolations: [],
    model: "synthetic-model",
    responseId: "response-1",
    usage: { total_tokens: 10 },
    attemptCount: 1,
    elapsedMs: 50,
    error: null,
  });
  store.completeRun("run-1", {
    completedAt: "2026-09-22T00:01:00.000Z",
    status: "completed",
    successCount: 1,
    errorCount: 0,
    consistency: {
      comparableItemCount: 1,
      consistentItemCount: 1,
      rate: 1,
      inconsistentItemIds: [],
    },
  });

  const saved = store.getRun("run-1");
  assert.equal(saved.status, "completed");
  assert.equal(saved.successCount, 1);
  assert.equal(saved.consistency.rate, 1);

  const results = store.listResults("run-1");
  assert.equal(results.length, 1);
  assert.equal(results[0].classification.primary_category_key, "곡물::쌀");
  assert.deepEqual(results[0].usage, { total_tokens: 10 });
});

test("같은 실행·항목·반복 결과의 중복 저장 거부", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "classification-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createResultStore(path.join(directory, "results.sqlite3"));
  t.after(() => store.close());

  store.createRun({
    id: "run-duplicate",
    startedAt: new Date().toISOString(),
    model: null,
    dryRun: true,
    promptVersion: "1",
    catalogCount: 1,
    inputCount: 1,
    repetitions: 1,
    concurrency: 1,
  });
  const result = {
    runId: "run-duplicate",
    itemId: "item-1",
    itemName: "쌀",
    repetition: 1,
    status: "error",
    classification: null,
    contractViolations: [],
    model: null,
    responseId: null,
    usage: null,
    attemptCount: null,
    elapsedMs: 1,
    error: "합성 오류",
  };

  store.saveResult(result);
  assert.throws(() => store.saveResult(result), /UNIQUE constraint failed/);
});
