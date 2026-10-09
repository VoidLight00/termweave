---
title: TermWeave Android Companion LTE 구현 상태
date: 2026-10-09
created_at: 2026-10-09T01:51:52+09:00
created_at_basis: current-file-creation
updated_at: 2026-10-09T01:51:52+09:00
timezone: Asia/Seoul
author: Codex
source_type: ai
tags: [AI, TermWeave, Android]
status: implementation-pilot
verification: apk-built-and-relay-tests-passed; physical-lte-unverified
---

# Android Companion 구현 상태

## 구현 범위

`mobile/android/`에 독립 Android 앱을 추가했습니다. `server/mobile-relay/`에 별도 중계 모듈을 추가했습니다. 기존 ADB 연결 기능과 실행 중인 휴대폰 설정은 변경하지 않았습니다.

사용자가 앱에서 직접 화면 공유를 시작합니다. Android의 공유 허용창을 거친 후 화면 공유 알림이 계속 표시됩니다. 알림과 앱의 종료 버튼으로 연결을 해제할 수 있습니다. 접근성 설정에서 사용자가 별도로 허용한 경우에만 터치·스와이프·홈·뒤로 입력을 처리합니다. 앱은 접근성 화면 내용을 수집하지 않습니다.

전화기와 Mac은 중계 서버로 먼저 연결하므로 같은 Wi-Fi·USB·Tailscale을 연결 전제로 사용하지 않습니다. 그러나 실제 LTE망 접속 증거는 아직 없습니다. 인터넷에서 접근 가능한 TLS 중계 주소의 배포도 수행하지 않았습니다.

## 연결 계약

- 전화기: `wss://허용된중계주소/connect?role=device`로 연결합니다. `Authorization: Bearer` 헤더에 기기 전용 키를 보냅니다.
- Mac 서버: 같은 중계 서버의 `role=viewer`에 별도 보기·입력 키로 연결합니다. 브라우저에 중계 키를 제공하지 않습니다.
- `startMobileRelay({deviceToken, viewerToken, expiresAt, port})`가 한 기기의 중계를 생성합니다. 키는 서로 다르게 생성한 256비트 이상의 무작위 값이어야 합니다.
- 서버는 기본적으로 `127.0.0.1`에만 바인딩합니다. 공개 TLS 중계 배포와 등록 UI 연결은 별도 작업입니다.
- 브라우저 Origin이 있는 직접 중계 접속은 거부합니다. TermWeave 인증을 거친 서버 연결을 붙여야 합니다.
- 기기/보기 연결이 변경되면 새로운 `streamId`를 발급합니다. 입력은 이 값과 증가하는 `seq`, 최대 2초의 `expiresAt`를 포함해야 합니다.
- 공유나 접근성 입력이 허용되지 않은 상태에서는 입력을 보내지 않습니다. 좌표는 0~1 범위로 제한합니다.
- 이전 연결의 입력, 중복 입력, 만료 입력, 임의 셸 명령은 거부합니다. 입력 대기열과 재연결 재전송은 없습니다.
- `hub.revoke()`는 양쪽 연결을 종료합니다. 등록 만료 시 추가 메시지는 거부됩니다.

## 영상 전송과 한계

초기 구현은 최대 가로 720픽셀·초당 5프레임의 JPEG를 보안 WebSocket으로 전송합니다. 프레임을 파일로 저장하지 않습니다. 전송 대기량과 프레임 크기를 제한합니다. 이 방식은 WebRTC 구현이 아니며 고화질 동영상·오디오·대규모 동시 접속 최적화는 포함하지 않습니다.

사용자 동의는 매 공유 세션마다 받습니다. 재부팅 후 자동으로 공유를 시작하지 않습니다. 연결 끊김, 공유 권한 종료, 화면 회전 시 공유를 종료하고 앱에서 다시 시작해야 합니다. 화면 일부만 공유할 때 다른 영역에 입력이 전달되지 않도록 전체 디스플레이 공유를 요청하며 캡처 크기가 변경되면 종료합니다.

