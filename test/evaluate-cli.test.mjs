// 평가 명령행 옵션 파싱 검증
import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/evaluate.mjs";

test("평가 인자 기본값과 명시값 파싱", () => {
  assert.deepEqual(parseArgs([]), {
    input: "data/final-classifications.csv",
    database: "data/evaluations.sqlite3",
    output: "data/evaluation-results.csv",
    repetitions: 1,
    concurrency: 2,
    limit: 10000,
  });
  assert.deepEqual(parseArgs([
    "--input", "fixtures/final.csv",
    "--database", "tmp/results.sqlite3",
    "--output", "tmp/evaluation.csv",
    "--repetitions", "3",
    "--concurrency", "4",
    "--limit", "50",
  ]), {
    input: "fixtures/final.csv",
    database: "tmp/results.sqlite3",
    output: "tmp/evaluation.csv",
    repetitions: 3,
    concurrency: 4,
    limit: 50,
  });
});

test("평가 인자는 알 수 없는 값과 범위 초과를 거부", () => {
  assert.throws(() => parseArgs(["--unknown", "value"]), /알 수 없는 인자/);
  assert.throws(() => parseArgs(["--repetitions", "0"]), /1~20/);
  assert.throws(() => parseArgs(["--concurrency", "11"]), /1~10/);
  assert.throws(() => parseArgs(["--limit", "0"]), /1~10000/);
});

test("평가 입력과 출력 경로가 같으면 거부", () => {
  assert.throws(() => parseArgs([
    "--input", "data/final.csv",
    "--output", "data/final.csv",
  ]), /입력과 출력 경로/);
  assert.throws(() => parseArgs([
    "--input", "data/final.csv",
    "--database", "data/final.csv",
  ]), /입력과 데이터베이스 경로/);
  assert.throws(() => parseArgs([
    "--database", "data/results.sqlite3",
    "--output", "data/results.sqlite3",
  ]), /데이터베이스와 출력 경로/);
});
