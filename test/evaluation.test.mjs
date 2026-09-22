// 확정 정답과 모델 판정 비교 — 정확도 집계와 검토용 CSV 검증
import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateClassifications,
  formatEvaluationCsv,
} from "../src/lib/evaluation.mjs";

const expectedItems = [
  {
    externalId: "ingredient-1",
    name: "쌀가루",
    primaryCategoryKey: "원료::곡물",
    additionalCategoryKeys: ["성분::식이섬유"],
    decisionSource: "LLM 분류 수용",
    comment: "",
  },
  {
    externalId: "ingredient-2",
    name: "천연향",
    primaryCategoryKey: "기타::첨가물",
    additionalCategoryKeys: [],
    decisionSource: "기존 운영 분류 수용",
    comment: "운영값 유지",
  },
];

function successResult(overrides = {}) {
  return {
    itemId: "ingredient-1",
    itemName: "쌀가루",
    repetition: 1,
    status: "success",
    classification: {
      name: "쌀가루",
      primary_category_key: "원료::곡물",
      additional_category_keys: ["성분::식이섬유"],
      needs_review: false,
      reason: "곡물 원료",
    },
    contractViolations: [],
    error: null,
    ...overrides,
  };
}

test("대표·추가 분류와 전체 일치율을 실행 결과 기준으로 집계", () => {
  const evaluation = evaluateClassifications({
    expectedItems,
    results: [
      successResult(),
      successResult({
        itemId: "ingredient-2",
        itemName: "천연향",
        classification: {
          name: "천연향",
          primary_category_key: "기타::첨가물",
          additional_category_keys: ["성분::식이섬유"],
          needs_review: true,
          reason: "추가 분류 불확실",
        },
      }),
    ],
  });

  assert.deepEqual(evaluation.summary, {
    expectedItemCount: 2,
    executionCount: 2,
    comparableCount: 2,
    primaryMatchCount: 2,
    primaryAccuracy: 1,
    additionalMatchCount: 1,
    additionalAccuracy: 0.5,
    completeMatchCount: 1,
    completeAccuracy: 0.5,
    modelNeedsReviewCount: 1,
    attentionCount: 1,
    errorCount: 0,
    contractViolationCount: 0,
  });
  assert.equal(evaluation.rows[1].primaryMatches, true);
  assert.equal(evaluation.rows[1].additionalMatches, false);
  assert.equal(evaluation.rows[1].needsAttention, true);
});

test("추가 분류 순서는 일치 여부에 영향 없음", () => {
  const evaluation = evaluateClassifications({
    expectedItems: [{
      ...expectedItems[0],
      additionalCategoryKeys: ["성분::식이섬유", "성분::비타민"],
    }],
    results: [successResult({
      classification: {
        ...successResult().classification,
        additional_category_keys: ["성분::비타민", "성분::식이섬유"],
      },
    })],
  });

  assert.equal(evaluation.summary.completeAccuracy, 1);
  assert.equal(evaluation.rows[0].needsAttention, false);
});

test("오류와 계약 위반은 비교에서 제외하고 검토 대상으로 집계", () => {
  const evaluation = evaluateClassifications({
    expectedItems,
    results: [
      successResult({
        status: "error",
        classification: null,
        error: "호출 실패",
      }),
      successResult({
        itemId: "ingredient-2",
        itemName: "천연향",
        status: "contract_violation",
        contractViolations: ["허용되지 않은 카테고리"],
      }),
    ],
  });

  assert.equal(evaluation.summary.comparableCount, 0);
  assert.equal(evaluation.summary.completeAccuracy, null);
  assert.equal(evaluation.summary.attentionCount, 2);
  assert.equal(evaluation.summary.errorCount, 1);
  assert.equal(evaluation.summary.contractViolationCount, 1);
});

test("확정 정답에 없는 실행 결과는 거부", () => {
  assert.throws(() => evaluateClassifications({
    expectedItems,
    results: [successResult({ itemId: "unknown" })],
  }), /확정 정답에 없는 항목/);
});

test("평가 CSV는 자연어 열과 검토 사유를 포함", () => {
  const evaluation = evaluateClassifications({
    expectedItems: [expectedItems[0]],
    results: [successResult({
      classification: {
        ...successResult().classification,
        needs_review: true,
        reason: "이름만으로 판단하기 어려움",
      },
    })],
  });
  const csv = formatEvaluationCsv(evaluation.rows);

  assert.match(csv, /"성분 ID","성분명","반복 번호","실행 상태"/);
  assert.match(csv, /"검토 필요","모델이 검토 필요로 판정"/);
  assert.match(csv, /"이름만으로 판단하기 어려움"/);
  assert.doesNotMatch(csv, /primaryCategoryKey|needsReview/);
});
