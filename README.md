# ingredient-classify-lab

재료·성분 이름을 미리 정해둔 카테고리 안에서만 분류하고, 그 판정을 믿을 수 있는지까지 함께 판단하는 실험 하네스입니다.

LLM에 분류를 맡기면 카탈로그에 없는 값을 지어내거나 같은 입력에 매번 다르게 답하는 문제가 생깁니다. 이 하네스는 출력 어휘를 스키마로 묶고, 애플리케이션이 결과를 다시 검증하며, 근거가 약한 판정은 사람 검수로 돌립니다. 같은 입력을 반복 실행해 일관성을 측정하고 확정 정답과 대조해 정확도를 계산하므로, 프롬프트를 고칠 때마다 무엇이 나아지고 무엇이 나빠졌는지 수치로 비교할 수 있습니다.

폐쇄 어휘 분류 문제라면 도메인을 가리지 않습니다. 카테고리와 판정 규칙은 커밋되지 않는 로컬 설정으로 주입하고, 저장소에는 합성 예시만 둡니다.

## 이 하네스의 특성

**출력 어휘를 두 겹으로 강제합니다.** OpenAI strict JSON Schema가 허용 키만 반환하도록 제한하고, 애플리케이션이 응답을 다시 검사합니다. 스키마만으로는 형식은 맞지만 의미가 어긋난 응답(대표·추가 분류 중복, 확정 판정인데 대표 분류 없음, 정책에 없는 카테고리 조합)을 걸러내지 못하기 때문입니다.

**도메인 지식을 세 층으로 나눕니다.** 개별 항목의 정답을 프롬프트에 적어 넣으면 그 항목만 맞고 새 입력에는 일반화되지 않습니다. 그래서 역할을 분리했습니다.

| 층 | 파일 | 담는 것 |
| --- | --- | --- |
| 카탈로그 | `config/catalog.json` | 각 카테고리가 무엇을 가리키는지, 인접 카테고리와의 경계 |
| 프롬프트 | `config/prompt.json` | 이름을 어떻게 분해하고 어떤 순서로 판정할지 |
| 정책 | `config/policy.json` | 대표 분류 우선순위, 허용되는 대표·추가 조합 |

정책은 프롬프트 지시문으로 주입되는 동시에 후처리에서도 쓰입니다. 모델이 고른 카테고리 집합은 유지한 채 대표·추가 순서만 정책에 맞게 바로잡고, 허용 목록에 없는 조합은 계약 위반으로 처리해 자동 반영을 막습니다.

**확정 대신 기권할 수 있습니다.** 결과에는 `needs_review`와 구조화된 사유 코드가 함께 담깁니다. 판단이 모호하면 가장 유력한 후보를 남기되 검수 대상으로 표시하므로, 자동 반영할 판정과 사람이 볼 판정을 구분할 수 있습니다.

**같은 실험을 다시 돌릴 수 있습니다.** 배치 실행은 모델 원본 응답과 후처리 결과를 모두 SQLite에 남깁니다. 반복 실행 시 판정 사유와 추가 분류 순서를 제외한 결과 서명으로 일관성을 집계하므로, 프롬프트를 바꿨을 때의 변화와 모델 자체의 실행 편차를 구분할 수 있습니다.

## 동작 구조

```text
{ id, name }                     이름 외 정보는 전송하지 않음
     │
     ├─ 시스템 프롬프트 조립      지시문 + 카테고리 목록 + 정책
     ├─ strict JSON Schema       허용 키 enum, 필수 필드
     ▼
OpenAI Responses API (store: false)
     │
     ├─ 정책 순서 정규화          대표·추가 뒤바뀜 교정
     ├─ 계약 검증                 허용 키·중복·필수값·정책 관계
     ▼
대표 분류 + 추가 분류 + 검수 여부 + 사유 + 위반 목록
     │
     └─ 배치 실행 시              SQLite 영속 + 반복 일관성 집계
```

카테고리 목록은 평면 나열이 아니라 대분류로 묶어 제시합니다. 여러 카테고리가 같은 설명을 공유하면 그 문장을 대분류 축 정의로 한 번만 출력하므로, 카테고리를 서로 구분하는 정보가 반복 문장에 묻히지 않습니다.

## 시작하기

Node.js 22 이상이 필요합니다.

```bash
npm install
npm test
npm start
```

API 키가 없으면 LLM을 호출하지 않는 dry-run으로 뜹니다. 설정 파일이 없으면 `config/*.example.json`을 사용합니다.

```bash
curl http://localhost:8787/healthz

curl -X POST http://localhost:8787/classify \
  -H 'Content-Type: application/json' \
  -d '{"name":"건조 쌀가루"}'
```

실제 분류를 하려면 예시 설정을 복사해 도메인에 맞게 고치고 키를 주입합니다. 키는 명령 인자나 파일이 아니라 터미널 입력으로 받습니다.

```bash
cp config/catalog.example.json config/catalog.json
cp config/prompt.example.json config/prompt.json
cp config/policy.example.json config/policy.json

read -s OPENAI_API_KEY
export OPENAI_API_KEY
npm start
```

## 실험 흐름

분류 품질을 개선하려면 배치 실행 → 검수 → 확정 정답 → 정확도 평가를 한 바퀴 돌립니다.

