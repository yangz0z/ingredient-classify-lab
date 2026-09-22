# ingredient-classify-lab

폐쇄 어휘(controlled vocabulary) 기반 LLM 텍스트 분류 검증 서버.

자유 텍스트 이름(예: 식품 재료명)을 미리 등록한 카테고리 카탈로그의 키로만 분류하도록 LLM 출력을 이중으로 강제·검증한다.

1. **strict JSON Schema** — 카탈로그에서 동적으로 생성한 스키마를 OpenAI Responses API의 structured output으로 강제한다. 허용 키 밖의 값은 모델 단계에서 차단된다.
2. **서버 측 계약 검증** — 스키마를 통과한 응답도 서버에서 다시 검증하고, 위반 내역을 `contractViolations`로 보고한다.

## 분류 계약

- 결과는 `primary_category_key`(최대 1개) + `additional_category_keys`(중복·primary 교차 금지)로 구성된다.
- 모든 키는 `major::minor` 형식의 카탈로그 등록 키만 허용한다.
- `needs_review=false`(확정)면 `primary_category_key`가 필수다.
- `needs_review=true`(검수 필요)여도 **가장 유력한 후보 primary를 보존**한다. 후보는 검수 화면 표시용이며 자동 반영 대상이 아니다. 후보조차 없으면 빈 문자열이다.
- `reason`(판정 사유)은 항상 필수다.

## 요구 사항

- Node.js 22 이상
- OpenAI API 키 (없으면 dry-run 모드로 동작)

## 설치

```bash
npm install
```

## 설정 주입

실제 카탈로그·프롬프트는 커밋하지 않는다 (`.gitignore`가 `config/*.json`을 제외하고 `*.example.json`만 허용). 예시 파일을 복사해 자신의 도메인에 맞게 수정한다.

```bash
cp config/catalog.example.json config/catalog.json
cp config/prompt.example.json config/prompt.json
```

- `config/catalog.json` — 카테고리 카탈로그. 각 항목은 `major`, `minor`, `description` 필수. 키는 `major::minor`로 자동 부여되며 중복은 기동 시 거부된다.
- `config/prompt.json` — 프롬프트 명세. `version`과 `instructions`(문자열 배열) 필수.
- 두 파일이 없으면 `config/*.example.json`으로 폴백해 기동한다.

### 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | (없음) | OpenAI API 키. 없으면 dry-run 모드 |
| `OPENAI_MODEL` | `gpt-5-mini` | 사용할 모델 |
| `CATALOG_PATH` | `config/catalog.json` | 카탈로그 경로 (명시 시 폴백 없음) |
| `PROMPT_PATH` | `config/prompt.json` | 프롬프트 명세 경로 (명시 시 폴백 없음) |
| `PORT` | `8787` | 서버 포트 |
| `DRY_RUN` | (없음) | `1`이면 키가 있어도 LLM을 호출하지 않음 |
| `REASONING_EFFORT` | `minimal` | 모델 reasoning effort |
| `LLM_TIMEOUT_MS` | `30000` | 호출당 시간 제한 |
| `LLM_MAX_ATTEMPTS` | `3` | 시간 초과·일시 오류 재시도 포함 최대 시도 횟수 |

API 키는 환경변수로만 주입한다. 코드·설정 파일에 하드코딩하지 않으며, 오류 메시지의 키 형식 문자열은 로그에 남기 전에 마스킹된다.

## 실행

```bash
npm start        # 기동
npm run dev      # 파일 변경 감지 재기동
```

키 없이 기동하면 dry-run 모드다. LLM을 호출하지 않고 계약을 충족하는 검수 대기 응답을 반환하므로, 배포 전 연동 점검에 쓸 수 있다.

## API

### GET /healthz

```json
{ "status": "ok", "dryRun": true, "catalogCount": 10, "promptVersion": 1 }
```

### POST /classify

요청:

```json
{ "name": "건조 닭가슴살" }
```

응답:

```json
{
  "input": { "name": "건조 닭가슴살" },
  "classification": {
    "name": "건조 닭가슴살",
    "primary_category_key": "육류::닭고기",
    "additional_category_keys": [],
    "needs_review": false,
    "reason": "닭 유래 육류 가공품"
  },
  "contractViolations": [],
  "dryRun": false,
  "model": "gpt-5-mini",
  "elapsedMs": 1234
}
```

- `contractViolations` — 서버 측 계약 검증에서 발견한 위반 메시지 목록. 비어 있으면 계약 충족. 위반이 있어도 응답 원본을 보존해 검수에 활용할 수 있다.
- 오류 응답은 `{ "error": { "code", "message" } }` 구조다. 코드: `invalid_request`(400), `invalid_json`(400), `payload_too_large`(413), `not_found`(404), `upstream_error`(502), `internal_error`(500).

## 테스트

```bash
npm test
```

모든 테스트는 합성 fixture만 사용하며 외부 API를 호출하지 않는다.

## 로드맵

- 2단계: better-sqlite3 기반 분류 결과 저장·배치 처리 (의존성만 선탑재된 상태)
