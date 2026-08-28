import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useLocation } from "react-router-dom";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { completedCacheKeyRegression } from "@/fixtures/cache-key-regression";
import { unresolvedInvestigation } from "@/pages/investigations-page";

export function SiteHeader() {
  const { pathname } = useLocation();
  const investigationId = pathname.match(/^\/i\/([^/]+)$/)?.[1];
  const investigationTitle =
    investigationId === completedCacheKeyRegression.id
      ? completedCacheKeyRegression.title
      : investigationId === unresolvedInvestigation.id
        ? unresolvedInvestigation.title
        : investigationId
          ? "Investigation"
          : null;

  return (
    <header className="flex h-(--header-height) shrink-0 items-center">
      <div className="flex w-full items-center gap-2 px-4 lg:px-5">
        <SidebarTrigger className="-ml-1" />
        {investigationTitle ? (
          <nav
            className="flex min-w-0 items-center gap-1.5 text-sm"
            aria-label="Breadcrumb"
          >
            <Link
              className="shrink-0 font-medium text-[#3e3e44] hover:text-black"
              to="/"
            >
              Investigations
            </Link>
            <HugeiconsIcon
              className="shrink-0 text-[#aaaab1]"
              icon={ArrowRight01Icon}
              size={13}
              strokeWidth={1.6}
              aria-hidden="true"
            />
            <span
              className="truncate text-[#7a7a82]"
              aria-current="page"
              title={investigationTitle}
            >
              {investigationTitle}
            </span>
          </nav>
        ) : (
          <h1 className="text-sm font-medium">Investigations</h1>
        )}
      </div>
    </header>
  );
}
