// 배치 실행 테스트 — 제한 동시성, 오류 격리, 반복 일관성 검증
import assert from "node:assert/strict";
import test from "node:test";

import { classificationSignature, runBatch } from "../src/lib/batch.mjs";

const catalog = [
  { key: "곡물::쌀", major: "곡물", minor: "쌀" },
  { key: "첨가물::향료", major: "첨가물", minor: "향료" },
];

function createMemoryStore() {
  const state = { run: null, results: [], completion: null };
  return {
    state,
    createRun(run) {
      state.run = run;
    },
    saveResult(result) {
      state.results.push(result);
    },
    completeRun(runId, completion) {
      state.completion = { runId, ...completion };
    },
  };
}

test("분류 서명은 판정 사유와 additional 순서에 영향받지 않음", () => {
  const first = classificationSignature({
    primary_category_key: "곡물::쌀",
    additional_category_keys: ["첨가물::향료", "곡물::쌀"],
    needs_review: true,
    reason: "첫 판정",
  });
  const second = classificationSignature({
    primary_category_key: "곡물::쌀",
    additional_category_keys: ["곡물::쌀", "첨가물::향료"],
    needs_review: true,
    reason: "표현만 다른 판정",
  });

  assert.equal(first, second);
});

test("배치는 설정한 동시성을 넘지 않고 모든 반복 결과를 저장", async () => {
  let active = 0;
  let maxActive = 0;
  const classifier = {
    dryRun: false,
    model: "synthetic-model",
    async classify(name) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        dryRun: false,
        model: "synthetic-model",
        responseId: `response-${name}`,
        usage: null,
        attemptCount: 1,
        classification: {
          name,
          primary_category_key: "곡물::쌀",
          additional_category_keys: [],
          needs_review: false,
          reason: "합성 판정",
        },
      };
    },
  };
  const store = createMemoryStore();

  const report = await runBatch({
    items: [
      { id: "a", name: "쌀가루" },
      { id: "b", name: "현미가루" },
      { id: "c", name: "찹쌀가루" },
    ],
    repetitions: 2,
    concurrency: 2,
    classifier,
    catalog,
    promptVersion: 1,
    store,
    runId: "run-concurrency",
  });

  assert.equal(maxActive, 2);
  assert.equal(store.state.results.length, 6);
  assert.equal(report.totalExecutions, 6);
  assert.equal(report.successCount, 6);
  assert.equal(report.errorCount, 0);
  assert.equal(report.consistency.consistentItemCount, 3);
  assert.equal(report.consistency.rate, 1);
});

test("배치는 항목 오류를 격리하고 실패 결과를 저장", async () => {
  const store = createMemoryStore();
  const classifier = {
    dryRun: false,
    model: "synthetic-model",
    async classify(name) {
      if (name === "실패 항목") throw new Error("upstream failed");
      return {
        dryRun: false,
        model: "synthetic-model",
        responseId: "response-ok",
        usage: null,
        attemptCount: 3,
        classification: {
          name,
          primary_category_key: "첨가물::향료",
          additional_category_keys: [],
          needs_review: false,
          reason: "합성 판정",
        },
      };
    },
  };

  const report = await runBatch({
    items: [
      { id: "ok", name: "천연향" },
      { id: "error", name: "실패 항목" },
    ],
    repetitions: 1,
    concurrency: 2,
    classifier,
    catalog,
    promptVersion: 1,
    store,
    runId: "run-errors",
  });

  assert.equal(report.successCount, 1);
  assert.equal(report.errorCount, 1);
  assert.equal(store.state.results.find((row) => row.itemId === "ok").attemptCount, 3);
  assert.match(store.state.results.find((row) => row.itemId === "error").error, /upstream failed/);
  assert.equal(store.state.completion.status, "completed_with_errors");
});

test("반복 판정이 달라지면 불일치 항목으로 집계", async () => {
  let call = 0;
  const store = createMemoryStore();
  const classifier = {
    dryRun: false,
    model: "synthetic-model",
    async classify(name) {
      call += 1;
      return {
        dryRun: false,
        model: "synthetic-model",
        responseId: `response-${call}`,
        usage: null,
        attemptCount: 1,
        classification: {
          name,
          primary_category_key: call === 1 ? "곡물::쌀" : "첨가물::향료",
          additional_category_keys: [],
          needs_review: false,
          reason: "합성 판정",
        },
      };
    },
  };

  const report = await runBatch({
    items: [{ id: "unstable", name: "모호한 이름" }],
    repetitions: 2,
    concurrency: 1,
    classifier,
    catalog,
    promptVersion: 1,
    store,
    runId: "run-inconsistent",
  });

  assert.equal(report.consistency.comparableItemCount, 1);
  assert.equal(report.consistency.consistentItemCount, 0);
  assert.equal(report.consistency.rate, 0);
  assert.deepEqual(report.consistency.inconsistentItemIds, ["unstable"]);
});
