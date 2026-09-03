export function CursorIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <g transform="translate(85, 89)">
        <path d="M170.428 334l148.991-83.5L170.428 167l-148.99 83.5 148.99 83.5z" fill="url(#harness-cursor-g0)" />
        <path d="M319.419 250.5v-167L170.428 0v167l148.991 83.5z" fill="url(#harness-cursor-g1)" />
        <path d="M170.428 0L21.438 83.5v167l148.99-83.5V0z" fill="url(#harness-cursor-g2)" />
        <path d="M319.419 83.5L170.428 334V167l148.991-83.5z" fill="#E4E4E4" />
        <path d="M319.419 83.5L170.428 167 21.438 83.5h297.981z" fill="#ffffff" />
      </g>
      <defs>
        <linearGradient id="harness-cursor-g0" x1="170.428" y1="167" x2="170.428" y2="334" gradientUnits="userSpaceOnUse">
          <stop offset="0.16" stopColor="#ffffff" stopOpacity="0.39" />
          <stop offset="0.66" stopColor="#ffffff" stopOpacity="0.8" />
        </linearGradient>
        <linearGradient id="harness-cursor-g1" x1="319.419" y1="84" x2="172.482" y2="172.5" gradientUnits="userSpaceOnUse">
          <stop offset="0.18" stopColor="#ffffff" stopOpacity="0.31" />
          <stop offset="0.72" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="harness-cursor-g2" x1="170.428" y1="0" x2="27.292" y2="253.8" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" stopOpacity="0.6" />
          <stop offset="0.67" stopColor="#ffffff" stopOpacity="0.22" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function ClaudeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 257" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path
        d="M50.23 170.32L100.59 142.06L101.43 139.6L100.59 138.24H98.12L89.7 137.72L60.92 136.94L35.97 135.91L11.8 134.61L5.7 133.31L0 125.8L0.58 122.04L5.7 118.6L13.03 119.25L29.23 120.35L53.53 122.04L71.16 123.07L97.28 125.8H101.43L102.01 124.11L100.59 123.07L99.48 122.04L74.34 104.99L47.12 86.98L32.86 76.61L25.15 71.36L21.26 66.43L19.57 55.67L26.57 47.96L35.97 48.61L38.37 49.26L47.89 56.58L68.25 72.33L94.82 91.9L98.71 95.14L100.26 94.04L100.46 93.26L98.71 90.35L84.25 64.23L68.83 37.65L61.96 26.64L60.14 20.03C59.5 17.3 59.04 15.04 59.04 12.25L67.01 1.43L71.42 0L82.05 1.43L86.52 5.31L93.13 20.42L103.83 44.2L120.42 76.54L125.28 86.13L127.87 95.01L128.84 97.73H130.53V96.18L131.89 77.97L134.42 55.61L136.88 26.83L137.72 18.73L141.74 9.01L149.71 3.76L155.93 6.74L161.05 14.06L160.34 18.79L157.29 38.56L151.33 69.54L147.44 90.28H149.71L152.3 87.69L162.8 73.75L180.43 51.72L188.21 42.97L197.28 33.31L203.11 28.71H214.13L222.23 40.77L218.6 53.21L207.26 67.6L197.87 79.78L184.38 97.93L175.96 112.45L176.74 113.61L178.75 113.42L209.21 106.94L225.67 103.96L245.31 100.59L254.19 104.73L255.16 108.95L251.66 117.57L230.66 122.75L206.03 127.68L169.35 136.36L168.9 136.68L169.41 137.33L185.94 138.89L193 139.28H210.31L242.52 141.67L250.94 147.25L256 154.05L255.16 159.24L242.2 165.85L224.7 161.7L183.87 151.98L169.87 148.48H167.92V149.65L179.59 161.05L200.98 180.37L227.74 205.25L229.1 211.41L225.67 216.27L222.04 215.75L198.51 198.06L189.44 190.09L168.9 172.78H167.53V174.6L172.27 181.53L197.28 219.12L198.58 230.66L196.76 234.42L190.28 236.69L183.15 235.39L168.51 214.85L153.41 191.71L141.22 170.97L139.73 171.81L132.54 249.26L129.17 253.21L121.39 256.19L114.91 251.27L111.47 243.3L114.91 227.55L119.06 207L122.43 190.67L125.47 170.39L127.29 163.65L127.16 163.19L125.67 163.39L110.37 184.38L87.1 215.82L68.7 235.52L64.29 237.27L56.64 233.32L57.36 226.25L61.63 219.97L87.1 187.56L102.46 167.47L112.38 155.87L112.32 154.18H111.73L44.07 198.12L32.02 199.68L26.83 194.82L27.48 186.85L29.94 184.26L50.29 170.26L50.23 170.32Z"
        fill="#D97757"
      />
    </svg>
  );
}

