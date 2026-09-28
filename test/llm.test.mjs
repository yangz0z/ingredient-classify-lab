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

const policySpec = {
  version: 1,
  primaryRules: ["명시된 사용 목적을 우선한다."],
  additionalPolicy: {
    unlistedRelation: "review",
    relations: [{
      primaryCategoryKey: "첨가물::향료",
      additionalCategoryKey: "곡물::쌀",
      condition: "독립 구성 성분으로 직접 확인되는 경우",
    }],
  },
  reviewRules: ["우선순위를 결정할 수 없으면 검수 대상으로 둔다."],
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
  const prompt = buildSystemPrompt(promptSpec, catalog, policySpec);

  assert.ok(prompt.includes("폐쇄 어휘 분류자다."));
  assert.ok(prompt.includes("- 곡물::쌀: 쌀 기반 곡물"));
  assert.ok(prompt.includes("- 첨가물::향료: 천연·합성 향료"));
  assert.ok(prompt.includes("첨가물::향료 -> 곡물::쌀"));
  assert.ok(prompt.includes("목록에 없는 primary-additional 관계"));
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
  assert.deepEqual(classification.review_reason_codes, ["missing_context"]);
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

// 대분류 공통 설명은 축 정의로 한 번만 제시 — 실제 카탈로그는 127개 중 112개가
// 같은 문장을 공유해 개별 줄에 반복하면 카테고리 간 구분 정보가 사라진다
const sharedDescriptionCatalog = [
  { key: "원료::닭", major: "원료", minor: "닭", description: "제품을 구성하는 물질의 원천" },
  { key: "원료::오리", major: "원료", minor: "오리", description: "제품을 구성하는 물질의 원천" },
  { key: "원료::쌀", major: "원료", minor: "쌀", description: "제품을 구성하는 물질의 원천" },
  { key: "원료::귀리", major: "원료", minor: "귀리", description: "귀리, 오트밀, 연맥분" },
  { key: "성분::루테인", major: "성분", minor: "루테인", description: "기능성 성분" },
];

test("대분류가 공유하는 설명은 축 정의로 한 번만 제시하고 개별 카테고리에서 생략", () => {
  const prompt = buildSystemPrompt(promptSpec, sharedDescriptionCatalog);
  const categorySection = prompt.slice(prompt.indexOf("허용 카테고리"));

  // 공유 설명은 대분류 헤더에만 1회 등장
  const occurrences = categorySection.split("제품을 구성하는 물질의 원천").length - 1;
  assert.equal(occurrences, 1);
  assert.ok(categorySection.includes("## 원료 — 제품을 구성하는 물질의 원천"));

  // 공유 설명을 쓰는 카테고리는 key만 표기
  assert.ok(categorySection.includes("\n- 원료::닭\n"));
  assert.ok(categorySection.includes("\n- 원료::오리\n"));

  // 고유 설명은 개별 줄에 유지
  assert.ok(categorySection.includes("- 원료::귀리: 귀리, 오트밀, 연맥분"));

  // 설명이 하나뿐인 대분류는 축 정의로 승격하지 않고 개별 표기 유지
  assert.ok(categorySection.includes("- 성분::루테인: 기능성 성분"));
});

test("카테고리 목록은 모든 key를 빠짐없이 포함하고 설명 상속을 명시", () => {
  const prompt = buildSystemPrompt(promptSpec, sharedDescriptionCatalog);

  for (const row of sharedDescriptionCatalog) {
    assert.ok(prompt.includes(row.key), `${row.key} 누락`);
  }
  assert.ok(prompt.includes("설명이 없는 카테고리는 대분류 축 정의를 따른다"));
});
