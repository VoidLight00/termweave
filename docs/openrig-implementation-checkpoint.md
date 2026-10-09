---
schema_version: 1
title: OpenRig 연동 작업 상태
project: TermWeave
document_type: checkpoint
author: Codex
language: ko-KR
created_at: '2026-10-09T00:36:37+09:00'
created_at_basis: filesystem_birthtime
updated_at: '2026-10-09T02:43:07+09:00'
saved_at: '2026-10-09T02:43:07+09:00'
source_checked_at: '2026-10-09T01:11:05+09:00'
timezone: Asia/Seoul
visibility: repository-local
status: scoped-local-release-0.2.8
verification_scope: live-team-and-native-identities; service-control; full-parity-incomplete
official_docs_version: 0.6.6
rigspec_version: '0.2'
installed_package_version: 0.6.7
source_commit: 29c2a56104e6247d289267685264b96fac46ec2a
installed_build_commit: b3c3c8575f2a646c07ecc49bbf07927473effc9d
sources:
- https://openrig.dev/docs/coordination
- https://openrig.dev/docs/continuity
- https://openrig.dev/specs/rigspec
- https://openrig.dev/docs/architecture
tags:
- AI
- termweave
- openrig
- integration
---

# OpenRig 연동 작업 상태

## Active Goal

TermWeave에서 OpenRig 자체 켜기·끄기, 실제 팀 실행, 업무 전달, 대화 복구와 전역 P 번호 연결을 제공합니다. 사용자 전체 요구의 완료 여부는 기능별 실제 증거로 판단합니다.

## Completed

- v0.2.8을 로컬 운영판에 반영했습니다. 관리 서비스 켜기·끄기와 선택 저장, 공식 starter 계획·실행, 업무 생성·이력·인계, 복구 계획·실행·상태 화면을 연결했습니다.
- 서비스 제어는 소유한 관리 프로그램만 대상으로 합니다. 기존 터미널이나 에이전트를 종료하지 않습니다. 꺼짐 요청이 실패하면 실제 실행 상태를 별도로 표시합니다.
- 설치된 공식 0.6.7의 사본에서 업무 인계 동시 변경 검사와 구조화된 네이티브 터미널 연결을 검증한 뒤 4개 파일만 반영했습니다. 공식 버전 번호와 TermWeave 추가 패치를 구분합니다.
- 전용 시험 프로젝트에서 Claude Builder와 Codex Reviewer를 실제 실행했습니다. 현재 네이티브 식별자와 대조한 연결은 Builder P29, Reviewer P30입니다.
- 격리된 제공자 설정 경로를 유지하면서 실제 계정 HOME을 사용하도록 수정했습니다. 두 제공자의 전용 인증 상태를 확인했습니다.
- Builder가 시험 코드와 테스트를 작성했고, Reviewer가 독립 실행에서 추가 결함을 찾아 수정 왕복을 진행하고 있습니다.

## Decisions

- 서비스 끄기, 패널 닫기, 에이전트 종료를 구분합니다.
- 역할 이름으로 P 번호를 추정하지 않습니다. 현재 작업공간·탭·패널·터미널 식별자가 모두 일치할 때만 번호를 표시합니다.
- 업무 등록과 알림 요청은 수신·실행·검증 완료가 아닙니다. 최초 알림이 선택 화면 때문에 거부된 실제 사례를 확인했습니다.
- 대화 복구는 같은 대화 재개, 새 대화 시작, 사람의 판단 대기, 실패를 구분합니다. 실제 재부팅 복구 완료로 표현하지 않습니다.

## Files Touched

- `server/openrig/`, `server/openrig-service.ts`, `server/openrig-auth.contract.test.ts`, `server/index.ts`, `shared/openrig.ts`.
- `scripts/openrig-daemon.py`, `scripts/openrig_daemon_test.py`, `tools/openrig-patches/`.
- `src/components/OpenRigPanel.tsx`, `OpenRigStarterPanel.tsx`, `OpenRigQueuePanel.tsx`, `OpenRigRecoveryPanel.tsx`, 관련 스타일과 번역, `src/App.tsx`.
- `docs/PLAN-completion-20261009.md`, 이 상태 기록, 인증 원인 분석 기록.

