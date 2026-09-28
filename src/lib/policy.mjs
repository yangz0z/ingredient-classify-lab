// 카테고리 정책 데이터 — 대표 우선순위와 허용 additional 관계 검증·프롬프트 조립
import { readFile } from "node:fs/promises";

import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

const policyShape = {
  type: "object",
  required: ["version", "primaryRules", "additionalPolicy", "reviewRules"],
  properties: {
    version: { type: ["number", "string"] },
    primaryRules: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    additionalPolicy: {
      type: "object",
      required: ["unlistedRelation", "relations"],
      properties: {
        unlistedRelation: { const: "review" },
        relations: {
          type: "array",
          items: {
            type: "object",
            required: ["primaryCategoryKey", "additionalCategoryKey", "condition"],
            properties: {
              primaryCategoryKey: { type: "string", minLength: 1 },
              additionalCategoryKey: { type: "string", minLength: 1 },
              condition: { type: "string", minLength: 1 },
              evidenceCount: { type: "integer", minimum: 1 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    reviewRules: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
  },
  additionalProperties: false,
};

const validatePolicyShape = ajv.compile(policyShape);
const normalizeText = (value) => String(value).trim();

function formatAjvErrors(errors) {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join(", ");
}

/**
 * 카테고리 정책 구조와 참조 무결성 검증
 * @param raw 파싱된 정책 객체
 * @param catalog 정규화된 카탈로그 배열
 * @return 정규화된 정책 객체
 */
export function normalizePolicySpec(raw, catalog) {
  if (!validatePolicyShape(raw)) {
    throw new Error(`정책 데이터 구조 오류: ${formatAjvErrors(validatePolicyShape.errors)}`);
  }

  const allowed = new Set(catalog.map((row) => row.key));
  const primaryRules = raw.primaryRules.map(normalizeText);
  const reviewRules = raw.reviewRules.map(normalizeText);
  if (primaryRules.some((rule) => !rule) || reviewRules.some((rule) => !rule)) {
    throw new Error("정책 규칙은 공백일 수 없음");
  }

  const pairs = new Set();
  const relations = raw.additionalPolicy.relations.map((relation, index) => {
    const primaryCategoryKey = normalizeText(relation.primaryCategoryKey);
    const additionalCategoryKey = normalizeText(relation.additionalCategoryKey);
    const condition = normalizeText(relation.condition);
    if (!allowed.has(primaryCategoryKey)) {
      throw new Error(`정책 ${index + 1}번 primary 카테고리가 카탈로그에 없음: ${primaryCategoryKey}`);
    }
    if (!allowed.has(additionalCategoryKey)) {
      throw new Error(`정책 ${index + 1}번 additional 카테고리가 카탈로그에 없음: ${additionalCategoryKey}`);
    }
    if (primaryCategoryKey === additionalCategoryKey) {
      throw new Error(`정책 ${index + 1}번 대표·추가 카테고리 중복`);
    }
    if (!condition) throw new Error(`정책 ${index + 1}번 조건은 공백일 수 없음`);

    const pair = `${primaryCategoryKey}\u0000${additionalCategoryKey}`;
    const reverse = `${additionalCategoryKey}\u0000${primaryCategoryKey}`;
    if (pairs.has(pair)) throw new Error(`정책 관계 중복: ${primaryCategoryKey} -> ${additionalCategoryKey}`);
    if (pairs.has(reverse)) {
      throw new Error(`정책 대표 우선순위 충돌: ${primaryCategoryKey} <-> ${additionalCategoryKey}`);
    }
    pairs.add(pair);
    return {
      primaryCategoryKey,
      additionalCategoryKey,
      condition,
      ...(relation.evidenceCount === undefined ? {} : { evidenceCount: relation.evidenceCount }),
    };
  });

  return {
    version: raw.version,
    primaryRules,
    additionalPolicy: {
      unlistedRelation: raw.additionalPolicy.unlistedRelation,
      relations,
    },
    reviewRules,
  };
}

/**
 * 정책 JSON 파일 로드 후 카탈로그와 함께 검증
 * @param filePath 정책 JSON 경로
 * @param catalog 정규화된 카탈로그 배열
 */
export async function loadPolicySpec(filePath, catalog) {
  let raw;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`정책 데이터 JSON 파싱 실패: ${filePath}`);
    throw new Error(`정책 데이터 파일 읽기 실패: ${filePath} (${error.code ?? error.message})`);
  }
  return normalizePolicySpec(raw, catalog);
}

/**
 * 검증된 정책을 시스템 프롬프트 지시문으로 변환
 * @param policySpec 정규화된 정책 객체
 * @return 정책 지시문
 */
export function formatPolicyInstructions(policySpec) {
  const primaryRules = policySpec.primaryRules
    .map((rule, index) => `${index + 1}. ${rule}`)
    .join("\n");
  const relations = policySpec.additionalPolicy.relations.length === 0
    ? "- 허용된 관계 없음"
    : policySpec.additionalPolicy.relations
      .map((relation) => `- ${relation.primaryCategoryKey} -> ${relation.additionalCategoryKey}: ${relation.condition}`)
      .join("\n");
  const reviewRules = policySpec.reviewRules
    .map((rule) => `- ${rule}`)
    .join("\n");

  return [
    `카테고리 정책 버전: ${policySpec.version}`,
    "대표 분류 우선순위:",
    primaryRules,
    "허용 additional 관계:",
    relations,
    "목록에 없는 primary-additional 관계는 additional로 확정하지 말고 needs_review=true로 반환한다.",
    "검수 분기:",
    reviewRules,
  ].join("\n");
}

/**
 * 정책 관계를 기준으로 뒤집힌 대표·추가 분류 순서 정규화
 * 선택된 전체 카테고리를 설명하는 대표 후보가 하나일 때만 적용
 * @param classification 모델 원본 분류
 * @param policySpec 정규화된 정책 객체
 * @return 정규화 결과와 적용 내역
 */
export function normalizeClassificationByPolicy(classification, policySpec) {
  if (classification === null
    || typeof classification !== "object"
    || Array.isArray(classification)
    || typeof classification.primary_category_key !== "string"
    || !Array.isArray(classification.additional_category_keys)
    || classification.additional_category_keys.length === 0
    || !policySpec?.additionalPolicy?.relations) {
    return { classification, adjustments: [] };
  }

  const categoryKeys = [
    classification.primary_category_key,
    ...classification.additional_category_keys,
  ];
  if (categoryKeys.some((key) => typeof key !== "string" || !key)
    || new Set(categoryKeys).size !== categoryKeys.length) {
    return { classification, adjustments: [] };
  }

  const allowedRelations = new Set(policySpec.additionalPolicy.relations.map(
    (relation) => `${relation.primaryCategoryKey}\u0000${relation.additionalCategoryKey}`,
  ));
  const candidates = categoryKeys.filter((candidate) => categoryKeys
    .filter((key) => key !== candidate)
    .every((key) => allowedRelations.has(`${candidate}\u0000${key}`)));

  if (candidates.length !== 1 || candidates[0] === classification.primary_category_key) {
    return { classification, adjustments: [] };
  }

  const primaryCategoryKey = candidates[0];
  const resolvableReviewReasons = new Set([
    "ambiguous_primary",
    "unsupported_policy_relation",
  ]);
  const resolvesReview = classification.needs_review === true
    && Array.isArray(classification.review_reason_codes)
    && classification.review_reason_codes.length > 0
    && new Set(classification.review_reason_codes).size === classification.review_reason_codes.length
    && classification.review_reason_codes.every((code) => resolvableReviewReasons.has(code));
  return {
    classification: {
      ...classification,
      primary_category_key: primaryCategoryKey,
      additional_category_keys: categoryKeys.filter((key) => key !== primaryCategoryKey),
      ...(resolvesReview ? {
        needs_review: false,
        review_reason_codes: [],
      } : {}),
    },
    adjustments: [
      `정책 우선순위에 따라 대표 분류 변경: ${classification.primary_category_key} → ${primaryCategoryKey}`,
      ...(resolvesReview ? ["정책 정규화로 대표 우선순위 검수 사유 해소"] : []),
    ],
  };
}

/**
 * 실행 결과에 남길 프롬프트·정책 합성 버전
 */
export function policyPromptVersion(promptSpec, policySpec) {
  return `${promptSpec.version}+policy:${policySpec.version}`;
}
