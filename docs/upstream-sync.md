# 원본 프로젝트 업데이트 에이전트

이 도구는 cmux, Herdr, Herdr Web UI의 공식 GitHub 저장소를 매시간 확인합니다. 저장소 이름뿐 아니라 GitHub 숫자 ID를 함께 검사합니다. 커밋 SHA와 해당 시점의 라이선스 문서 해시를 저장하므로 이동한 브랜치를 고정된 근거로 오인하지 않습니다.

## 실행

```sh
python3 tools/upstream-sync/sync.py --repo "$PWD" --state "$HOME/.local/state/termweave-upstream-sync"
python3 tools/upstream-sync/sync.py --repo "$PWD" --state "$HOME/.local/state/termweave-upstream-sync" --implement
python3 -m unittest discover -s tools/upstream-sync -p 'test_*.py'
```

첫 실행은 현재 원본 커밋을 기준점으로 저장하며 작업을 만들지 않습니다. 이후에 관측한 변경부터 처리합니다. 첫 명령은 실제 원본 확인만 수행합니다. `--implement`는 설치된 Codex CLI를 실행하고 독립된 Git 복제본에서 해당 변경의 적용과 시험을 요청합니다. 실행당 에이전트 호출은 최대 한 번입니다. 설치된 Codex의 기본 인증과 기본 모델을 사용하며 전역 설정은 수정하지 않습니다. 에이전트에는 `workspace-write`, 승인 불가, 네트워크 차단 설정을 명시합니다. 호출 전에 고정한 커밋의 README와 릴리스 설명을 수집합니다. MIT·Apache 원본은 변경된 텍스트 파일의 전체 내용도 제한된 크기로 수집합니다. 각 자료에는 경로, 커밋, 내용 해시와 라이선스 해시를 붙입니다. cmux는 README와 공개 문서만 수집하며 코드와 자산은 전달하지 않습니다. 파일이 너무 크거나 자료가 불충분하면 `evidence-blocked`로 중단합니다. 설명이 부족한 변경은 추측하여 완료 처리하지 않고 검토 대상으로 남깁니다.

서비스는 명시적인 설치 명령을 실행해야 시작됩니다.

```sh
python3 tools/upstream-sync/service.py install --repo "$PWD" --state "$HOME/.local/state/termweave-upstream-sync" --implement
python3 tools/upstream-sync/service.py status
python3 tools/upstream-sync/service.py disable
```

설치 시 실제 bun·node·herdr·tmux·git·codex 경로에서 버전 확인 명령을 실행하고 각 실행 파일 디렉터리를 서비스 PATH에 저장합니다. 하나라도 없거나 실행되지 않으면 설치를 중단합니다. 설치 직후 한 번 실행하고 이후 매시간 실행합니다. 비활성화해도 후보 코드와 증거는 유지합니다. Mac이 꺼져 있으면 실행하지 못합니다. 이 도구의 파일이 존재한다는 사실만으로 서비스 실행을 증명할 수는 없습니다.

## 처리와 제한

1. 원본 관측값과 작업 상태를 별도로 기록합니다. 커밋과 릴리스 목록의 해시를 함께 작업 키로 사용합니다. 같은 커밋에서 새 릴리스가 나오거나 설명이 바뀌어도 별도 작업을 만듭니다. 동일한 관측은 중복 처리하지 않습니다.
2. 대상 저장소에 커밋되지 않은 변경이 있으면 `baseline-dirty`로 대기합니다. 기존 변경을 무시한 HEAD 복제는 하지 않습니다. 릴리스 기준이 커밋되고 작업 폴더가 깨끗해지면 다시 진행합니다. 잠금으로 동시 실행을 막습니다. 실패는 지수 간격으로 재시도하며 세 번 실패하면 수동 검토를 기다립니다.
3. 라이선스 변경, 원본 기록의 분기, API 비교 결과의 잘림은 자동 적용을 막습니다.
4. 후보는 독립 복제본에 생성합니다. 작업 중인 체크아웃, 실행 중인 터미널, 인증 설정, 운영 서비스에는 배포하지 않습니다.
5. Codex 호출 전에 원본 체크아웃의 개인정보 검사를 실행합니다. 검사가 없거나 실패하면 `privacy-blocked`로 중단하며 자동 재시도하지 않습니다. 에이전트가 인증, 배포, 의존성, scripts 전체, 기존 테스트, 검증 설정, 버전을 수정하면 자동 승격을 거부합니다. 새 검증 코드는 `tools/upstream-adaptation-tests/`에만 추가합니다.
6. 기존 전체 검사, `--deployment` 전체 기능 검사, `gates/public_privacy_gate.sh`를 모두 통과해야 로컬 후보 버전을 올립니다. 해당 개인정보 검사가 없으면 실패합니다.
7. 버전을 올린 다음 세 검사를 다시 실행합니다. 버전 변경은 `package.json`과 존재하는 `shared/product.ts`에 함께 반영합니다.
8. 기본값에서는 통과한 후보가 `ready-for-review` 상태입니다. `--promote-local`을 명시하면 전용 자동화 기준 저장소에만 검증된 후보를 커밋하고 빠른 전진 방식으로 통합합니다. GitHub 공개와 운영 배포는 수행하지 않습니다.

