// `{{DYNAMIC_GEO}}` used to resolve the user's country through third-party IP
// lookups, which sent the user's IP off-device. Only a fixed two-letter country
// code from the pinned recipe, or none, is accepted now.
export function pinnedGeoLocation(value) {
  const geoLocation = value ?? "";
  if (geoLocation === "" || /^[A-Za-z]{2}$/.test(geoLocation)) return geoLocation;
  throw new Error("CONFIG_REJECTED");
}
