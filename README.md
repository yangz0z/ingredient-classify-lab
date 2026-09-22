# ingredient-classify-lab

LLM이 자유 텍스트를 **미리 정한 카테고리 안에서만** 분류하도록 만들고, 그 결과가 애플리케이션에서 안전하게 사용할 수 있는지 검증하는 로컬 HTTP 서버입니다.

일반적인 LLM 분류는 존재하지 않는 카테고리를 만들거나, 대표 분류와 추가 분류를 중복해서 반환하거나, 불확실한 결과를 확정값처럼 내놓을 수 있습니다. 이 프로젝트는 다음 두 단계로 결과를 제한합니다.

1. OpenAI Responses API의 strict JSON Schema로 출력 형식과 허용 카테고리를 제한
2. 서버에서 필드 간 규칙을 다시 검사해 중복·누락·입력 불일치 등을 보고

분류 규칙과 카테고리는 설정 파일로 주입합니다. 저장소에는 특정 서비스의 실제 데이터나 분류 정책이 포함되지 않습니다.

## 언제 사용하는가

이 프로젝트는 다음 작업을 위한 검증 하네스입니다.

- 운영 코드에 연결하기 전에 카테고리·프롬프트·모델 조합 시험
- LLM 결과가 정해진 출력 계약을 지키는지 확인
- 사람이 확인해야 할 모호한 결과와 계약 위반 수집
- 같은 입력을 반복 실행해 결과 일관성 비교
- 검증된 프롬프트와 계약 규칙을 실제 서비스에 이식하기 전 회귀 테스트

다음 용도의 완성형 제품은 아닙니다.

- 카테고리나 프롬프트를 자동으로 만들어 주는 서비스
- 검수 없이 LLM 결과를 운영 데이터에 바로 반영하는 서비스
- 특정 업종의 분류 지식을 내장한 범용 분류 모델
- 인증·권한·영속 저장소를 갖춘 운영용 API

## 동작 방식

```text
분류할 이름
    ↓
프롬프트 + 허용 카테고리 카탈로그
    ↓
OpenAI Responses API
    ↓ strict JSON Schema
구조화된 분류 결과
    ↓ 서버 계약 검증
대표 분류 + 추가 분류 + 검수 필요 여부 + 위반 목록
```

예를 들어 `건조 닭가슴살`을 입력하면 모델은 카탈로그에 등록된 `육류::닭고기` 같은 키만 반환할 수 있습니다. 서버는 반환된 결과에서 다음 항목을 추가로 검사합니다.

- 허용 목록에 없는 카테고리 사용 여부
- 대표 분류와 추가 분류의 중복 여부
- 추가 분류 내부의 중복 여부
- 입력 이름과 응답 이름의 일치 여부
- 확정 결과의 대표 분류 누락 여부
- 판정 사유 누락 여부

모델이 검수가 필요하다고 판단한 경우에도 가장 유력한 대표 분류 후보는 보존합니다. 이 후보는 검수 화면에 제안값으로 표시할 수 있지만 자동 확정값으로 취급해서는 안 됩니다.

## 현재 구현 범위

- `POST /classify`: 단건 분류 및 계약 위반 보고
- `GET /healthz`: 서버·설정·dry-run 상태 확인
- 카탈로그 기반 strict JSON Schema 동적 생성
- 시간 제한 및 제한적 재시도
- API 키가 없는 dry-run 모드
- API 키 형식이 포함된 오류 메시지 마스킹
- 합성 데이터만 사용하는 단위·HTTP 테스트

배치 실행, SQLite 결과 저장, 반복 일관성 측정, 브라우저 검수 화면은 아직 구현되지 않았습니다.

## 빠른 시작

### 1. 요구 사항

- Node.js 22 이상
- 실제 LLM 호출 시 OpenAI API 키

### 2. 설치

```bash
npm install
```

### 3. 예시 설정으로 dry-run 실행

API 키 없이 시작하면 LLM을 호출하지 않고 계약에 맞는 검수 대기 응답을 반환합니다.

```bash
npm start
```

다른 터미널에서 상태와 응답 형식을 확인합니다.

```bash
curl http://localhost:8787/healthz

curl -X POST http://localhost:8787/classify \
  -H 'Content-Type: application/json' \
  -d '{"name":"건조 닭가슴살"}'
```

### 4. 실제 분류 실행

예시 설정을 복사한 뒤 자신의 도메인에 맞게 수정합니다.

```bash
cp config/catalog.example.json config/catalog.json
cp config/prompt.example.json config/prompt.json
```

API 키는 설정 파일에 저장하지 않고 실행 환경에만 주입합니다.

```bash
read -s OPENAI_API_KEY
export OPENAI_API_KEY
npm start
```

