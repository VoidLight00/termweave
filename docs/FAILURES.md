# TermWeave 실패·미확정·공개 차단 원장

기계 판독 원본은 `tracking/failures.json`입니다. 제품 기능 시험은 P2에서 실행하지 않았습니다. 현재 공개 상태는 **BLOCKED**입니다. 과거 결과는 최신 런타임 증거가 아니며 P2 schema PASS는 아래 문제를 해결하지 않습니다.

## 렌더링 증상: 미재현

| ID | 상태 | 수용 기준 |
|---|---|---|
| RENDER-SLIDER-001 | 사용자 관찰, 원인 미확정 | AC-RENDER-SLIDER, AC-RENDER-CJK |
| RENDER-SINGLE-001 | 단일 오른쪽 잘림, 원인 미확정 | AC-RENDER-SINGLE, AC-RENDER-CJK, AC-GEOMETRY-ROLES |

`H-FLEX-SHRINK`·`H-FIT-DELAY`·`H-SHARED-GEOMETRY`를 별도 가설로 유지합니다. flex 축소와 xterm mount rect, 120ms settle 이후 일시/지속 현상, 공유 PTY와 로컬 grid를 분리합니다. 하단 마지막 행·상태줄·cursor도 검사합니다. 기존 도킹 테스트만으로 마지막 셀 표시를 입증했다고 취급하지 않습니다. 수정 전 FAIL과 수정 후 PASS를 같은 합성 fixture에서 기록해야 합니다.

## 과거 실패: 현재 재검증 전

- `LEGACY-INTEGRATION-001`: 이전 integration 기록 187 pass/9 fail. phone startup·Codex binding·PATH·/proc를 제품/환경 문제로 분류해야 합니다.
- `LEGACY-PASTE-001`: terminal Control+v 기존 실패. 변경 전에도 재현됐다는 과거 보고를 통과로 바꾸지 않습니다.
- `QA-PORTABILITY-001`: private home gate와 Mac browser path 의존은 현재 소스에 남아 있습니다. P3에서 저장소 gate와 portable resolver로 교체합니다.

## 공개 검토 추적

검토 대상은 P1 source snapshot입니다. 검토 ID는 유지하되 제한된 로컬 보고서 경로는 공개 문서에 싣지 않습니다.

| 검토 ID | 분류 | 요약·해제 조건 |
|---|---|---|
| PUB-001 | 확인된 공개 차단 | upstream plugin/config/state/install identity가 남음. 독립 namespace·공존·opt-in migration 필요 |
| PUB-002 | 확인된 공개 차단 | installer 노출/upgrade/Tailscale와 executable update source 정책 미완료. **auto-update 기본 OFF이며 download checksum 검증은 존재함** |
| PUB-003 | 확인된 공개 차단 | 제외 media의 문서 참조·무조건 copy가 남음. synthetic media 또는 참조 제거 후 site/link 검사 |
| PUB-004 | 확인된 공개 차단 | 개인 gate·Mac path 의존. portable 격리 regression 필요 |
| PUB-005 | 코드상 확인된 보안 위험 | token/pairing 없는 reachable 비-Funnel 접근에 full access 가능. **기본 bind는 loopback**. 외부 opt-in 인증 강제 검사 필요. 실제 외부 노출/악용은 검증하지 않음 |
| PUB-006 | 검증 필요 | credential/cookie/proxy 공존, pairing lifecycle, observe, invalid auth, redaction, fragment 문서 검사 |
| PUB-007 | 출처 UNKNOWN 차단 | artwork 재사용 권한 미확인. 독립 artwork 또는 출처 증명 필요 |
| PUB-008 | 출처 UNKNOWN 차단 | runtime bundle·font·complete notices. SBOM·checksum/source mapping·재현 build 또는 미지원 제외 필요 |
| PUB-009 | 개인정보 UNKNOWN 차단 | video frame·synthetic fixture·최종 build/source-map 의미 검토 미완료 |
| PUB-010 | CONFIRMED_DISABLED | 현재 inherited publishing workflow는 disabled, 활성 YAML 0개. **현재 활성 취약점으로 표시하지 않음**. 검토된 최소 권한·full-SHA replacement 전 비활성 유지 |

P1 검토에서 **확정된 실제 secret·개인 transcript 유출은 찾지 못했습니다.** 이것은 최종 privacy clearance가 아닙니다. code·전체 예정 ref/history·build·source-map·binary metadata를 다시 검토해야 합니다. 승인된 maintainer identity·MIT 원저작권·THIRD_PARTY_NOTICES·upstream provenance·유효 attribution은 그대로 보존합니다.

## 중단 규칙

필수 기능 검사가 NOT_RUN/FAIL/UNKNOWN/BLOCKED이거나 release_blocker가 미해결이면 공개하지 않습니다. `CONFIRMED_DISABLED` workflow 상태는 미해결 live 위험으로 부풀리지 않습니다. 아직 제품 테스트를 실행하지 않은 소스에 과거 PASS를 이식하지 않습니다. 실제 원인·실행 evidence·tested revision을 기록한 뒤에만 상태를 변경합니다.
