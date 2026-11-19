export function splitSshAddress(value: string): { address: string; username: string } {
  const separator = value.lastIndexOf("@");
  return separator < 0 ? { address: value, username: "" } : { address: value.slice(separator + 1), username: value.slice(0, separator) };
}

export function joinSshAddress(address: string, username: string): string {
  return username ? `${username}@${address}` : address;
}

/** Literal IPs are devices, not configured SSH aliases with their own User. */
export function needsSshUsername(value: string): boolean {
  const { address, username } = splitSshAddress(value.trim());
  const ip = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) || /^\[?[a-f\d:]+(?:%[\w.-]+)?\]?$/i.test(address) && address.includes(":");
  return ip && !username.trim();
}

export function canConnectSshAddress(value: string): boolean {
  return !!splitSshAddress(value.trim()).address.trim() && !needsSshUsername(value);
}
