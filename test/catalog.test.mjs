// 카탈로그·프롬프트 명세 로더 테스트 — 예시 설정과 합성 fixture만 사용
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadCatalog,
  loadPromptSpec,
  normalizeCatalog,
  normalizePromptSpec,
} from "../src/lib/catalog.mjs";

const examplePath = (name) => fileURLToPath(new URL(`../config/${name}`, import.meta.url));

test("예시 카탈로그는 major::minor 고유 키를 부여받음", async () => {
  const catalog = await loadCatalog(examplePath("catalog.example.json"));

  assert.equal(catalog.length, 10);
  for (const row of catalog) {
    assert.equal(row.key, `${row.major}::${row.minor}`);
  }
  assert.equal(new Set(catalog.map((row) => row.key)).size, catalog.length);
});

test("카탈로그 키 중복 거부", () => {
  assert.throws(
    () => normalizeCatalog([
      { major: "곡물", minor: "쌀", description: "쌀" },
      { major: "곡물", minor: "쌀", description: "중복 항목" },
    ]),
    /카탈로그 키 중복: 곡물::쌀/,
  );
});

test("필수 필드 누락 카탈로그 거부", () => {
  assert.throws(
    () => normalizeCatalog([{ major: "곡물", description: "minor 누락" }]),
    /카탈로그 구조 오류/,
  );
  assert.throws(() => normalizeCatalog([]), /카탈로그 구조 오류/);
  assert.throws(() => normalizeCatalog({}), /카탈로그 구조 오류/);
});

test("예약 구분자 포함 카탈로그 거부", () => {
  assert.throws(
    () => normalizeCatalog([{ major: "곡물::통", minor: "쌀", description: "구분자 포함" }]),
    /예약 구분자/,
  );
});

test("명시 key와 파생 key 불일치 거부", () => {
  assert.throws(
    () => normalizeCatalog([{ key: "잘못된키", major: "곡물", minor: "쌀", description: "키 불일치" }]),
    /카탈로그 키 불일치/,
  );
});

test("예시 프롬프트 명세 로드와 구조 오류 거부", async () => {
  const promptSpec = await loadPromptSpec(examplePath("prompt.example.json"));

  assert.equal(promptSpec.version, 1);
  assert.ok(promptSpec.instructions.length > 0);

  assert.throws(() => normalizePromptSpec({}), /프롬프트 명세 구조 오류/);
  assert.throws(
    () => normalizePromptSpec({ version: 1, instructions: [] }),
    /프롬프트 명세 구조 오류/,
  );
});

test("존재하지 않는 설정 파일은 읽기 실패로 보고", async () => {
  await assert.rejects(loadCatalog("/nonexistent/catalog.json"), /카탈로그 파일 읽기 실패/);
});
