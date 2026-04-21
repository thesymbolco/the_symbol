# The Symbol — 프로젝트 운영 노트

모든 운영/배포/DB/페이지 메모를 이 문서 하나에 모읍니다. 새로운 내용은 이 파일에 덧붙여 주세요.

- 레포: https://github.com/thesymbolco/the_symbol.git
- 프론트엔드: `app/` (Vite + React + TypeScript)
- 백엔드: Supabase (Auth + Postgres + RLS)
- 배포: Vercel (main 브랜치 푸시 시 자동 재배포)

---

## 목차

1. [자주 쓰는 Git / 배포 명령](#1-자주-쓰는-git--배포-명령)
2. [Supabase 초기 설정 (최초 1회)](#2-supabase-초기-설정-최초-1회)
3. [로그인 / 팀 계정 관리](#3-로그인--팀-계정-관리)
4. [SQL 마이그레이션 기록](#4-sql-마이그레이션-기록)
5. [로컬 개발 명령](#5-로컬-개발-명령)
6. [페이지별 UX 메모](#6-페이지별-ux-메모)
7. [트러블슈팅](#7-트러블슈팅)

---

## 1. 자주 쓰는 Git / 배포 명령

### 기본 흐름 (변경 → 반영)

```bash
# 작업 디렉토리 확인
cd "/Users/parkcg/The Symbol_Edit"

# 변경된 파일 확인
git status
git diff

# 전체 스테이징 & 커밋
git add -A
git commit -m "feat: 설명 간결하게"

# main 으로 푸시 → Vercel 자동 배포
git push origin main
```

### 브랜치 / 동기화

```bash
# 원격 최신 받아오기
git pull origin main

# 새 브랜치 만들어서 작업
git checkout -b feat/설명
# ...작업 후
git push -u origin feat/설명
```

### 실수 복구

```bash
# 아직 커밋 안 한 변경 되돌리기 (파일 단위)
git checkout -- <파일경로>

# 마지막 커밋 메시지만 수정 (푸시 전)
git commit --amend -m "새 메시지"

# 마지막 커밋 취소하되 변경은 유지
git reset --soft HEAD~1

# 특정 파일 이전 버전으로 복구
git log --oneline -- <파일경로>
git checkout <커밋해시> -- <파일경로>
```

### Vercel 관련

- `git push origin main` 하면 Vercel이 자동으로 빌드/배포.
- 수동 트리거가 필요하면 Vercel 대시보드 → Project → Deployments → Redeploy.
- 환경변수(`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`)를 바꾸면 **반드시 Redeploy** 해야 반영됨.

---

## 2. Supabase 초기 설정 (최초 1회)

### 2-1. SQL 마이그레이션 실행

Supabase Dashboard → **SQL Editor** → New query → 다음 파일들을 **순서대로** 복사/붙여넣어 Run:

1. `app/supabase/schema.sql` — 기본 테이블(`companies`, `company_members`, `company_documents`)과 RLS
2. `app/supabase/migrations/2026-04-16-team-management.sql` — `profiles` 테이블 + 팀 관리 RLS
3. `app/supabase/migrations/2026-04-16-team-management-fix.sql` — profile insert RLS 완화 패치

이미 실행된 스크립트를 다시 실행해도 대부분 `if not exists` / `drop policy if exists` 구문이 있어 안전함.

### 2-2. Supabase Auth 설정

**Authentication → Providers → Email**
- **Allow new users to sign up**: ON (관리자가 앱 내에서 계정을 만들 때 이 설정 필요)
- **Confirm email**: OFF (가짜 이메일 도메인 `thesymbol.local`을 쓰므로 확인 메일이 가지 않음)

### 2-3. 초기 owner 계정 (최초 1회 수동)

아직 owner가 아무도 없는 상태에선 Supabase 대시보드에서 수동으로 만들어야 합니다. 그 이후부터는 앱 내에서 모두 처리.

1. **Authentication → Users → Add user → Create new user**
   - Email: `<아이디>@thesymbol.local` (예: `admin@thesymbol.local`)
   - Password: 원하는 비밀번호
   - **Auto Confirm User** 체크
2. **Table Editor → `companies`** → 없으면 회사 행 1개 만들기
3. **Table Editor → `company_members`** → Insert
   - `company_id`: 위 회사 id
   - `user_id`: 방금 만든 유저 UID (Users 화면에서 확인)
   - `role`: `owner`
   - `status`: `active`
4. **Table Editor → `profiles`** → Insert
   - `user_id`: 동일 UID
   - `username`: 로그인 아이디 (예: `admin`)
   - `display_name`, `phone`, `title`, `email` 원하는 값

이제 앱에서 아이디 `admin` + 비밀번호로 로그인하면 "팀 관리" 페이지가 활성화됩니다.

### 2-4. 프론트 환경변수

`app/.env.local` (Git에 커밋되지 않음):

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

Vercel에도 같은 값을 Project Settings → Environment Variables 에 추가하고 Redeploy.

---

## 3. 로그인 / 팀 계정 관리

### 로그인 흐름

- 사용자는 아이디 `park` 입력 → 내부적으로 `park@thesymbol.local` 로 변환 → Supabase `signInWithPassword` 호출
- 세션은 브라우저에 유지. 이후 API 호출 시 RLS로 소속 회사 데이터만 접근 허용.
- 아이디 규칙: 영문/숫자/`._-`, 3~32자

### 앱 내 팀 관리

owner로 로그인 → **직원·메모 → 팀 관리** 탭.

**계정 만들기**
- 이름, 직책, 휴대폰, 실제 이메일, 아이디, 비밀번호, 역할 입력 → **계정 만들기**
- 생성 즉시 현재 회사의 구성원으로 연결됨.

**수정 / 비활성화 / 제거**
- 수정: 이름, 직책, 휴대폰, 이메일, 역할, 상태(active/inactive)
- 제거: 회사 소속에서 제외 (auth.users는 남음; 완전 삭제는 Supabase 대시보드)
- inactive: 로그인은 되지만 회사 데이터는 볼 수 없음

**비밀번호**
- 본인 비밀번호 → 팀 관리 페이지 하단 "내 비밀번호 변경"
- 타인 비밀번호 재설정 → Supabase Dashboard → Authentication → Users → 해당 유저 → Reset password

### 데이터 구조

| 테이블 | 역할 |
|---|---|
| `auth.users` | Supabase 기본 사용자 (이메일=합성, 비밀번호) |
| `profiles` | 아이디, 이름, 휴대폰, 직책, 실제 이메일 |
| `companies` | 회사 |
| `company_members` | 회사 ↔ 사용자 연결, 역할(role), 상태(status) |
| `company_documents` | 회사별 앱 데이터 (JSON payload) |

RLS 정책 핵심:
- 구성원: 자기 회사 데이터만 SELECT/UPDATE
- owner: 자기 회사의 member/profile 전체 SELECT/INSERT/UPDATE/DELETE

---

## 4. SQL 마이그레이션 기록

새 마이그레이션은 `app/supabase/migrations/YYYY-MM-DD-<설명>.sql` 형식으로 추가하고 아래 목록에도 기록해 주세요.

| 파일 | 내용 | 실행 |
|---|---|---|
| `app/supabase/schema.sql` | 초기 테이블/RLS | ✅ |
| `app/supabase/migrations/2026-04-16-team-management.sql` | profiles + 팀 관리 RLS | ✅ |
| `app/supabase/migrations/2026-04-16-team-management-fix.sql` | profile insert RLS 완화 | ✅ |

---

## 5. 로컬 개발 명령

```bash
cd "/Users/parkcg/The Symbol_Edit/app"

# 의존성 설치
npm install

# 개발 서버 (http://localhost:5173)
npm run dev

# 프로덕션 빌드 확인
npm run build

# 빌드된 파일 미리보기
npm run preview

# 린트
npm run lint
```

---

## 6. 페이지별 UX 메모

### 생두 주문 페이지 — 카피/구조 정리 (2026 점검)

**1. 같은 「합계」가 여러 층에 반복**
- 히어로: 현재 주문표 기준 수량·총액 (실시간)
- 월별 추이 카드: 가장 최근 **월 기록** 스냅샷 기준
- 저장된 월별 기록 표: 달마다 기록된 수량·총액
- → 출처를 라벨에 분명히 (주문표 vs 월 기록) ✅

**2. 월별 섹션 안 설명 문장 겹침**
- 헤더 muted와 `기록할 달` 힌트가 같은 주제
- → 헤더 설명 제거, 힌트는 규칙(엑셀→달 자동, 같은 달 덮어쓰기)만 ✅

**3. 기록 없을 때 안내 이중**
- 차트 빈 상태와 표 빈 상태 문구 유사
- → 한 블록만 안내, 표는 첫 기록 이후에만 노출 ✅

**4. 원두별: 스냅샷 없을 때 긴 설명 + 겹침** — 짧게 한 줄 + 필요 시 접기 (TODO)

**5. 원두별: 리스트와 칩 이중** — 칩 제거 또는 리스트만 강조 (TODO)

**6. 히어로 vs 주문표 패널 겹침** — 한 블록에만 긴 설명 (TODO)

**7. 일일 원두 가격: 버튼 줄 설명 과다** — 접기/한 줄 요약 (TODO)

---

## 7. 트러블슈팅

### 로그인은 되는데 "회사 등록" 화면이 뜸

- 현재 로그인한 계정이 `company_members`에 연결되어 있지 않음.
- Supabase Table Editor에서 해당 `user_id`로 row 추가.

### 팀 관리에서 계정 생성 시 "RLS violation"

- 마이그레이션이 안 돌아간 경우가 대부분. `app/supabase/migrations/*.sql`을 모두 Run.
- 현재 로그인 계정의 `company_members.role`이 `owner`여야 함.

### 로그인은 되지만 빈 화면

- Supabase 환경변수 누락. Vercel Project Settings → Environment Variables 확인 후 Redeploy.

### 계정을 중복 생성 시 "이미 있는 아이디"

- `auth.users`에 유령 계정이 남아 있음 (signUp 성공 후 profile/member 삽입이 실패한 케이스).
- Supabase → Authentication → Users → 해당 계정 Delete 후 재시도.

### 배포했는데 변경이 안 보임

- Vercel이 아직 빌드 중이거나 캐시. 대시보드 → Deployments에서 상태 확인.
- 브라우저는 Ctrl+Shift+R (Mac: Cmd+Shift+R) 강제 새로고침.

### 로스팅 현황 데이터가 이상하게 바뀜

- 블렌딩 로직이 production을 덮어쓰는 버그가 과거에 있었음. 지금은 수정됨.
- 증상 재발 시: 해당 날짜의 블렌딩 사이클을 +1 → −1 해서 production을 재계산하거나, 해당 셀 값을 수동으로 입력.
