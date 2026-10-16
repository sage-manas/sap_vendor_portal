'use client';

import { Menu } from '@base-ui/react/menu';
import { Avatar } from '@/components/ui/controls';

/**
 * The account menu at the right of the top bar.
 *
 * items: [{ label, onClick?, href?, icon?, destructive? } | 'separator']
 */
export default function UserMenu({ name, caption, items }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className="flex h-8 items-center gap-2 rounded-md pl-1 pr-2 hover:bg-subtle cursor-pointer data-[popup-open]:bg-subtle"
        aria-label={`Account: ${name || 'signed in'}`}
      >
        <Avatar name={name} size={24} />
        <span className="hidden max-w-40 truncate text-sm text-fg md:inline">{name}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={6} className="z-50">
          <Menu.Popup className="min-w-56 rounded-lg border border-border bg-surface p-1 text-sm shadow-popover outline-none data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-150">
            <div className="px-2 pb-2 pt-1.5">
              <p className="truncate font-medium text-fg">{name}</p>
              {caption && <p className="truncate text-xs text-fg-subtle">{caption}</p>}
            </div>
            <div role="separator" className="my-1 h-px bg-border" />
            {items.map((item, i) => (item === 'separator' ? (
              <div key={`s${i}`} role="separator" className="my-1 h-px bg-border" />
            ) : (
              <Menu.Item
                key={item.label}
                onClick={item.onClick}
                render={item.href ? <a href={item.href} /> : undefined}
                className={`flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 outline-none select-none data-[highlighted]:bg-subtle ${item.destructive ? 'text-danger' : 'text-fg'}`}
              >
                {item.icon && <item.icon className="size-4 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />}
                {item.label}
              </Menu.Item>
            )))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
