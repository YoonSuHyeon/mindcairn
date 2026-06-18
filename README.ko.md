# mindcairn

> AI 코딩 에이전트를 위한 self-hosted 팀의 뇌 — 코드·문서·결정을 하나의 하이브리드 검색 인덱스에 모아 MCP로 서빙합니다.

**한국어** | [English](README.md)

[![CI](https://github.com/YoonSuHyeon/mindcairn/actions/workflows/ci.yml/badge.svg)](https://github.com/YoonSuHyeon/mindcairn/actions/workflows/ci.yml)

![mindcairn 데모 — 터미널에서 하이브리드 검색](docs/assets/demo.gif)


## 왜

코드 검색 도구는 코드만 알고, 메모리 서버는 노트만 압니다. 하지만 개발팀의 지식은 그렇게 깔끔하게 나뉘지 않습니다. "환불이 여기서 어떻게 동작하지?"의 답은 `RefundService.kt` *그리고* "부분 환불을 막은 이유"가 적힌 설계 메모 — 에이전트는 **같은 검색 한 번**에 둘 다 받아야 합니다.

mindcairn은 개인 개발자가 남는 머신에 직접 띄울 수 있는 작은 self-hosted MCP 서버입니다. 레포를 가리키면 구조를 분석하고, 설계 문서와 세션 중 캡처한 결정까지 같은 인덱스에 적재합니다. 팀의 모든 Claude Code / Cursor 세션이 `search_codebase` 하나로 코드·문서·결정을 함께 받습니다 — 같은 네트워크면 HTTP로, 원격 팀원은 Tailscale로.

- **코드 + 문서 + 결정, 인덱스 하나** — 레포 청크, Notion export/마크다운(`ingest_doc`), 세션 중 캡처한 결정(`capture_decision`)이 전부 같은 하이브리드 인덱스에 삽니다.
- **식별자를 실제로 찾아내는 하이브리드 검색** — BM25 sparse + dense(bge-m3)를 RRF로 융합. 내부 평가에서 Hit@5 **63% → 88%** (정확 식별자 쿼리 50→75%, 자연어 쿼리 75→100%).
- **1~10명 팀용 설계** — 읽기 전용 모드, 쓰기 도구 IP 화이트리스트, usage 로그, `report_issue` 피드백 루프. SSO도, 클러스터도, 좌석당 과금도 없음.

## 비교

정중하게 — 서로 다른 일을 하는 도구들입니다. mindcairn의 일은 그 교집합입니다.

| | mindcairn | [claude-context](https://github.com/zilliztech/claude-context) | [mem0](https://github.com/mem0ai/mem0) | [basic-memory](https://github.com/basicmachines-co/basic-memory) |
|---|---|---|---|---|
| 기억 대상 | 코드 + 문서 + 결정 | 코드만 | 대화에서 추출한 사실 | 마크다운 노트 |
| 배포 | self-hosted, 신규 3rd party 없음 | OpenAI key + Zilliz Cloud | SaaS 또는 self-host | 로컬 파일 |
| 팀 공유 | 읽기 전용 모드 + IP 화이트리스트 + usage 로그 | — | — | — |

## Privacy & data flow

정직하게 — 무엇이 어디서 도는지:

| 단계 | 실행 위치 | 코드가 머신 밖으로 나가나? |
|---|---|---|
| 임베딩 | 로컬 Ollama (`bge-m3`, 기본값) | 아니오 (`EMBEDDING_PROVIDER=openai` 선택 시에만) |
| 벡터 저장·검색 | 로컬 Qdrant + SQLite | 아니오 |
| `init` 분석 (discovery/strategy) | Claude — 보유한 Claude Code CLI 로그인 또는 API key | 예 — 레포 구조와 스니펫이 분석용으로 전송됨 |
| 청크 enrich (라벨링) | Claude (Haiku) | 예 — 청크 내용 전송. **`ENRICHER=off`로 차단 가능** |

이미 Claude Code를 쓰고 있다면 mindcairn은 **신규 3rd party를 하나도 추가하지 않습니다**. (claude-context는 OpenAI + Zilliz Cloud 계정이 필요합니다.) "fully local"이라고 주장하지 않습니다 — LLM 분석 단계는 Claude를 호출하고, 그 양은 사용자가 통제합니다.

## 실제 레포 검증

[검증 벤치마크](docs/benchmarks.md) 실측 — 모든 수치는 실제 실행 로그 기반, 추정치 없음. 판정 기준: `search_codebase` top-5 안에 정답 파일 포함.

| 레포 | 언어 | `init` 시간 | 파일 | 청크 | 검색 hit |
|---|---|---|---|---|---|
| gin-gonic/gin | Go | 166.7s | 58 | 111 | 3/3 (전부 #1) |
| trpc/trpc | TS 모노레포 | 267.3s (+ 보수 build 174.2s) | 182 | 473 | 3/3 |
| fastapi/fastapi | Python | 113.3s | 48 | 81 | 3/3 |

비-JVM 레포 3개에서 **top-5 hit 9/9**, `init`은 각 113~267초. 내부 Kotlin/Spring 운영 환경에서는 하이브리드 검색이 Hit@5를 63%에서 88%로 올렸습니다.

## Quickstart

### 가장 쉬운 방법: 코딩 에이전트에게 맡기기

Claude Code, Cursor 등 MCP를 지원하는 코딩 에이전트를 쓴다면 직접 명령어를 칠 필요가 없습니다. 작업 중인 프로젝트를 열고 이걸 붙여넣으세요:

> 이 저장소에 **mindcairn**을 셋업해줘.
> 1. `https://github.com/YoonSuHyeon/mindcairn`을 이 프로젝트 옆에 클론하고(이미 있으면 생략) 그 안에서 `bun install` 실행.
> 2. Docker와 Ollama가 떠 있는지 확인하고, mindcairn 폴더에서 `docker compose up -d`(Qdrant)와 `ollama pull bge-m3` 실행.
> 3. `bun run src/cli/index.ts init --repo <이 저장소의 절대경로> --tag <짧은-이름> --yes` 실행.
> 4. `bun run src/cli/index.ts serve <짧은-이름>`로 서버를 띄우고, 나한테 등록: `claude mcp add --transport http mindcairn-<짧은-이름> http://localhost:8765/mcp`.
>
> 이후 이 코드베이스에 대해 물어보면 `search_codebase` 도구를 써줘.

에이전트가 각 단계를 실행하고, 도중에 만나는 preflight 오류(Docker/Ollama/모델 누락)도 알아서 해결하며 MCP 연결까지 연결해줍니다 — 당신은 승인만 하면 됩니다. 직접 하고 싶다면 아래 수동 절차를 따르세요.

### 0. 사전 준비

[Bun](https://bun.sh) (필수 — `bun:sqlite` 사용), Docker, 임베딩용 Ollama 또는 OpenAI API key. LLM 분석은 Claude Code CLI(API key 불필요) 또는 `ANTHROPIC_API_KEY`.

macOS 기준:

```bash
brew install oven-sh/bun/bun
brew install --cask docker      # 설치 후 Docker Desktop 을 한 번 실행하고 뜰 때까지 대기
brew install ollama             # 설치 후 Ollama 앱 실행 (또는 `ollama serve`)
```

LLM 분석용으로 [Claude Code CLI](https://claude.com/claude-code) 로그인(`claude`가 PATH에) 또는 `ANTHROPIC_API_KEY` 중 하나가 필요합니다. 둘 다 없으면 [No-LLM 모드](docs/extending.md#25-no-llm-mode--hand-written-strategy-zero-code-leaves-your-machine)로.

두 데몬이 **실제로 실행 중인지** 확인 — Quickstart 실패 원인 1순위:

```bash
docker info > /dev/null && echo "docker OK"             # Docker Desktop 미실행이면 에러
curl -s localhost:11434 > /dev/null && echo "ollama OK"  # Ollama 미실행이면 에러
```

(Linux: Docker Engine + [Ollama](https://ollama.com/download), 확인 방법 동일.)

### 1. 인덱싱 & 서빙

```bash
docker compose up -d          # Qdrant (벡터 DB)
ollama pull bge-m3            # 임베딩 모델 (또는 EMBEDDING_PROVIDER=openai)
bun install

# 대화식 마법사: preflight → preset → 분석 → 인덱싱 → MCP 안내
bun run src/cli/index.ts init

# 비대화식
bun run src/cli/index.ts init --repo /path/to/your/repo --tag my-app --yes

# MCP 서버 실행
bun run src/cli/index.ts serve my-app
```

에이전트 연결:

```bash
claude mcp add --transport http mindcairn-my-app http://localhost:8765/mcp
```

> **이미 Qdrant나 다른 서버가 해당 포트를 쓰고 있다면?** 6333에 Qdrant가 이미 떠 있으면 `docker compose up`은 건너뛰세요 — mindcairn이 그대로 사용합니다. 8765가 사용 중이면 `serve`가 (조용히 포트를 공유하는 대신) 시작을 거부합니다. `MINDCAIRN_MCP_PORT=8770`처럼 다른 포트를 지정하세요. `init` 마법사는 대화식이라 블록 붙여넣기 중간에 두면 안 되고, 한 줄씩 실행하거나 비대화식 형태를 쓰세요.

깨끗한 머신에서 실측: [spring-petclinic](https://github.com/spring-projects/spring-petclinic)(37파일) 기준 `init` **88초** — Docker 이미지·임베딩 모델 다운로드 포함해도 30분 이내.

### 중지 & 초기화

```bash
# 중지: serve 프로세스 Ctrl-C; docker compose down   (인덱스 데이터는 유지)
# 인스턴스 1개 초기화: 로컬 상태 + Qdrant 컬렉션 삭제
# (컬렉션명 = mindcairn_<tag>, 영숫자 외 문자는 "_" 치환: my-app → mindcairn_my_app)
rm -rf .mindcairn/my-app
curl -X DELETE http://localhost:6333/collections/mindcairn_my_app
# 전체 초기화: docker compose down -v  (Qdrant volume 전부 삭제)
```

## Features

- **하이브리드 검색 (BM25 + dense, RRF 융합)** — 코드 인식 토크나이저(camelCase/snake_case 분해 + 식별자 원형 토큰 + 한글 지원)가 dense 임베딩 옆에 BM25 sparse 벡터를 함께 색인. 쿼리는 둘을 Reciprocal Rank Fusion으로 융합. 정확한 함수명도, 자연어 질문도 둘 다 통합니다.
- **레이어 인식 청킹** — 전략 에이전트가 레포를 보고 아키텍처 레이어별(controller / service / repository / DTO / entity) 청커를 설계. 고정 크기 텍스트 윈도가 아닙니다. 커버리지가 낮으면 generic 전략으로 fallback.
- **결정 캡처** — `capture_decision`으로 코딩 세션 중간에 결정/사실/장애 기록을 인덱스에 저장. 몇 초 안에, 관련 코드 바로 옆에서 검색됩니다.
- **문서 ingest** — Notion export나 임의 마크다운을 `ingest_doc` 도구/배치 스크립트로 같은 인덱스에 적재. 설계 문서가 코드와 나란히 검색됨.
- **LLM enrich (옵션)** — 빠른 모델(Haiku)이 청크마다 구조화 라벨(클래스명/메서드/테이블/키워드)을 부착하고, 임베딩은 원문 노이즈 대신 라벨을 색인. `ENRICHER=off`로 끌 수 있음.
- **증분 sync** — 변경된 파일만 재색인(`sync` 명령). 신규 청크는 자동으로 BM25에 참여.
- **안전한 팀 공유** — `MINDCAIRN_READONLY=1`이면 검색 도구만 노출, `MINDCAIRN_WRITE_IPS`로 쓰기 가능 IP 제한, 모든 쿼리 usage 로그 기록.
- **피드백·회귀 루프** — `report_issue`로 나쁜 답 수집, `eval_query` + golden set으로 검색 품질 회귀를 사전 차단.

### MCP 도구

| 도구 | 역할 |
|------|------|
| `search_codebase` | 코드 + 적재 문서 + 결정 하이브리드 검색 |
| `find_pattern` | 패턴/컨벤션 구현 사례 찾기 |
| `explain_module` | 모듈 이름으로 요약 |
| `get_chunk` | 청크 id로 원문 조회 |
| `capture_decision` | 팀 결정사항 인덱스에 저장 |
| `ingest_doc` | 외부 문서 색인 |
| `list_captured` | 저장된 결정/문서 목록 |
| `learn_preference` | 팀 선호/규칙 저장 |
| `eval_query` | 검색 품질 평가 케이스 실행 |
| `report_issue` | 나쁜 답변 피드백 접수 |

`MINDCAIRN_READONLY=1`이면 검색/읽기 도구 + `report_issue`만 노출됩니다.

## Architecture

```
 your repo ────▶ ┌──────────────────────────────────────┐
 (읽기 전용)      │ init  (1회, 30분 이내)                │
 문서/결정        │  1 preset    언어/글롭 감지            │
 (ingest_doc,    │  2 discovery LLM이 구조 분석          │
  capture_…)     │  3 strategy  레이어 인식 청킹 설계      │
                 │  4 build     청크 → enrich → 임베딩    │
                 └───────────────┬──────────────────────┘
                                 ▼
                  ┌────────────┐   ┌──────────────┐
                  │ Qdrant     │   │ SQLite       │
                  │ dense+BM25 │   │ 청크, usage  │
                  │ (RRF)      │   │ 로그, eval   │
                  └─────┬──────┘   └──────┬───────┘
                        └────────┬────────┘
                                 ▼
                 ┌───────────────────────────┐  HTTP /mcp
                 │ MCP server  :8765         │◀──────────── Claude Code / Cursor
                 │ search_codebase,          │              (원격 팀원은
                 │ find_pattern, ingest_doc… │               Tailscale 등으로)
                 └───────────────────────────┘
```

## Configuration

전부 옵션 — 로컬 Ollama + Claude CLI 기본값으로 동작합니다. [`.env.example`](.env.example) 참고.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `EMBEDDING_PROVIDER` | `ollama` | `ollama` 또는 `openai` |
| `OPENAI_API_KEY` | — | `EMBEDDING_PROVIDER=openai`일 때 필수 |
| `MINDCAIRN_EMBED_MODEL` | `bge-m3` / `text-embedding-3-small` | provider별 임베딩 모델 |
| `MINDCAIRN_EMBED_DIM` | `1024` / `1536` | 임베딩 차원 |
| `ANTHROPIC_API_KEY` | — | 있으면 API, 없으면 Claude CLI(OAuth) |
| `MINDCAIRN_LLM` | 자동 | `claude-cli` 또는 `api` 강제 |
| `MINDCAIRN_CLAUDE_BIN` | `claude` | Claude CLI 경로 |
| `MINDCAIRN_LLM_TIMEOUT_MS` | `120000` | LLM 호출당 타임아웃(ms). 멈춘 CLI/API 호출을 죽여 인덱싱이 행되는 것 방지 |
| `ENRICHER` | `auto` | 청크 라벨링: `claude-cli` / `api` / `off` / `auto` |
| `MINDCAIRN_MODEL_LARGE` | (Claude Opus) | discovery/strategy 모델 |
| `MINDCAIRN_MODEL_FAST` | (Claude Haiku) | enrich/eval 모델 |
| `MINDCAIRN_QDRANT_HOST` | `http://localhost:6333` | Qdrant 주소 |
| `MINDCAIRN_OLLAMA_HOST` | `http://localhost:11434` | Ollama 주소 |
| `MINDCAIRN_MCP_PORT` | `8765` | MCP 서버 포트 |
| `MINDCAIRN_MCP_HOST` | `0.0.0.0` | MCP 바인드 주소 |
| `MINDCAIRN_READONLY` | off | `1` = 검색 도구 + `report_issue`만 노출 (팀 공유 인스턴스) |
| `MINDCAIRN_WRITE_IPS` | — | 쓰기 도구 IP 화이트리스트 (콤마 구분). localhost는 항상 허용, **미설정 시 원격 쓰기 차단**(localhost 전용) |
| `MINDCAIRN_TRUST_PROXY` | — | 프록시의 `X-Forwarded-For`를 신뢰해 `req.ip`를 실제 클라이언트로 인식. `loopback` / IP / hop 수. **리버스 프록시 뒤일 때만 설정** — 아니면 클라이언트가 IP를 위조해 `MINDCAIRN_WRITE_IPS`를 우회할 수 있음 |
| `MINDCAIRN_OUTPUT_DIR` | `.mindcairn` | 인덱스/preset 저장 위치 |

## Extending — 회사별 커스터마이즈

대부분의 회사별 적응은 코드 없이 됩니다: preset으로 인덱싱 범위를 정하고, LLM이 설계한 청킹 전략은 직접 수정 가능한 JSON 파일입니다 (회사 컨벤션별 커스텀 chunker — `@Table` 엔티티, 코드 enum 인터페이스, 자체 어노테이션 등). 새 언어의 심볼 단위 파싱 추가는 코드 작업이지만 끼워 넣는 지점이 명확합니다. [docs/extending.md](docs/extending.md) 참고.

[`templates/commands/`](templates/commands/)에 Claude Code 슬래시 커맨드(`/mindcairn-start`)가 들어 있습니다 — 프로젝트의 `.claude/commands/`에 복사하고 placeholder 스킬/에이전트 이름을 팀 것으로 바꾸면 mindcairn 중심 워크플로 진입점(작업 시작, 자유 검색, SQL 작성, 디버그, 회고)이 생깁니다.

## Limitations

검증 라운드 결과 그대로 — 현재 알려진 한계입니다:

1. **심볼 단위 청킹은 Kotlin/Java 전용.** Go/Python/TS는 정규식 파서가 class/method를 추출하지 못해 file 단위 청크만 생성됩니다. 검색은 동작하지만 함수 단위 정밀도는 JVM 언어보다 낮습니다. 증분 `sync`도 현재 변경된 `.kt` 파일만 잡고, 기준 SHA를 기록하는 `build --ref` 선행이 필요합니다 — 다른 언어는 `build` 재실행으로.
2. **여러 file-unit chunker가 같은 파일을 중복 청킹할 수 있음** — gin: 58파일 → 111청크, trpc: 182파일 → 473청크. 검색 시 quota로 편향은 완화되지만 인덱스 크기와 enrich 비용이 늘어납니다.
3. **claude-cli 경로는 세션 사용량 한도에 종속.** 한도(429)에 걸리면 재시도해도 enrich가 실패할 수 있습니다. `init` 재실행 시 캐시 덕에 실패분만 다시 시도되어 복구는 가능합니다.
4. **한국어 우선 UX** — CLI 마법사, 로그 출력, enrich 라벨이 현재 한국어입니다 (한국 팀에서 나온 코드베이스라서). 검색 자체는 언어 무관(bge-m3 다국어)이지만 UI 언어 옵션은 미구현.
5. **graph 레이어 없음, 자동 기억 추출 없음.** 순수 하이브리드 검색입니다. 결정은 명시적 `capture_decision` / `ingest_doc`으로만 인덱스에 들어갑니다.

## FAQ

**내 코드가 외부로 나가나요?**
임베딩과 벡터 검색은 로컬(Ollama + Qdrant)입니다. discovery/strategy 분석과 옵션인 청크 enrich는 코드 일부를 Claude로 보냅니다 — 보유한 Claude Code CLI 로그인 또는 API key 경유. `ENRICHER=off`로 LLM 호출을 최소화하면 1회성 discovery + strategy 분석만 남습니다. LLM 호출을 **0**으로 만들려면 전략 JSON을 직접 작성해 `build --strategy`로 빌드하세요 — [No-LLM 모드](docs/extending.md#25-no-llm-mode--hand-written-strategy-zero-code-leaves-your-machine) 참고. [Privacy & data flow](#privacy--data-flow)도 참고.

**왜 Node가 아니라 Bun인가요?**
청크 저장에 `bun:sqlite`를 사용하고, 빠른 dev loop를 덤으로 얻습니다. Node는 지원하지 않습니다.

**지원 언어는?**
Kotlin/Java는 전용 구조 파서가 있고, TypeScript/JavaScript, Python, Go, Rust, SQL은 generic file 단위 전략으로 색인됩니다 ([Limitations](#limitations) 참고). 전략 에이전트가 레포에 맞는 걸 고릅니다.

**원격 팀원은 어떻게 접속하나요?**
서버가 `0.0.0.0`에 바인드되므로 네트워크만 뚫리면 됩니다 — 저희는 [Tailscale](https://tailscale.com)을 씁니다. 공유 인스턴스는 `MINDCAIRN_READONLY=1`로 띄우고 본인 IP만 `MINDCAIRN_WRITE_IPS`에 넣으세요.

**Glean / Sourcegraph와 뭐가 다른가요?**
그쪽은 큰 조직용이고, 가격과 운영도 그렇습니다. mindcairn은 반대쪽 끝을 노립니다: 개발자 한 명, 남는 머신 한 대, `init` 한 번, 1~10명 팀.

**Notion이나 내부 문서도 색인되나요?**
네 — 단건은 `ingest_doc`(MCP 도구), Notion export는 배치 스크립트로. 문서·결정·코드가 같은 하이브리드 인덱스를 공유합니다.

## License

[MIT](LICENSE)
