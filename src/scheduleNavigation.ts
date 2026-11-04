let opener: ((id: string) => void) | null = null;
export function registerScheduleOpener(next: typeof opener): void { opener = next; }
export function openSchedule(id: string): void { opener?.(id); }
