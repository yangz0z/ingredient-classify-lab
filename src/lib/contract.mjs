// 분류 결과 계약 검증 — 순수 함수만 포함
// 계약: LLM 출력은 등록된 카테고리 key만 사용하고, needs_review=true여도
// 후보 primary를 보존한다(검수 용도, 자동 반영 아님)

export const REQUIRED_RESULT_FIELDS = [
  "name",
  "primary_category_key",
  "additional_category_keys",
  "needs_review",
  "reason",
];

/**
 * 카탈로그에서 structured output용 strict JSON Schema 생성
 * primary는 빈 문자열(미확정)을 허용하고 additional은 등록 key만 허용
 * @param catalog 정규화된 카탈로그 배열
 * @return JSON Schema 객체
 */
export function buildClassificationSchema(catalog) {
  const keys = catalog.map((row) => row.key);
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      primary_category_key: { type: "string", enum: ["", ...keys] },
      additional_category_keys: {
        type: "array",
        items: { type: "string", enum: keys },
        maxItems: 10,
      },
      needs_review: { type: "boolean" },
      reason: { type: "string", minLength: 1 },
    },
    required: [...REQUIRED_RESULT_FIELDS],
  };
}

/**
 * 분류 결과의 계약 위반 목록 수집
 * @param result LLM 분류 결과
 * @param catalog 정규화된 카탈로그 배열
 * @param input 원본 입력 ({ name })
 * @return 위반 메시지 배열 — 위반이 없으면 빈 배열
 */
export function collectContractViolations(result, catalog, input) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return ["분류 응답 객체 누락"];
  }

  const missing = REQUIRED_RESULT_FIELDS
    .filter((field) => !(field in result))
    .map((field) => `분류 응답 필드 누락: ${field}`);
  if (missing.length > 0) return missing;

  const violations = [];
  if (result.name !== input.name) {
    violations.push("분류 응답의 입력 이름 불일치");
  }

  const allowed = new Set(catalog.map((row) => row.key));
  if (typeof result.primary_category_key !== "string"
    || (result.primary_category_key && !allowed.has(result.primary_category_key))) {
    violations.push("허용되지 않은 primary 카테고리");
  }
  if (!Array.isArray(result.additional_category_keys)) {
    violations.push("additional 카테고리 배열 누락");
  } else {
    if (result.additional_category_keys.some((key) => !allowed.has(key))) {
      violations.push("허용되지 않은 additional 카테고리");
    }
    if (new Set(result.additional_category_keys).size !== result.additional_category_keys.length) {
      violations.push("additional 카테고리 중복");
    }
    if (result.primary_category_key && result.additional_category_keys.includes(result.primary_category_key)) {
      violations.push("primary와 additional 중복");
    }
  }
  if (typeof result.needs_review !== "boolean") {
    violations.push("needs_review 형식 오류");
  } else if (!result.needs_review && !result.primary_category_key) {
    violations.push("확정 결과의 primary 누락");
  }
  if (typeof result.reason !== "string" || !result.reason.trim()) {
    violations.push("판정 사유 누락");
  }
  return violations;
}

/**
 * 계약 검증 후 정규화된 결과 반환 — 위반 시 첫 위반 메시지로 예외
 * needs_review=true의 후보 primary는 비우지 않고 그대로 보존
 * @return 정규화된 분류 결과 (reason 트림)
 */
export function validateClassification(result, catalog, input) {
  const violations = collectContractViolations(result, catalog, input);
  if (violations.length > 0) throw new Error(violations[0]);
  return { ...result, reason: result.reason.trim() };
}

/**
 * 위반 목록과 정규화 결과를 함께 반환 — API 응답 조립용
 * 위반이 있어도 결과 형상이 객체면 원본을 그대로 노출해 검수에 활용
 * @return { ok, violations, classification }
 */
export function checkClassification(result, catalog, input) {
  const violations = collectContractViolations(result, catalog, input);
  if (violations.length > 0) {
    const preservable = result !== null && typeof result === "object" && !Array.isArray(result);
    return { ok: false, violations, classification: preservable ? result : null };
  }
  return { ok: true, violations: [], classification: { ...result, reason: result.reason.trim() } };
}
