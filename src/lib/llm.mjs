// LLM 호출 계층 — OpenAI Responses API, strict 스키마 강제, 시간 제한, 제한 재시도, dry-run
import OpenAI from "openai";

import { buildClassificationSchema } from "./contract.mjs";

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

/**
 * 프롬프트 명세와 카탈로그로 시스템 프롬프트 조립
 * @param promptSpec 프롬프트 명세 ({ instructions })
 * @param catalog 정규화된 카탈로그 배열
 * @return 시스템 프롬프트 문자열
 */
export function buildSystemPrompt(promptSpec, catalog) {
  const categories = catalog
    .map((row) => `- ${row.key}: ${row.description}`)
    .join("\n");
  return `${promptSpec.instructions.join("\n")}\n\n허용 카테고리:\n${categories}`;
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
 * 폐쇄 어휘 분류기 생성
 * dry-run 모드는 API 키 없이 동작하며 계약을 충족하는 검수 대기 결과를 반환
 * @param options.catalog 정규화된 카탈로그 배열
 * @param options.promptSpec 프롬프트 명세
 * @param options.apiKey OpenAI API 키 — 없으면 dry-run
 * @return { classify, dryRun, model, systemPrompt, schema }
 */
export function createClassifier({
  catalog,
  promptSpec,
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
  const systemPrompt = buildSystemPrompt(promptSpec, catalog);
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
