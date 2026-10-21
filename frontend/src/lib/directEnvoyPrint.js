const UNASSIGNED_COMPANY_KEYS = new Set([
  "unassigned",
  "unas",
  "none",
  "no company",
]);

function normalizeCompanyKey(value) {
  return String(value || "").trim().toLowerCase();
}

export function isAssignedEnvoyCompany(company) {
  if (!company) return false;

  const values = typeof company === "object"
    ? [
        company.name,
        company.short,
        company.company,
        company.companyShort,
        company.company_short,
        company.partnerSlug,
        company.partner_slug,
        ...(Array.isArray(company.tags) ? company.tags : []),
      ]
    : [company];

  return values.some((value) => {
    const key = normalizeCompanyKey(value);
    return Boolean(key) && !UNASSIGNED_COMPANY_KEYS.has(key);
  });
}

// A company without a connected partner API (in-house drivers, carriers handed
// parcels at the counter) has nothing to accept the order, so being in its
// envoy note is what "landed" means. Every other company must accept the order
// before a label can print; there is no skip-the-partner path. Mirrors
// check_label_readiness in backend/app/delivery_sync.py, which enforces it.
export function envoyNeedsNoPartnerSend(envoyNote) {
  return Boolean(envoyNote) && !envoyNote.partnerId && isAssignedEnvoyCompany(envoyNote);
}