export function CodexIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 260" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path
        d="M239.18 106.2C245.05 88.52 243.02 69.17 233.61 53.1C219.45 28.46 191 15.78 163.21 21.74C147.55 4.32 123.79 -3.42 100.88 1.42C77.96 6.26 59.37 22.96 52.1 45.22C33.84 48.96 18.09 60.39 8.87 76.58C-5.44 101.18 -2.2 132.22 16.9 153.32C11.01 170.99 13.02 190.34 22.42 206.42C36.6 231.07 65.07 243.75 92.87 237.78C105.24 251.71 123 259.63 141.62 259.53C170.11 259.55 195.34 241.17 204.04 214.05C222.29 210.3 238.04 198.87 247.27 182.69C261.4 158.13 258.14 127.26 239.18 106.2ZM141.62 242.54C130.26 242.56 119.24 238.57 110.52 231.29L112.05 230.42L163.72 200.59C166.34 199.06 167.95 196.26 167.97 193.22V120.37L189.82 133.01C190.03 133.12 190.19 133.33 190.22 133.57V193.94C190.17 220.76 168.44 242.48 141.62 242.54ZM37.16 197.93C31.46 188.09 29.41 176.55 31.38 165.34L32.91 166.26L84.63 196.09C87.24 197.62 90.47 197.62 93.07 196.09L156.26 159.66V184.89C156.24 185.15 156.11 185.39 155.9 185.55L103.56 215.73C80.31 229.13 50.59 221.17 37.16 197.93ZM23.55 85.38C29.29 75.47 38.35 67.92 49.13 64.05V125.44C49.09 128.46 50.7 131.26 53.32 132.75L116.2 169.03L94.35 181.66C94.11 181.79 93.83 181.79 93.59 181.66L41.35 151.53C18.14 138.08 10.18 108.39 23.55 85.13V85.38ZM203.01 127.08L139.94 90.45L161.73 77.86C161.97 77.73 162.26 77.73 162.5 77.86L214.73 108.04C231.03 117.45 240.44 135.43 238.87 154.18C237.31 172.94 225.05 189.11 207.41 195.68V134.29C207.32 131.28 205.65 128.54 203.01 127.08ZM224.76 94.39L223.22 93.46L171.6 63.38C168.98 61.84 165.73 61.84 163.11 63.38L99.98 99.81V74.59C99.95 74.33 100.07 74.07 100.29 73.92L152.52 43.79C168.86 34.37 189.17 35.25 204.64 46.04C220.11 56.83 227.95 75.59 224.76 94.18V94.39ZM88.06 139.1L66.22 126.51C66 126.38 65.85 126.15 65.81 125.9V65.68C65.83 46.83 76.75 29.68 93.83 21.69C110.9 13.69 131.06 16.28 145.56 28.34L144.03 29.21L92.36 59.03C89.74 60.57 88.13 63.37 88.11 66.4V139.1ZM99.93 113.52L128.07 97.3L156.26 113.52V145.95L128.17 162.17L99.98 145.95L99.93 113.52Z"
        fill="#09090b"
      />
    </svg>
  );
}

export function OpenCodeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M320 224V352H192V224H320Z" fill="#71717a" />
      <path fillRule="evenodd" clipRule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="#ffffff" />
    </svg>
  );
}

export function HarnessLogo({
  harness,
  className = "w-4 h-4"
}: {
  harness: "Cursor" | "Claude Code" | "Codex" | "OpenCode" | string;
  className?: string;
}) {
  switch (harness) {
    case "Cursor":
      return (
        <span className="w-5 h-5 rounded-full bg-[#09090b] border border-black/10 flex items-center justify-center p-0.5 shadow-xs shrink-0 inline-flex" title="Cursor Harness">
          <CursorIcon className={className} />
        </span>
      );
    case "Claude Code":
      return (
        <span className="w-5 h-5 rounded-full bg-[#fdf8f6] border border-[#d97757]/20 flex items-center justify-center p-0.5 shadow-xs shrink-0 inline-flex" title="Claude Code Harness">
          <ClaudeIcon className={className} />
        </span>
      );
    case "Codex":
      return (
        <span className="w-5 h-5 rounded-full bg-[#ffffff] border border-black/10 flex items-center justify-center p-0.5 shadow-xs shrink-0 inline-flex" title="OpenAI Codex Harness">
          <CodexIcon className={className} />
        </span>
      );
    case "OpenCode":
      return (
        <span className="w-5 h-5 rounded-full bg-[#131010] border border-white/20 flex items-center justify-center p-0.5 shadow-xs shrink-0 inline-flex" title="OpenCode Harness">
          <OpenCodeIcon className={className} />
        </span>
      );
    default:
      return null;
  }
}
