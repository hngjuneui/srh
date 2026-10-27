# 배드민턴 스코어보드

태블릿 크롬에서 쓰는 독립 점수판입니다. Rally Lab(분석기)과 코드·배포가 완전히 분리되어 있고, 서버 없이 정적 파일만으로 동작합니다.

## 조작

| 조작 | 동작 |
|---|---|
| 팀 영역 탭 또는 아래로 쓸기 | 그 팀 +1 |
| 팀 영역 위로 쓸기 | 그 팀의 이번 게임 최근 득점 1개 취소 |
| 리모컨 짧게 / 길게(기본 0.7초) | 우리 팀 +1 / 상대 팀 +1. 누르는 동안 반복 입력은 한 번으로 묶음 |
| 되돌리기 / 코트 교대 | 양 팀 통틀어 마지막 입력 취소 / 좌우 교환(팀 기록은 유지) |

- 모든 득점·취소는 입력 즉시 이 기기(localStorage)에 시간순으로 저장되고, 새로고침 후 이어서 진행합니다. 기록 화면에서 CSV/JSON으로 내보낼 수 있습니다.
- 리모컨 화면에서 수신 키(key/code/repeat/간격)를 확인하고 버튼을 등록합니다. 볼륨 키는 크롬이 웹페이지에 전달하지 않을 수 있습니다.
- 서버 동기화(다른 기기에서 기록 보기)는 아직 없습니다. 이벤트마다 고유 ID를 저장해 두어 이후 중복 없는 동기화에 쓸 수 있습니다.

## 배포 (Cloudflare Workers, 새 Worker `badminton-scoreboard`)

```powershell
cd scoreboard
npm ci
npx wrangler login
npm run deploy
```

처음 배포하면 `https://badminton-scoreboard.<계정 서브도메인>.workers.dev` 주소가 만들어집니다. 기존 `rally-lab`, `robot` Worker는 건드리지 않습니다.

Git 자동 배포를 원하면 Cloudflare 대시보드에서 새 Worker를 이 저장소에 연결하고 **Root directory를 `/scoreboard`**, Deploy command를 `npx wrangler deploy`로 지정합니다.

## 테스트

```powershell
npm test                                         # 규칙·취소·리모컨 판정
python -m http.server 8811 --directory public    # 다른 창에서
node tests/ui.mjs                                # 브라우저 조작(Playwright 필요)
```

## 파일

- `public/core.js` — 경기 규칙. 점수는 저장하지 않고 이벤트 기록에서 매번 다시 계산합니다.
- `public/remote.js` — 리모컨 짧게/길게 판정과 반복 입력 묶기.
- `public/app.js` — 화면, 터치, 저장, 기록·설정 창.
