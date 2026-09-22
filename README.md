# ingredient-classify-lab

AI를 활용해 원료와 성분을 정해진 카테고리로 자동 분류하는 도구입니다.

단건 HTTP API와 반복 가능한 명령행 배치를 제공합니다. 분류 규칙과 카테고리는 로컬 설정으로 주입하며, 저장소에는 특정 서비스의 데이터나 정책을 포함하지 않습니다.

## 핵심 특성

### 폐쇄 어휘 분류

모델은 카탈로그에 등록된 `major::minor` 키만 반환할 수 있습니다. OpenAI Responses API의 strict JSON Schema가 출력 형식과 허용값을 제한합니다.

### 애플리케이션 계약 검증

서버가 모델 응답을 다시 검사합니다. 허용되지 않은 카테고리, 대표·추가 분류 중복, 입력 이름 불일치, 필수값 누락 등을 계약 위반으로 구분합니다.

### 검수 우선 결과

결과에는 카테고리와 함께 `needs_review`와 판정 사유가 포함됩니다. 판단이 모호하면 사람의 검수가 필요하다고 표시하고, 가장 유력한 대표 분류가 있으면 후보로 보존합니다.

### 반복 가능한 배치 실험

JSONL 데이터셋을 제한된 동시성으로 분류하고 결과를 SQLite에 저장합니다. 같은 입력을 여러 번 실행해 대표 분류, 추가 분류, 검수 필요 여부가 일관되는지도 측정합니다. 일부 항목의 실패는 나머지 실행을 중단하지 않습니다.

### 도메인 설정 격리

카테고리와 프롬프트는 커밋되지 않는 로컬 설정 파일로 주입합니다. 합성 예시만 저장소에 포함하므로 같은 하네스를 다른 폐쇄 어휘 분류 문제에도 사용할 수 있습니다.

## 동작 방식

```text
입력 이름 + 프롬프트 + 허용 카테고리
                ↓
        OpenAI Responses API
                ↓ strict JSON Schema
          구조화된 분류 결과
                ↓ 애플리케이션 계약 검증
 대표 분류 + 추가 분류 + 검수 여부 + 위반 목록
                ↓ 배치 실행 시
      SQLite 저장 + 반복 일관성 집계
```

## 빠른 시작

Node.js 22 이상이 필요합니다.

```bash
npm install
npm test
npm start
```

API 키가 없으면 LLM을 호출하지 않는 dry-run 모드로 시작합니다.

```bash
curl http://localhost:8787/healthz

curl -X POST http://localhost:8787/classify \
  -H 'Content-Type: application/json' \
  -d '{"name":"건조 쌀가루"}'
```

실제 분류에는 예시 설정을 복사해 도메인에 맞게 수정하고, API 키를 환경변수로 주입합니다.

```bash
cp config/catalog.example.json config/catalog.json
cp config/prompt.example.json config/prompt.json

read -s OPENAI_API_KEY
export OPENAI_API_KEY
npm start
```

## 배치 실행

입력은 고유한 `id`와 분류할 `name`을 가진 JSONL 파일입니다. `examples/batch-input.jsonl`에서 합성 예시를 확인할 수 있습니다.

```bash
OPENAI_MODEL=gpt-5.4-mini REASONING_EFFORT=none npm run batch -- \
  --input examples/batch-input.jsonl \
  --repetitions 3 \
  --concurrency 2
```

기본 결과 파일은 `data/classifications.sqlite3`입니다. 입력 데이터와 SQLite 결과는 커밋 대상에서 제외됩니다.

## 분류 계약

- `primary_category_key`: 대표 분류 최대 1개
- `additional_category_keys`: 추가 분류 0개 이상
- 모든 분류 키: 카탈로그에 등록된 `major::minor` 값
- `needs_review=false`: 대표 분류 필수
- `needs_review=true`: 유력한 대표 분류 후보 또는 빈 문자열 허용
- `reason`: 판정 사유 필수
- 대표 분류와 추가 분류 간 중복 금지

`contractViolations`가 비어 있지 않은 결과는 자동 확정값이 아니라 검수 참고용으로만 사용해야 합니다.

## 설정

- `config/catalog.json`: 카테고리 카탈로그
- `config/prompt.json`: 프롬프트 명세
- `OPENAI_API_KEY`: OpenAI API 키. 없으면 dry-run 모드
- `OPENAI_MODEL`: 사용할 모델
- `DRY_RUN=1`: API 키가 있어도 LLM 미호출
- `LLM_TIMEOUT_MS`: 호출당 제한 시간
- `LLM_MAX_ATTEMPTS`: 일시 오류를 포함한 최대 시도 횟수

실제 설정 파일이 없으면 `config/*.example.json`을 사용합니다.

## 프로젝트 구조

```text
config/                    합성 설정 예시
examples/                  합성 배치 입력 예시
src/server.mjs             HTTP 서버 진입점
src/batch.mjs              배치 실행 진입점
src/lib/                   설정·분류·계약·배치·SQLite 계층
src/routes/                HTTP 라우트
test/                      외부 API를 호출하지 않는 테스트
```

## 데이터 경계

- API 키는 환경변수로만 주입
- OpenAI 요청에 `store: false` 적용
- 오류 메시지의 API 키 형식 마스킹
- 실제 카탈로그·프롬프트·입력·SQLite 결과는 저장소에서 제외
- SQLite 파일의 접근 권한과 보존 기간은 사용 환경에서 별도 관리

이 프로젝트는 분류 로직 검증용입니다. 운영 환경의 인증·권한, 비밀 관리, 데이터 반영은 포함하지 않습니다.

## 라이선스

MIT
