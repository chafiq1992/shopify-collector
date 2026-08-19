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

export function canDirectPrintEnvoyLabel({ deliveryOrderId, envoyCode, company, partnerSendState } = {}) {
  return Boolean(
    deliveryOrderId &&
    envoyCode &&
    partnerSendState?.ok === false &&
    partnerSendState?.integrationFailure === true &&
    isAssignedEnvoyCompany(company)
  );
}