## Evidence

- 전체 기본 종료 검사는 `close-next.log`에서 모든 단계 PASS와 GREEN을 반환했습니다. 미완성 전체 동등 기능을 허용하는 공개 검사는 아닙니다.
- 추가 OpenRig 게이트, 안드로이드 중계 계약 검사, 배포 사본 형식 검사·빌드가 종료 코드 0입니다.
- v0.2.8 배포 시 기존 터미널 13개, 고유 전역 번호와 번호별 실제 대상 조회, 인증 설정을 보존했습니다. 네이티브 Herdr는 재시작하지 않았습니다.
- 실제 화면의 연결·팀 목록·진입·닫기·초점 복귀·320px 폭은 v0.2.7에서 확인했습니다. v0.2.8에서는 꺼짐 요청→실제 관리 서비스 중지→웹 앱 재시작 후 꺼짐 유지→다시 켜짐까지 확인했습니다. 터미널 13개와 번호는 모두 보존했습니다.
- 비공개 실행 증거: `~/.local/state/termweave-release-0.2.7/`, `~/.local/state/termweave-release-0.2.8/`, `~/.local/state/termweave-openrig-patch-20261009/`, `~/.local/state/termweave-openrig-smoke/`.

## Pending

- 실제 Builder 수정과 Reviewer 재검토, 업무 상태 왕복 완료 확인.
- 완료된 켜기·끄기 검증 이후 시험 팀의 실제 복구 결과 확인.
- 실제 저장 상태 복구 및 같은 대화 재개 결과 확인.
- 휴대폰 설치·LTE 영상·입력·철회 검증과 전체 cmux·tmux 요구의 나머지 구현.
- 민감 정보가 없는 공개 후보와 독립 설치 검증. 공개 조건은 아직 충족하지 않았습니다.

## Constraints

기존 사용자 터미널에 입력하지 않습니다. 시험 입력은 새로 만든 전용 팀의 정확한 네이티브 대상에만 전달합니다. 로컬 운영판은 선별된 변경만 반영하며 인증 정보와 원문 터미널 내용을 공개하지 않습니다. 옵시디언 정리는 별도 P27 작업입니다.

## Reference

사용자가 제공한 로컬 OpenRig 안내서는 비공식 해설입니다. 공식 문서와 설치된 0.6.7의 실제 동작을 구현 기준으로 사용합니다. [공식 연동 명세](openrig-official-integration-spec-20261009.md)와 [전체 실행 계획](PLAN-completion-20261009.md)을 함께 확인합니다.

## 2026-10-09 추가 검증

운영판 v0.2.10에 모바일 터미널 우선 기본값을 반영했습니다. 기존 자동 설정도 터미널로 해석하며, 사용자가 선택한 채팅 화면은 패널마다 기억합니다. 관련 검사 29개와 배포 사본 타입 검사·빌드가 종료 코드 0입니다. 실제 운영판의 모바일 터치 환경에서 신규 설정·기존 자동 설정 모두 터미널 시작, 채팅 클릭, 새로고침 후 명시 선택 유지, 터미널 복귀를 확인했습니다. 배포 당시 터미널 12개와 고유 번호·인증 설정을 보존했으며 네이티브 Herdr는 재시작하지 않았습니다. 증거는 `~/.local/state/termweave-release-0.2.10/`에 있습니다.

OpenRig 전용 팀은 Builder 수정과 Reviewer 재검토를 마쳤습니다. 공식 복원 재검증은 동일 대화의 실제 식별자를 확인해 fully_restored를 반환했습니다. 앞선 부분 실패 기록도 보존했습니다. v0.2.9에는 공식 큐 조회에 팀 이름을 전달하고 결과의 소속을 검증하는 수정을 반영했습니다.

승인된 안드로이드 임시 중계와 서명된 시험 APK 다운로드가 준비됐습니다. 실제 휴대폰 설치·LTE 영상·입력은 미검증입니다. 터미널 알림의 네이티브 확장 후보는 전체 빌드 공간 부족으로 미검증이며 운영판에 포함하지 않았습니다. 전체 기능 완료나 공개 배포 완료를 뜻하지 않습니다.
