## Active Goal

사용자는 USB·같은 Wi-Fi 없이 LTE 모바일 앱으로 휴대폰을 맥북에서 제어하도록 요청했습니다. 화면 공유 시작·재부팅 후 Android 허용이 필요한 방식으로 진행할지 비동기 질문에 대한 응답을 기다립니다. 이전 완전 무인 복구 요구를 임의로 완화하지 않습니다.

## Completed

v0.2.5 로컬 적용: Android 등록·Wi-Fi 페어링/연결·scrcpy 실행/개별 종료, 테마·글꼴·색상 가져오기/내보내기, 정확한 P 번호 검색, 정보 GitHub 링크 수정, 승인 카드 terminal identity 확인. TermWeave Phone.app 로컬 생성(실행 흐름은 미검증).

## Decisions

운영 저장 키와 기본 포트 7317은 보존했습니다. 후보 전체 덮어쓰기 대신 운영 복사본에 이번 변경만 적용했습니다. LTE 앱 구현은 재부팅 요구 조정의 응답 전까지 진행하지 않았습니다. 유료 중계 신청 없음.

## Files Touched

shared/android.ts, server/android/*, AndroidPanel.*, AppearancePanel.*, src/lib/appearance.*, settings.ts, paletteSearch.*, shared/protocol.ts, server/prompt.ts, 관련 호출 컴포넌트, i18n.ko.ts, shared/product.ts, scripts/android-launcher.ts, public/appearance/*, docs/android-lte-plan.md. scripts/phone-setup.contract.test.ts는 macOS 소켓 경로가 너무 긴 임시 경로를 축소했습니다.

## Evidence

로컬 비공개 증거: ~/.local/state/termweave-mobile-20261008 (staging, manifest, backup, deployment.json, checks.json, verification-limits.json). 기존 터미널 15개·인증 보존. 타입/빌드/16개 집중 테스트/인증 및 출처 차단/320·375·768·1440 화면 검사 통과. Aside에서 실제 v0.2.5 새로고침 확인, 나머지 설정 항목은 그 브라우저 에이전트가 완전히 확인하지 못했습니다.

전체 unit: 1213 pass, 4 skip, 9 fail. 기존 pane index 기대값 및 다국어 사전 검사 등을 포함하며 일부 새 문자열 누락도 있어 전체 통과가 아닙니다. 분리 integration: 198 pass, phone setup 1 fail. phone setup 경로 수정 후 해당 1개는 통과했습니다. 전체 suite 재실행 통과를 주장하지 않습니다.

실기: Samsung Android16 USB와 명시한 Wi-Fi 주소 scrcpy 렌더·홈 입력 확인. USB 분리 뒤 무선 서비스가 사라져 scrcpy exit1, 입력 exit1. LTE 연결 미구현·미검증. 비공개 실기 로그에는 식별 정보가 있으므로 원문 출력 금지.

## Pending

1. 사용자가 Android 화면 공유 허용 방식과 완전 무인 복구 중 선택하도록 요청했습니다. 응답 이후 LTE 앱/중계 구현을 결정합니다.
2. LTE 실제 화면·입력·재연결·회전·권한 종료·재부팅 복구를 검증해야 합니다.
3. 전체 검사 실패 및 다국어 사전 정합성을 해결해야 합니다.
4. 실제 GitHub 공개 저장소 접근 여부는 확인되지 않았습니다. UI 링크 수정은 공개 완료의 증거가 아닙니다.

## Constraints

기존 네이티브 Herdr 서버·터미널·인증을 재시작하거나 초기화하지 않습니다. 폰 전체 adb kill이나 다른 scrcpy 종료 금지. 토큰/기기식별자/페어링 코드 출력 금지. 실제 LTE 검증 전 완료로 보고하지 않습니다.
