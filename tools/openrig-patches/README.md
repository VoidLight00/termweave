---
title: OpenRig 작업 인수인계 동시 변경 검사 패치
created_at: "2026-10-09T02:00:25+09:00"
updated_at: "2026-10-09T02:00:25+09:00"
saved_at: "2026-10-09T02:00:25+09:00"
timezone: Asia/Seoul
author: Codex
project: TermWeave
tags: [AI, openrig, safety]
status: candidate-tested-not-deployed
upstream_version: 0.6.7
license: Apache-2.0
---

# OpenRig 작업 인수인계 동시 변경 검사

설치된 공식 버전의 handoff는 원본을 읽은 뒤 작업 번호만으로 갱신합니다. TermWeave는 사용자가 확인한 담당자·상태·수정 시각이 같은 경우에만 전달하도록 별도 후보 패치를 제공합니다.

`build_candidate.py --source <설치 패키지> --output <새 후보 경로>`는 입력 해시를 확인한 뒤 사본만 변경합니다. 현재 실행 중인 원본은 수정하지 않습니다. 공식 Apache-2.0 LICENSE 파일은 후보에 보존됩니다. 입력·출력 파일 해시는 두 JSON 원장에 있습니다.

검사: `node tools/openrig-patches/test_candidate.mjs <후보 경로>`

실제 후보의 Hono 경로·공식 저장소 클래스·SQLite를 사용하여 정상 전달, 다른 담당자 거부, 오래된 수정 시각 거부, 조회 후 변경 경쟁 거부, 브라우저의 claimed:v1 기록 전달을 확인했습니다. 5개 검사·17개 확인 항목이 통과했습니다. 에이전트나 운영 관리 프로그램은 실행하지 않았습니다.

후보 API는 GET `/api/queue/termweave-capabilities`에서 `handoffCompareAndSwap: 1`을 반환합니다. POST `/api/queue/:id/handoff`의 `expectedCurrent`에 destinationSession·state·tsUpdated를 전달하면 담당자 일치와 원자적 SQL 조건을 검사합니다. 기존 호출은 그대로 유지됩니다. TermWeave는 후보 기능 확인 없이 이 변경 기능을 호출하지 않습니다.

이 패치는 일반 에이전트의 신원을 대신하지 않습니다. 브라우저 사용자 작업은 `human@kernel` 및 `claimed:v1`로 남깁니다. 토큰·계정·기존 설정·실행 터미널은 변경하지 않습니다.

## 구조화된 터미널 연결 확장

`extend_terminal_candidate.py <후보 경로>`는 별도 후보의 Herdr 연결 코드만 확장합니다. `terminal-output-hashes.json`에 입력·출력 해시를 기록합니다. `layout.apply`의 응답 트리를 요청 트리와 구조적으로 대조한 뒤, 응답의 `pane_id`와 `pane.list`의 실제 `terminal_id`를 연결합니다. 이름이나 명령 문자열은 연결 근거로 사용하지 않습니다. TermWeave 서버는 현재 네이티브 목록의 작업공간·탭·패널·터미널 식별자를 다시 대조하고 전역 패널 번호를 붙입니다.

검증 명령은 `node tools/openrig-patches/test_terminal_candidate.mjs <후보 경로>`입니다. 실제 후보 모듈을 불러와 중복 이름·다른 탭·구조 변경·누락 패널을 시험하고, 연결 코드의 모의 왕복 요청을 검증합니다. 실기 네이티브 왕복 검증과 설치본 반영은 별도 단계입니다.
