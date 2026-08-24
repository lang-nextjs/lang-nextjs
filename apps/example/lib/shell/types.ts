import type { ComponentType } from "react";

/**
 * Nav shapes, owned by the shell rather than by the component that renders them.
 *
 * These lived in components/shell/AppSidebar.tsx, which made lib/ depend on
 * components/ — backwards, and awkward for anyone consuming rungNavGroups()
 * without wanting the sidebar. The renderer should depend on the data shape,
 * not the other way round.
 */
export type NavItem = {
  title: string;
  /** null renders a non-interactive entry — for a rung declared but absent. */
  href: string | null;
  icon?: ComponentType<{ className?: string }>;
  external?: boolean;
  note?: string;
};

export type NavGroup = { label: string; items: NavItem[] };
