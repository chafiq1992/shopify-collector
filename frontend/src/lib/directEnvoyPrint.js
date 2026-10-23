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

// For a company with no partner API there is nothing to send: being in its
// envoy note is the whole hand-over. It still has to be confirmed by the agent,
// because routing puts every "Marrakech" order in the in-house Marrakech envoy
// and staff move the Marrakech-region parcels to a carrier (lionex3) from the
// company step. Treating the order as landed on arrival skipped that triage.
export function noPartnerApiSendState(envoyNote, { confirmed = false, companyId = "", cityName = "" } = {}) {
  const company = envoyNote?.company || "This company";
  return {
    ok: confirmed ? true : null,
    message: confirmed
      ? `${company} has no partner API. Its envoy note is the hand-over.`
      : `${company} has no partner API. Check the company and city, then confirm.`,
    sentAt: null,
    integrationFailure: false,
    noPartnerApi: true,
    // What was confirmed: changing any of it afterwards reopens the step.
    envoyCode: confirmed ? String(envoyNote?.code || "") : "",
    companyId: confirmed ? String(companyId || "") : "",
    cityName: confirmed ? String(cityName || "") : "",
  };
}

// True once the agent changes the company or city after confirming a no-API
// envoy: that change is not applied in Delivery yet, so the label must wait.
// Carrier sends are never reopened; re-sending would leave a ghost parcel.
export function confirmationOutdated(partnerSendState, { companyId, cityName } = {}) {
  if (partnerSendState?.ok !== true || !partnerSendState.noPartnerApi || !partnerSendState.companyId) return false;
  return String(companyId || "") !== partnerSendState.companyId
    || String(cityName || "") !== (partnerSendState.cityName || "");
}

// What the company step's button does for the company the agent picked: a
// partner company is sent the order; any other company is only confirmed
// (its envoy note and city are applied, nothing is sent).
export function companyStepActionLabel(company, partnerSendState = {}) {
  if (company && !company.partnerIntegrationId) return "Confirm Envoy & City";
  if (!company && partnerSendState?.noPartnerApi) return "Confirm Envoy & City";
  return partnerSendState?.ok === false ? "Resend to Partner" : "Send to Partner";
}
