import { createContext, useContext, useEffect } from "react";
import { useLocation } from "react-router-dom";
import type { ReactNode } from "react";

export interface PageTitleState {
  /** The route the title belongs to — a stale title never outlives its page. */
  path: string;
  title: string;
}

const PageTitleContext = createContext<(next: PageTitleState) => void>(() => {});

export function PageTitleProvider({
  onTitle,
  children,
}: {
  onTitle: (next: PageTitleState) => void;
  children: ReactNode;
}) {
  return <PageTitleContext.Provider value={onTitle}>{children}</PageTitleContext.Provider>;
}

/** Publish this page's name to the topbar. The heading itself lives there. */
export function usePageTitle(title: string) {
  const set = useContext(PageTitleContext);
  const { pathname } = useLocation();
  useEffect(() => {
    set({ path: pathname, title });
  }, [set, pathname, title]);
}
