# Aisevak Design Language: Frontier SF Startup System

Aisevak is a calm, minimal control room for agent work. The interface embodies the **Frontier SF Startup** aesthetic: quiet surfaces, hairline micro-borders, crystalline typography, clear agent state, compact controls, and motion that explains what changed without decorative excess.

## Design principles

### Quiet by default

The product is information-dense, so the chrome stays subdued. Carbon obsidian and warm porcelain surfaces carry structure; luminous violet is reserved for selection, focus, and primary actions. Color communicates state, never decorating an otherwise clear screen.

### Work first

Every screen leads with the object being managed: tasks, runs, agents, skills, keys, credentials, projects, or connections. Page titles are short, actions sit close to their target, and supporting metadata is deliberately smaller.

### One visual grammar

Controls use the shadcn composition model paired with AICSS agentic primitives: small reusable primitives, shared semantic tokens, hairline micro-borders (`0.5px`), consistent focus rings, and state-based variants.

### Motion confirms change

Animation is functional and brief (150–200ms). AICSS quantum lattice orbs pulse and wave to reflect live agent thinking and working states. Thinking disclosures smoothly expand to reveal chain-of-thought streams. Motion respects `prefers-reduced-motion`.

### Anti-patterns & Strict "Do Nots"

- ❌ **NO decorative status dots**: Do not place green/amber/red indicator dots beside ordinary labels (e.g. no `● Live catalog`, `● Default`, etc.).
- ❌ **NO noisy tag / pill badge designs**: Avoid bulky colored badges (e.g. no chunky `DEFAULT` purple pill tags).
- ❌ **NO nested header boxes inside dropdowns**: Menus and popovers should open directly into their functional command search without redundant logos or banner headers.
- ❌ **NO microscopic fonts**: Avoid cramped 8px/9px text. Minimum font size for metadata is 11px/11.5px (monospace), and standard body is 13px–14px.

## Foundations

### Color

Both themes use the same semantic roles with refined low-contrast surfaces.

| Role | Light (Porcelain) | Dark (Obsidian) | Use |
| --- | --- | --- | --- |
| Canvas Background | `#FAF9F7` (warm porcelain) | `#0A0A0C` (deep obsidian void) | app canvas |
| Card / Panel | `#FFFFFF` | `#121215` (raised carbon) | panels, cards, inputs |
| Hover / Muted | `#F5F4F0` | `#17171B` | secondary surfaces, row hover |
| Primary | `#5B4DE3` (soft violet) | `#7C72FF` (luminous indigo) | primary action, focus, selection |
| Success | `#16A34A` (forest) | `#34D399` (mint) | completed and active-positive states |
| Warning | `#D97706` (amber) | `#FBBF24` (soft amber) | running and attention states |
| Destructive | `#DC2626` (ruby) | `#F87171` (coral) | failures and destructive actions |
| Border | `rgba(0,0,0,0.07)` | `rgba(255,255,255,0.08)` | 0.5px hairline dividers |

All product code consumes semantic CSS tokens such as `--background`, `--card`, `--primary`, `--muted-foreground`, and `--border`.

### Typography

- **Interface**: `Geist Sans`, then `Inter`, then the platform sans-serif stack with tight optical tracking (`-0.015em` to `-0.025em`).
- **Technical identifiers & Diffs**: `Geist Mono`, then `JetBrains Mono`, then the platform monospace stack with tabular figures (`tnum`, `zero`).
- Headings use the interface family with tighter tracking and medium weight (`500`), avoiding heavy display faces.
- Default interface text is compact (`13px`). Hierarchy comes from weight, tone, and spacing as much as scale.

### Shape and depth

- Control radius: `6px`–`7px`.
- Card and panel radius: `9px`–`10px`.
- Elevated or authentication surfaces: `12px`–`14px`.
- Structure uses `0.5px`–`1px` semantic hairline borders. Shadows are subtle and reserved for cards on hover, overlays, and raised surfaces.

