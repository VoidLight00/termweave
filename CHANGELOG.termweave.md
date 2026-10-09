# TermWeave Changelog

TermWeave(herdr web ui 포크)의 변경 기록입니다. 원본 프로젝트의 기록은 `CHANGELOG.md`에 있습니다.
이 파일에는 실제 동작이나 게이트로 확인된 완료 항목만 적습니다. 일부만 끝난 항목은 "남은 일"에 따로 적습니다.

## [0.3.2] - 2026-10-09

- feat: live app runs owned releases of this repo and redeploys on every version bump

## [0.3.1] - 2026-10-09

- fix: auto release accepts unchanged values and records every change since the last release
- feat: show which OpenRig seats need a person and why
- fix: public export commits are authored by the GitHub account noreply address
- fix: conventional commit message for public exports

## [0.3.0] - 2026-10-09 (첫 공개 릴리스)

### 2026-10-09

#### Added
- 네이티브 맥 앱 `TermWeave.app`을 추가했습니다. Aside 웹앱 바로가기 대신 WKWebView 창으로 열리고, 로컬 설정 파일의 토큰으로 자동 로그인합니다. 토큰은 앱 파일에 들어가지 않습니다. (`tools/mac-app/`)
- 재부팅 후 에이전트 복원 기능을 추가했습니다. 60초마다 패널별 Claude·Codex 세션 ID를 기록하고, 재부팅 뒤 같은 패널에서 `claude --resume` 또는 `codex resume`을 실행합니다. (`tools/resurrect/`, LaunchAgent `com.voidlight.termweave-resurrect`)
- 실행 중 플러그인을 검사하는 회귀 게이트 `tools/local-fixes/20261009/korean_input_gate.sh`를 추가했습니다. 수정 전 원본에서는 8개 항목이 실패합니다.
- 플러그인을 다시 설치한 뒤 수정 사항을 다시 적용하는 `tools/local-fixes/20261009/apply.sh`와 `plugin-fixes.patch`를 추가했습니다.

#### Changed
- 사이드바 PC 줄의 `+`를 "새 폴더 세션" 만들기로 바꿨습니다. 폴더 선택이 맨 위에 오고, 시작 프로그램의 기본값은 셸입니다.
- 페어링 화면과 알림 아이콘을 TermWeave v2 로고와 이름으로 바꿨습니다. 옛 아이콘 파일도 v2로 교체하고 서비스워커 캐시 이름을 올렸습니다.
- `TermWeave Phone` 앱은 연결에 실패하면 브라우저 대신 TermWeave 앱 창을 엽니다.

#### Fixed
- 네이티브 맥 앱에서 한글이 `ㅎㄱ`처럼 첫 자모만 입력되던 문제를 고쳤습니다. WebKit 한국어 입력기의 교체 입력을 입력창 전후 비교(`imeEdit`)로 처리합니다. 조합 이벤트를 한 번 보면 세션 내내 xterm 경로로 고정되던 동작을 없앴습니다. (PM-20261009-03)
- 한글 바로 뒤의 띄어쓰기가 NBSP(U+00A0)로 셸에 들어가던 문제를 고쳤습니다. WebKit 빠른 타자 시험(키 간격 60·25·12ms, 문장 3개)에서 9/9 문자 단위로 일치합니다. (PM-20261009-04)
- 작은 글자 크기에서 한글 위쪽이 잘리던 문제를 고쳤습니다. 확대된 한글의 글자 크기가 줄 높이를 넘지 않습니다(크기 10: 11px/11px, 크기 13: 15px/15px).

### 2026-10-08

#### Added
- 터미널마다 에이전트 로고를 표시합니다(Claude, Codex, Gemini 등).
- 터미널 "…" 메뉴에 이름 변경과 삭제를 추가했습니다.
- 오픈소스 테마(Catppuccin, Rose Pine 등)와 폰트(D2Coding, JetBrains Mono, Noto Sans KR) 변경 기능을 라이선스와 함께 추가했습니다.
- TermWeave 앱 아이콘과 로고를 적용했습니다. 시안 5개 중 4번(v2)을 선택했습니다.

#### Changed
- 패널 번호를 `%3` 대신 `P3`처럼 전역 번호로 표시합니다.
- 터미널을 지우면 종료 확인 팝업을 띄우고, 확인하면 실제로 종료될 때까지 확인합니다. 왼쪽 사이드바에서도 같습니다.

## 남은 일 (2026-10-09 기준)

- 실제 재부팅 시험으로 에이전트 복원 확인
- P번호로 패널 간 메시지 보내기(현재는 `w1:p1` 형식 주소)
- 전체를 한 번에 "폴더만" 보는 전환
- `herdr-plugin.toml`과 업데이트 안내 문구의 이름·버전 변경
- cmux·herdr 업스트림 자동 반영(개인정보 검사 단계에서 막힘)
- USB 없이 안드로이드 미러링, APK 휴대폰 설치와 LTE 실사용 검증
- Moshi 기능(mosh 방식 연결, 이미지 메모, 음성)
- OpenRig 후속 작업 1건
- 실제 휴대폰에서 모바일 사용성 검증
- 플러그인과 이 저장소의 내용 통합, 그 뒤 GitHub 공개(개인정보 검사와 공개 승인 필요)
