// 기획 검수 결과 확정 — 비교용 CSV를 단순한 확정값 CSV로 변환
import { parse } from "csv-parse/sync";

export const FINAL_CLASSIFICATION_HEADERS = [
  "성분 ID",
  "성분명",
  "확정 대표 분류",
  "확정 추가 분류",
  "확정 근거",
  "검수 의견",
];

const REVIEW_SOURCE_HEADERS = [
  "성분 ID",
  "성분명",
  "현재 운영 분류",
  "LLM 대표 분류",
  "LLM 추가 분류",
  "기획 검수 결과",
  "확정 대표 분류",
];

const normalizeText = (value) => String(value ?? "").trim();
const toCategoryKey = (value) => normalizeText(value).replace(/\s*>\s*/g, "::");
const toCategoryLabel = (value) => normalizeText(value).replaceAll("::", " > ");

function parseCategories(value) {
  const text = normalizeText(value);
  return text ? text.split(/\s*\|\s*/).filter(Boolean).map(toCategoryKey) : [];
}

function findHeaderBody(text, firstHeader, secondHeader) {
  const lines = text.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*"?${firstHeader}"?\\s*,\\s*"?${secondHeader}"?\\s*,`);
  const headerIndex = lines.findIndex((line) => pattern.test(line));
  if (headerIndex < 0) throw new Error(`${firstHeader}, ${secondHeader} 헤더 행을 찾을 수 없음`);
  return lines.slice(headerIndex).join("\n");
}

function parseWithRequiredHeaders(text, requiredHeaders) {
  let headers = [];
  const records = parse(findHeaderBody(text, requiredHeaders[0], requiredHeaders[1]), {
    bom: true,
    columns(sourceHeaders) {
      headers = sourceHeaders.map(normalizeText);
      return headers;
    },
    skip_empty_lines: true,
  });
  if (new Set(headers).size !== headers.length) throw new Error("CSV 열 이름 중복");
  for (const header of requiredHeaders) {
    if (!headers.includes(header)) throw new Error(`CSV 필수 열 누락: ${header}`);
  }
  if (records.length === 0) throw new Error("CSV 데이터가 비어 있음");
  return records;
}

function validateIdentity(row, rowNumber, seen) {
  const externalId = normalizeText(row["성분 ID"]);
  const name = normalizeText(row["성분명"]);
  if (!externalId) throw new Error(`CSV ${rowNumber}행 성분 ID 누락`);
  if (!name) throw new Error(`CSV ${rowNumber}행 성분명 누락`);
  if (seen.has(externalId)) throw new Error(`CSV 성분 ID 중복: ${externalId}`);
  seen.add(externalId);
  return { externalId, name };
}

/**
 * 기획 검수 CSV에서 확정 분류만 추출
 * 비교에 쓰이지 않는 추가 열은 무시
 * @param text 기획 검수 CSV 문자열
 * @param options.onExcluded 확정값이 없는 제외 행 알림 함수
 * @return 확정 분류 배열
 */
export function buildFinalClassifications(text, { onExcluded = null } = {}) {
  const records = parseWithRequiredHeaders(text, REVIEW_SOURCE_HEADERS);
  const seen = new Set();
  return records.flatMap((row, index) => {
    const identity = validateIdentity(row, index + 2, seen);
    const currentCategoryKeys = parseCategories(row["현재 운영 분류"]);
    const modelPrimaryCategoryKey = toCategoryKey(row["LLM 대표 분류"]);
    const modelAdditionalCategoryKeys = parseCategories(row["LLM 추가 분류"]);
    const plannerResult = normalizeText(row["기획 검수 결과"]);
    let primaryCategoryKey;
    let additionalCategoryKeys;
    let decisionSource;

    if (!plannerResult) {
      if (!modelPrimaryCategoryKey) {
        onExcluded?.({ ...identity, reason: "확정 대표 분류 없음" });
        return [];
      }
      primaryCategoryKey = modelPrimaryCategoryKey;
      additionalCategoryKeys = modelAdditionalCategoryKeys;
      decisionSource = "기획 판정 없음 · LLM 자동 수용";
    } else if (plannerResult === "LLM 분류 수용") {
      primaryCategoryKey = modelPrimaryCategoryKey;
      additionalCategoryKeys = modelAdditionalCategoryKeys;
      decisionSource = plannerResult;
    } else if (plannerResult === "기존 운영 분류 수용") {
      [primaryCategoryKey = "", ...additionalCategoryKeys] = currentCategoryKeys;
      decisionSource = plannerResult;
    } else if (plannerResult === "신규 값으로 분류") {
      primaryCategoryKey = toCategoryKey(row["확정 대표 분류"]);
      additionalCategoryKeys = [];
      decisionSource = plannerResult;
    } else {
      throw new Error(`지원하지 않는 기획 검수 결과: ${plannerResult}`);
    }

    if (!primaryCategoryKey) throw new Error(`성분 ID ${identity.externalId}의 확정 대표 분류 누락`);
    return [{
      ...identity,
      primaryCategoryKey,
      additionalCategoryKeys,
      decisionSource,
      comment: normalizeText(row["검수 의견"]),
    }];
  });
}

function csvValue(value) {
  const text = Array.isArray(value) ? value.map(toCategoryLabel).join(" | ") : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * 확정 분류 배열을 단순 CSV로 직렬화
 */
export function formatFinalClassifications(items) {
  const rows = [
    FINAL_CLASSIFICATION_HEADERS,
    ...items.map((item) => [
      item.externalId,
      item.name,
      toCategoryLabel(item.primaryCategoryKey),
      item.additionalCategoryKeys,
      item.decisionSource,
      item.comment,
    ]),
  ];
  return `${rows.map((row) => row.map(csvValue).join(",")).join("\n")}\n`;
}

/**
 * 확정값 전용 CSV 파싱
 * 이후 애플리케이션은 비교용 원본이 아닌 이 계약만 사용
 */
export function parseFinalClassifications(text) {
  const records = parseWithRequiredHeaders(text, FINAL_CLASSIFICATION_HEADERS);
  const seen = new Set();
  return records.map((row, index) => {
    const identity = validateIdentity(row, index + 2, seen);
    const primaryCategoryKey = toCategoryKey(row["확정 대표 분류"]);
    if (!primaryCategoryKey) throw new Error(`CSV ${index + 2}행 확정 대표 분류 누락`);
    return {
      ...identity,
      primaryCategoryKey,
      additionalCategoryKeys: parseCategories(row["확정 추가 분류"]),
      decisionSource: normalizeText(row["확정 근거"]),
      comment: normalizeText(row["검수 의견"]),
    };
  });
}

/**
 * 확정 분류의 카탈로그 계약 검증
 * @param items 확정 분류 배열
 * @param catalog 정규화된 카탈로그
 */
export function validateFinalClassifications(items, catalog) {
  const allowed = new Set(catalog.map((row) => row.key));
  for (const item of items) {
    if (!item.decisionSource) {
      throw new Error(`성분 ID ${item.externalId}의 확정 근거 누락`);
    }
    if (!allowed.has(item.primaryCategoryKey)) {
      throw new Error(`성분 ID ${item.externalId}의 확정 대표 분류가 카탈로그에 없음`);
    }
    if (item.additionalCategoryKeys.some((key) => !allowed.has(key))) {
      throw new Error(`성분 ID ${item.externalId}의 확정 추가 분류가 카탈로그에 없음`);
    }
    if (new Set(item.additionalCategoryKeys).size !== item.additionalCategoryKeys.length) {
      throw new Error(`성분 ID ${item.externalId}의 확정 추가 분류 중복`);
    }
    if (item.additionalCategoryKeys.includes(item.primaryCategoryKey)) {
      throw new Error(`성분 ID ${item.externalId}의 대표·추가 분류 중복`);
    }
  }
  return items;
}
