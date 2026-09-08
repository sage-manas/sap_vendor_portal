'use client';

import React, { createContext, useContext, useState } from 'react';

const ShellContext = createContext(undefined);

export function ShellProvider({ children }) {
  const [activeTab, setActiveTab] = useState('dashboard');

  return (
    <ShellContext.Provider
      value={{
        activeTab,
        setActiveTab
      }}
    >
      {children}
    </ShellContext.Provider>
  );
}

export function useShell() {
  const context = useContext(ShellContext);
  if (context === undefined) {
    throw new Error('useShell must be used within a ShellProvider');
  }
  return context;
}
