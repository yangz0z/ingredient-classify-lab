// 확정 분류 CSV 테스트 — 기획 판정 변환과 단순 계약 왕복 검증
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFinalClassifications,
  formatFinalClassifications,
  parseFinalClassifications,
  validateFinalClassifications,
} from "../src/lib/final-classifications.mjs";

const headers = [
  "성분 ID",
  "성분명",
  "현재 운영 분류",
  "LLM 대표 분류",
  "LLM 추가 분류",
  "기획 검수 결과",
  "확정 대표 분류",
  "검수 의견",
];
const csvValue = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const row = (values) => values.map(csvValue).join(",");

function sourceCsv(records, preamble = true) {
  const prefix = preamble ? "검수 필요 건,,안내\n,,안내\n,,,,\n" : "";
  return `${prefix}${row(headers)}\n${records.map((record) => row(headers.map((header) => record[header]))).join("\n")}\n`;
}

test("운영·LLM 일치 건은 빈 기획 판정을 자동 수용", () => {
  const [result] = buildFinalClassifications(sourceCsv([{
    "성분 ID": "1",
    "성분명": "합성 원료",
    "현재 운영 분류": "성분 > 식이섬유",
    "LLM 대표 분류": "성분 > 식이섬유",
  }]));

  assert.equal(result.primaryCategoryKey, "성분::식이섬유");
  assert.equal(result.decisionSource, "기획 판정 없음 · LLM 자동 수용");
});

test("LLM·운영·신규 판정 규칙으로 확정값 선택", () => {
  const results = buildFinalClassifications(sourceCsv([
    {
      "성분 ID": "1",
      "성분명": "LLM 수용",
      "현재 운영 분류": "원료 > 생선",
      "LLM 대표 분류": "원료 > 어류",
      "LLM 추가 분류": "성분 > 오메가",
      "기획 검수 결과": "LLM 분류 수용",
    },
    {
      "성분 ID": "2",
      "성분명": "운영 수용",
      "현재 운영 분류": "성분 > 루테인 | 원료 > 채소",
      "LLM 대표 분류": "성분 > 식물추출물",
      "기획 검수 결과": "기존 운영 분류 수용",
    },
    {
      "성분 ID": "3",
      "성분명": "신규 분류",
      "현재 운영 분류": "",
      "LLM 대표 분류": "",
      "기획 검수 결과": "신규 값으로 분류",
      "확정 대표 분류": "기타 > 첨가제",
    },
  ], false));

  assert.deepEqual(results.map((result) => ({
    primary: result.primaryCategoryKey,
    additional: result.additionalCategoryKeys,
  })), [
    { primary: "원료::어류", additional: ["성분::오메가"] },
    { primary: "성분::루테인", additional: ["원료::채소"] },
    { primary: "기타::첨가제", additional: [] },
  ]);
});

test("빈 기획 판정은 LLM 대표·추가 분류를 자동 수용", () => {
  const [result] = buildFinalClassifications(sourceCsv([{
    "성분 ID": "1",
    "성분명": "불일치",
    "현재 운영 분류": "원료 > 생선",
    "LLM 대표 분류": "원료 > 어류",
    "LLM 추가 분류": "성분 > 오메가",
  }]));
  assert.equal(result.primaryCategoryKey, "원료::어류");
  assert.deepEqual(result.additionalCategoryKeys, ["성분::오메가"]);
});

test("운영·LLM·기획 확정값이 모두 없는 행은 제외", () => {
  const excluded = [];
  const results = buildFinalClassifications(sourceCsv([{
    "성분 ID": "1",
    "성분명": "분류 정보 없는 설명문",
    "현재 운영 분류": "",
    "LLM 대표 분류": "",
    "기획 검수 결과": "",
    "확정 대표 분류": "",
  }]), { onExcluded: (item) => excluded.push(item) });
  assert.deepEqual(results, []);
  assert.deepEqual(excluded, [{
    externalId: "1",
    name: "분류 정보 없는 설명문",
    reason: "확정 대표 분류 없음",
  }]);
});

test("확정값 CSV 직렬화 후 같은 값으로 다시 파싱", () => {
  const items = [{
    externalId: "1",
    name: "쉼표, 따옴표 \" 포함",
    primaryCategoryKey: "원료::어류",
    additionalCategoryKeys: ["성분::오메가"],
    decisionSource: "LLM 분류 수용",
    comment: "여러 줄\n의견",
  }];

  assert.deepEqual(parseFinalClassifications(formatFinalClassifications(items)), items);
});

test("확정 대표·추가 분류가 카탈로그 안에 있는지 검증", () => {
  const catalog = [
    { key: "원료::어류" },
    { key: "성분::오메가" },
  ];
  const valid = [{
    externalId: "1",
    primaryCategoryKey: "원료::어류",
    additionalCategoryKeys: ["성분::오메가"],
    decisionSource: "LLM 분류 수용",
  }];
  assert.equal(validateFinalClassifications(valid, catalog), valid);
  assert.throws(
    () => validateFinalClassifications([{ ...valid[0], primaryCategoryKey: "없는::분류" }], catalog),
    /확정 대표 분류가 카탈로그에 없음/,
  );
  assert.throws(
    () => validateFinalClassifications([{ ...valid[0], additionalCategoryKeys: ["원료::어류"] }], catalog),
    /대표·추가 분류 중복/,
  );
  assert.throws(
    () => validateFinalClassifications([{ ...valid[0], decisionSource: "" }], catalog),
    /확정 근거 누락/,
  );
});
