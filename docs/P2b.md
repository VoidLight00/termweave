# TERM-RENDER-001: P2b 크기 제약 수정

## 확인한 원인

실제 `PaneTerminal`·`DockDivider`·xterm과 mock WebSocket을 사용하는 합성 브라우저 fixture에서 원본 CSS의 지속 잘림을 재현했습니다. 가로 flex 자식인 `.terminal-stack`에 폭·축소 제약이 없어 xterm의 이전 intrinsic 폭을 유지했습니다. mount도 같은 큰 폭을 유지하므로 fit과 resize frame은 서로 일치하지만, 실제 panel보다 큰 grid를 계속 사용했습니다.

원본에서 단일 panel 650px에 stack 690px, 좌우 축소 panel 287.8px에 stack 690px, 모바일 panel 390px에 stack 883px가 기록됐습니다. 오른쪽 마지막 열이 panel 밖으로 잘렸고 observe adopted grid의 마지막 열도 내부 scroll로 접근하지 못했습니다.

`PaneTerminal.css`의 `.terminal-stack`에 `flex: 1 1 0`, `min-width: 0`, `min-height: 0`, `width: 100%`를 추가했습니다. 부모의 실제 이용 가능 크기로 stack과 mount가 축소되고 fit이 올바른 cols/rows를 계산합니다. overflow policy나 임의 column reduction은 변경하지 않았습니다. observe/mirror의 `overflow: auto`와 shared grid 정책은 보존합니다.

## 검사

- `scripts/terminal-render-fixture.tsx`: 합성 ASCII·한국어·중국어·일본어·emoji·ANSI·multiline·dynamic last-row/last-column fixture, 실제 PaneTerminal과 경계 UI.
- `scripts/terminal-render-regression.ts`: mock WebSocket, 실제 pointer 경계 조작, body/stack/mount/screen bounds·grid·resize frame·last-row/column·입력·observe/fixed 정책.
- `scripts/terminal-render-native.ts`: 격리 HOME/XDG/socket의 owned native 세션에서 web grid·resize frame·`stty size` 일치와 terminal ID·shell PID 유지.

같은 브라우저 fixture는 **원본 CSS exit 1 / 수정 CSS exit 0**입니다. 단일 shrink, 좌우 경계 80/20, zoom 복귀, mobile, observe scroll, interact 복귀에서 원본 실패를 기록했습니다. 수정 후 단일/분할/상하·좌우 50→80→20→50/탭/zoom/mobile/글꼴 준비·font size/DPR 1·2/멀티라인 입력을 검사합니다.

native 검사에는 프로젝트 안의 별도 HOME·XDG 경로와 짧은 named test session을 사용합니다. 운영 socket을 사용하지 않으며 반환받은 owned pane만 입력합니다. 테스트 서버 종료도 해당 격리 세션에만 적용합니다. 정상 종료 뒤 native owned 세션을 정리했습니다. shell PID와 terminal identity 유지 및 `stty` rows/cols 일치는 해당 합성 세션의 검사 결과이며 운영 세션 검사 결과가 아닙니다.

## 가설을 구분한 결과

- **H-FLEX-SHRINK:** 동일 fixture에서 재현·원인 확인·수정 통과.
- **H-FIT-DELAY:** 기존 120ms settle 정책은 보존했습니다. immediate/150ms/500ms 측정을 분리합니다. 조작 중 일시적 이전 grid를 완전히 없앴다고 주장하지 않습니다. 원본의 500ms 후 지속 잘림 원인은 flex 크기였습니다.
- **H-SHARED-GEOMETRY:** mock interact는 다른 shared geometry를 즉시 adopt하거나 무단 reassert하지 않는 기존 정책을 유지합니다. observe/fixed는 공유 grid를 adopt하고 가로 scroll로 마지막 열에 접근합니다. 여러 실제 기기 사이의 resize 경쟁을 해결했다고 주장하지 않습니다.

## 남은 검증 경계

현재 결과는 synthetic Chromium과 owned native 세션 범위입니다. 실제 iOS/Android·Safari·VoiceOver·실기기 IME·다기기 resize 경합·full App provider TUI는 P3/P5b 검증 대상입니다. 프로그램의 SIGWINCH redraw는 mock output과 분리해서 판단해야 합니다. 제품 전체·설치·공개 privacy/license 게이트는 통과한 상태가 아닙니다. 운영 배포·서비스 재시작·원격 생성·push는 하지 않았습니다.
