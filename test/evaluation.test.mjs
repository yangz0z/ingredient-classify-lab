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
    policyNormalizationCount: 0,
    automaticCount: 1,
    automaticRate: 0.5,
    automaticMatchCount: 1,
    automaticAccuracy: 1,
    incorrectAutomaticCount: 0,
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
  assert.equal(evaluation.summary.automaticCount, 0);
  assert.equal(evaluation.summary.automaticRate, 0);
  assert.equal(evaluation.summary.automaticAccuracy, null);
});

test("자동 분류율과 자동 분류 정확도를 별도 집계", () => {
  const evaluation = evaluateClassifications({
    expectedItems,
    results: [
      successResult(),
      successResult({
        itemId: "ingredient-2",
        itemName: "천연향",
        classification: {
          name: "천연향",
          primary_category_key: "원료::곡물",
          additional_category_keys: [],
          needs_review: false,
          reason: "잘못 자동 확정",
        },
      }),
    ],
  });

  assert.equal(evaluation.summary.automaticCount, 2);
  assert.equal(evaluation.summary.automaticRate, 1);
  assert.equal(evaluation.summary.automaticMatchCount, 1);
  assert.equal(evaluation.summary.automaticAccuracy, 0.5);
  assert.equal(evaluation.summary.incorrectAutomaticCount, 1);
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
  assert.match(csv, /"적용 결과가 검토 필요로 판정"/);
  assert.match(csv, /"이름만으로 판단하기 어려움"/);
  assert.doesNotMatch(csv, /primaryCategoryKey|needsReview/);
});

test("평가 CSV는 모델 원본과 정책 정규화 결과를 구분", () => {
  const evaluation = evaluateClassifications({
    expectedItems: [expectedItems[0]],
    results: [successResult({
      modelClassification: {
        ...successResult().classification,
        primary_category_key: "성분::식이섬유",
        additional_category_keys: ["원료::곡물"],
        needs_review: true,
        review_reason_codes: ["ambiguous_primary"],
      },
      policyAdjustments: [
        "정책 우선순위에 따라 대표 분류 변경: 성분::식이섬유 → 원료::곡물",
      ],
    })],
  });
  const csv = formatEvaluationCsv(evaluation.rows);

  assert.equal(evaluation.summary.policyNormalizationCount, 1);
  assert.match(csv, /"적용 대표 분류"/);
  assert.match(csv, /"모델 원본 대표 분류"/);
  assert.match(csv, /"적용 검수 판정"/);
  assert.match(csv, /"모델 원본 검수 판정"/);
  assert.match(csv, /"모델 원본 검수 사유 상세"/);
  assert.match(csv, /"정책 정규화"/);
  assert.match(csv, /성분 > 식이섬유/);
  assert.match(csv, /정책 우선순위에 따라 대표 분류 변경/);
});

test("평가 CSV는 구조화된 검수 사유를 자연어로 출력", () => {
  const evaluation = evaluateClassifications({
    expectedItems: [expectedItems[0]],
    results: [successResult({
      classification: {
        ...successResult().classification,
        needs_review: true,
        review_reason_codes: ["ambiguous_primary", "missing_context"],
      },
    })],
  });
  const csv = formatEvaluationCsv(evaluation.rows);

  assert.match(csv, /"적용 검수 사유 상세"/);
  assert.match(csv, /대표 분류 후보가 여러 개임 \| 분류에 필요한 정보가 부족함/);
  assert.doesNotMatch(csv, /ambiguous_primary|missing_context/);
});

// 자동 분류 정확도는 대표 분류만 본다 — 추가 분류는 운영 판단에서 비중이 낮아 제외
test("대표 분류가 맞으면 추가 분류가 달라도 자동 분류 정답으로 집계", () => {
  const evaluation = evaluateClassifications({
    expectedItems,
    results: [
      successResult({
        classification: {
          name: "쌀가루",
          primary_category_key: "원료::곡물",
          additional_category_keys: [],
          needs_review: false,
          reason: "대표는 맞고 추가만 누락",
        },
      }),
    ],
  });

  assert.equal(evaluation.summary.additionalMatchCount, 0);
  assert.equal(evaluation.summary.completeMatchCount, 0);
  // 자동 분류 집계는 대표 기준이므로 정답
  assert.equal(evaluation.summary.automaticMatchCount, 1);
  assert.equal(evaluation.summary.automaticAccuracy, 1);
  assert.equal(evaluation.summary.incorrectAutomaticCount, 0);
});

test("대표 분류가 틀리면 추가 분류가 맞아도 자동 분류 오류로 집계", () => {
  const evaluation = evaluateClassifications({
    expectedItems,
    results: [
      successResult({
        classification: {
          name: "쌀가루",
          primary_category_key: "기타::첨가물",
          additional_category_keys: ["성분::식이섬유"],
          needs_review: false,
          reason: "대표만 틀림",
        },
      }),
    ],
  });

  assert.equal(evaluation.summary.additionalMatchCount, 1);
  assert.equal(evaluation.summary.automaticMatchCount, 0);
  assert.equal(evaluation.summary.incorrectAutomaticCount, 1);
});

test("대표 분류가 맞으면 추가 분류 차이만으로 검토 대상이 되지 않음", () => {
  const evaluation = evaluateClassifications({
    expectedItems,
    results: [
      successResult({
        classification: {
          name: "쌀가루",
          primary_category_key: "원료::곡물",
          additional_category_keys: [],
          needs_review: false,
          reason: "대표는 맞고 추가만 누락",
        },
      }),
    ],
  });

  assert.equal(evaluation.summary.attentionCount, 0);
  assert.deepEqual(evaluation.rows[0].attentionReasons, []);
});
