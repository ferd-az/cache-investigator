export function displayInvestigationId(id: string) {
  return `INV-${id.replace(/^inv_/, "").slice(0, 6).toUpperCase()}`;
}
