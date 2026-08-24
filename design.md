# Aisevak Design System Guidelines

This document serves as the persistent design specification for Aisevak, enforcing a clean, minimal, and subtle **Frontier SF Startup** aesthetic (Linear, Cursor, Raycast style).

---

## 1. Core Visual Principles

### 1.1 Quiet by Default
- **Chrome stays subdued**: Content, code diffs, and agent activity are the focus.
- **Restrained color**: Monochromatic carbon/porcelain surfaces. Color is strictly reserved for primary actions and critical error states.

### 1.2 Anti-Patterns & Strict "Do Nots"
- ❌ **NO decorative status dots**: Do not place green/amber/red indicator dots beside ordinary labels (e.g. no `● Live catalog`, `● Default`, etc.).
- ❌ **NO noisy tag / pill badge designs**: Avoid bulky colored badges (e.g. no chunky `DEFAULT` purple pill tags).
- ❌ **NO nested header boxes inside dropdowns**: Menus and popovers should open directly into their functional command search without redundant logos or banner headers.
- ❌ **NO microscopic fonts**: Avoid cramped 8px/9px text. Minimum font size for metadata is 11px/11.5px (monospace), and standard body is 13px–14px.

---

## 2. Component Design Rules

### 2.1 Model Selector & Command Palettes
- **Header**: Borderless command search input integrated seamlessly at the top with a 1px hairline bottom border (`border-b border-border`).
- **List Items**: Clean, flat rows with `8px 10px` padding and `6px` border-radius.
- **Typography**:
  - Model Name: `13px font-medium text-foreground`
  - Model Description: `11.5px text-muted-foreground`
- **Selection State**: Soft background hover/active tint (`var(--card-hover)`) and a simple, subtle checkmark icon (`<Check size={14} className="text-primary" />`). No borders or pill badges on selected items.

### 2.2 Typography Pairings
- **Interface & Headings**: `Geist Sans` (fallback `Inter`) with tight optical tracking (`-0.015em` to `-0.025em`) and clean weights (`400`, `500`, `600`).
- **Code, Diffs & Telemetry**: `Geist Mono` (fallback `JetBrains Mono`) with tabular figures (`tnum`, `zero`).

### 2.3 Color Tokens & Surfaces
- **Dark Mode (Obsidian Carbon)**:
  - Background Canvas: `#0A0A0C`
  - Card / Panel Surface: `#121215`
  - Card Hover Surface: `#17171B`
  - Micro-Borders: `rgba(255, 255, 255, 0.08)` (0.5px hairline)
  - Primary Accent: `#7C72FF` (luminous soft indigo)
- **Light Mode (Warm Porcelain)**:
  - Background Canvas: `#FAF9F7`
  - Card / Panel Surface: `#FFFFFF`
  - Card Hover Surface: `#F5F4F0`
  - Micro-Borders: `rgba(0, 0, 0, 0.07)`
  - Primary Accent: `#5B4DE3` (soft electric violet)

### 2.4 Task Creation & Kanban Composer
- **Prompt Composer Surface**: Task creation on the Kanban board uses a sleek agent prompt composer (`TaskComposer`) with multi-line prompt input and embedded agent/project routing selectors, replacing multi-input horizontal forms.
- **In-Place Board Creation**: Submitting creates and schedules the task thread in the background, instantly inserting the card into the Kanban columns without routing away from the Kanban board.

---

## 3. Agentic Primitives (AICSS)
- **Thinking & Reasoning**: Clean collapsible accordion with smooth height transition, subtle shimmer label, and live elapsed timer.
- **Quantum Lattice Orbs (`AgentOrb`)**: Micro dot matrix (14px–16px) for active agent states (*Thinking*, *Working*, *Searching*, *Finalizing*).
- **File Diffs (`FileDiff`)**: High-legibility code diff card with word-level additions/deletions and one-click copy.
- **Approval Cards (`ApprovalCard`)**: Understated human-in-the-loop permission prompt with keyboard accelerators (`⌘↵` / `Esc`).
