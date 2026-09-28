// 평가 계층 — 확정 정답과 배치 분류 결과 비교 및 사람이 읽는 CSV 생성

export const EVALUATION_HEADERS = [
  "성분 ID",
  "성분명",
  "반복 번호",
  "실행 상태",
  "확정 대표 분류",
  "적용 대표 분류",
  "대표 분류 결과",
  "확정 추가 분류",
  "적용 추가 분류",
  "추가 분류 결과",
  "전체 분류 결과",
  "모델 원본 대표 분류",
  "모델 원본 추가 분류",
  "정책 정규화",
  "적용 검수 판정",
  "적용 검수 사유 상세",
  "모델 원본 검수 판정",
  "모델 원본 검수 사유 상세",
  "검토 대상",
  "검토 사유",
  "모델 판정 사유",
  "계약 위반",
  "실행 오류",
];

const STATUS_LABELS = {
  success: "성공",
  contract_violation: "계약 위반",
  error: "오류",
};

const REVIEW_REASON_LABELS = {
  unknown_identity: "성분이나 원료의 정체를 확인할 수 없음",
  ambiguous_primary: "대표 분류 후보가 여러 개임",
  ambiguous_component: "독립 구성 성분 여부가 불명확함",
  missing_context: "분류에 필요한 정보가 부족함",
  unsupported_policy_relation: "허용된 대표·추가 분류 관계가 없음",
  other_uncertainty: "기타 불확실성이 있음",
};

const categoryLabel = (key) => String(key ?? "").replaceAll("::", " > ");
const sortedKeys = (keys) => [...(keys ?? [])].sort();

function sameCategorySet(expected, actual) {
  const expectedKeys = sortedKeys(expected);
  const actualKeys = sortedKeys(actual);
  return expectedKeys.length === actualKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index]);
}

function reviewReasons({ status, primaryMatches, additionalMatches, modelNeedsReview }) {
  const reasons = [];
  if (status === "error") reasons.push("실행 오류");
  if (status === "contract_violation") reasons.push("분류 계약 위반");
  if (status === "success" && !primaryMatches) reasons.push("대표 분류 불일치");
  if (status === "success" && !additionalMatches) reasons.push("추가 분류 불일치");
  if (status === "success" && modelNeedsReview) reasons.push("적용 결과가 검토 필요로 판정");
  return reasons;
}

/**
 * 확정 정답과 배치 실행 결과 비교
 * 정확도 분모는 계약을 통과한 성공 결과만 사용
 * @param options.expectedItems 확정 분류 배열
 * @param options.results 배치 실행 결과 배열
 * @return 평가 요약과 행별 비교 결과
 */
