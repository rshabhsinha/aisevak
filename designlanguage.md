# Aisevak Design Language

Aisevak is a calm control room for agent work. The interface should feel precise and dependable without looking industrial: quiet surfaces, clear state, compact controls, and motion that explains what changed.

## Design principles

### Quiet by default

The product is information-dense, so the chrome stays subdued. Warm neutral surfaces carry structure; violet is reserved for selection, focus, and primary actions. Color should communicate state, never decorate an otherwise clear screen.

### Work first

Every screen leads with the object being managed: tasks, runs, agents, skills, keys, credentials, projects, or connections. Page titles are short, actions sit close to their target, and supporting metadata is deliberately smaller.

### One visual grammar

Controls use the shadcn composition model: small reusable primitives, shared semantic tokens, consistent focus rings, and state-based variants. Avoid one-off colors, radii, or button treatments inside feature views.

### Motion confirms change

Animation is functional and brief. Navigation icons move from outline to filled when selected. Theme icons rotate and resolve into the active mode. Loading, sending, expanding, and copying each have one restrained response. Motion must respect `prefers-reduced-motion`.

## Foundations

### Color

Both themes use the same semantic roles rather than independently chosen colors.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Background | warm off-white | near-black | app canvas |
| Card | white | raised charcoal | panels, cards, inputs |
| Muted | warm gray | soft charcoal | secondary surfaces |
| Primary | soft violet | bright violet | primary action, focus, selection |
| Success | evergreen | mint | completed and active-positive states |
| Warning | amber | sand | running and attention states |
| Destructive | rose | coral | failures and destructive actions |

All product code should consume semantic CSS tokens such as `--background`, `--card`, `--primary`, `--muted-foreground`, and `--border`. Do not add literal feature colors when a semantic token already describes the intent.

### Typography

- Interface: Inter, then the platform sans-serif stack.
- Technical identifiers: JetBrains Mono, then the platform monospace stack.
- Headings use the interface family with tighter tracking and weight, not a second display face.
- Default interface text is compact. Size differences should be small; hierarchy comes from weight, tone, and spacing as much as scale.

### Shape and depth

- Control radius: 7px.
- Card and panel radius: 10px.
- Elevated or authentication surfaces: 14px.
- Pills are reserved for status, counts, models, and compact metadata.
- Most structure uses a one-pixel semantic border. Shadows are subtle and reserved for cards on hover, overlays, and raised authentication surfaces.

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
