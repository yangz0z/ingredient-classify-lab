// SQLite 결과 저장소 테스트 — 실행·결과·일관성 요약 영속 검증
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

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
    modelClassification: {
      name: "쌀가루",
      primary_category_key: "기능성::유산균",
      additional_category_keys: ["곡물::쌀"],
      needs_review: false,
      reason: "모델 원본",
    },
    policyAdjustments: ["정책 우선순위에 따라 대표 분류 변경"],
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
  assert.equal(results[0].modelClassification.primary_category_key, "기능성::유산균");
  assert.deepEqual(results[0].policyAdjustments, ["정책 우선순위에 따라 대표 분류 변경"]);
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

test("기존 SQLite에 모델 원본과 정책 정규화 열을 추가", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "classification-store-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "legacy.sqlite3");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE classification_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      repetition INTEGER NOT NULL,
      status TEXT NOT NULL,
      classification_json TEXT,
      contract_violations_json TEXT NOT NULL,
      model TEXT,
      response_id TEXT,
      usage_json TEXT,
      attempt_count INTEGER,
      elapsed_ms INTEGER NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, item_id, repetition)
    )
  `);
  legacy.close();

  const store = createResultStore(databasePath);
  store.close();

  const migrated = new Database(databasePath, { readonly: true });
  const columns = migrated.prepare("PRAGMA table_info(classification_results)").all();
  migrated.close();
  const columnNames = new Set(columns.map((column) => column.name));
  assert.equal(columnNames.has("model_classification_json"), true);
  assert.equal(columnNames.has("policy_adjustments_json"), true);
});
