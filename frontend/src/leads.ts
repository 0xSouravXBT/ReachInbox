const EMAIL_CANDIDATE_PATTERN = /[^\s,;"<>()[\]]+@[^\s,;"<>()[\]]+/g;

export interface ParsedLeads {
  recipients: string[];
  invalidCount: number;
  duplicatesRemoved: number;
}

export function parseLeadText(value: string): ParsedLeads {
  const candidates = (value.match(EMAIL_CANDIDATE_PATTERN) ?? [])
    .map((candidate) => candidate.replace(/[.,]+$/g, "").toLowerCase())
    .filter(Boolean);
  const unique = Array.from(new Set(candidates));
  const recipients = unique.filter(isValidEmail);

  return {
    recipients,
    invalidCount: unique.length - recipients.length,
    duplicatesRemoved: candidates.length - unique.length,
  };
}

function isValidEmail(value: string): boolean {
  if (value.length > 320 || /\s/.test(value) || value.includes("..")) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (
    !local ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) ||
    domain.length > 255
  ) {
    return false;
  }
  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)) &&
    /^[a-z]{2,}$/i.test(labels[labels.length - 1])
  );
}
