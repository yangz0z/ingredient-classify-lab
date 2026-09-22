// 라우트 통합 테스트 — 예시 설정으로 dry-run 서버를 띄워 검증
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildApp } from "../src/server.mjs";

const env = {
  CATALOG_PATH: fileURLToPath(new URL("../config/catalog.example.json", import.meta.url)),
  PROMPT_PATH: fileURLToPath(new URL("../config/prompt.example.json", import.meta.url)),
};

let server;
let base;

test.before(async () => {
  const { app, meta } = await buildApp(env);
  assert.equal(meta.dryRun, true);
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
});

test("GET /healthz는 dry-run 상태와 카탈로그 크기를 보고", async () => {
  const response = await fetch(`${base}/healthz`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.dryRun, true);
  assert.equal(body.catalogCount, 10);
  assert.equal(body.promptVersion, 1);
});

test("POST /classify는 dry-run 판정과 빈 계약 위반 목록을 반환", async () => {
  const response = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "  건조 닭가슴살  " }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.input, { name: "건조 닭가슴살" });
  assert.equal(body.classification.name, "건조 닭가슴살");
  assert.equal(body.classification.needs_review, true);
  assert.deepEqual(body.contractViolations, []);
  assert.equal(body.dryRun, true);
  assert.equal(body.model, null);
  assert.equal(typeof body.elapsedMs, "number");
});

test("POST /classify는 name 누락을 400으로 거부", async () => {
  const response = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_request");
});

test("POST /classify는 공백 name과 길이 초과를 400으로 거부", async () => {
  const blank = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "   " }),
  });
  assert.equal(blank.status, 400);

  const tooLong = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "가".repeat(301) }),
  });
  assert.equal(tooLong.status, 400);
});

test("POST /classify는 JSON 파싱 실패를 구조화 응답으로 반환", async () => {
  const response = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{잘못된 JSON",
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_json");
});

test("알 수 없는 경로는 404 구조화 응답", async () => {
  const response = await fetch(`${base}/unknown`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "not_found");
});
