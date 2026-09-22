// 폐쇄 어휘 설정 로더 — 카탈로그·프롬프트 명세의 구조 검증과 안정 키 부여
import { readFile } from "node:fs/promises";

import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true });

// 카탈로그 파일 구조 — 항목별 major·minor·description 필수
const catalogShape = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["major", "minor", "description"],
    properties: {
      major: { type: "string", minLength: 1 },
      minor: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
    },
    additionalProperties: true,
  },
};

// 프롬프트 명세 구조 — version과 instructions 필수
const promptShape = {
  type: "object",
  required: ["version", "instructions"],
  properties: {
    version: { type: ["number", "string"] },
    title: { type: "string" },
    instructions: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
  },
  additionalProperties: true,
};

const validateCatalogShape = ajv.compile(catalogShape);
const validatePromptShape = ajv.compile(promptShape);

function formatAjvErrors(errors) {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join(", ");
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} 파일 읽기 실패: ${filePath} (${error.code ?? error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} JSON 파싱 실패: ${filePath}`);
  }
}

/**
 * 카탈로그 구조 검증과 major::minor 안정 키 부여
 * 키 중복, 예약 구분자('::') 포함, 명시 key와 파생 key 불일치를 거부
 * @param raw 파싱된 카탈로그 배열
 * @return key가 부여된 정규화 카탈로그
 */
export function normalizeCatalog(raw) {
  if (!validateCatalogShape(raw)) {
    throw new Error(`카탈로그 구조 오류: ${formatAjvErrors(validateCatalogShape.errors)}`);
  }
  const seen = new Set();
  return raw.map((row, index) => {
    const major = row.major.trim();
    const minor = row.minor.trim();
    if (!major || !minor) {
      throw new Error(`카탈로그 ${index + 1}번 항목의 major/minor 공백`);
    }
    if (major.includes("::") || minor.includes("::")) {
      throw new Error(`카탈로그 ${index + 1}번 항목에 예약 구분자 '::' 포함`);
    }
    const key = `${major}::${minor}`;
    if (row.key !== undefined && row.key !== key) {
      throw new Error(`카탈로그 키 불일치: ${row.key} != ${key}`);
    }
    if (seen.has(key)) {
      throw new Error(`카탈로그 키 중복: ${key}`);
    }
    seen.add(key);
    return { ...row, key, major, minor, description: row.description.trim() };
  });
}

/**
 * 카탈로그 파일 로드 후 정규화
 * @param filePath 카탈로그 JSON 경로
 */
export async function loadCatalog(filePath) {
  return normalizeCatalog(await readJson(filePath, "카탈로그"));
}

/**
 * 프롬프트 명세 구조 검증
 * @param raw 파싱된 프롬프트 명세 객체
 */
export function normalizePromptSpec(raw) {
  if (!validatePromptShape(raw)) {
    throw new Error(`프롬프트 명세 구조 오류: ${formatAjvErrors(validatePromptShape.errors)}`);
  }
  return raw;
}

/**
 * 프롬프트 명세 파일 로드 후 검증
 * @param filePath 프롬프트 명세 JSON 경로
 */
export async function loadPromptSpec(filePath) {
  return normalizePromptSpec(await readJson(filePath, "프롬프트 명세"));
}
