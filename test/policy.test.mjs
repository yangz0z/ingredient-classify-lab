// 카테고리 정책 데이터 검증 — 대표 우선순위와 허용 additional 관계 계약
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyAutoApplyGate,
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

  assert.equal(typeof policy.version, "number");
  assert.ok(policy.primaryRules.length > 0);
  // autoApplyPolicy는 선택 항목 — 없으면 제외 목록이 비어 게이팅이 동작하지 않는다
  assert.ok(Array.isArray(policy.autoApplyPolicy.excludedPrimaryCategoryKeys));
});

// 자동 반영 게이팅 — 측정된 판정 정확도가 낮은 대표 카테고리는 사람 검수로 회수한다
const gatedPolicy = {
  version: 2,
  primaryRules: ["사용 목적을 우선한다."],
  additionalPolicy: { unlistedRelation: "review", relations: [] },
  reviewRules: ["근거가 부족하면 검수로 둔다."],
  autoApplyPolicy: {
    basis: "정답 69건 자동 판정 정확도 70% 미만",
    excludedPrimaryCategoryKeys: ["첨가물::향료"],
  },
};

test("자동 반영 제외 카테고리는 검수로 강등하고 사유를 남김", () => {
  const policy = normalizePolicySpec(gatedPolicy, catalog);
  const classification = {
    name: "쌀 향",
    primary_category_key: "첨가물::향료",
    additional_category_keys: [],
    needs_review: false,
    review_reason_codes: [],
    reason: "향 목적",
  };

  const gated = applyAutoApplyGate(classification, policy);

  assert.equal(gated.classification.needs_review, true);
  assert.deepEqual(gated.classification.review_reason_codes, ["other_uncertainty"]);
  assert.equal(gated.adjustments.length, 1);
  assert.match(gated.adjustments[0], /자동 반영 제외/);
  // 원본은 변경하지 않는다
  assert.equal(classification.needs_review, false);
  // 분류값 자체는 검수 후보로 보존한다
  assert.equal(gated.classification.primary_category_key, "첨가물::향료");
});

test("제외 목록에 없는 대표 카테고리와 이미 검수 대상인 결과는 그대로 유지", () => {
  const policy = normalizePolicySpec(gatedPolicy, catalog);
  const passing = {
    name: "백미",
    primary_category_key: "곡물::쌀",
    additional_category_keys: [],
    needs_review: false,
    review_reason_codes: [],
    reason: "쌀",
  };
  assert.equal(applyAutoApplyGate(passing, policy).classification, passing);
  assert.deepEqual(applyAutoApplyGate(passing, policy).adjustments, []);

  const reviewing = {
    name: "쌀 향",
    primary_category_key: "첨가물::향료",
    additional_category_keys: [],
    needs_review: true,
    review_reason_codes: ["unknown_identity"],
    reason: "정체 불명",
  };
  assert.equal(applyAutoApplyGate(reviewing, policy).classification, reviewing);
});

test("자동 반영 제외 목록은 카탈로그에 있는 키만 허용하고 정책에 없어도 로드", () => {
  assert.throws(
    () => normalizePolicySpec({
      ...gatedPolicy,
      autoApplyPolicy: { basis: "근거", excludedPrimaryCategoryKeys: ["없음::카테고리"] },
    }, catalog),
    /자동 반영 제외 카테고리가 카탈로그에 없음/,
  );

  const withoutGate = normalizePolicySpec({
    version: 1,
    primaryRules: ["사용 목적을 우선한다."],
    additionalPolicy: { unlistedRelation: "review", relations: [] },
    reviewRules: ["근거가 부족하면 검수로 둔다."],
  }, catalog);
  assert.deepEqual(withoutGate.autoApplyPolicy.excludedPrimaryCategoryKeys, []);
});

// 정책 계층 없이도 동작해야 한다 — 규칙을 프롬프트에 합치고 관계 화이트리스트를 뺀 구성 비교용
test("정책이 없으면 프롬프트에 정책 절을 붙이지 않음", async () => {
  const { buildSystemPrompt } = await import("../src/lib/llm.mjs");
  const promptSpec = { version: 1, instructions: ["분류자다."] };

  const withPolicy = buildSystemPrompt(promptSpec, catalog, normalizePolicySpec(gatedPolicy, catalog));
  const without = buildSystemPrompt(promptSpec, catalog, null);

  assert.ok(withPolicy.includes("카테고리 정책 버전"));
  assert.ok(!without.includes("카테고리 정책 버전"));
  assert.ok(without.includes("허용 카테고리"));
});

test("정책이 없으면 추가 분류 조합을 계약 위반으로 보지 않음", async () => {
  const { checkClassification } = await import("../src/lib/contract.mjs");
  const classification = {
    name: "닭고기 향",
    primary_category_key: "첨가물::향료",
    additional_category_keys: ["육류::닭고기"],
    needs_review: false,
    review_reason_codes: [],
    reason: "향료에 닭고기가 함께 표기됨",
  };

  const checked = checkClassification(classification, catalog, { name: "닭고기 향" }, null);

  assert.equal(checked.ok, true);
  assert.deepEqual(checked.adjustments, []);
});

test("정책이 없으면 실행 버전에 프롬프트 버전만 기록", () => {
  assert.equal(policyPromptVersion({ version: 6 }, null), "6");
});
