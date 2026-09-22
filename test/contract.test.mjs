// 분류 결과 계약 검증 테스트 — 합성 카탈로그만 사용
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClassificationSchema,
  checkClassification,
  collectContractViolations,
  validateClassification,
} from "../src/lib/contract.mjs";

const catalog = [
  { key: "곡물::쌀", major: "곡물", minor: "쌀" },
  { key: "기능성::유산균", major: "기능성", minor: "유산균" },
  { key: "첨가물::향료", major: "첨가물", minor: "향료" },
];

test("분류 스키마는 허용 카테고리와 빈 primary만 노출", () => {
  const schema = buildClassificationSchema(catalog);

  assert.deepEqual(
    schema.properties.primary_category_key.enum,
    ["", "곡물::쌀", "기능성::유산균", "첨가물::향료"],
  );
  assert.deepEqual(
    schema.properties.additional_category_keys.items.enum,
    ["곡물::쌀", "기능성::유산균", "첨가물::향료"],
  );
  assert.equal(schema.properties.reason.minLength, 1);
  assert.equal(schema.additionalProperties, false);
});

test("정상 primary와 additional 결과 허용", () => {
  const result = validateClassification(
    {
      name: "쌀과 유산균",
      primary_category_key: "곡물::쌀",
      additional_category_keys: ["기능성::유산균"],
      needs_review: false,
      reason: "쌀이 주재료이고 유산균을 추가 함유",
    },
    catalog,
    { name: "쌀과 유산균" },
  );

  assert.equal(result.primary_category_key, "곡물::쌀");
});

test("허용 목록 밖 카테고리 거부", () => {
  assert.throws(
    () => validateClassification(
      {
        name: "쌀",
        primary_category_key: "곡물::보리",
        additional_category_keys: [],
        needs_review: false,
        reason: "오분류",
      },
      catalog,
      { name: "쌀" },
    ),
    /허용되지 않은 primary/,
  );
});

test("primary와 additional 중복 거부", () => {
  assert.throws(
    () => validateClassification(
      {
        name: "쌀",
        primary_category_key: "곡물::쌀",
        additional_category_keys: ["곡물::쌀"],
        needs_review: false,
        reason: "중복",
      },
      catalog,
      { name: "쌀" },
    ),
    /primary와 additional 중복/,
  );
});

test("검수 필요 결과는 primary를 비울 수 있음", () => {
  const result = validateClassification(
    {
      name: "알 수 없는 재료",
      primary_category_key: "",
      additional_category_keys: [],
      needs_review: true,
      reason: "이름만으로 판단 불가",
    },
    catalog,
    { name: "알 수 없는 재료" },
  );

  assert.equal(result.needs_review, true);
});

test("검수 필요 결과의 유효한 후보 primary를 보존", () => {
  const result = validateClassification(
    {
      name: "모호한 첨가물",
      primary_category_key: "첨가물::향료",
      additional_category_keys: [],
      needs_review: true,
      reason: "향료 후보이나 용도 확인 필요",
    },
    catalog,
    { name: "모호한 첨가물" },
  );

  assert.equal(result.primary_category_key, "첨가물::향료");
  assert.equal(result.needs_review, true);
});

test("확정 결과는 primary가 필수", () => {
  assert.throws(
    () => validateClassification(
      {
        name: "알 수 없는 재료",
        primary_category_key: "",
        additional_category_keys: [],
        needs_review: false,
        reason: "잘못된 결과",
      },
      catalog,
      { name: "알 수 없는 재료" },
    ),
    /확정 결과의 primary 누락/,
  );
});

test("응답의 입력 이름 불일치 거부", () => {
  assert.throws(
    () => validateClassification(
      {
        name: "다른 이름",
        primary_category_key: "곡물::쌀",
        additional_category_keys: [],
        needs_review: false,
        reason: "이름 불일치",
      },
      catalog,
      { name: "쌀" },
    ),
    /입력 이름 불일치/,
  );
});

test("복수 위반을 목록으로 수집", () => {
  const violations = collectContractViolations(
    {
      name: "쌀",
      primary_category_key: "곡물::보리",
      additional_category_keys: ["곡물::쌀", "곡물::쌀"],
      needs_review: false,
      reason: "   ",
    },
    catalog,
    { name: "쌀" },
  );

  assert.ok(violations.includes("허용되지 않은 primary 카테고리"));
  assert.ok(violations.includes("additional 카테고리 중복"));
  assert.ok(violations.includes("판정 사유 누락"));
});

test("checkClassification은 위반이 있어도 결과를 보존", () => {
  const broken = {
    name: "쌀",
    primary_category_key: "곡물::보리",
    additional_category_keys: [],
    needs_review: false,
    reason: "검수용",
  };
  const checked = checkClassification(broken, catalog, { name: "쌀" });

  assert.equal(checked.ok, false);
  assert.ok(checked.violations.length > 0);
  assert.equal(checked.classification, broken);

  const objectMissing = checkClassification(null, catalog, { name: "쌀" });
  assert.equal(objectMissing.classification, null);
  assert.deepEqual(objectMissing.violations, ["분류 응답 객체 누락"]);
});
