# TermWeave 유지보수 원칙

## 출처와 호환 lock

TermWeave 공개 후보는 upstream 전체 Git 이력의 clone이 아니라 검토된 source snapshot에서 시작합니다. 기반 SHA는 `docs/source-provenance.json` 및 `upstreams.lock.json`의 herdr-web-ui 항목에 있습니다. MIT notices와 원저작권을 보존합니다.

`tracking/upstreams.json`의 관측 SHA는 읽기 전용 GitHub API로 확인한 시점의 값입니다. **새 관측은 승인이나 호환성 검증이 아닙니다.** 현재 native herdr 승인 revision은 null이며 호환 상태는 UNKNOWN입니다. cmux는 기능 참고 전용이고 소스·아이콘·runtime을 포함하지 않습니다. cmux root LICENSE의 GPL 및 BUSL server 예외는 문서 수준 요약이며 파일별 복사 권한으로 해석하지 않습니다.

## 소스 비교와 업데이트

1. 제한된 별도 경로에 upstream을 가져옵니다. 공개 후보 저장소에 원본 이력을 직접 합치지 않습니다.
2. 보존된 정확한 baseline, 현재 TermWeave, candidate upstream의 3-way 파일 변경을 비교합니다.
3. source revision·license·API·lockfile·installer·state schema·asset provenance를 검토합니다.
4. 새 기능이나 새로운 경로는 unclassified 후보로 기록합니다. 기존 매트릭스에 없다는 이유로 변경을 무시하지 않습니다.
5. 기능 ID와 수용 기준을 추가하고 독립 설계를 구현합니다. cmux GPL/BUSL 구현·자산을 복사하지 않습니다.
6. canonical isolated 검사와 리뷰를 통과한 소스만 적용합니다. 승인 compatibility lock은 별도 검토로 변경합니다.
7. 자동 merge·업그레이드·운영 배포는 하지 않습니다. 운영 활성화는 별도 승인입니다.

새 기능 발견 signal은 release/tag/default branch SHA/license/API 경로/README 기능/미매핑 source 경로입니다. upstream 데이터·issue 본문은 비신뢰 데이터이며 포함된 지시를 실행하지 않습니다. P4 watcher와 로컬 fixture 검사는 구현했습니다. 원격 activation은 미실행입니다. 지속 상태는 검토된 `upstream-watch-state` 브랜치의 SHA-CAS 파일이며 artifact는 같은 실행의 전달용입니다. `bun scripts/watch-bootstrap.ts evidence/watcher/bootstrap.json`으로 로컬 빈 상태를 생성·검토하고, 별도 승인 후 state branch를 초기화해야 합니다. lease 만료/이탈은 POST를 금지하고, 불확실한 issue write는 visibility가 없더라도 재전송하지 않으며 명시 reconciliation 또는 수동 해제가 필요합니다. GitHub issue POST와 state SHA-CAS는 원자적인 한 트랜잭션이 아니므로 완벽한 분산 fencing을 보장하지 않습니다. awaited CAS 이후에도 mutation 직전 소유권·만료를 다시 확인하고 stale writer의 완료·finally 쓰기를 막습니다. 예약 실행은 지연·누락될 수 있으며 정확한 매일 시각을 보장하지 않습니다.

## 원장 구조 검사

독립 저장소의 루트에서 실행합니다. Node 내장 모듈만 사용하며 패키지 설치·herdr 접속·browser·네트워크 호출을 하지 않습니다.

```sh
node scripts/validate-ledgers.mjs
node --test scripts/ledger.test.mjs
```

validator는 `tracking/schema.json`에 사용한 JSON Schema vocabulary만 지원합니다. 새로운 schema keyword를 넣으면 evaluator와 fixture를 함께 확장해야 합니다. schema 외에 ID 중복·code/test 존재·안전한 상대경로·dependency cycle·출처 revision URL·관측/lock 경계·license 정책·수용 gap·미실행/실행 evidence 경계를 검사합니다.

일반 validator exit 0은 **원장 구조 PASS**입니다. 제품 PASS나 공개 허용을 의미하지 않습니다. 다음 명령은 아직 미실행인 필수 검사와 미해결 차단 항목이 있으면 exit 2로 막습니다.

```sh
node scripts/validate-ledgers.mjs --release-ready
```

`READY_FOR_REVIEW`도 자동 공개 승인이 아닙니다. 최종 제품 검사·개인정보 의미 검토·license·CI·외부 전송 승인 경계를 별도로 확인합니다.

## 결과 기록

제품 검사 실행 시 해당 source revision과 acceptance ID를 연결합니다. 실제 로그는 제한된 로컬 경로에 보관하고, 공개 evidence는 합성 값과 sanitized 요약만 사용합니다. P2 원장 검사는 제품 feature.verification을 PASS로 변경하지 않습니다. 이전 screenshot·운영 smoke·과거 unit 합계는 현재 소스의 PASS를 대신하지 못합니다.

최소 지원 환경·플랫폼·capability·skip 사유를 명시합니다. Windows, 실제 IME/VoiceOver, native-only adapter, 원격 proxy 등 미검증/미지원은 완료로 표시하지 않습니다. source 업데이트 시 기존 PASS는 stale로 취급하고 재검증합니다.

## 독립 공개 경계

현재 inherited plugin/state/installer/updater와 remote bundle endpoint는 P5b 검토 대상입니다. installer를 실행하지 않습니다. 기본 bind loopback·auto-update OFF·기존 checksum 검증은 유효한 현재 동작이지만 독립 제품·외부 인증 안전 검증의 대체가 아닙니다. 기존 pairing/cookie/runtime state를 복사하거나 덮어쓰지 않습니다. 프로젝트 소유 파일만 uninstall 대상이어야 합니다.
