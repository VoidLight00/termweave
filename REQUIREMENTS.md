# TermWeave 요구사항과 현재 상태

TermWeave는 herdr-web-ui의 검토 소스에 기반한 독립 웹 클라이언트입니다. herdr는 외부 native runtime이며 cmux는 기능 참고 대상입니다. 공식 제휴나 cmux runtime 포함을 뜻하지 않습니다. 원저작권과 라이선스는 `LICENSE`, `THIRD_PARTY_NOTICES.md`, `docs/source-provenance.json`에 유지합니다.

## 상태를 읽는 방법

- **구현 상태**는 코드가 존재하는지 나타냅니다. `implemented`, `partial`, `planned`, `native-only`, `unsupported`를 구분합니다.
- **검증 상태**는 현재 소스에서 실행한 시험 결과입니다. `PASS`, `FAIL`, `UNKNOWN`, `BLOCKED`, `NOT_RUN`, `NOT_APPLICABLE`을 구분합니다.
- P2는 원장 구조와 연결만 검사합니다. 제품 unit/API/integration/browser/build/설치 검사는 실행하지 않았습니다. 모든 제품 기능은 현재 `NOT_RUN`이며 native-only 제외 항목만 `NOT_APPLICABLE`입니다.
- 이전 운영 검사·스크린샷·187 pass/9 fail integration 기록·runtime_tests_run=0 감사는 새 저장소의 PASS 증거가 아닙니다.
- 필수 검사의 FAIL·UNKNOWN·미실행, 미해결 공개 차단 항목이 있으면 릴리스를 차단합니다. 현재 공개 상태는 **BLOCKED**입니다.

## 기계 판독 원장

| 파일 | 역할 |
|---|---|
| `tracking/features.json` | 기능 ID, 출처, 구현 코드, 의존성, 플랫폼, native capability, 수용 검사, 제한, 후속 단계 |
| `tracking/acceptance.json` | 검사 ID, 기존 파일, 검사 기준, 현재 coverage gap |
| `tracking/upstreams.json` | revision 고정 출처와 최신 **관측** SHA, 라이선스 문서 hash, 발견 규칙 |
| `upstreams.lock.json` | 검토된 소스 기반과 **승인 호환** 경계. 관측 SHA와 독립 |
| `tracking/failures.json` | 증상·미확정 가설·과거 실패·PUB-001~010 검토 대응 |
| `tracking/schema.json` | 원장 bundle의 JSON Schema v1 |

## 기능별 요구와 수용 연결