cmux는 동작 참고 대상으로만 사용합니다. GPL/BUSL 코드와 자산을 MIT 프로젝트에 복사하지 않습니다. Herdr와 Herdr Web UI도 원본 라이선스와 저작권 고지를 보존해야 합니다. 이 정책은 법적 호환성의 자동 판정을 의미하지 않습니다.

검증과 에이전트 출력은 민감한 내용을 포함할 수 있으므로 원문을 저장하지 않습니다. 종료 코드와 출력 해시만 기록합니다. 상태 디렉터리는 개인 전용이며 공개 저장소에 넣지 않습니다. `state.json`의 오류에는 예외 종류만 기록합니다.

## 완료 증거의 범위

테스트는 잘못된 참조, 중복 갱신, 오래된 관측, 라이선스 변경, 재시도 제한, 출력 비저장, 검사 실패 시 버전 유지, 누락된 개인정보 검사, 보호 파일 변경 거부, 상태 파일 권한을 검사합니다. 원본 세 곳의 실제 공개 API 조회와 첫 실행 작업 0건을 확인했습니다. 같은 Codex 실행 옵션으로 임시 저장소에 지정한 파일을 생성하는 시험도 종료 코드 0과 파일 내용 일치로 확인했습니다. 실제 원본 기능의 전체 적용과 승격은 별도 작업 결과로 검증해야 합니다. 전체 기능 동등성과 공개 검사가 미완료인 동안 자동 승격이 중단되는 것은 의도한 동작입니다. 이 도구만으로 원본의 모든 미래 기능이 자동으로 완성된다고 주장하지 않습니다.

