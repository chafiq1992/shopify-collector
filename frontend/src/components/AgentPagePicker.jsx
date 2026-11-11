import React from "react";
import { clearAuth } from "../lib/auth";
import { readCurrentStore } from "../lib/stores";

export const AGENT_HOME = "/agent-pages";
const AGENT_PAGES = [
  { path: "/confirmation", label: "Confirmation", agentOnly: true },
  { path: "/verification", label: "Verification" },
  { path: "/order-lookup", label: "Order Lookup" },
  { path: "/inventory-helper", label: "Inventory Helper" },
];
export function hasStaffPagePicker(role) {
  return role === "agent" || role === "verificateur";
}

function availablePages(role) {
  return AGENT_PAGES.filter(page => !page.agentOnly || role === "agent");
}

export function staffPagePaths(role) {
  return [AGENT_HOME, ...availablePages(role).map(({ path }) => path)];
}

const controlClass = "inline-flex min-h-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50";

function PageLink({ path, className, children }) {
  const pageUrl = () => `${path}?store=${encodeURIComponent(readCurrentStore())}`;
  function openPage(event) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    history.pushState(null, "", pageUrl());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  return <a href={pageUrl()} onClick={openPage} className={className}>{children}</a>;
}

export function AgentPagesLink() {
  return <PageLink path={AGENT_HOME} className={controlClass}>Pages</PageLink>;
}

export function AgentLogoutButton() {
  function logout() {
    clearAuth();
    location.assign("/login");
  }
  return <button type="button" onClick={logout} className={controlClass}>Logout</button>;
}

export default function AgentPagePicker({ role }) {
  return (
    <main className="min-h-dvh bg-slate-50 px-4 py-6 text-slate-900">
      <div className="mx-auto max-w-xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold">Choose a page</h1>
          <AgentLogoutButton />
        </div>
        <nav aria-label="Staff pages" className="grid gap-3 sm:grid-cols-2">
          {availablePages(role).map(({ path, label }) => (
            <PageLink key={path} path={path} className="rounded-xl border border-slate-200 bg-white px-4 py-4 text-sm font-semibold shadow-sm hover:border-indigo-300 hover:bg-indigo-50">
              {label}
            </PageLink>
          ))}
        </nav>
      </div>
    </main>
  );
}