현재 앱은 HTTPS 중계 주소와 12자리 일회용 등록 코드를 입력합니다. 코드는 5분 동안 한 번만 사용할 수 있으며 오답은 5회로 제한합니다. 영구 기기 키는 HTTPS 응답으로 메모리에만 받고 디스크에 저장하지 않습니다. TermWeave 설정에는 중계 주소·보기 키 입력, 연결, 철회, 영상, 원격 입력 허용과 홈·뒤로 제어가 연결됐습니다. 외부 보기 키는 서버의 권한 0600 설정 파일에만 저장하며 응답·URL·브라우저 저장소에 기록하지 않습니다. 정식 사용에는 외부 중계 배포와 실제 LTE 검증이 더 필요합니다. 로컬 관리 도구는 일회용 등록 코드 발급·등록 철회·키 교체·24시간 등록 만료를 처리합니다.

## 빌드와 검증

- Android SDK 35, minSdk 29, targetSdk 35, OpenJDK 17, Gradle 8.9, Android Gradle Plugin 8.7.2입니다.
- `python3 mobile/android/build.py`로 APK와 lint를 실행합니다.
- `bash mobile/android/gates/verify_android_companion.sh`는 APK 빌드, lint와 실제 WebSocket 기반 중계 테스트를 실행합니다.
- APK는 `mobile/android/app/build/outputs/apk/debug/app-debug.apk`에 생성됩니다. 디버그 서명이며 정식 배포 APK가 아닙니다.
- 실제 중계 소켓 테스트와 TermWeave production API 계약 테스트 10개·57개 assertion이 통과했습니다. 인증 실패·브라우저 Origin 거부·JPEG 전달·홈 입력 전달·watcher 입력 차단·TermWeave 기기 철회 후 영상 중단·원격 중계 철회 확인을 검증했습니다.
- 원격 중계 철회 응답을 받지 못한 경우 UI에 확인되지 않았다고 표시합니다. 설정 키를 로컬에서 지운 사실과 원격 철회 성공을 구분합니다.
- 전체 TypeScript 검사도 통과했습니다. Android APK 빌드와 lint, 중계 테스트를 묶은 게이트의 종료코드는 0입니다.
- 실제 휴대폰 설치, LTE 프레임 수신, 터치 결과, 권한 철회, 회전 및 재부팅 실험은 미검증입니다. 코드 빌드나 테스트 소켓을 실제 LTE 동작 증거로 표시하지 않습니다.

## 공식 출처와 라이선스

- Android 화면 공유 및 세션별 동의: https://developer.android.com/media/grow/media-projection
- Android 접근성 입력: https://developer.android.com/reference/android/accessibilityservice/AccessibilityService
- foreground service 유형: https://developer.android.com/develop/background-work/services/fgs/service-types
- OkHttp 4.12.0: Maven POM의 공급자 Square, Inc.와 Apache-2.0 라이선스를 확인했습니다. https://square.github.io/okhttp/
- RustDesk: 구조 참고 대상으로 확인했으며 AGPL-3.0 코드를 복사하거나 연결하지 않았습니다. https://github.com/rustdesk/rustdesk

공유 기능은 Android 공식 API를 사용해 직접 구현했습니다. 외부 서버 가입·과금·공개 배포·휴대폰 설정 변경은 수행하지 않았습니다.

## 서버 연결과 유지보수

`MobileRelayGateway`는 기존 TermWeave 인증·동일 출처 검사 뒤에서만 사용합니다. `/api/mobile-relay/stream`은 인증된 브라우저 영상/입력 연결이며 watch 역할은 입력할 수 없습니다. 기기 등록 철회 시 해당 브라우저를 즉시 분리합니다. `MobileRelayPanel`은 기존 Android 설정 아래에 배치됩니다. 중계 키를 전역 관리자 키로 대체하지 않습니다.

운영 실행기 `tools/mobile-relay/daemon.ts`는 `revoke`를 권한 0600 등록 파일에 저장합니다. 관리 도구 `manage.py`의 재기동 검증에서 철회 상태가 유지됐습니다. 로컬 서비스는 127.0.0.1:7339에만 바인딩합니다. `prepare-tunnel`은 외부 터널 명령을 출력만 하며 실제 공개하지 않습니다. Cloudflare를 사용하는 경우 암호화된 연결이 Cloudflare에서 종료되므로 애플리케이션 수준 종단간 영상 암호화와 같지 않습니다.
