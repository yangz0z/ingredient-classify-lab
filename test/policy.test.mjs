// 카테고리 정책 데이터 검증 — 대표 우선순위와 허용 additional 관계 계약
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatPolicyInstructions,
  loadPolicySpec,
  normalizeClassificationByPolicy,
  normalizePolicySpec,
  policyPromptVersion,
} from "../src/lib/policy.mjs";
import { loadCatalog } from "../src/lib/catalog.mjs";

const examplePath = (name) => fileURLToPath(new URL(`../config/${name}`, import.meta.url));

const catalog = [
  { key: "첨가물::향료", major: "첨가물", minor: "향료", description: "향료" },
  { key: "육류::닭고기", major: "육류", minor: "닭고기", description: "닭고기" },
  { key: "기능성::유산균", major: "기능성", minor: "유산균", description: "유산균" },
];

const rawPolicy = {
  version: 1,
  primaryRules: [
    "명시된 사용 목적이 재료 출처보다 대표 분류에 우선한다.",
  ],
  additionalPolicy: {
    unlistedRelation: "review",
    relations: [
      {
        primaryCategoryKey: "첨가물::향료",
        additionalCategoryKey: "육류::닭고기",
        condition: "두 카테고리가 독립된 근거로 직접 확인되는 경우",
        evidenceCount: 3,
      },
    ],
  },
  reviewRules: [
    "대표 후보의 우선순위를 정책으로 결정할 수 없으면 검수 대상으로 둔다.",
  ],
};

test("정책 데이터는 카테고리 관계를 검증하고 공백을 정규화", () => {
  const policy = normalizePolicySpec(rawPolicy, catalog);

  assert.equal(policy.version, 1);
  assert.equal(policy.additionalPolicy.relations.length, 1);
  assert.equal(policy.additionalPolicy.relations[0].primaryCategoryKey, "첨가물::향료");
  assert.equal(policy.additionalPolicy.relations[0].evidenceCount, 3);
});

test("정책 데이터는 존재하지 않는 카테고리와 중복·역방향 관계를 거부", () => {
  assert.throws(
    () => normalizePolicySpec({
      ...rawPolicy,
      additionalPolicy: {
        ...rawPolicy.additionalPolicy,
        relations: [{
          primaryCategoryKey: "없는::분류",
          additionalCategoryKey: "육류::닭고기",
          condition: "잘못된 관계",
        }],
      },
    }, catalog),
    /카탈로그에 없음/,
  );

  const relation = rawPolicy.additionalPolicy.relations[0];
  assert.throws(
    () => normalizePolicySpec({
      ...rawPolicy,
      additionalPolicy: {
        ...rawPolicy.additionalPolicy,
        relations: [relation, { ...relation }],
      },
    }, catalog),
    /관계 중복/,
  );

  assert.throws(
    () => normalizePolicySpec({
      ...rawPolicy,
      additionalPolicy: {
        ...rawPolicy.additionalPolicy,
        relations: [
          relation,
          {
            primaryCategoryKey: relation.additionalCategoryKey,
            additionalCategoryKey: relation.primaryCategoryKey,
            condition: "역방향 관계",
          },
        ],
      },
    }, catalog),
    /대표 우선순위 충돌/,
  );
});

test("정책 지시문은 특정 재료명 없이 대표·추가·검수 규칙을 조립", () => {
  const policy = normalizePolicySpec(rawPolicy, catalog);
  const text = formatPolicyInstructions(policy);

  assert.match(text, /카테고리 정책 버전: 1/);
  assert.match(text, /첨가물::향료 -> 육류::닭고기/);
  assert.match(text, /목록에 없는 primary-additional 관계/);
  assert.doesNotMatch(text, /확정 정답 3건|evidenceCount/);
  assert.doesNotMatch(text, /세라자임|글리세린|상어연골/);
});

test("실행 버전은 프롬프트와 정책 버전을 함께 기록", () => {
  assert.equal(policyPromptVersion({ version: 4.1 }, { version: 1 }), "4.1+policy:1");
});

test("정책 우선순위와 반대로 반환된 대표·추가 분류를 정규화", () => {
  const classification = {
    name: "닭고기 향",
    primary_category_key: "육류::닭고기",
    additional_category_keys: ["첨가물::향료"],
    needs_review: false,
    reason: "두 카테고리 확인",
  };

  const normalized = normalizeClassificationByPolicy(classification, rawPolicy);

  assert.deepEqual(normalized.classification, {
    ...classification,
    primary_category_key: "첨가물::향료",
    additional_category_keys: ["육류::닭고기"],
  });
  assert.deepEqual(normalized.adjustments, [
    "정책 우선순위에 따라 대표 분류 변경: 육류::닭고기 → 첨가물::향료",
  ]);
  assert.equal(classification.primary_category_key, "육류::닭고기");
});

test("정책 정규화로 우선순위 불확실성만 해소되면 자동 분류로 전환", () => {
  const classification = {
    name: "닭고기 향",
    primary_category_key: "육류::닭고기",
    additional_category_keys: ["첨가물::향료"],
    needs_review: true,
    review_reason_codes: ["ambiguous_primary", "unsupported_policy_relation"],
    reason: "대표 우선순위 확인 필요",
  };

  const normalized = normalizeClassificationByPolicy(classification, rawPolicy);

  assert.equal(normalized.classification.needs_review, false);
  assert.deepEqual(normalized.classification.review_reason_codes, []);
  assert.equal(normalized.adjustments.length, 2);
  assert.match(normalized.adjustments[1], /검수 사유 해소/);
});

test("구성 성분 불확실성은 대표 순서를 정규화해도 유지", () => {
  const classification = {
    name: "닭고기 향",
    primary_category_key: "육류::닭고기",
    additional_category_keys: ["첨가물::향료"],
    needs_review: true,
    review_reason_codes: ["ambiguous_component"],
    reason: "독립 구성 성분 확인 필요",
  };

  const normalized = normalizeClassificationByPolicy(classification, rawPolicy);

  assert.equal(normalized.classification.needs_review, true);
  assert.deepEqual(normalized.classification.review_reason_codes, ["ambiguous_component"]);
});

test("중복된 검수 사유 코드는 정책 정규화로 숨기지 않음", () => {
  const classification = {
    name: "닭고기 향",
    primary_category_key: "육류::닭고기",
    additional_category_keys: ["첨가물::향료"],
    needs_review: true,
    review_reason_codes: ["ambiguous_primary", "ambiguous_primary"],
    reason: "잘못된 중복 코드",
  };

  const normalized = normalizeClassificationByPolicy(classification, rawPolicy);

  assert.equal(normalized.classification.needs_review, true);
  assert.deepEqual(normalized.classification.review_reason_codes, [
    "ambiguous_primary",
    "ambiguous_primary",
  ]);
});

test("전체 카테고리 관계를 설명할 대표 분류가 없으면 정규화하지 않음", () => {
  const classification = {
    name: "쌀 향",
    primary_category_key: "육류::닭고기",
    additional_category_keys: ["첨가물::향료", "기능성::유산균"],
    needs_review: false,
    reason: "관계 불명확",
  };

  const normalized = normalizeClassificationByPolicy(classification, rawPolicy);

  assert.equal(normalized.classification, classification);
  assert.deepEqual(normalized.adjustments, []);
});

test("공개 예시 정책은 예시 카탈로그와 함께 로드", async () => {
  const exampleCatalog = await loadCatalog(examplePath("catalog.example.json"));
  const policy = await loadPolicySpec(examplePath("policy.example.json"), exampleCatalog);

  assert.equal(policy.version, 1);
  assert.ok(policy.primaryRules.length > 0);
});
