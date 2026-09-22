// 서버 조립 — 설정 로드, 분류기 구성, 라우트 장착, 구조화 에러 응답
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import express from "express";

import { loadCatalog, loadPromptSpec } from "./lib/catalog.mjs";
import { createClassifier, sanitizeError } from "./lib/llm.mjs";
import { createClassifyRouter } from "./routes/classify.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 설정 파일 경로 결정
 * 명시 경로는 폴백 없이 그대로 사용하고, 기본 경로가 없으면 example로 폴백
 * @param explicitPath 환경변수로 지정한 경로
 * @param defaultRelative 기본 경로 (프로젝트 루트 기준)
 * @param exampleRelative 폴백 예시 경로 (프로젝트 루트 기준)
 */
export function resolveConfigPath(explicitPath, defaultRelative, exampleRelative) {
  if (explicitPath) return path.resolve(explicitPath);
  const defaultPath = path.join(projectRoot, defaultRelative);
  if (existsSync(defaultPath)) return defaultPath;
  return path.join(projectRoot, exampleRelative);
}

/**
 * Express 앱 조립
 * OPENAI_API_KEY가 없거나 DRY_RUN=1이면 dry-run 모드로 기동
 * @param env 환경변수 객체 (기본 process.env)
 * @return { app, meta }
 */
export async function buildApp(env = process.env) {
  const catalogPath = resolveConfigPath(env.CATALOG_PATH, "config/catalog.json", "config/catalog.example.json");
  const promptPath = resolveConfigPath(env.PROMPT_PATH, "config/prompt.json", "config/prompt.example.json");
  const [catalog, promptSpec] = await Promise.all([
    loadCatalog(catalogPath),
    loadPromptSpec(promptPath),
  ]);

  const apiKey = env.OPENAI_API_KEY || null;
  const dryRun = env.DRY_RUN === "1" || !apiKey;
  const classifier = createClassifier({
    catalog,
    promptSpec,
    apiKey,
    dryRun,
    model: env.OPENAI_MODEL || "gpt-5-mini",
    reasoningEffort: env.REASONING_EFFORT || "minimal",
    timeoutMs: Number(env.LLM_TIMEOUT_MS) || 30000,
    maxAttempts: Number(env.LLM_MAX_ATTEMPTS) || 3,
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use(createClassifyRouter({ classifier, catalog, promptSpec }));

  app.use((req, res) => {
    res.status(404).json({
      error: { code: "not_found", message: `경로 없음: ${req.method} ${req.path}` },
    });
  });

  // 구조화 에러 응답 — 본문 파싱 실패 400, 크기 초과 413, 그 외 500
  app.use((error, req, res, next) => {
    if (error?.type === "entity.parse.failed") {
      return res.status(400).json({
        error: { code: "invalid_json", message: "요청 본문 JSON 파싱 실패" },
      });
    }
    if (error?.type === "entity.too.large") {
      return res.status(413).json({
        error: { code: "payload_too_large", message: "요청 본문 크기 초과" },
      });
    }
    res.status(500).json({
      error: { code: "internal_error", message: sanitizeError(error) },
    });
  });

  return {
    app,
    meta: { catalogPath, promptPath, dryRun, catalogCount: catalog.length },
  };
}

async function main() {
  const { app, meta } = await buildApp(process.env);
  const port = Number(process.env.PORT) || 8787;
  app.listen(port, () => {
    console.log(JSON.stringify({
      message: "server started",
      port,
      dryRun: meta.dryRun,
      catalogCount: meta.catalogCount,
    }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
