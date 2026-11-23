/** A selected parent gets a project subfolder; a selected project folder is reused. */
export function machineProjectClonePath(folder: string, projectName: string, windows: boolean): string {
  const separator = windows && folder.includes("\\") ? "\\" : "/";
  const parent = folder.trim().replace(windows ? /[\\/]+$/ : /\/+$/, "");
  const leaf = parent.split(windows ? /[\\/]/ : /\//).pop();
  if (windows ? leaf?.toLowerCase() === projectName.toLowerCase() : leaf === projectName) return parent;
  return `${parent}${separator}${projectName}`;
}
