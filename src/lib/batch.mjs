// 배치 실행 계층 — 제한 동시성, 결과 격리, 반복 일관성 집계
import { randomUUID } from "node:crypto";

import { checkClassification } from "./contract.mjs";
import { sanitizeError } from "./llm.mjs";

/**
 * 분류 결과의 의미 있는 필드로 반복 비교용 서명 생성
 * 판정 사유와 additional 순서는 일관성 비교에서 제외
 * @param classification 분류 결과
 * @return 직렬화된 비교 서명
 */
export function classificationSignature(classification) {
  return JSON.stringify({
    primaryCategoryKey: classification.primary_category_key,
    additionalCategoryKeys: [...classification.additional_category_keys].sort(),
    needsReview: classification.needs_review,
  });
}

function summarizeConsistency(results, items, repetitions) {
  if (repetitions < 2) {
    return {
      comparableItemCount: 0,
      consistentItemCount: 0,
      rate: null,
      inconsistentItemIds: [],
    };
  }

  const successfulByItem = new Map(items.map((item) => [item.id, []]));
  for (const result of results) {
    if (result.status === "success") successfulByItem.get(result.itemId)?.push(result);
  }

  const comparable = [];
  const inconsistentItemIds = [];
  for (const item of items) {
    const successful = successfulByItem.get(item.id) ?? [];
    if (successful.length !== repetitions) continue;
    comparable.push(item.id);
    const signatures = new Set(successful.map((row) => classificationSignature(row.classification)));
    if (signatures.size > 1) inconsistentItemIds.push(item.id);
  }

  const consistentItemCount = comparable.length - inconsistentItemIds.length;
  return {
    comparableItemCount: comparable.length,
    consistentItemCount,
    rate: comparable.length === 0 ? null : consistentItemCount / comparable.length,
    inconsistentItemIds,
  };
}

/**
 * 분류 배치 실행
 * 각 항목 오류는 다른 항목 실행을 중단하지 않고 개별 결과로 저장
 * @param options.items 정규화된 { id, name } 배열
 * @param options.repetitions 항목별 반복 횟수
 * @param options.concurrency 최대 동시 실행 수
 * @param options.classifier 분류기
 * @param options.catalog 카탈로그
 * @param options.promptVersion 프롬프트 버전
 * @param options.store 결과 저장소
 * @return 실행 요약
 */
export async function runBatch({
  items,
  repetitions,
  concurrency,
  classifier,
  catalog,
  promptVersion,
  store,
  runId = randomUUID(),
  onResult = null,
}) {
  const startedAt = new Date().toISOString();
  store.createRun({
    id: runId,
    startedAt,
    model: classifier.model,
    dryRun: classifier.dryRun,
    promptVersion: String(promptVersion),
    catalogCount: catalog.length,
    inputCount: items.length,
    repetitions,
    concurrency,
  });

  const tasks = items.flatMap((item) => Array.from(
    { length: repetitions },
    (_, index) => ({ item, repetition: index + 1 }),
  ));
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex];
      nextIndex += 1;
      const resultStartedAt = Date.now();
      let row;
      try {
        const response = await classifier.classify(task.item.name);
        const checked = checkClassification(
          response.classification,
          catalog,
          { name: task.item.name },
        );
        row = {
          runId,
          itemId: task.item.id,
          itemName: task.item.name,
          repetition: task.repetition,
          status: checked.ok ? "success" : "contract_violation",
          classification: checked.classification,
          contractViolations: checked.violations,
          model: response.model ?? null,
          responseId: response.responseId ?? null,
          usage: response.usage ?? null,
          attemptCount: response.attemptCount ?? null,
          elapsedMs: Date.now() - resultStartedAt,
          error: null,
        };
      } catch (error) {
        row = {
          runId,
          itemId: task.item.id,
          itemName: task.item.name,
          repetition: task.repetition,
          status: "error",
          classification: null,
          contractViolations: [],
          model: classifier.model,
          responseId: null,
          usage: null,
          attemptCount: error?.attemptCount ?? null,
          elapsedMs: Date.now() - resultStartedAt,
          error: sanitizeError(error),
        };
      }
      results.push(row);
      store.saveResult(row);
      onResult?.(row, results.length, tasks.length);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  ));

  const successCount = results.filter((row) => row.status === "success").length;
  const contractViolationCount = results.filter((row) => row.status === "contract_violation").length;
  const errorCount = results.filter((row) => row.status === "error").length;
  const consistency = summarizeConsistency(results, items, repetitions);
  const status = errorCount > 0 || contractViolationCount > 0
    ? "completed_with_errors"
    : "completed";
  const completion = {
    completedAt: new Date().toISOString(),
    status,
    successCount,
    contractViolationCount,
    errorCount,
    consistency,
  };
  store.completeRun(runId, completion);

  return {
    runId,
    status,
    inputCount: items.length,
    repetitions,
    totalExecutions: tasks.length,
    successCount,
    contractViolationCount,
    errorCount,
    consistency,
  };
}
