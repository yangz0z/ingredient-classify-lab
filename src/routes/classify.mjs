// 분류 API 라우트 — 요청 검증, 판정, 계약 위반 보고
import Ajv from "ajv";
import { Router } from "express";

import { checkClassification } from "../lib/contract.mjs";
import { sanitizeError } from "../lib/llm.mjs";

const ajv = new Ajv({ allErrors: true });

const validateBody = ajv.compile({
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 300 },
  },
  additionalProperties: false,
});

/**
 * 분류 라우터 생성
 * @param options.classifier createClassifier 결과
 * @param options.catalog 정규화된 카탈로그 배열
 * @param options.promptSpec 프롬프트 명세
 */
export function createClassifyRouter({ classifier, catalog, promptSpec }) {
  const router = Router();

  router.get("/healthz", (req, res) => {
    res.json({
      status: "ok",
      dryRun: classifier.dryRun,
      catalogCount: catalog.length,
      promptVersion: promptSpec.version ?? null,
    });
  });

  router.post("/classify", async (req, res) => {
    if (!validateBody(req.body)) {
      return res.status(400).json({
        error: {
          code: "invalid_request",
          message: (validateBody.errors ?? [])
            .map((error) => `${error.instancePath || "/"} ${error.message}`)
            .join(", "),
        },
      });
    }
    const name = req.body.name.trim();
    if (!name) {
      return res.status(400).json({
        error: { code: "invalid_request", message: "name은 공백일 수 없음" },
      });
    }

    const startedAt = Date.now();
    try {
      const result = await classifier.classify(name);
      const { violations, classification } = checkClassification(result.classification, catalog, { name });
      res.json({
        input: { name },
        classification,
        contractViolations: violations,
        dryRun: result.dryRun,
        model: result.model ?? null,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      res.status(502).json({
        error: { code: "upstream_error", message: sanitizeError(error) },
      });
    }
  });

  return router;
}
