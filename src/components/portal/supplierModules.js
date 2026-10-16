import {
  BarChart3, Building2, CreditCard, FileText, Gauge, LayoutDashboard, Receipt, ShoppingBag, Warehouse,
} from 'lucide-react';

// The supplier portal's destinations, in the order a supplier works through
// them. The sidebar and the command palette both read this, so the two can't
// disagree about names, icons or order. Which modules a given supplier sees is
// still decided by modulesFor (lib/onboarding.js).
//
// `registration` is the company profile: the sidebar puts it in its footer,
// and it is the only module an onboarding supplier gets.

export const OVERVIEW = { id: 'dashboard', name: 'Overview', icon: LayoutDashboard };

// Only for the buying organisation's own staff (ADR-0027).
export const BACK_OFFICE = { id: 'workspace', name: 'Workspace back office', icon: Warehouse };

export const SUPPLIER_MODULES = [
  { id: 'pos', name: 'Orders', icon: ShoppingBag },
  { id: 'invoices', name: 'Invoices', icon: Receipt },
  { id: 'payments', name: 'Payments', icon: CreditCard },
  { id: 'rfqs', name: 'RFQs', icon: FileText },
  { id: 'performance', name: 'Performance', icon: Gauge },
  { id: 'analytics', name: 'Reports', icon: BarChart3 },
  { id: 'registration', name: 'Company profile', icon: Building2 },
];
