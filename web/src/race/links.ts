/** Google Maps driving directions from a street-address origin to a point. */
export function gmapsDirectionsUrl(originAddress: string, lat: number, lon: number): string {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originAddress)}&destination=${lat},${lon}`;
}
