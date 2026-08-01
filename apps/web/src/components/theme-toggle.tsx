import { Moon, Sun } from "./icons";
import { useTheme } from "./theme-provider";
import { Button } from "./ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  return (
    <Button
      className="theme-toggle"
      variant="ghost"
      size="icon"
      type="button"
      aria-label={`Use ${nextTheme} theme`}
      title={`Use ${nextTheme} theme`}
      onClick={() => setTheme(nextTheme)}
    >
      <Sun className="theme-icon theme-icon-sun" size={17} weight="fill" />
      <Moon className="theme-icon theme-icon-moon" size={17} weight="fill" />
    </Button>
  );
}
