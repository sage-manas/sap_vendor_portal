'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/lib/theme-context';
import { Button } from '@/components/ui/button';

export default function ThemeToggle() {
  const { theme, toggleTheme, mounted } = useTheme();
  const dark = mounted && theme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {dark ? <Sun strokeWidth={1.5} /> : <Moon strokeWidth={1.5} />}
    </Button>
  );
}
