// Authenticated portal shell. Branded header with school name + logo,
// horizontal nav, footer. Per-school primary color is injected via
// CSS custom properties so every page picks it up automatically.

import Link from 'next/link';
import { Home, Users, FileText, FilePen, MessageSquare, CreditCard, HandCoins, UserCheck, LogOut, ShoppingBag, BookOpen, Receipt } from 'lucide-react';
import { requireParent } from '@/lib/identity';

export const dynamic = 'force-dynamic';

const NAV_ITEMS = [
  { href: '/home', label: 'Home', icon: Home },
  { href: '/attendance', label: 'Attendance', icon: UserCheck },
  { href: '/family', label: 'Family', icon: Users },
  { href: '/forms-v2', label: 'Forms', icon: FilePen },
  { href: '/resources', label: 'Important Documents', icon: BookOpen },
  { href: '/forms', label: 'Documents', icon: FileText },
  { href: '/messages', label: 'Messages', icon: MessageSquare },
  { href: '/tuition', label: 'Tuition', icon: CreditCard },
  { href: '/billing', label: 'Invoices', icon: Receipt },
  { href: '/financial-aid', label: 'Financial Aid', icon: HandCoins },
  { href: '/products', label: 'School Store', icon: ShoppingBag },
];

// Per-school nav-item hide list. Keyed by school_id. Values are the
// `href` values from NAV_ITEMS above. Eventually this moves into
// school_branding (or a new school_portal_config) so operators can
// toggle it without a code change. Hardcoded for now while Wooster is
// still in migration: we only want them seeing Family + Forms +
// Documents until the rest of the modules are ready for them.
const HIDDEN_NAV_BY_SCHOOL: Record<string, Set<string>> = {
  // Montessori School of Wooster — keep them on Family + Forms + Documents
  // until other modules are migration-ready for them. Adding /products
  // explicitly so it doesn't appear until Wooster opts in.
  '2c944223-b2ad-45e1-8ba4-a4b616e4c29a': new Set([
    '/attendance', '/messages', '/tuition', '/billing', '/financial-aid', '/products',
  ]),
};

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const id = await requireParent();
  const b = id.branding;

  return (
    <div
      className="flex min-h-screen flex-col"
      style={{
        // Per-school theming — overrides the defaults from globals.css
        ['--brand' as string]: b.primary_color,
        ['--brand-soft' as string]: b.primary_color_soft,
        ['--brand-fg' as string]: b.primary_color_fg,
      }}
    >
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            {b.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.logo_url} alt="" className="h-8 w-8 rounded object-contain" />
            ) : (
              <div className="h-8 w-8 rounded" style={{ background: 'var(--brand)' }} />
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-gray-900">
                {b.display_name}
              </div>
              <div className="truncate text-[11px] text-gray-500">Family Portal</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-gray-600 sm:inline">
              {id.parent.first_name} {id.parent.last_name}
            </span>
            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
              >
                <LogOut className="h-3 w-3" /> Sign out
              </button>
            </form>
          </div>
        </div>
        <nav className="border-t border-gray-100 bg-gray-50">
          <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-2">
            {NAV_ITEMS
              .filter((item) => !(HIDDEN_NAV_BY_SCHOOL[id.school.id]?.has(item.href)))
              .map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm text-gray-700 hover:text-gray-900 hover:bg-white"
                  >
                    <Icon className="h-4 w-4" /> {item.label}
                  </Link>
                );
              })}
          </div>
        </nav>
      </header>

      <main className="flex-1">
        <div className="mx-auto max-w-5xl px-4 py-6">{children}</div>
      </main>

      <footer className="border-t border-gray-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-4 text-xs text-gray-500">
          {b.footer_html ? (
            <div dangerouslySetInnerHTML={{ __html: b.footer_html }} />
          ) : (
            <div className="flex flex-col gap-1 sm:flex-row sm:justify-between">
              <span>© {b.display_name}</span>
              {(b.support_email || b.support_phone) && (
                <span>
                  Need help?{' '}
                  {b.support_email ? (
                    <a href={`mailto:${b.support_email}`} className="underline">
                      {b.support_email}
                    </a>
                  ) : null}
                  {b.support_email && b.support_phone ? ' · ' : ''}
                  {b.support_phone ? <a href={`tel:${b.support_phone}`}>{b.support_phone}</a> : null}
                </span>
              )}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
