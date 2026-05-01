# Project Context: B2B Computer Parts Asset Management System

## 1. 개요 (Overview)
- **프로젝트 명**: B2B 컴퓨터 부품 자산 관리 및 비즈니스 인사이트 플랫폼
- **주요 기능**: 
    - 부품 견적서 보관 및 관리
    - 실시간/누적 부품 가격 추이 비교 및 데이터 분석
    - 비즈니스 인사이트 및 재고 알림 제공
- **대상 사용자**: 컴퓨터 부품 도매상 및 B2B 비즈니스 파트너

## 2. 기술 스택 (Tech Stack)
### Backend (Human-Centric)
- **언어**: Kotlin
- **프레임워크**: Spring Boot
- **데이터베이스**: 초기 jsDB(학습용) 또는 표준 RDBMS 고려 중
- **특이사항**: 사용자가 직접 코딩을 주도하며 AI는 보조 도구로 활용

### Frontend (AI-Centric)
- **언어/프레임워크**: Next.js (React), TypeScript
- **스타일링**: Tailwind CSS
- **UI 라이브러리**: shadcn/ui (AI 생성 최적화)
- **개발 방식**: AI 에이전트가 코드 생성을 주도하고 사용자가 검토/지시

### AI & Agents
- **모델**: Gemini Pro (유료 구독 중), Claude (API 및 Claude Code 활용 예정)
- **에이전트 프레임워크**: **EJClaw** (NanoClaw 포크 버전)
    - Discord 기반 Tribunal 시스템 (Owner, Reviewer, Arbiter 3중 구조)
    - Bun + SQLite(WAL) 런타임 사용
- **연동 프로토콜**: MCP (Model Context Protocol)를 통한 Figma 및 외부 툴 연동

## 3. 개발 환경 및 워크플로우 (Environment & Workflow)
- **호스트 머신**: macOS (MacBook Air M5), 클램쉘 모드 및 듀얼 모니터 세팅
- **터미널/에디터**: Kitty Terminal, Neovim
- **메인 인터페이스**: Discord (비공개 서버 내 봇 토큰 3개 운용)
- **워크플로우**:
    1. Discord에서 사용자 지시 전달
    2. EJClaw Owner가 코드 작성 (Figma MCP 참고)
    3. Reviewer(Claude)가 코드 정적 분석 및 빌드 테스트 피드백
    4. 최종 승인된 코드를 프로젝트 레포지토리에 반영

## 4. 에이전트 지침 및 제약 사항 (Agent Instructions)
- **보안**: 모든 에이전트 작업은 격리된 샌드박스 환경에서 수행하며, 호스트의 핵심 시스템 파일 접근은 차단됨.
- **역할 분담**:
    - **Owner**: 기능 구현 및 UI 컴포넌트 생성 담당 (Gemini Pro/Codex 권장)
    - **Reviewer**: 코드 품질 검토, 보안 취약점 체크, 스타일 가이드 준수 확인 (Claude Code 권장)
- **코드 스타일**: Kotlin은 관용적(Idiomatic) 스타일을 지향하며, 프론트엔드는 모바일 웹 반응형을 기본으로 함.

## 5. 향후 개선 및 확장 계획
- **Figma MCP**: 기획-개발 파이프라인 자동화
- **Spring OpenAPI 연동**: 백엔드 API 명세를 실시간으로 프론트엔드 에이전트에 주입
- **Self-Healing**: 빌드 에러 발생 시 에이전트가 스스로 수정하는 루프 구축
- **RAG Memory**: 도메인 지식 및 과거 결정 사항을 SQLite-vec을 통해 관리
