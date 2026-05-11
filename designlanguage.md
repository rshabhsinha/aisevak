# Aisevak Design Language

This document outlines the core design language and typography choices for the Aisevak dashboard.

## Typography

We use a carefully selected pairing of Google Fonts to ensure readability, visual hierarchy, and a modern, professional aesthetic.

1.  **Body & UI Elements: `Inter`**
    *   **Usage:** Primary interface text, navigation items, buttons, task descriptions, and chat body.
    *   **Why:** Inter is a highly legible, clean sans-serif typeface specifically designed for computer screens. It provides a neutral, utilitarian foundation that doesn't distract from the content.

2.  **Headings & Brand: `Outfit`**
    *   **Usage:** Application title, page headers (`h1`, `h2`, `h3`), panel titles, and emphasized brand elements.
    *   **Why:** Outfit is a geometric sans-serif that feels slightly more pronounced and modern than a standard utilitarian font. It adds a touch of character and strong visual hierarchy to titles without being overly decorative.

3.  **Code & Monospace: `JetBrains Mono`**
    *   **Usage:** Code blocks, task keys (e.g., `TASK-12`), log outputs, and metadata badges.
    *   **Why:** JetBrains Mono is an exceptional monospace font designed for developers. Its increased x-height and clear character distinction make it perfect for reading code and technical identifiers within the dashboard.

## Layout & Structure

*   **Flat & Seamless:** We avoid unnecessary "boxed" containers (`.panel`, `.card` wrappers) in favor of a sleek, edge-to-edge master-detail layout. Content areas flow naturally into one another.
*   **Kanban Board:** The task board utilizes subtle vertical dividers to delineate columns (Todo, Running, Completed), providing structure while maintaining a clean, open feel.
*   **Subtle Surfaces:** We use a very light gray (`--bg-sidebar`) for structural elements like sidebars and list containers, contrasting slightly with pure white (`--bg`) for the main content areas to establish depth without borders.

## Colors & Borders

*   **Borders:** Used sparingly. Primarily to separate structural regions (sidebar, topbar, kanban columns) rather than framing individual UI components.
*   **Interactive Elements:** Selected states and interactive focus use a subtle blue/indigo accent to provide clear feedback.
*   **Brand Mark:** The application logo uses a distinct, slightly gradient-driven background box to anchor the sidebar and provide a recognizable visual anchor point.