공식 출처: [cmux](https://github.com/manaflow-ai/cmux), [Herdr](https://github.com/herdrdev/herdr), [Herdr Web UI](https://github.com/devswha/herdr-web-ui).

추가 검증에서 테스트 21개가 통과했습니다. 라이브 자료 묶음 수집 시험은 GitHub 공개 API 호출 제한(HTTP 403)으로 중단되어 전체 묶음 수집 성공으로 보고하지 않습니다. 인증 정보를 추가하거나 제한을 우회하지 않았습니다. 이 경우 에이전트 호출에 도달하지 않으며 재시도 상태로 남습니다.

## 전용 저장소의 자동 기능 통합과 버전 관리

자동 통합은 기본적으로 꺼져 있습니다. 다음 명령으로 커밋이 완료된 깨끗한 릴리스 저장소를 개인 상태 경로 아래의 전용 기준 저장소로 복제합니다. 개발 작업 폴더나 운영 플러그인을 통합 대상으로 지정할 수 없습니다.

```sh
python3 tools/upstream-sync/sync.py --repo <커밋한-릴리스-저장소> --state <개인-상태-경로> --init-baseline
python3 tools/upstream-sync/sync.py --repo <개인-상태-경로>/baseline --state <개인-상태-경로> --implement --promote-local
python3 tools/upstream-sync/service.py install --repo <개인-상태-경로>/baseline --state <개인-상태-경로> --implement --promote-local
```

전용 저장소에는 외부 Git 원격 주소가 없습니다. 도구는 경로, 전용 표식, 브랜치 이름을 검사합니다. 후보를 만든 이후 기준 커밋이나 작업 파일이 달라지면 통합을 차단합니다. 검사 파일의 변경 전후 해시를 비교하며 전체 기능 검사와 개인정보 검사가 모두 통과해야 합니다.

실제 기능 변경이 있으면 후보 버전을 올립니다. 적용 대상이 아니라고 판단한 경우에는 판단 근거와 원본 참조가 있어야 하며 기능 파일 변경이 없어야 합니다. 이 경우 버전은 유지하고 확인 기록만 커밋합니다. 두 경우 모두 `docs/upstream-integrations.json`과 `docs/upstream-CHANGELOG.md`에 근거를 남긴 뒤 검사를 다시 실행합니다. 중복된 원본 리비전이나 후보 버전은 거부합니다.

검증을 통과한 후보는 커밋한 뒤 전용 기준 브랜치에 빠른 전진으로만 통합합니다. 통합 전 커밋은 `refs/termweave/rollback/` 아래에 보존합니다. 실행 상태에는 통합 커밋과 복구 참조를 기록합니다. 이 과정은 전용 저장소의 자동 기능 반영과 로컬 버전 관리입니다. 공개 저장소 게시나 실행 중인 제품의 자동 배포를 의미하지 않습니다. 전체 기능 검사가 아직 실패한다면 자동 통합도 진행되지 않습니다.

자동 구현으로 추가한 시험은 기존 앱 검사에 맡기지 않습니다. 신뢰하는 실행기가 `tools/upstream-adaptation-tests/*.test.ts`를 직접 선택하여 Bun으로 실행합니다. 보고서의 임의 명령 문자열은 실행하지 않습니다. 기본 시험 준비 코드는 비우고, 운영 터미널 접근을 막는 macOS 제한 환경에서 단위 검사를 수행합니다. 시험이 없거나 실패하면 통합을 차단합니다. 개인정보 검사 구현과 승인 목록도 변경 금지 대상이며, 후보의 심볼릭 링크와 숨겨진 산출물 변경을 거부합니다.

## 차단된 작업의 복구

`baseline-dirty`는 작업 폴더가 깨끗해지면 다음 실행에서 자동 복구합니다. `privacy-blocked`와 `evidence-blocked`는 자동 재시도하지 않습니다. 개인정보 문제와 자료 부족 원인을 먼저 해결하고 해당 작업만 명시적으로 다시 대기 상태로 옮깁니다. 라이선스 변경 차단에는 이 명령을 사용하지 않습니다.

아래 명령은 서비스와 같은 잠금을 획득하고, 깨끗한 기준 저장소의 개인정보 검사를 다시 통과한 뒤 지정한 작업만 초기화합니다. 서비스가 작업 중이면 잠금 오류가 발생하므로 완료 후 다시 실행합니다. 이후 시간별 실행이 해당 작업을 처리합니다.

```sh
python3 - <개인-상태-경로> <state.json의-정확한-작업-키> <<'PY'
import fcntl, json, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1]).resolve()
key = sys.argv[2]
repo = root / 'baseline'
with (root / 'lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    dirty = subprocess.run(['git', '-C', str(repo), 'status', '--porcelain'], capture_output=True, check=True)
    if dirty.stdout:
        raise SystemExit('기준 저장소의 변경을 먼저 정리해야 합니다.')
    check = subprocess.run(['bash', 'gates/public_privacy_gate.sh'], cwd=repo, capture_output=True)
    if check.returncode:
        raise SystemExit('개인정보 검사가 통과하지 않아 작업을 재개하지 않습니다.')
    path = root / 'state.json'
    state = json.loads(path.read_text())
    job = state['jobs'][key]
    if job['status'] not in ('privacy-blocked', 'evidence-blocked', 'failed'):
        raise SystemExit('이 상태는 수동 복구 대상이 아닙니다.')
    job.update(status='pending', attempts=0, nextAttempt=0)
    job['manualRecoveryCount'] = job.get('manualRecoveryCount', 0) + 1
    temp = path.with_suffix('.recovery.tmp')
    temp.write_text(json.dumps(state, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)
    print('지정한 작업을 다시 대기 상태로 옮겼습니다.')
PY
```
