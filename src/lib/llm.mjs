// LLM 호출 계층 — OpenAI Responses API, strict 스키마 강제, 시간 제한, 제한 재시도, dry-run
import OpenAI from "openai";

import { buildClassificationSchema } from "./contract.mjs";
import { formatPolicyInstructions } from "./policy.mjs";

const RETRY_BASE_DELAY_MS = 500;

/**
 * 오류 메시지에서 API 키 형식 제거 후 길이 제한
 * @param error 오류 객체 또는 값
 * @return 마스킹된 메시지
 */
export function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:sk|nvapi)-[A-Za-z0-9_*.-]+/gi, "[REDACTED]")
    .slice(0, 1000);
}

// 같은 설명을 이 수 이상의 카테고리가 공유하면 개별 정의가 아니라 대분류 축 정의로 본다.
// 축 정의를 개별 줄마다 반복하면 카테고리를 구분하는 정보가 그만큼 묻힌다.
const AXIS_DESCRIPTION_MIN_SHARE = 3;

// 대분류에서 가장 널리 공유되는 설명을 축 정의로 선택 — 공유 수가 기준 미달이면 null
function resolveAxisDescription(rows) {
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.description, (counts.get(row.description) ?? 0) + 1);
  }
  let axisDescription = null;
  let topCount = 0;
  for (const [description, count] of counts) {
    if (count > topCount) {
      axisDescription = description;
      topCount = count;
    }
  }
  return topCount >= AXIS_DESCRIPTION_MIN_SHARE ? axisDescription : null;
}

/**
 * 카테고리 목록을 대분류별로 묶고 공통 설명은 축 정의로 한 번만 제시
 * @param catalog 정규화된 카탈로그 배열
 * @return 카테고리 목록 문자열
 */
export function formatCategoryCatalog(catalog) {
  const majors = [];
  const grouped = new Map();
  for (const row of catalog) {
    if (!grouped.has(row.major)) {
      grouped.set(row.major, []);
      majors.push(row.major);
    }
    grouped.get(row.major).push(row);
  }

  return majors.map((major) => {
    const rows = grouped.get(major);
    const axisDescription = resolveAxisDescription(rows);
    const header = axisDescription === null ? `## ${major}` : `## ${major} — ${axisDescription}`;
    const items = rows.map((row) => (row.description === axisDescription
      ? `- ${row.key}`
      : `- ${row.key}: ${row.description}`));
    return [header, ...items].join("\n");
  }).join("\n\n");
}

/**
 * 프롬프트 명세와 카탈로그로 시스템 프롬프트 조립
 * @param promptSpec 프롬프트 명세 ({ instructions })
 * @param catalog 정규화된 카탈로그 배열
 * @param policySpec 검증된 카테고리 정책 객체
 * @return 시스템 프롬프트 문자열
 */
export function buildSystemPrompt(promptSpec, catalog, policySpec = null) {
  const sections = [
    promptSpec.instructions.join("\n"),
    [
      "허용 카테고리: 대분류(##)와 그 아래 카테고리 key 목록이다.",
      "설명이 없는 카테고리는 대분류 축 정의를 따른다.",
      formatCategoryCatalog(catalog),
    ].join("\n"),
  ];
  if (policySpec) sections.push(formatPolicyInstructions(policySpec));
  return sections.join("\n\n");
}

// 재시도 대상 판정 — 시간 초과, 연결 오류, 429, 5xx만 재시도
function isRetryable(error) {
  const retryableNames = [
    "TimeoutError",
    "AbortError",
    "APIUserAbortError",
    "APIConnectionError",
    "APIConnectionTimeoutError",
  ];
  if (retryableNames.includes(error?.name)) return true;
  const status = error?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 등록된 카테고리만 반환하는 분류기 생성
 * dry-run 모드는 API 키 없이 동작하며 계약을 충족하는 검수 대기 결과를 반환
 * @param options.catalog 정규화된 카탈로그 배열
 * @param options.promptSpec 프롬프트 명세
 * @param options.policySpec 검증된 카테고리 정책 객체
 * @param options.apiKey OpenAI API 키 — 없으면 dry-run
 * @return { classify, dryRun, model, systemPrompt, schema }
 */
export function createClassifier({
  catalog,
  promptSpec,
  policySpec = null,
  apiKey = null,
  model = "gpt-5-mini",
  reasoningEffort = "minimal",
  timeoutMs = 30000,
  maxAttempts = 3,
  dryRun = !apiKey,
  client: providedClient = null,
  retryDelay = wait,
}) {
  const schema = buildClassificationSchema(catalog);
  const systemPrompt = buildSystemPrompt(promptSpec, catalog, policySpec);
  // SDK 자체 재시도는 끄고 이 계층에서 횟수를 통제
  const client = dryRun ? null : (providedClient ?? new OpenAI({ apiKey, maxRetries: 0 }));

  async function classify(name) {
    if (dryRun) {
      return {
        dryRun: true,
        model: null,
        responseId: null,
        usage: null,
        attemptCount: 0,
        classification: {
          name,
          primary_category_key: "",
          additional_category_keys: [],
          needs_review: true,
          review_reason_codes: ["missing_context"],
          reason: "dry-run 모드 — LLM 미호출, 실제 판정 아님",
        },
      };
    }

    let lastError;
    let attemptCount = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptCount = attempt;
      try {
        const response = await client.responses.create({
          model,
          reasoning: { effort: reasoningEffort },
          instructions: systemPrompt,
          input: JSON.stringify({ name }),
          text: {
            format: {
              type: "json_schema",
              name: "vocabulary_classification",
              strict: true,
              schema,
            },
          },
          max_output_tokens: 4000,
          store: false,
        }, { signal: AbortSignal.timeout(timeoutMs) });

        return {
          dryRun: false,
          model: response.model,
          responseId: response.id,
          usage: response.usage ?? null,
          attemptCount: attempt,
          classification: JSON.parse(response.output_text),
        };
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !isRetryable(error)) break;
        await retryDelay(RETRY_BASE_DELAY_MS * attempt);
      }
    }
    if (lastError && typeof lastError === "object") {
      try {
        lastError.attemptCount = attemptCount;
      } catch {
        // 수정 불가능한 SDK 오류 객체는 원본 그대로 전달
      }
    }
    throw lastError;
  }

  return {
    classify,
    dryRun,
    model: dryRun ? null : model,
    systemPrompt,
    schema,
  };
}
