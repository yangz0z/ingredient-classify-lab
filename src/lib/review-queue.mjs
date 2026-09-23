// 검수 큐 생성 — 기존 분류와 LLM 결과를 자연어 비교 CSV로 변환

export const REVIEW_HEADERS = [
  "성분 ID",
  "성분명",
  "비교 검수 구분",
  "검수 사유",
  "운영 처리 구분",
  "현재 토글 OFF 처리",
  "토글 ON 시 처리",
  "어드민 작업",
  "현재 운영 분류",
  "LLM 대표 분류",
  "LLM 추가 분류",
  "LLM 검토 필요",
  "LLM 판단 근거",
  "실행 상태",
  "기획 검수 결과",
  "확정 대표 분류",
  "확정 추가 분류",
  "검수 의견",
];

const categoryLabel = (key) => String(key ?? "").replaceAll("::", " > ");
const categoryListLabel = (keys) => (keys ?? []).map(categoryLabel).join(" | ");
const sortedKeys = (keys) => [...(keys ?? [])].sort();
const STATUS_LABELS = {
  success: "성공",
  contract_violation: "계약 위반",
  error: "오류",
};
const REVIEW_STATUS_LABELS = {
  matched: "운영 분류 일치",
  new_confirmation: "신규 분류 확인",
  attention: "재검토 필요",
};
const OPERATIONAL_STATUS = {
  auto: {
    label: "자동 분류 가능",
    toggleOff: "판정 결과만 저장 · 운영 분류 미반영",
    toggleOn: "운영 분류 자동 반영",
    adminAction: "결과 확인 · 틀린 경우만 수정",
  },
  needs_review: {
    label: "검수 필요",
    toggleOff: "판정 결과만 저장 · 운영 분류 미반영",
    toggleOn: "검수 전까지 운영 분류 미반영",
    adminAction: "확정 · 수정 · 거부 필요",
  },
  failed: {
    label: "분류 실패",
    toggleOff: "실패 기록 저장 · 운영 분류 미반영",
    toggleOn: "운영 분류 미반영",
    adminAction: "재시도 결과 확인 또는 수동 분류",
  },
};

function sameCategorySet(expected, actual) {
  const expectedKeys = sortedKeys(expected);
  const actualKeys = sortedKeys(actual);
  return expectedKeys.length === actualKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index]);
}

function describeReview(source, result) {
  if (result.status === "error") return ["attention", "LLM 실행 오류"];
  if (result.status === "contract_violation") return ["attention", "LLM 분류 계약 위반"];
  if (!result.classification) return ["attention", "LLM 분류 결과 없음"];

  const classification = result.classification;
  const modelKeys = [
    classification.primary_category_key,
    ...(classification.additional_category_keys ?? []),
  ].filter(Boolean);
  const reasons = [];
  if (source.existingCategoryKeys.length === 0) {
    reasons.push("현재 운영 분류가 없어 LLM 결과 확인 필요");
  } else if (!sameCategorySet(source.existingCategoryKeys, modelKeys)) {
    reasons.push("운영 분류와 LLM 분류가 다름");
  }
  if (classification.needs_review) reasons.push("LLM이 검토 필요로 판정함");
  if (reasons.length === 0) return ["matched", "운영 분류와 LLM 분류가 일치함"];
  if (source.existingCategoryKeys.length === 0 && !classification.needs_review) {
    return ["new_confirmation", reasons.join(" | ")];
  }
  return ["attention", reasons.join(" | ")];
}

/**
 * 기존 분류 스냅샷과 단일 반복 실행 결과 비교
 * @param options.sources 성분 ID·이름·기존 분류 목록
 * @param options.results SQLite에서 조회한 배치 결과
 * @return 검수 CSV 행
 */
export function buildReviewRows({ sources, results }) {
  const resultsById = new Map();
  for (const result of results) {
    if (result.repetition !== 1) throw new Error("검수 큐는 1회 실행 결과만 지원");
    if (resultsById.has(result.itemId)) throw new Error(`실행 결과 중복: ${result.itemId}`);
    resultsById.set(result.itemId, result);
  }

  const sourceIds = new Set(sources.map((source) => String(source.ingredientId)));
  for (const resultId of resultsById.keys()) {
    if (!sourceIds.has(resultId)) throw new Error(`입력에 없는 실행 결과: ${resultId}`);
  }

  return sources.map((source) => {
    const externalId = String(source.ingredientId);
    const result = resultsById.get(externalId);
    if (!result) throw new Error(`실행 결과 누락: ${externalId}`);
    if (result.itemName !== source.ingredientName) {
      throw new Error(`성분명 불일치: ${externalId}`);
    }
    const normalizedSource = {
      ...source,
      existingCategoryKeys: source.existingCategoryKeys ?? [],
    };
    const [reviewStatus, reviewReason] = describeReview(normalizedSource, result);
    const operationalStatus = result.status === "error"
      ? "failed"
      : (result.status === "contract_violation"
        || !result.classification
        || result.classification.needs_review
          ? "needs_review"
          : "auto");
    return {
      externalId,
      name: source.ingredientName,
      reviewStatus,
      reviewRequired: reviewStatus !== "matched",
      reviewReason,
      operationalStatus,
      existingCategoryKeys: normalizedSource.existingCategoryKeys,
      modelPrimaryCategoryKey: result.classification?.primary_category_key ?? "",
      modelAdditionalCategoryKeys: result.classification?.additional_category_keys ?? [],
      modelNeedsReview: result.classification?.needs_review ?? null,
      modelReason: result.classification?.reason ?? "",
      status: result.status,
      contractViolations: result.contractViolations ?? [],
      error: result.error ?? "",
    };
  });
}

function csvValue(value) {
  const text = String(value ?? "");
  const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

/**
 * 검수 행을 사람이 읽는 CSV로 직렬화
 */
export function formatReviewCsv(rows) {
  const values = [
    ["검수 방법", "기획 검수 결과가 비어 있으면 LLM 분류 수용", "결과가 틀린 행만 판정·확정값 입력"],
    ["기획 검수 결과 선택값", "LLM 분류 수용 | 기존 운영 분류 수용 | 신규 값으로 분류"],
    [],
    REVIEW_HEADERS,
    ...rows.map((row) => [
      row.externalId,
      row.name,
      REVIEW_STATUS_LABELS[row.reviewStatus] ?? row.reviewStatus,
      row.reviewReason,
      OPERATIONAL_STATUS[row.operationalStatus]?.label ?? row.operationalStatus,
      OPERATIONAL_STATUS[row.operationalStatus]?.toggleOff ?? "",
      OPERATIONAL_STATUS[row.operationalStatus]?.toggleOn ?? "",
      OPERATIONAL_STATUS[row.operationalStatus]?.adminAction ?? "",
      categoryListLabel(row.existingCategoryKeys),
      categoryLabel(row.modelPrimaryCategoryKey),
      categoryListLabel(row.modelAdditionalCategoryKeys),
      row.modelNeedsReview === null ? "비교 제외" : (row.modelNeedsReview ? "필요" : "불필요"),
      row.modelReason,
      STATUS_LABELS[row.status] ?? row.status,
      "",
      "",
      "",
      "",
    ]),
  ];
  return `${values.map((row) => row.map(csvValue).join(",")).join("\n")}\n`;
}
