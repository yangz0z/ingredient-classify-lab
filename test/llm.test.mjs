// LLM 계층 테스트 — dry-run과 순수 함수만 검증 (외부 호출 없음)
import assert from "node:assert/strict";
import test from "node:test";

import { validateClassification } from "../src/lib/contract.mjs";
import { buildSystemPrompt, createClassifier, sanitizeError } from "../src/lib/llm.mjs";

const catalog = [
  { key: "곡물::쌀", major: "곡물", minor: "쌀", description: "쌀 기반 곡물" },
  { key: "첨가물::향료", major: "첨가물", minor: "향료", description: "천연·합성 향료" },
];

const promptSpec = {
  version: 1,
  instructions: ["폐쇄 어휘 분류자다.", "제공된 key만 사용한다."],
};

test("오류 메시지에서 API 키 형식을 제거", () => {
  const key = `sk-${"a".repeat(32)}`;
  assert.equal(sanitizeError(new Error(`실패 ${key}`)), "실패 [REDACTED]");
  assert.equal(
    sanitizeError(new Error("401 Incorrect API key: nvapi-rb********qtIf.")),
    "401 Incorrect API key: [REDACTED]",
  );
});

test("시스템 프롬프트는 지시문과 카테고리 목록을 포함", () => {
  const prompt = buildSystemPrompt(promptSpec, catalog);

  assert.ok(prompt.includes("폐쇄 어휘 분류자다."));
  assert.ok(prompt.includes("- 곡물::쌀: 쌀 기반 곡물"));
  assert.ok(prompt.includes("- 첨가물::향료: 천연·합성 향료"));
});

test("dry-run 분류기는 키 없이 계약 충족 결과를 반환", async () => {
  const classifier = createClassifier({ catalog, promptSpec });

  assert.equal(classifier.dryRun, true);
  assert.equal(classifier.model, null);

  const result = await classifier.classify("건조 쌀가루");
  assert.equal(result.dryRun, true);
  assert.equal(result.model, null);

  const classification = validateClassification(result.classification, catalog, { name: "건조 쌀가루" });
  assert.equal(classification.needs_review, true);
  assert.equal(classification.primary_category_key, "");
});

test("DRY_RUN 강제 시 키가 있어도 LLM을 호출하지 않음", async () => {
  const classifier = createClassifier({
    catalog,
    promptSpec,
    apiKey: "sk-synthetic-not-a-real-key",
    dryRun: true,
  });

  const result = await classifier.classify("쌀");
  assert.equal(result.dryRun, true);
  assert.equal(result.attemptCount, 0);
});

test("일시 오류는 제한 횟수 안에서 재시도하고 시도 횟수를 반환", async () => {
  let calls = 0;
  const client = {
    responses: {
      async create() {
        calls += 1;
        if (calls < 3) {
          const error = new Error("temporary failure");
          error.status = 429;
          throw error;
        }
        return {
          id: "response-1",
          model: "synthetic-model",
          output_text: JSON.stringify({
            name: "쌀",
            primary_category_key: "곡물::쌀",
            additional_category_keys: [],
            needs_review: false,
            reason: "쌀 기반",
          }),
          usage: null,
        };
      },
    },
  };
  const classifier = createClassifier({
    catalog,
    promptSpec,
    apiKey: "sk-synthetic-not-a-real-key",
    dryRun: false,
    maxAttempts: 3,
    client,
    retryDelay: async () => {},
  });

  const result = await classifier.classify("쌀");
  assert.equal(calls, 3);
  assert.equal(result.attemptCount, 3);
});

test("재시도 대상이 아닌 오류는 즉시 반환", async () => {
  let calls = 0;
  const client = {
    responses: {
      async create() {
        calls += 1;
        const error = new Error("bad request");
        error.status = 400;
        throw error;
      },
    },
  };
  const classifier = createClassifier({
    catalog,
    promptSpec,
    apiKey: "sk-synthetic-not-a-real-key",
    dryRun: false,
    maxAttempts: 3,
    client,
    retryDelay: async () => {},
  });

  await assert.rejects(
    classifier.classify("쌀"),
    (error) => error.message === "bad request" && error.attemptCount === 1,
  );
  assert.equal(calls, 1);
});

test("수정 불가능한 SDK 오류 객체도 원래 오류로 반환", async () => {
  const originalError = new Error("immutable error");
  originalError.status = 400;
  Object.freeze(originalError);
  const client = {
    responses: {
      async create() {
        throw originalError;
      },
    },
  };
  const classifier = createClassifier({
    catalog,
    promptSpec,
    apiKey: "sk-synthetic-not-a-real-key",
    dryRun: false,
    client,
  });

  await assert.rejects(classifier.classify("쌀"), (error) => error === originalError);
});
