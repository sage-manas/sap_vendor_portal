'use client';

import React from 'react';
import Header from './Header';
import Sidebar from './Sidebar';
import BapiConsole from './BapiConsole';
import CommandPalette from '../ui/CommandPalette';
import { usePortal } from '@/lib/portal-context';
import { isPlatformPath } from '@/lib/planes';

import { usePathname } from 'next/navigation';

export default function PortalLayout({ children }) {
  const pathname = usePathname();
  const {
    activeTab,
    setActiveTab,
    state,
    consoleOpen,
    setConsoleOpen,
    consoleEndRef,
    handleResetDatabase
  } = usePortal();

  const isAuthPage = pathname === '/sign-in' || pathname === '/sign-up' || pathname === '/forgot-password' || pathname === '/reset-password';

  // The platform console is a different plane with its own shell, session and
  // navigation (src/app/platform/layout.jsx). The supplier chrome — sidebar,
  // BAPI console, command palette — has no meaning there, so this layout
  // steps out of the way entirely.
  const isPlatformPlane = isPlatformPath(pathname);

  React.useEffect(() => {
    if (isPlatformPlane) return undefined;
    if (isAuthPage) {
      document.body.classList.add('auth-mode');
    } else {
      document.body.classList.remove('auth-mode');
    }
    return () => {
      document.body.classList.remove('auth-mode');
    };
  }, [isAuthPage, isPlatformPlane]);

  if (isPlatformPlane) {
    return children;
  }

  if (isAuthPage) {
    return (
      <div id="main-content" className="auth-page-wrapper min-h-screen w-full bg-base flex items-center justify-center py-8 px-4">
        {children}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-base text-text-primary font-sans">
      <Header />
      <CommandPalette />

      <div className="flex-1 flex overflow-hidden relative">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          state={state}
          onReset={handleResetDatabase}
        />

        <main id="main-content" className="flex-1 flex flex-col min-w-0 relative h-full">
          <div className={`flex-1 overflow-y-auto py-2.5 px-4 md:py-4 md:px-6 custom-scrollbar transition-all duration-300 ${consoleOpen ? 'pb-72' : 'pb-14'}`}>
            {children}
          </div>

          <BapiConsole
            state={state}
            consoleOpen={consoleOpen}
            setConsoleOpen={setConsoleOpen}
            consoleEndRef={consoleEndRef}
          />
        </main>
      </div>
    </div>
  );
}