### AICSS Agentic Components

1. **Thinking & Reasoning (`ThinkingReasoning`)**: Shimmering label state with collapsible chain-of-thought and latency/token counters.
2. **Quantum Lattice Orbs (`AgentOrb`)**: 3x3 dot matrix micro-animations displaying live agent status (*Thinking*, *Working*, *Searching*, *Finalizing*).
3. **File Diffs (`FileDiff`)**: Word/line level additions (`+`) and deletions (`-`) with one-click copy and clean monospace layout.
4. **Approval Cards (`ApprovalCard`)**: Understated human-in-the-loop action confirmation cards with keyboard accelerators (`⌘↵` / `Esc`).
5. **Task Progress (`TaskList`)**: Step-by-step checklists with live status indicators.

### Spacing

The base rhythm is 4px. Common gaps are 8, 12, 16, 24, and 32px. Dense lists may use smaller internal spacing, but interactive targets remain at least 30–36px tall on desktop and 40px on narrow screens when practical.

## Components

### Buttons

- Primary: one per local action group, violet fill.
- Secondary: white or raised neutral surface with a border.
- Ghost: navigation, icon actions, and low-emphasis utilities.
- Destructive: only for irreversible or security-sensitive actions.
- Icon-only buttons always have an accessible label and tooltip text.

### Fields

Inputs, textareas, native selects, and switches share the same border, card surface, and violet focus ring. Placeholder text is quieter than labels. Form labels describe the value, while placeholder text may provide a concise example.

### Status

Statuses are small pill badges with semantic soft backgrounds. Use green for successful completion, amber for active work, rose for failure, and neutral gray for queued, disabled, or unknown states. Do not rely on color alone; every badge retains a text label.

### Navigation and icons

Phosphor is the product icon family. Its rounded geometry pairs with shadcn controls and supports regular and filled weights.

- Default navigation icons use `regular` weight.
- The selected destination uses `fill` weight and the violet accent.
- Use a single icon per action; avoid placing decorative icons beside already-obvious text.
- Standard icon sizes are 14px inside controls and 17px in navigation.

### Cards and lists

Task cards are the main raised surface. Other collections prefer flat rows inside a list region. Selection uses a card surface, semantic border, and quiet violet tint. Avoid nesting cards inside cards.

### Conversation

User messages use a compact muted bubble. Assistant content remains unboxed for readability. Tool work is grouped into a bordered, collapsible log. Code always uses the dark technical surface in both themes so syntax and copy behavior remain predictable.

## Layout patterns

### Workspace frame

Desktop uses a 232px navigation rail and a 64px top bar. The rail groups daily workspace views separately from system management. At medium widths it collapses to icons; on mobile it becomes a horizontally scrollable bottom navigation bar.

### Board

The task board is horizontally scrollable and keeps columns visually open. Cards provide the primary separation; columns do not need framed backgrounds. Task details appear in a side panel and become a full-width overlay on mobile.

### Master–detail

Runs, agents, skills, and connections use a dense collection rail with a generous editing or conversation surface. The selected row is raised slightly so selection remains legible in both themes.

### Empty and loading states

Empty states are plain, short, and centered in their available region. Loading uses the relevant Phosphor spinner without adding new full-screen branding unless the workspace itself is booting.

## Content voice

Aisevak uses direct, calm language.

- Prefer “New task” to “Create a new task item.”
- Prefer “Needs attention” to “Error state detected.”
- Prefer “No runs yet” to instructions that merely restate an empty view.
- Use sentence case throughout.
- Keep button labels to a verb and, when useful, a short object.

## Accessibility and quality

- All themes must meet WCAG AA contrast for normal text and focus indicators.
- Every interactive element must have a visible keyboard focus state.
- Icon-only actions require accessible labels.
- State is expressed with text in addition to color or motion.
- Motion is disabled or reduced when the operating system requests it.
- New UI must be checked in light mode, dark mode, and at desktop and narrow widths before release.