**배치 실행.** 입력은 고유 `id`와 `name`을 가진 JSONL입니다(`examples/batch-input.jsonl` 참고). `--repetitions`를 2 이상 주면 같은 입력을 여러 번 실행해 일관성을 함께 집계합니다.

```bash
OPENAI_MODEL=<model> npm run batch -- \
  --input examples/batch-input.jsonl \
  --database data/run-1.sqlite3 \
  --repetitions 3 --concurrency 2
```

**검수 CSV 생성.** 기존 분류가 담긴 스냅샷과 배치 결과를 합쳐 사람이 볼 비교표를 만듭니다. 검수자는 틀린 행만 판정과 확정값을 채우며, 빈 칸은 모델 분류 수용으로 처리됩니다.

```bash
npm run review:export -- \
  --source <snapshot>.jsonl --database data/run-1.sqlite3 \
  --run-id <batch-run-id> --output data/review-queue.csv
```

**확정값 변환.** 검수 CSV에서 최종 판정만 추출해 정답 CSV로 만들고 현재 카탈로그와 대조합니다.

```bash
npm run finalize:review -- --input data/review-queue.csv
```

**정확도 평가.** 확정 정답으로 재실행해 대표·추가·전체 일치율, 자동 분류율, 자동 분류 정확도를 계산합니다.

```bash
OPENAI_MODEL=<model> npm run evaluate -- \
  --input data/final-classifications.csv \
  --database data/eval-1.sqlite3 --output data/eval-1-results.csv
```

정확도는 대표 분류, 추가 분류, 전체 일치로 나눠 집계합니다. `needs_review=false`인데 틀린 결과는 자동 분류 오류로 따로 셉니다 — 검수로 걸러진 오답과 그대로 반영될 오답은 위험이 다르기 때문입니다.

## 분류 계약

```jsonc
{
  "name": "입력과 동일한 이름",
  "primary_category_key": "major::minor",   // 최대 1개, 빈 문자열 허용
  "additional_category_keys": ["major::minor"],
  "needs_review": false,
  "review_reason_codes": [],                 // needs_review와 연동
  "reason": "판정 근거"
}
```

- 모든 키는 카탈로그에 등록된 `major::minor` 값
- `needs_review=false`면 대표 분류 필수, `true`면 유력 후보 또는 빈 문자열 허용
- 대표 분류와 추가 분류 간 중복 금지, 추가 분류 내부 중복 금지
- `review_reason_codes`는 `unknown_identity`, `ambiguous_primary`, `ambiguous_component`, `missing_context`, `unsupported_policy_relation`, `other_uncertainty` 중에서만 선택
- 정책에 등록되지 않은 대표·추가 조합은 계약 위반

`POST /classify` 응답에는 모델 원본(`modelClassification`), 후처리 적용 결과(`classification`), 정책 조정 내역(`policyAdjustments`), 위반 목록(`contractViolations`)이 함께 담깁니다. `contractViolations`가 비어 있지 않은 결과는 확정값이 아니라 검수 참고용입니다.

## 설정

| 항목 | 설명 |
| --- | --- |
| `config/catalog.json` | 카테고리 카탈로그. `CATALOG_PATH`로 교체 |
| `config/prompt.json` | 프롬프트 명세. `PROMPT_PATH`로 교체 |
| `config/policy.json` | 대표 우선순위와 허용 조합. `POLICY_PATH`로 교체 |
| `OPENAI_API_KEY` | 없으면 dry-run |
| `OPENAI_MODEL` | 사용할 모델 |
| `REASONING_EFFORT` | 추론 강도. 지원값은 모델마다 다름 |
| `DRY_RUN=1` | 키가 있어도 미호출 |
| `LLM_TIMEOUT_MS` / `LLM_MAX_ATTEMPTS` | 호출 제한 시간과 재시도 상한 |
| `PORT` | 서버 포트(기본 8787) |

카탈로그는 `major`·`minor`·`description` 배열이며 키는 `major::minor`로 파생됩니다. 정책은 대표 규칙, 허용 조합, 검수 규칙으로 구성되고 로드 시 모든 카테고리 키가 카탈로그에 존재하는지, 역방향 조합이 함께 등록돼 충돌하지 않는지 검사합니다.

## 프로젝트 구조

```text
config/                    합성 설정 예시
examples/                  합성 배치 입력 예시
src/server.mjs             HTTP 서버
src/batch.mjs              배치 실행
src/export-review.mjs      검수 CSV 생성
src/finalize-review.mjs    확정값 변환
src/evaluate.mjs           정확도 평가
src/lib/                   카탈로그·프롬프트·정책·계약·LLM·배치·평가·영속 계층
src/routes/                HTTP 라우트
test/                      외부 호출 없는 테스트
```

## 데이터 경계

- 분류 대상 이름만 외부로 전송하며 요청에 `store: false` 적용
- API 키는 환경변수로만 주입하고 오류 메시지에서 키 형식을 마스킹
- 실제 카탈로그·프롬프트·정책·입력·실행 결과는 저장소에서 제외
- SQLite 파일의 접근 권한과 보존 기간은 사용 환경에서 관리

이 프로젝트는 분류 로직을 검증하기 위한 하네스입니다. 운영 환경의 인증·권한, 비밀 관리, 데이터 반영 경로는 포함하지 않습니다.

## 라이선스

MIT