export function evaluateClassifications({ expectedItems, results }) {
  const expectedById = new Map(expectedItems.map((item) => [item.externalId, item]));
  const rows = results.map((result) => {
    const expected = expectedById.get(result.itemId);
    if (!expected) throw new Error(`확정 정답에 없는 항목: ${result.itemId}`);

    const comparable = result.status === "success" && result.classification !== null;
    const modelPrimaryCategoryKey = result.classification?.primary_category_key ?? "";
    const modelAdditionalCategoryKeys = result.classification?.additional_category_keys ?? [];
    const originalPrimaryCategoryKey = result.modelClassification?.primary_category_key
      ?? modelPrimaryCategoryKey;
    const originalAdditionalCategoryKeys = result.modelClassification?.additional_category_keys
      ?? modelAdditionalCategoryKeys;
    const originalNeedsReview = result.modelClassification?.needs_review
      ?? result.classification?.needs_review
      ?? null;
    const originalReviewReasons = result.modelClassification?.review_reason_codes
      ?? result.classification?.review_reason_codes
      ?? [];
    const primaryMatches = comparable
      ? expected.primaryCategoryKey === modelPrimaryCategoryKey
      : null;
    const additionalMatches = comparable
      ? sameCategorySet(expected.additionalCategoryKeys, modelAdditionalCategoryKeys)
      : null;
    const completeMatches = comparable
      ? primaryMatches && additionalMatches
      : null;
    const modelNeedsReview = comparable
      ? Boolean(result.classification.needs_review)
      : null;
    const reasons = reviewReasons({
      status: result.status,
      primaryMatches,
      additionalMatches,
      modelNeedsReview,
    });

    return {
      externalId: expected.externalId,
      name: expected.name,
      repetition: result.repetition,
      status: result.status,
      expectedPrimaryCategoryKey: expected.primaryCategoryKey,
      modelPrimaryCategoryKey,
      primaryMatches,
      expectedAdditionalCategoryKeys: expected.additionalCategoryKeys,
      modelAdditionalCategoryKeys,
      additionalMatches,
      completeMatches,
      originalPrimaryCategoryKey,
      originalAdditionalCategoryKeys,
      policyAdjustments: result.policyAdjustments ?? [],
      modelNeedsReview,
      modelReviewReasons: result.classification?.review_reason_codes ?? [],
      originalNeedsReview,
      originalReviewReasons,
      needsAttention: reasons.length > 0,
      attentionReasons: reasons,
      modelReason: result.classification?.reason ?? "",
      contractViolations: result.contractViolations ?? [],
      error: result.error ?? "",
    };
  });

  const comparableRows = rows.filter((row) => row.status === "success");
  const primaryMatchCount = comparableRows.filter((row) => row.primaryMatches).length;
  const additionalMatchCount = comparableRows.filter((row) => row.additionalMatches).length;
  const completeMatchCount = comparableRows.filter((row) => row.completeMatches).length;
  const rate = (count) => comparableRows.length === 0 ? null : count / comparableRows.length;
  const automaticRows = comparableRows.filter((row) => !row.modelNeedsReview);
  const automaticMatchCount = automaticRows.filter((row) => row.completeMatches).length;

  return {
    summary: {
      expectedItemCount: expectedItems.length,
      executionCount: rows.length,
      comparableCount: comparableRows.length,
      primaryMatchCount,
      primaryAccuracy: rate(primaryMatchCount),
      additionalMatchCount,
      additionalAccuracy: rate(additionalMatchCount),
      completeMatchCount,
      completeAccuracy: rate(completeMatchCount),
      modelNeedsReviewCount: comparableRows.filter((row) => row.modelNeedsReview).length,
      policyNormalizationCount: rows.filter((row) => row.policyAdjustments.length > 0).length,
      automaticCount: automaticRows.length,
      automaticRate: rows.length === 0 ? null : automaticRows.length / rows.length,
      automaticMatchCount,
      automaticAccuracy: automaticRows.length === 0
        ? null
        : automaticMatchCount / automaticRows.length,
      incorrectAutomaticCount: automaticRows.length - automaticMatchCount,
      attentionCount: rows.filter((row) => row.needsAttention).length,
      errorCount: rows.filter((row) => row.status === "error").length,
      contractViolationCount: rows.filter((row) => row.status === "contract_violation").length,
    },
    rows,
  };
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function matchLabel(value) {
  if (value === null) return "비교 제외";
  return value ? "일치" : "불일치";
}

function categoryListLabel(keys) {
  return (keys ?? []).map(categoryLabel).join(" | ");
}

/**
 * 평가 결과를 자연어 열 이름의 CSV로 직렬화
 * @param rows evaluateClassifications의 행별 비교 결과
 */
export function formatEvaluationCsv(rows) {
  const values = [
    EVALUATION_HEADERS,
    ...rows.map((row) => [
      row.externalId,
      row.name,
      row.repetition,
      STATUS_LABELS[row.status] ?? row.status,
      categoryLabel(row.expectedPrimaryCategoryKey),
      categoryLabel(row.modelPrimaryCategoryKey),
      matchLabel(row.primaryMatches),
      categoryListLabel(row.expectedAdditionalCategoryKeys),
      categoryListLabel(row.modelAdditionalCategoryKeys),
      matchLabel(row.additionalMatches),
      matchLabel(row.completeMatches),
      categoryLabel(row.originalPrimaryCategoryKey),
      categoryListLabel(row.originalAdditionalCategoryKeys),
      row.policyAdjustments.join(" | "),
      row.modelNeedsReview === null ? "비교 제외" : (row.modelNeedsReview ? "필요" : "불필요"),
      row.modelReviewReasons.map((code) => REVIEW_REASON_LABELS[code] ?? code).join(" | "),
      row.originalNeedsReview === null ? "비교 제외" : (row.originalNeedsReview ? "필요" : "불필요"),
      row.originalReviewReasons.map((code) => REVIEW_REASON_LABELS[code] ?? code).join(" | "),
      row.needsAttention ? "검토 필요" : "검토 불필요",
      row.attentionReasons.join(" | "),
      row.modelReason,
      row.contractViolations.join(" | "),
      row.error,
    ]),
  ];
  return `${values.map((row) => row.map(csvValue).join(",")).join("\n")}\n`;
}