작업이 끝나면 현재 셸에서 키를 제거합니다.

```bash
unset OPENAI_API_KEY
```

## 분류 계약

응답의 `classification`은 다음 규칙을 따릅니다.

- `primary_category_key`: 대표 분류 최대 1개
- `additional_category_keys`: 추가 분류 0개 이상
- 모든 분류 키: 카탈로그에 등록된 `major::minor` 형식
- `needs_review=false`: 대표 분류 필수
- `needs_review=true`: 유력한 대표 분류 후보 또는 빈 문자열 허용
- `reason`: 판정 사유 필수
- 대표 분류와 추가 분류 간 중복 금지
- 추가 분류 내부 중복 금지

`contractViolations`가 비어 있으면 서버 계약을 충족한 결과입니다. 값이 있으면 모델 응답을 검수 참고용으로만 사용해야 합니다.

## 설정

실제 카탈로그와 프롬프트는 커밋하지 않습니다. `.gitignore`는 `config/*.json`을 제외하고 `*.example.json`만 허용합니다.

- `config/catalog.json`: 카테고리 카탈로그. 각 항목에 `major`, `minor`, `description` 필요
- `config/prompt.json`: 프롬프트 명세. `version`, `instructions` 필요
- 실제 설정 파일이 없으면 `config/*.example.json`으로 폴백

### 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | 없음 | OpenAI API 키. 없으면 dry-run 모드 |
| `OPENAI_MODEL` | `gpt-5-mini` | 사용할 모델 |
| `CATALOG_PATH` | `config/catalog.json` | 카탈로그 경로. 명시하면 예시 파일로 폴백하지 않음 |
| `PROMPT_PATH` | `config/prompt.json` | 프롬프트 경로. 명시하면 예시 파일로 폴백하지 않음 |
| `PORT` | `8787` | 서버 포트 |
| `DRY_RUN` | 없음 | `1`이면 API 키가 있어도 LLM 미호출 |
| `REASONING_EFFORT` | `minimal` | 모델 추론 강도 |
| `LLM_TIMEOUT_MS` | `30000` | 호출당 제한 시간 |
| `LLM_MAX_ATTEMPTS` | `3` | 시간 초과·일시 오류를 포함한 최대 시도 횟수 |

## API

### `GET /healthz`

서버 기동 상태와 적용된 설정의 요약을 반환합니다.

```json
{
  "status": "ok",
  "dryRun": true,
  "catalogCount": 10,
  "promptVersion": 1
}
```

### `POST /classify`

요청:

```json
{
  "name": "건조 닭가슴살"
}
```

응답:

```json
{
  "input": {
    "name": "건조 닭가슴살"
  },
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

오류 응답은 `{ "error": { "code", "message" } }` 형태입니다.

| 상태 | 코드 | 의미 |
|---:|---|---|
| 400 | `invalid_request` | 요청 필드·값 오류 |
| 400 | `invalid_json` | JSON 파싱 실패 |
| 413 | `payload_too_large` | 요청 본문 크기 초과 |
| 404 | `not_found` | 존재하지 않는 경로 |
| 502 | `upstream_error` | LLM 호출 실패 |
| 500 | `internal_error` | 서버 내부 오류 |

## 프로젝트 구조

```text
config/
  catalog.example.json   합성 카테고리 예시
  prompt.example.json    합성 프롬프트 예시
src/
  lib/catalog.mjs        설정 로드·카탈로그 정규화
  lib/contract.mjs       JSON Schema 생성·서버 계약 검증
  lib/llm.mjs            OpenAI 호출·시간 제한·재시도·dry-run
  routes/classify.mjs    HTTP 요청 검증·응답 조립
  server.mjs             Express 앱 조립·오류 처리
test/                    합성 fixture 기반 테스트
```

## 테스트

```bash
npm test
```

테스트는 외부 API를 호출하지 않으며 실제 도메인 데이터도 사용하지 않습니다.

## 보안과 데이터 경계

- API 키는 환경변수로만 주입
- 오류 메시지에 포함된 키 형식은 로그 전에 마스킹
- OpenAI 요청에 `store: false` 적용
- 실제 카탈로그·프롬프트·입력 데이터는 저장소에서 제외
- 예시 설정과 테스트는 합성 데이터만 사용

실제 운영 환경에 적용하려면 별도의 인증·권한, 비밀 저장소, 요청 감사, 데이터 보존 정책을 설계해야 합니다.

## 로드맵

1. 배치 분류와 동시성 제한
2. SQLite 기반 실행 결과 저장
3. 동일 입력 반복 실행과 일관성 측정
4. 검수 큐와 브라우저 검수 화면
5. 확정 정답셋 기반 모델·프롬프트 비교
