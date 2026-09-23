// 검수 큐 테스트 — 운영 분류와 LLM 결과 비교 및 자연어 CSV 검증
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReviewRows,
  formatReviewCsv,
} from "../src/lib/review-queue.mjs";

const sources = [
  {
    ingredientId: 1,
    ingredientName: "합성 일치 원료",
    existingCategoryKeys: ["원료::어류", "성분::오메가"],
  },
  {
    ingredientId: 2,
    ingredientName: "합성 미분류 원료",
    existingCategoryKeys: [],
  },
];

const success = ({ id, name, primary, additional = [], needsReview = false }) => ({
  itemId: String(id),
  itemName: name,
  repetition: 1,
  status: "success",
  classification: {
    name,
    primary_category_key: primary,
    additional_category_keys: additional,
    needs_review: needsReview,
    reason: "합성 판정 근거",
  },
  contractViolations: [],
  error: null,
});

test("운영·LLM 일치는 완료, 운영 미분류는 신규 분류 확인으로 표시", () => {
  const rows = buildReviewRows({
    sources,
    results: [
      success({
        id: 1,
        name: "합성 일치 원료",
        primary: "원료::어류",
        additional: ["성분::오메가"],
      }),
      success({
        id: 2,
        name: "합성 미분류 원료",
        primary: "기타::첨가제",
      }),
    ],
  });

  assert.equal(rows[0].reviewRequired, false);
  assert.equal(rows[0].reviewStatus, "matched");
  assert.equal(rows[0].operationalStatus, "auto");
  assert.equal(rows[0].reviewReason, "운영 분류와 LLM 분류가 일치함");
  assert.equal(rows[1].reviewRequired, true);
  assert.equal(rows[1].reviewStatus, "new_confirmation");
  assert.equal(rows[1].operationalStatus, "auto");
  assert.equal(rows[1].reviewReason, "현재 운영 분류가 없어 LLM 결과 확인 필요");
});

test("불일치·모델 검토·오류 사유를 모두 보존", () => {
  const rows = buildReviewRows({
    sources,
    results: [
      success({
        id: 1,
        name: "합성 일치 원료",
        primary: "원료::어류",
        needsReview: true,
      }),
      {
        itemId: "2",
        itemName: "합성 미분류 원료",
        repetition: 1,
        status: "error",
        classification: null,
        contractViolations: [],
        error: "합성 오류",
      },
    ],
  });

  assert.match(rows[0].reviewReason, /운영 분류와 LLM 분류가 다름/);
  assert.match(rows[0].reviewReason, /LLM이 검토 필요로 판정함/);
  assert.equal(rows[0].reviewStatus, "attention");
  assert.equal(rows[0].operationalStatus, "needs_review");
  assert.equal(rows[1].reviewReason, "LLM 실행 오류");
  assert.equal(rows[1].reviewStatus, "attention");
  assert.equal(rows[1].operationalStatus, "failed");
});

test("계약 위반은 운영 검수 필요 상태로 분류", () => {
  const [row] = buildReviewRows({
    sources: [sources[0]],
    results: [{
      itemId: "1",
      itemName: "합성 일치 원료",
      repetition: 1,
      status: "contract_violation",
      classification: null,
      contractViolations: ["합성 계약 위반"],
      error: null,
    }],
  });

  assert.equal(row.operationalStatus, "needs_review");
  assert.equal(row.reviewReason, "LLM 분류 계약 위반");
});

test("검수 CSV는 비교값과 기획 입력 열을 사람이 읽는 이름으로 출력", () => {
  const rows = buildReviewRows({
    sources: [sources[0]],
    results: [success({
      id: 1,
      name: "합성 일치 원료",
      primary: "원료::어류",
      additional: ["성분::오메가"],
    })],
  });
  const csv = formatReviewCsv(rows);

  assert.match(csv, /기획 검수 결과가 비어 있으면 LLM 분류 수용/);
  assert.match(csv, /LLM 분류 수용 \| 기존 운영 분류 수용 \| 신규 값으로 분류/);
  assert.match(csv, /"성분 ID","성분명","비교 검수 구분","검수 사유","운영 처리 구분"/);
  assert.match(csv, /"현재 토글 OFF 처리","토글 ON 시 처리","어드민 작업"/);
  assert.match(csv, /"운영 분류 일치"/);
  assert.match(csv, /"자동 분류 가능","판정 결과만 저장 · 운영 분류 미반영","운영 분류 자동 반영"/);
  assert.match(csv, /"현재 운영 분류","LLM 대표 분류","LLM 추가 분류"/);
  assert.match(csv, /"기획 검수 결과","확정 대표 분류","확정 추가 분류","검수 의견"/);
  assert.match(csv, /"원료 > 어류 \| 성분 > 오메가"/);
  assert.doesNotMatch(csv, /"계약 위반"|"실행 오류"/);
  assert.doesNotMatch(csv, /primaryCategoryKey|needsReview/);
});

test("입력과 실행 결과의 ID 누락·중복을 거부", () => {
  assert.throws(
    () => buildReviewRows({ sources, results: [] }),
    /실행 결과 누락/,
  );
  const duplicate = success({
    id: 1,
    name: "합성 일치 원료",
    primary: "원료::어류",
  });
  assert.throws(
    () => buildReviewRows({ sources: [sources[0]], results: [duplicate, duplicate] }),
    /실행 결과 중복/,
  );
});

test("CSV 수식으로 해석될 수 있는 셀은 텍스트로 보호", () => {
  const rows = buildReviewRows({
    sources: [{ ingredientId: 3, ingredientName: "=위험", existingCategoryKeys: [] }],
    results: [success({
      id: 3,
      name: "=위험",
      primary: "기타::첨가제",
    })],
  });

  assert.match(formatReviewCsv(rows), /"'=위험"/);
});
