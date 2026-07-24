const DIRECT_PRINT_COMPANY_KEYS = new Set([
  "oscario",
  "marrakech",
  "kech",
  "k",
]);

function normalizeCompanyKey(value) {
  return String(value || "").trim().toLowerCase();
}

export function isDirectEnvoyPrintCompany(company) {
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

  return values.some((value) => DIRECT_PRINT_COMPANY_KEYS.has(normalizeCompanyKey(value)));
}

export function canDirectPrintEnvoyLabel({ deliveryOrderId, envoyCode, company } = {}) {
  return Boolean(deliveryOrderId && envoyCode && isDirectEnvoyPrintCompany(company));
}
