'use client';

import React from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

/**
 * KPI Card Component
 * Displays key performance indicator with icon, title, value, and trend
 */
export function KPICard({ title, value, unit, icon: Icon, trend, bgGradient }) {
  const isPositive = !trend || trend.startsWith('+');

  return (
    <div className="metric-panel animate-fadeUp">
      <div className="flex items-start justify-between mb-4">
        <div className="p-2.5 rounded-none" style={{ backgroundColor: 'var(--color-emerald-dim)' }}>
          <Icon className="size-5" style={{ color: 'rgb(var(--color-emerald-default-rgb))' }} />
        </div>
        {trend && (
          <div className={`flex items-center gap-1 text-[11px] font-semibold ${isPositive ? 'text-emerald-text' : 'text-red-500'}`}>
            {isPositive ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {trend}
          </div>
        )}
      </div>
      <p className="label">{title}</p>
      <p className="text-2xl font-bold tabular-nums text-text-primary mt-1">{value}</p>
      <p className="text-[11px] text-text-tertiary mt-1">{unit}</p>
    </div>
  );
}

/**
 * Status Badge Component
 * Displays payment status with appropriate styling
 */
export function StatusBadge({ status, size = 'sm' }) {
  const variantMap = {
    Cleared: 'active',
    Approved: 'active',
    Processing: 'info',
    Pending: 'pending',
    Overdue: 'suspended',
    Failed: 'suspended',
  };

  const variant = variantMap[status] || 'pending';
  const sizeClass = size === 'sm' ? 'px-2.5 py-0.5 text-[11px]' : size === 'md' ? 'px-3 py-1 text-xs' : 'px-4 py-1.5 text-[13px]';

  return (
    <span className={`status-badge status-badge-${variant} ${sizeClass}`}>
      {status}
    </span>
  );
}

/**
 * Payment Card Component
 * Displays individual payment information in card format
 */
export function PaymentCard({ payment, onSelect, compact = false }) {
  return (
    <div
      onClick={() => onSelect && onSelect(payment)}
      className="card p-4 hover:bg-surface2 transition-colors duration-150 cursor-pointer"
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="font-bold text-text-primary text-[13px]">{payment.paymentNumber}</p>
          <p className="text-[11px] text-text-tertiary mt-0.5 tabular-nums">{payment.paymentDate}</p>
        </div>
        <StatusBadge status={payment.status} size="sm" />
      </div>

      {!compact && (
        <div className="grid grid-cols-2 gap-3 text-[11px]">
          <div>
            <p className="text-text-tertiary">Invoice</p>
            <p className="font-mono font-semibold text-text-primary">{payment.invoiceNumber}</p>
          </div>
          <div>
            <p className="text-text-tertiary">Net Amount</p>
            <p className="font-mono font-semibold text-text-primary tabular-nums">₹ {Number(payment.netAmount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Simple Chart Component
 * Renders a basic line/bar chart for payment trends
 */
export function SimpleChart({ data, height = 200, type = 'line' }) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-text-tertiary text-[12px]">
        No data available
      </div>
    );
  }

  const maxAmount = Math.max(...data.map(d => d.amount));
  const minAmount = 0;
  const range = maxAmount - minAmount;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-2 h-40">
        {data.map((item, idx) => {
          const percentage = ((item.amount - minAmount) / range) * 100;
          return (
            <div key={idx} className="flex-1 flex flex-col items-center gap-2">
              <div
                className="w-full rounded-none hover:opacity-80 transition-opacity duration-150"
                style={{ height: `${percentage}%`, minHeight: '4px', backgroundColor: 'rgb(var(--color-emerald-default-rgb))' }}
              />
              <p className="text-[10px] font-semibold text-text-secondary">{item.month}</p>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[11px] text-text-tertiary tabular-nums">
        <span>₹ 0</span>
        <span>₹ {(maxAmount / 100000).toFixed(1)}L</span>
      </div>
    </div>
  );
}

/**
 * Timeline Component
 * Displays payment lifecycle timeline
 */
export function PaymentTimeline({ events = [] }) {
  if (!events || events.length === 0) {
    return <div className="text-center py-8 text-text-tertiary text-[12px]">No timeline events</div>;
  }

  return (
    <div className="space-y-4">
      {events.map((event, idx) => (
        <div key={idx} className="flex gap-4">
          <div className="flex flex-col items-center">
            <div
              className={`w-3 h-3 rounded-full ${event.completed ? '' : 'bg-border-em'}`}
              style={event.completed ? { backgroundColor: 'rgb(var(--color-emerald-default-rgb))' } : undefined}
            />
            {idx < events.length - 1 && <div className="w-0.5 h-8 bg-border" />}
          </div>
          <div className="flex-1 pb-4">
            <p className="font-semibold text-text-primary text-[13px]">{event.title}</p>
            <p className="text-[11px] text-text-tertiary mt-0.5 tabular-nums">{event.date}</p>
            {event.description && <p className="text-[11px] text-text-secondary mt-1">{event.description}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Filter Bar Component
 * Reusable filter component with multiple options
 */
export function FilterBar({ filters, onFilterChange, clearFilters }) {
  return (
    <div className="flex flex-wrap gap-2 items-center">
      {filters.map((filter) => (
        <div key={filter.id} className="flex items-center gap-2">
          <label className="text-[11px] font-semibold text-text-secondary">{filter.label}</label>
          <select
            value={filter.value}
            onChange={(e) => onFilterChange(filter.id, e.target.value)}
            className="!w-auto"
          >
            {filter.options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      ))}
      {clearFilters && (
        <button
          onClick={clearFilters}
          className="text-[11px] font-semibold text-red-500 hover:text-red-600 transition-colors duration-150 cursor-pointer"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * Document Card Component
 * Displays document information
 */
export function DocumentCard({ doc, onPreview, onDownload }) {
  return (
    <div className="card p-4 hover:bg-surface2 transition-colors duration-150">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="font-semibold text-text-primary text-[13px]">{doc.name}</p>
          <p className="text-[11px] text-text-tertiary mt-0.5">{doc.type}</p>
        </div>
        <span className="chip bg-surface2 text-text-secondary tabular-nums">{doc.generatedDate}</span>
      </div>
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
        <p className="text-[11px] font-mono text-text-secondary">{doc.reference}</p>
        <div className="flex gap-2">
          {onPreview && (
            <button
              onClick={() => onPreview(doc)}
              className="px-2.5 py-1 text-[11px] font-semibold text-text-secondary hover:bg-surface2 hover:text-text-primary rounded-none transition-colors duration-150 cursor-pointer"
            >
              View
            </button>
          )}
          {onDownload && (
            <button
              onClick={() => onDownload(doc)}
              className="px-2.5 py-1 text-[11px] font-semibold text-emerald-400 hover:bg-surface2 rounded-none transition-colors duration-150 cursor-pointer"
            >
              Download
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Empty State Component
 * Shows when no data is available
 */
export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 rounded-none border-2 border-dashed border-border bg-base">
      {Icon && <Icon className="size-10 text-text-tertiary mb-4" />}
      <h3 className="text-[15px] font-bold text-text-primary">{title}</h3>
      <p className="text-[12px] text-text-tertiary mt-2 max-w-sm text-center">{description}</p>
      {action && (
        <button className="btn btn-v mt-4">
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * Data Table Component
 * Reusable table for displaying structured data
 */
export function DataTable({ columns, data, actions, loading = false }) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-12 skeleton" />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return <EmptyState title="No data" description="No records found matching your criteria" />;
  }

  return (
    <div className="overflow-x-auto card">
      <table className="w-full text-left table-sticky">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key}>
                {col.label}
              </th>
            ))}
            {actions && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {data.map((row, idx) => (
            <tr key={idx}>
              {columns.map((col) => (
                <td key={col.key} className="tabular-nums">
                  {col.render ? col.render(row[col.key], row) : row[col.key]}
                </td>
              ))}
              {actions && (
                <td>
                  <div className="flex gap-2">
                    {actions.map((action) => (
                      <button
                        key={action.id}
                        onClick={() => action.handler(row)}
                        className="text-[11px] font-semibold px-2.5 py-1.5 rounded-none transition-colors duration-150 cursor-pointer"
                        style={{
                          color: action.color || '#78716C',
                          backgroundColor: `${action.color || '#D6D3D1'}20`,
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Alert Banner Component
 * Shows alerts for important information
 */
export function AlertBanner({ type = 'info', title, message, action }) {
  const typeConfig = {
    info: { bg: 'bg-zinc-900/30', text: 'text-zinc-400', border: 'border-zinc-800' },
    warning: { bg: 'bg-amber-500/20', text: 'text-amber-400', border: 'border-amber-500/30' },
    error: { bg: 'bg-rose-900/20', text: 'text-rose-400', border: 'border-rose-900/50' },
    success: { bg: 'bg-emerald-900/20', text: 'text-emerald-400', border: 'border-emerald-900/50' },
  };

  const config = typeConfig[type];

  return (
    <div className={`p-4 rounded-none border ${config.bg} ${config.border}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className={`font-semibold text-[13px] ${config.text}`}>{title}</p>
          <p className={`text-[12px] mt-1 ${config.text}`}>{message}</p>
        </div>
        {action && (
          <button className={`text-[11px] font-semibold ${config.text} hover:underline ml-4 flex-shrink-0 cursor-pointer`}>
            {action}
          </button>
        )}
      </div>
    </div>
  );
}
