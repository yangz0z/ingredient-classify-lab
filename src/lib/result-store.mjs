// SQLite 결과 저장소 — 배치 실행 메타데이터와 개별 판정 영속
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

function parseJson(value) {
  return value === null ? null : JSON.parse(value);
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    model: row.model,
    dryRun: Boolean(row.dry_run),
    promptVersion: row.prompt_version,
    catalogCount: row.catalog_count,
    inputCount: row.input_count,
    repetitions: row.repetitions,
    concurrency: row.concurrency,
    successCount: row.success_count,
    contractViolationCount: row.contract_violation_count,
    errorCount: row.error_count,
    consistency: parseJson(row.consistency_json),
  };
}

function mapResult(row) {
  return {
    id: row.id,
    runId: row.run_id,
    itemId: row.item_id,
    itemName: row.item_name,
    repetition: row.repetition,
    status: row.status,
    classification: parseJson(row.classification_json),
    contractViolations: parseJson(row.contract_violations_json),
    model: row.model,
    responseId: row.response_id,
    usage: parseJson(row.usage_json),
    attemptCount: row.attempt_count,
    elapsedMs: row.elapsed_ms,
    error: row.error,
  };
}

/**
 * SQLite 결과 저장소 생성과 스키마 초기화
 * @param databasePath SQLite 파일 경로
 * @return 저장소 인터페이스
 */
export function createResultStore(databasePath) {
  const resolvedPath = path.resolve(databasePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const database = new Database(resolvedPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS batch_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      model TEXT,
      dry_run INTEGER NOT NULL,
      prompt_version TEXT NOT NULL,
      catalog_count INTEGER NOT NULL,
      input_count INTEGER NOT NULL,
      repetitions INTEGER NOT NULL,
      concurrency INTEGER NOT NULL,
      success_count INTEGER,
      contract_violation_count INTEGER,
      error_count INTEGER,
      consistency_json TEXT
    );

    CREATE TABLE IF NOT EXISTS classification_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES batch_runs(id),
      item_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      repetition INTEGER NOT NULL,
      status TEXT NOT NULL,
      classification_json TEXT,
      contract_violations_json TEXT NOT NULL,
      model TEXT,
      response_id TEXT,
      usage_json TEXT,
      attempt_count INTEGER,
      elapsed_ms INTEGER NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, item_id, repetition)
    );

    CREATE INDEX IF NOT EXISTS idx_classification_results_run_status
      ON classification_results(run_id, status);
  `);

  const insertRun = database.prepare(`
    INSERT INTO batch_runs (
      id, started_at, status, model, dry_run, prompt_version,
      catalog_count, input_count, repetitions, concurrency
    ) VALUES (
      @id, @startedAt, 'running', @model, @dryRun, @promptVersion,
      @catalogCount, @inputCount, @repetitions, @concurrency
    )
  `);
  const insertResult = database.prepare(`
    INSERT INTO classification_results (
      run_id, item_id, item_name, repetition, status, classification_json,
      contract_violations_json, model, response_id, usage_json,
      attempt_count, elapsed_ms, error
    ) VALUES (
      @runId, @itemId, @itemName, @repetition, @status, @classificationJson,
      @contractViolationsJson, @model, @responseId, @usageJson,
      @attemptCount, @elapsedMs, @error
    )
  `);
  const updateRun = database.prepare(`
    UPDATE batch_runs SET
      completed_at = @completedAt,
      status = @status,
      success_count = @successCount,
      contract_violation_count = @contractViolationCount,
      error_count = @errorCount,
      consistency_json = @consistencyJson
    WHERE id = @runId
  `);
  const selectRun = database.prepare("SELECT * FROM batch_runs WHERE id = ?");
  const selectResults = database.prepare(`
    SELECT * FROM classification_results
    WHERE run_id = ?
    ORDER BY item_id, repetition
  `);

  return {
    path: resolvedPath,
    createRun(run) {
      insertRun.run({ ...run, dryRun: run.dryRun ? 1 : 0 });
    },
    saveResult(result) {
      insertResult.run({
        ...result,
        classificationJson: result.classification === null
          ? null
          : JSON.stringify(result.classification),
        contractViolationsJson: JSON.stringify(result.contractViolations),
        usageJson: result.usage === null ? null : JSON.stringify(result.usage),
      });
    },
    completeRun(runId, completion) {
      updateRun.run({
        runId,
        ...completion,
        contractViolationCount: completion.contractViolationCount ?? 0,
        consistencyJson: JSON.stringify(completion.consistency),
      });
    },
    getRun(runId) {
      return mapRun(selectRun.get(runId));
    },
    listResults(runId) {
      return selectResults.all(runId).map(mapResult);
    },
    close() {
      database.close();
    },
  };
}
