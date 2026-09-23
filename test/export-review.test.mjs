// 검수 CSV 명령행 테스트 — 인자와 운영 스냅샷 입력 검증
import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, parseReviewSources, validatePaths } from "../src/export-review.mjs";

test("검수 CSV 인자 기본값과 명시값 파싱", () => {
  assert.deepEqual(parseArgs([
    "--source", "source.jsonl",
    "--run-id", "run-1",
  ]), {
    source: "source.jsonl",
    database: "data/classifications.sqlite3",
    runId: "run-1",
    output: "data/review-queue.csv",
  });
  assert.equal(parseArgs([
    "--source", "source.jsonl",
    "--database", "data/custom.sqlite3",
    "--run-id", "run-2",
    "--output", "results/review.csv",
  ]).output, "results/review.csv");
});

test("검수 CSV 인자는 원본과 실행 ID를 필수로 요구", () => {
  assert.throws(() => parseArgs(["--run-id", "run-1"]), /--source 필수/);
  assert.throws(() => parseArgs(["--source", "source.jsonl"]), /--run-id 필수/);
  assert.throws(() => parseArgs(["--unknown", "value"]), /알 수 없는 인자/);
});

test("운영 스냅샷 JSONL의 ID·이름·기존 분류를 정규화", () => {
  const sources = parseReviewSources([
    JSON.stringify({
      ingredientId: 1,
      ingredientName: " 합성 원료 ",
      existingCategoryKeys: ["원료::어류"],
    }),
    JSON.stringify({
      ingredientId: "2",
      ingredientName: "합성 성분",
      existingCategoryKeys: [],
    }),
  ].join("\n"));

  assert.deepEqual(sources, [
    { ingredientId: "1", ingredientName: "합성 원료", existingCategoryKeys: ["원료::어류"] },
    { ingredientId: "2", ingredientName: "합성 성분", existingCategoryKeys: [] },
  ]);
});

test("운영 스냅샷의 중복 ID와 잘못된 분류 형식을 거부", () => {
  const duplicate = JSON.stringify({
    ingredientId: 1,
    ingredientName: "합성 원료",
    existingCategoryKeys: [],
  });
  assert.throws(() => parseReviewSources(`${duplicate}\n${duplicate}`), /ID 중복/);
  assert.throws(() => parseReviewSources(JSON.stringify({
    ingredientId: 1,
    ingredientName: "합성 원료",
    existingCategoryKeys: "원료::어류",
  })), /existingCategoryKeys 형식 오류/);
});

test("검수 CSV는 입력 덮어쓰기와 존재하지 않는 SQLite를 거부", () => {
  assert.throws(() => validatePaths({
    source: "source.jsonl",
    database: "results.sqlite3",
    output: "source.jsonl",
  }, () => true), /서로 달라야 함/);
  assert.throws(() => validatePaths({
    source: "source.jsonl",
    database: "missing.sqlite3",
    output: "review.csv",
  }, () => false), /SQLite 파일을 찾을 수 없음/);
});
