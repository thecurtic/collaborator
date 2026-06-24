# Skills Recommendation for Self-Hosted Personal Web Apps

Based on my review of [skills.sh](https://skills.sh) and the [Superpowers framework](https://github.com/obra/superpowers), here are my recommendations for your workflow building a self-hosted personal web application with local inference.

## Current Project Context: Collaborator

Collaborator is a **chat interface** backed by local LLM inference with this architecture:

- **backend/** — FastAPI server on this VM handling SQLite persistence, context assembly, and LLM proxying
- **frontend/** — Next.js web UI served from a tailnet machine for chatting, reviewing responses, discarding turns
- **Local inference only** — Uses `qwen/qwen3-coder-next` via LM Studio at `http://<inference-host>:1234/v1`
- **Tailnet networking** — All communication stays within your private network; no public internet exposure

## Core Philosophy Alignment

Both skills.sh and Superpowers emphasize:
- **Systematic approaches** over ad-hoc fixes
- **Composable, reusable patterns** 
- **Self-hosted/local-first principles** (Superpowers explicitly designed for this)
- **Clear documentation and planning**

## Recommended Skills Shortlist

### 1. **superpowers:brainstorming** ⭐⭐⭐
**Why it fits your workflow:**
- Helps you clarify requirements before writing code
- The visual companion and frame-template tools let your AI "see" different design options
- Perfect for prototyping UI ideas and architectural decisions
- With local inference, you can run the companion server on your machine for brainstorming sessions

**Key benefit:** Prevents building the wrong thing by formalizing requirements early.

---

### 2. **superpowers:writing-plans** ⭐⭐⭐
**Why it fits your workflow:**
- Creates concrete implementation plans before coding begins
- The plan format is designed for subagent execution, which works great with Pi
- File structure and task decomposition ensure clean architecture
- Plans are saved to docs, creating living documentation for your self-hosted project

**Key benefit:** A well-written plan lets you delegate implementation to subagents while maintaining architectural control.

---

### 3. **superpowers:systematic-debugging** ⭐⭐⭐
**Why it fits your workflow:**
- The 4-phase root cause process is essential for self-hosted debugging
- No external services means you must debug everything yourself
- The evidence gathering phase is critical when logs span multiple components

**Key benefit:** 95% first-time fix rate vs 40% for random fixes—critical when you're the only support.

---

### 4. **superpowers:subagent-driven-development** ⭐⭐⭐
**Why it fits your workflow:**
- Fresh subagent per task prevents context pollution (important with local inference constraints)
- Review after each task catches issues early
- Works seamlessly with Pi's multi-turn conversations

**Key benefit:** Execute entire plans autonomously while maintaining quality gates.

---

### 5. **superpowers:test-driven-development** ⭐⭐⭐
**Why it fits your workflow:**
- Self-hosted projects benefit most from automated testing (no external QA)
- TDD ensures your code works in your specific deployment environment
- Prevents regressions when you're both developer and only QA

**Key benefit:** Test failures will catch deployment-specific issues before they reach production.

---

### 6. **superpowers:executing-plans** ⭐⭐
**Why it fits your workflow:**
- Alternative to subagent-driven when context is limited
- Batch execution with checkpoints lets you verify progress

**Key benefit:** Can execute plans in constrained environments where subagents would be too expensive.

---

### 7. **skills.sh:playwright-cli** ⭐⭐
**Why it fits your workflow:**
- Test your self-hosted web app end-to-end
- Capture screenshots and artifacts for debugging

**Key benefit:** Verify the web UI works in your specific local deployment configuration.

---

### 8. **skills.sh:ai-research-explore** ⭐⭐
**Why it fits your workflow:**
- Research best practices for self-hosted deployments
- Find tools and patterns that work offline

**Key benefit:** Stay up-to-date on self-hosted patterns without external dependencies.

---

## Skills to Skip (For Your Use Case)

| Skill | Why Skip |
|-------|----------|
| Marketing skills (most) | Not relevant for personal projects |
| Cloud-specific skills | Your setup is self-hosted, not cloud |
| Multi-service integration | Focus on the core app first |
| External API tutorials | Your constraints say "no external services" |

---

## Implementation Plan for Pi

Given your setup (Pi + local inference), I recommend:

1. **Install Superpowers in Pi:**
   ```bash
   pi install git:github.com/obra/superpowers
   ```

2. **Set up the workflow for your project:**
   - Use `brainstorming` to define feature scope
   - Create plans with `writing-plans`
   - Execute plans with `subagent-driven-development`
   - Debug issues with `systematic-debugging`

3. **For web UI testing:**
   - Use `playwright-cli` to test your deployed app
   - Create regression tests for your UI

## Why Superpowers Over skills.sh Packages

Superpowers is specifically designed for:
- **Local-first workflows** (your constraint)
- **Self-hosted projects** (your deployment model)
- **Developer autonomy** (you're the only dev and QA)

skills.sh has excellent tools, but many focus on external service integration or rapid prototyping rather than the careful, systematic development you want for your self-hosted project.

## Next Steps

1. Install Superpowers in Pi
2. Pick one feature to build following the systematic process
3. Use `brainstorming` → `writing-plans` → `subagent-driven-development`
4. Test with `playwright-cli`
5. Debug issues with `systematic-debugging`

This creates a repeatable, maintainable process for all your self-hosted projects.

## Collaborator-Specific Recommendations

For building the Collaborator backend and frontend, here's how to apply these skills:

### Backend Development (FastAPI + SQLite)

1. **superpowers:brainstorming**
   - Define the SQLite schema (see memory model above)
   - Decide on API endpoint structure
   - Design error handling strategy
   - Plan context assembly logic

2. **superpowers:writing-plans**
   - Break down backend features (DB setup → API endpoints → inference proxy)
   - Create test-before-code sequence

3. **superpowers:test-driven-development**
   - Write SQLite schema tests first
   - Test the inference proxy against mock LLM responses
   - Verify error handling for network failures

4. **superpowers:systematic-debugging**
   - Diagnose database connection issues
   - Trace inference proxy failures
   - Investigate tailnet connectivity problems

### Frontend Development (Next.js)

1. **superpowers:brainstorming**
   - Design chat UI layout and turn editing experience
   - Plan discard/commit behavior for conversation turns
   - Decide on context preview display

2. **superpowers:test-driven-development**
   - Test message sending flow
   - Verify discard behavior before commit
   - Test offline/failure scenarios

3. **skills.sh:playwright-cli**
   - End-to-end tests for chat workflow
   - Verify discards don't affect future context

## Next Steps

1. **Install Superpowers in Pi** (already done via `git:github.com/obra/superpowers`)
2. **Use brainstorming** to refine the SQLite schema and API design
3. **Create implementation plan** for the first phase:
   - Define SQLite schema
   - Set up FastAPI backend with minimal structure
   - Wire inference endpoint
   - Persist turns to SQLite
