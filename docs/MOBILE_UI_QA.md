# Mobile UI verification

Run the normal workspace checks with `pnpm typecheck`, `pnpm build`, and `pnpm test`.
The viewport and keyboard regressions are in `apps/web/src/mobileLayout.test.ts`.
On a slow workstation, the existing process-heavy tests can be run with
`pnpm exec vitest run --maxWorkers=2 --minWorkers=1 --no-file-parallelism --testTimeout=20000`.
Worktree cleanup tests require a Git version supporting `git worktree list --porcelain -z`.

Use 320×568, 375×812, 430×932, 844×390, and 1280×800 viewports. The mobile
layout applies through 920px, including phone landscape and smaller tablets.
Repeat chat and schedule forms at 844×280, 844×200, and 320×200 to represent
keyboard-shortened viewports. Compact controls and scrolling must keep Send,
form inputs, Cancel, and Create reachable even when they cannot all fit at once.

- Open Tasks, filter and clear search, switch each status, and scroll its cards.
  Open New task, select an agent/project, and verify Cancel and Create stay reachable.
- Open Threads, search, show archived chats, open a conversation, go back, and
  start a draft. Deep links and browser back should retain the correct conversation.
- In a draft, choose a harness, search/select a model, change reasoning, and type
  a multiline message. On touch keyboards Return adds a newline; use Send to
  submit. Desktop Enter still sends, Shift Enter adds a newline, and IME composition
  must not submit. Draft suggestions scroll independently of the composer.
- Open More to reach Incidents, Agents, Skills, Settings, and Log out. Select an
  agent/skill, verify the form and save action are reachable, and use the back action.
  Tap a prompt reference shortcut and select a result.
- In Settings, reach every tab, scroll long project/repository/credential lists,
  and inspect forms with long paths and names. Connector repositories must remain
  visible beneath connection settings on mobile.
- Open Schedule, use month/agenda and month navigation, and open a new schedule,
  day overview, and event details. The form body should scroll with footer actions
  visible. Tab stays within the dialog; Escape closes and restores focus.
- Inspect Activity/Incidents with long prose, links, code, tables, and filenames.
  Code and tables may scroll inside their own panels; the page should stay within
  the viewport. Copy controls should be available without hover.
- Inspect login/onboarding with a short viewport and keyboard open. Inputs and
  submit must remain reachable; login errors should be visible.
- On a physical iOS/Android device, repeat composer/dialog checks with the keyboard,
  browser chrome, portrait/landscape rotation, safe-area insets, and pinch zoom.
  Browser viewport emulation and unit tests do not reproduce every native keyboard.
