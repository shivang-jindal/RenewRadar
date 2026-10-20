/** Presentation helpers. Money is always formatted from integer minor units. */

import { currencyExponent, formatMinorAsDecimal } from '@renewradar/shared';

export function formatMoney(minor: number, currency: string): string {
  const symbol = SYMBOLS[currency.toUpperCase()] ?? `${currency} `;
  const decimals = currencyExponent(currency);
  const negative = minor < 0;
  const [whole, fraction = ''] = formatMinorAsDecimal(Math.abs(minor), currency).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = decimals > 0 ? `${grouped}.${fraction}` : grouped;
  return `${negative ? '-' : ''}${symbol}${body}`;
}

/** Grouped totals without a currency symbol, for per-currency tables. */
export function formatAmount(minor: number, currency: string): string {
  return `${formatMinorAsDecimal(minor, currency)} ${currency.toUpperCase()}`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return formatter.format(diffHours, 'hour');
  return formatter.format(Math.round(diffHours / 24), 'day');
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

const SYMBOLS: Record<string, string> = {
  AUD: 'A$',
  BRL: 'R$',
  CAD: 'C$',
  CHF: 'CHF ',
  CNY: 'CN¥',
  EUR: '€',
  GBP: '£',
  INR: '₹',
  JPY: '¥',
  KRW: '₩',
  MXN: 'MX$',
  NGN: '₦',
  NZD: 'NZ$',
  PHP: '₱',
  PLN: 'zł ',
  SGD: 'S$',
  THB: '฿',
  TRY: '₺',
  TWD: 'NT$',
  USD: '$',
  VND: '₫',
  ZAR: 'R',
};