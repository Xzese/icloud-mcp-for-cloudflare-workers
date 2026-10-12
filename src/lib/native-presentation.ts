// Native Reminders returns a newly signed urgency asset URL on same-version
// reads. Its identity, encryption metadata and checksum remain stable. Limit
// this normalization to the proven field and retain every other property.
export function stableNativePresentation(fields: Record<string, unknown>): Record<string, unknown> {
  let stable = fields;
  // The List membership asset exhibits the same signed-URL-only read drift.
  for (const name of ["UrgentPresentationAlarmsAsData", "MembershipsOfRemindersInSectionsAsData", "GroceryLocalCorrectionsAsData", "SectionIDsOrderingAsData"]) {
    const field = fields[name];
    if (!field || typeof field !== "object" || Array.isArray(field) || !("type" in field) || field.type !== "ASSETID" || !("value" in field)) continue;
    const value = field.value;
    if (!value || typeof value !== "object" || Array.isArray(value) || !("downloadURL" in value) || typeof value.downloadURL !== "string") continue;
    const { downloadURL: _url, ...metadata } = value;
    stable = { ...stable, [name]: { ...field, value: metadata } };
  }
  return stable;
}