| 요구사항 ID | 구현 범위 | 수용 검사 | 남은 제한/단계 |
|---|---|---|---|
| WORKSPACE-NAV-001 | 작업 공간별 사이드바 | AC-WORKSPACE-ROWS, AC-WORKSPACE-ISOLATION | P3 지연/삭제 검사 |
| WORKSPACE-STORE-001 | 배치·비율·활성 탭 저장, v1/v2→v3 | AC-STORAGE-MIGRATION, AC-WORKSPACE-ISOLATION | 브라우저별 저장, 동기화 아님 |
| TERMINAL-ADD-001 | 같은 native 공간·탭·cwd 새 셸 | AC-ADD-SPLIT, AC-STALE-ROSTER | P3 경합 장애 주입 |
| DOCK-LAYOUT-001 | 중첩 분할·중앙 결합·순서 | AC-DOCK-MODEL, AC-DRAG-REAL, AC-SESSION-PRESERVE | 웹 배치와 native 이동 구분 |
| DOCK-DRAG-001 | 실제 제목 drag·MIME·삽입·취소 | AC-DRAG-REAL, AC-SESSION-PRESERVE | 모바일 touch 미검증 |
| DOCK-RESIZE-001 | pointer/keyboard 경계·zoom 복귀 | AC-RESIZE-ZOOM, AC-RENDER-SLIDER | P2b 잘림 차단 |
| DOCK-VIEW-001 | 비파괴 숨김·별도 브라우저 | AC-VIEW-DETACH, AC-SESSION-PRESERVE | OS 창 분리 아님 |
| FOCUS-SPATIAL-001 | 공간 방향 실제 입력 포커스 | AC-SPATIAL-FOCUS, AC-INPUT-KEYS | Cmd+방향은 별칭 |
| PANE-MOVE-001 | 동일 PC native pane.move | AC-NATIVE-MOVE, AC-NATIVE-MOVE-RACE, AC-ACCESS-ROLES | cross-host 이주·자동 재시도 없음 |
| TERMINAL-ATTACH-001 | reconnect·공유 grid·role | AC-ATTACH-RECONNECT, AC-GEOMETRY-ROLES | platform capability 확인 |
| TERM-RENDER-001 | 오른쪽 마지막 열·하단 행·커서 | AC-RENDER-SLIDER, AC-RENDER-SINGLE, AC-RENDER-CJK, AC-GEOMETRY-ROLES | P2b 미재현·미수정 |
| TERMINAL-SEARCH-001 | 최근 2,000줄 literal 검색 | AC-TERMINAL-SEARCH | 전용 regression 필요 |
| PREVIEW-WEB-001 | 제한 credentialless iframe | AC-PREVIEW-SAFETY | WebKit·자동화 API 아님 |
| PREVIEW-PORT-001 | local loopback 포트 주소 | AC-PREVIEW-SAFETY | 원격 proxy/HMR/scan 없음 |
| CHAT-PROVIDERS-001 | 지원 agent 대화/답변 | AC-CHAT-PROVIDERS | P3 canonical 실패 분류 |
| NOTIFY-APPROVAL-001 | 입력 필요·push·승인 | AC-NOTIFY-APPROVAL | browser permission 제약 |
| FILES-INPUT-001 | 파일·링크·clipboard·IME | AC-FILES, AC-INPUT-KEYS | Control+v/실제 IME 미검증 |
| REMOTE-MACHINES-001 | 호스트별 relay context | AC-REMOTE-SCOPE | 설치/SSH는 별도 opt-in |
| MOBILE-VIEW-001 | 좁은 viewport 그룹 선택 | AC-MOBILE-VIEW, AC-RENDER-CJK | 실제 device 미검증 |
| AUTH-DEVICE-001 | 인증·origin·device·observe | AC-ACCESS-ROLES | 외부 인증 강제 검사 필요 |
| A11Y-I18N-001 | 4개 언어·키보드 접근성 | AC-I18N-A11Y | P5b hardcode 이식 |
| PERFORMANCE-FLOW-001 | output flow·remount 정리 | AC-FLOW-REMOUNT | 장기 누수 benchmark 미검증 |
| UPSTREAM-WATCH-001 | 일일 후보 issue 감시 | AC-UPSTREAM-WATCH | P4 계획, 아직 실행 없음 |
| RELEASE-ROLLBACK-001 | 불변 artifact·pointer·rollback | AC-RELEASE-ROLLBACK | P5 계획, 운영 별도 승인 |
| INSTALL-PUBLIC-001 | 독립 identity·설치·공개 안전 | AC-PUBLIC-INSTALL | P5b 공개 차단 |
| NATIVE-WINDOW-001 | OS 창·WebKit 확장점 | AC-NATIVE-LIMITS | native-only, 미지원 |
| GIT-METADATA-001 | Git·PR·포트 metadata | AC-NATIVE-LIMITS | P6 계획, 미지원 |

## TERM-RENDER-001: 원인 미확정

관찰 증상을 두 개로 유지합니다. ① slider 확장/축소 중 잘림 ② 단일 보기 오른쪽 잘림입니다. 하단 마지막 행·상태줄도 별도 검사합니다. 실제 사용자 화면·대화는 공개 fixture로 사용하지 않습니다.

가설은 확정 결함과 다릅니다.
1. `H-FLEX-SHRINK`: 가로 flex에서 stack이 기존 xterm 폭보다 줄지 않는지 비교합니다.
2. `H-FIT-DELAY`: 120ms fit 지연의 일시적 현상과 500ms 이후 지속 잘림을 구분합니다.
3. `H-SHARED-GEOMETRY`: 다른 기기의 PTY 크기와 로컬 interact grid 차이를 mock으로 분리합니다.

