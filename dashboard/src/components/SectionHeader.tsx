import type { ReactNode } from "react";
import { usePageTitle } from "../lib/pageTitle";

interface Props {
  /** The plain name of the page. Rendered as the heading in the topbar. */
  title: string;
  /** Only when it states a fact the user cannot infer — a count or a range. */
  subtitle?: string;
  actions?: ReactNode;
}

export function SectionHeader({ title, subtitle, actions }: Props) {
  usePageTitle(title);
  if (!subtitle && !actions) return null;
  return (
    <div className="page-head">
      {subtitle && <p className="sub">{subtitle}</p>}
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
