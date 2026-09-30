# Colyseus 단일 방 배포

게임은 Colyseus 서버 한 프로세스에서 `flocking-main` 방 하나를 미리 만듭니다. 최대 30명이 접속하고, 사람과 AI를 합쳐 살아 있는 편대를 최소 5개로 유지합니다. 접속이 끊기면 해당 편대는 AI가 이어서 조종합니다. 다시 접속하면 새 식별자와 드론 4기로 출격합니다.

## 로컬 확인

Node.js 22 이상에서 저장소 루트의 의존성을 설치한 뒤 다음 순서로 실행합니다.

```sh
npm install
npm run build
npm test
npm start
```

`http://localhost:2567/health`에서 방이 준비됐는지 확인하고, 게임은 `http://localhost:2567/`에서 엽니다. 기본 `multiplayer-config.json`의 `endpoint`는 빈 문자열이며 브라우저가 현재 사이트와 같은 주소로 접속합니다. 서버는 빌드된 `dist/multiplayer/client`에 있는 정해진 정적 파일만 제공합니다.

클라이언트는 Colyseus SDK의 `joinById('flocking-main', { nickname, protocol: 1 })`로 들어갑니다. 입장 후 `resync` 메시지를 보내면 `welcome`, `snapshot`, `counts`를 다시 받습니다. 입력은 `{ sequence, input }` 형태의 `input` 메시지로 보내며, 사망 후 `respawn` 메시지로 새 편대를 받습니다. 서버 메시지는 `welcome`, `snapshot`, `frames`, `counts`, `result`, `room-error`입니다. `frames`는 평상시 3틱씩 약 초당 20번 전달되고 60틱마다 서버 지문이 붙습니다. 입장·퇴장 등으로 현재 묶음을 먼저 전송할 때는 더 작은 묶음이 추가됩니다.

## Colyseus Cloud

Cloud의 빌드 명령은 기본 `npm run build`입니다. 저장소 루트의 `ecosystem.config.js`가 PM2에서 `server/colyseus.mjs` 하나만 fork 모드로 실행합니다. `package.json`은 CommonJS로 두어 PM2 설정을 읽게 하고, 실제 게임과 빌드 스크립트는 `.mjs`입니다. 기존 Sites Worker 결과물은 `dist/server/package.json`을 통해 ESM으로 유지합니다.

1. 로컬 빌드와 두 브라우저 연결 테스트를 마칩니다.
2. 검토한 변경을 `github.com/skaas/flockingio` 저장소에 올립니다. 이 단계는 별도의 명시적 요청에 따라 진행합니다.
3. Colyseus Cloud에서 지역과 서버 사양을 선택하고 서버를 생성합니다. 생성 시 과금이 시작됩니다.
4. 저장소 루트에서 `npx @colyseus/cloud deploy --remote origin`으로 배포하고 브라우저에서 해당 앱을 선택합니다.
5. 배포 주소의 `/health`와 실제 두 브라우저 접속을 확인합니다.

Cloud의 첫 배포에서 생기는 `.colyseus-cloud.json`에는 재배포 권한이 있어 Git에서 제외합니다. 서버 재시작이나 배포 시 진행 중인 전장은 새로 시작합니다. 현재 방 상태를 저장하는 데이터베이스나 재접속 조종권 복구는 없습니다. 사용자 증가에 맞춘 서버 사양은 실제 부하 테스트 결과로 정합니다.

기존 Sites 빌드는 `npm run build:sites`, 기존 로컬 순위 서버는 `npm run start:legacy`입니다. Sites 빌드도 브라우저 SDK와 `multiplayer-config.json`을 생성합니다. Sites처럼 별도 도메인에서 게임을 제공할 경우 빌드 전에 `COLYSEUS_ENDPOINT`를 Cloud 주소로 설정해야 하며, 별도 도메인의 브라우저 접근 허용도 확인해야 합니다. 한 주소에서 게임과 방을 함께 제공하는 기본 구성은 이 추가 설정이 필요 없습니다.

## 배포 전 검증 — 2026-09-30

- 전체 자동 테스트 406개 통과, 실패 0개.
- 멀티플레이 빌드와 기존 Sites 빌드 성공. 생성된 Sites Worker의 ESM 로딩도 확인했습니다.
- 로컬 서버에 실제 Colyseus SDK 연결 30개가 같은 방으로 입장했습니다. 31번째 연결과 클라이언트의 추가 방 생성은 거부됐습니다. 이 중 두 클라이언트가 전장을 계산하며 367프레임과 서버 지문 8회를 검증했고 오류는 없었습니다.
- 두 Chromium 화면에서 자기 편대 구분, 전투 지속, 사망 결과, 드론 4기 재출격, 메뉴를 열어도 전투가 계속되는 동작을 확인했습니다.
- 접속 중단 후 조작이 차단되고, 수동 재입장 시 새 편대 ID와 드론 4기를 받는 것을 확인했습니다. 퇴장한 기존 편대의 AI 전환은 SDK 통합 검사에서도 확인했습니다.
- 화면 갱신을 잠시 멈춰 쌓인 39프레임을 따라잡고, 의도적으로 상태를 바꿔 발생시킨 지문 불일치를 새 스냅샷으로 복구했습니다. 최종 브라우저 콘솔 오류는 0개였습니다.
- `/health`와 게임·SDK 파일 응답을 확인했고, 비밀 설정 및 서버 소스 경로는 404로 차단됐습니다.

위 결과는 로컬 기능 검증입니다. Cloud 서버 생성·결제·배포는 아직 수행하지 않았으며, 특정 Cloud 사양의 지연이나 수용 인원을 보장하는 부하 측정은 아닙니다. 배포 후 실제 주소에서 접속 및 부하를 다시 확인해야 합니다.

Cloud 배포 절차: [Colyseus 공식 문서](https://docs.colyseus.io/cloud).