수정 전 같은 합성 fixture가 실패하고 수정 후 통과해야 합니다. 단일·분할·resize·zoom·reload·font·DPR·CJK/emoji·ANSI/TUI·mobile·PTY cols/rows·마지막 행/열·커서를 함께 검사합니다. overflow 숨김이나 임의 cols 축소로 가리지 않습니다. observe/mirror에 무단 resize를 보내지 않습니다.

## 단계별 완료 경계

P2 원장 검증 → P2b rendering 재현/수정 → P3 격리 제품 회귀 → P4 watcher → P5 release/rollback → P5b 독립 설치·4개 언어·개인정보/라이선스·CI 공개 안전 검사 순서입니다. P6는 누락 기능의 지속 backlog이며 첫 공개의 무제한 기능 동등성 요구가 아닙니다. 운영 서비스·기존 터미널·인증·기기·native upgrade는 변경하지 않습니다.

## 2026-10-07 추가 요청: cmux·tmux 기능 확장

사용자 요청으로 전체 기능 대조와 추가 구현을 별도 목표로 확장합니다. 위 표는 이전 공개 준비 범위의 기록이며, 이번 전체 기능 요청의 완료 근거로 사용하지 않습니다. 공식 소스 대조는 `tracking/cmux-tmux-parity.json`, 구현 설명은 `docs/cmux-tmux-parity-20261007.md`에 기록합니다.

| ID | 요구사항 | 완료 조건 | 검증 |
| --- | --- | --- | --- |
| TW1 | 공식 소스 기반 기능 목록 | 리비전·라이선스·명령 위치·미검증 항목 보존 | scripts/parity-inventory.ts |
| TW2 | 실제 tmux 엔진 사용 | 독립 소켓, 세션 생성, 분할·창·pane 조작 | server/tmux/runtime.test.ts |
| TW3 | 터미널별 번호 | 창 내 번호와 고유 ID 구분, 세대가 다른 주소 거부 | server/tmux/runtime.test.ts |
| TW4 | 웹 실시간 연결 | 실제 출력, 정확한 pane 입력, 기본 명령, 재접속·종료 후 세션 보존 | scripts/tmux-workspace-regression.ts |
| TW5 | 권한과 입력 보존 | 인증·출처 검사, 보기 전용 직접 입력 거부, 불확실한 입력 재전송 금지 | scripts/tmux-workspace-regression.ts |
| TW6 | 선택한 작업 정보 | Git 훅 미실행, 변경 상태, 해당 프로세스의 수신 포트만 표시 | server/tmux/metadata.test.ts, server/tmux/ports.test.ts |
| TW7 | 기존 작업 보호 | 임시 서버만 사용, 기존 Herdr 화면·채팅 회귀 검사 | gates/verify_termweave.sh |
| TW8 | 전체 기능 동일 동작 | cmux 미대응 기능과 tmux 버전 차이 해소, 기능별 실행 증거 확보 | 미완료: gates/verify_termweave.sh --deployment |

## 2026-10-08 운영 반영 요청

사용자가 배포와 새로고침을 명시적으로 승인했습니다. 운영 중인 Herdr 본체와 기존 터미널·인증·기기 연결은 보존하며 웹 브리지와 화면의 검증된 변경만 반영합니다. 전체 계획은 `docs/PRD-cmux-tmux.md`, 단계는 `docs/ROADMAP-cmux-tmux.md`입니다.

- CT-IDENTITY-01: 서버에 저장한 전역 번호, 세션 간 중복 없음, 삭제 번호 재사용 없음입니다. `server/pane-numbers.test.ts`와 실제 브라우저 검사로 확인합니다.
- CT-NAV-01·02: 별도 화살표로 목록만 접으며 기기·세션별 접힘 상태를 저장합니다.
- CT-CLOSE-01: 왼쪽과 본문에서 확인 후 실제 터미널을 종료합니다. 실패 시 숨기지 않습니다.
- CT-NAME-01: 왼쪽과 본문에서 개별 이름을 변경하고 새로고침 후 이름과 전역 번호를 유지합니다.
- 실제 사용자 흐름: `scripts/sidebar-lifecycle-regression.ts`가 임시 Herdr에서 실행하며, `gates/verify_termweave.sh`에 연결합니다.

부분 배포의 증거는 전체 cmux·tmux 동일 동작의 완료를 뜻하지 않습니다. TW8은 계속 별도 미완료 상태입니다.
