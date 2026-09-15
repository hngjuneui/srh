# 조사 메모 — 2026-09-14

## 코칭 출처와 제품 적용

1. [Badminton Insight — Forehand Clear](https://badminton-insight.com/how-to-do-a-forehand-clear-in-badminton/)
   - 코치가 설명한 준비·회전·스트라이크·연습 진행 순서를 참고.
   - 일반·수비·공격 클리어가 다름. 특정 각도/거리 하나를 보편적 정답으로 적용하지 않음.
   - 제품 적용: 일반 포핸드 연습 모드, 한 동작 전체 관찰, 손잡이·접촉 미확인 표시.
2. [University of Georgia — Forehand & Backhand Clear](https://open.online.uga.edu/badminton/chapter/forehandandbackhandclear/)
   - 측면 준비, 머리 위 준비, 비라켓 팔 균형, 타격 후 연결을 설명.
   - 제품 적용: 준비/높은 타격/연결된 스윙의 코칭 카드. 검색에서 확인했으며 직접 열기는 403 응답.
3. [Badminton Wales — BWF Shuttle Time, Couch to Court](https://badminton.wales/wp-content/uploads/2022/06/couch-to-court-3158.pdf)
   - 후방에서 상대 후방으로 보내는 목적, 단계별 연습을 참고.
   - 제품 적용: 단일 정지 포즈 판정을 넘어 동작 전후를 관찰하는 개발 방향.

인터넷 콘텐츠를 대량 수집하거나 저작권 영상을 학습 데이터로 가져오지 않았습니다. 코칭 내용을 참고한 제품 기준이며, 별도 자세 평가 신경망을 학습했다는 뜻이 아닙니다.

## 유사 앱에서 참고한 동선

| 서비스 | 확인한 기능/범위 | 적용 |
|---|---|---|
| [Badminton Scoreboard / SeedsJP](https://play.google.com/store/apps/details?hl=en&id=com.naoyaono.badminton_score_board) | 복식, 선수명, 득점/차감, 코트 교체, 서브 표시 | 큰 팀별 숫자, 팀 이름 수정, 취소, 가까운 팀 설정, 서버 표시 |
| [AI Scoring App](https://www.aiscoringapp.com/) | 음성/클릭 점수 조작, reverse point | 경기 중 비접촉 수정의 접근성을 참고. 이 프로토타입은 X 자세를 사용 |
| [Bodet SCOREAPP 매뉴얼](https://static.bodet-sport.com/images/stories/EN/support/Pdfs/manuals/Scoreapp/608438-ScoreApp-User-Manual.pdf) | 종목별 점수, 되돌리기 | 점수 이력에서 전체 상태 재계산 |
| [SwingVision](https://swing.vision/) | 공식 제목에서 테니스·피클볼 AI 통계를 확인. 웹 본문은 JS 전용으로 기능 상세 검증 제한 | 배드민턴 자동 심판의 검증 사례로 사용하지 않음 |

각 서비스가 영상을 보고 자동으로 배드민턴 승자를 알아낸다고 가정하지 않았습니다. 앱 화면/브랜드를 복제하지 않고 정보 우선순위와 조작 흐름만 참고했습니다.

## 영상 분석 연구

- [Automated Hit-frame Detection for Badminton Match Analysis](https://arxiv.org/abs/2307.16000): 랠리 분할, 선수/코트, 셔틀 방향, 타격 시점처럼 문제를 분해하는 접근을 참고. 논문 결과를 이 앱 정확도로 옮기지 않음.
- [A New Perspective for Shuttlecock Hitting Event Detection](https://arxiv.org/abs/2306.10293): 짧은 영상 구간의 시간 정보로 타격 이벤트를 인식하는 후속 방향.
- [MediaPipe PoseLandmarker](https://ai.google.dev/edge/api/mediapipe/python/mp/tasks/vision/PoseLandmarker): 사전 학습 인체 랜드마크 추론 API.
- [OpenCV Optical Flow](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html): 추적 확장 참고. 현재 코드는 광류 모델이 아니라 프레임 차분을 사용함.
- [WebRTC TURN](https://webrtc.org/getting-started/turn-server): 이동통신망/공유기 뒤에서 직접 연결 불가 시 중계 필요.

## 현장 평가표

실제 영상 확보 후 아래 항목을 기록합니다. 지금은 빈 기준표이며 실제 성능 수치는 없습니다.

| 항목 | 수집할 값 |
|---|---|
| 원격 연결 | 휴대폰/OS, PC CPU/GPU, 통신사, 체육관, 업로드 Mbps, 왕복+분석 p50/p95, 분석 fps, 10분 끊김 횟수 |
| 랠리 분할 | 실제 랠리 수, 누락, 과검출, 시작/끝 오차, 준비·줍기 포함 비율 |
| 자동 점수 | 자동 판정 수, 정확한 수, 보류 수, 옵션별 오판, 경기 누적 점수 차이 |
| X 수정 | 네 사람 각각의 시도/성공, 오작동, 중복, 가림·원거리, 랠리 중 오작동 |
| 클리어 관찰 | 실제 스트로크와 후보의 일치, 준비 관측 여부, 타점 식별 가능/불가, 코치 비교 |
| 하이라이트 | 선정 구간 수, 길이, 불필요 구간, 영상 이어보기/출력 정상 여부 |

스코어의 `strength`는 규칙의 상대적 강도입니다. 학습·보정된 확률이 아닙니다. 같은 포즈에서 파생된 마지막 스윙/줍기 신호를 두 개의 독립 근거로 세지 않습니다.
