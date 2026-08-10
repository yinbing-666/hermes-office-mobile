export type OfficeIconName = 'office' | 'workspace' | 'agent' | 'growth' | 'activity' | 'workflow' | 'monitor' | 'coffee' | 'file' | 'search' | 'message' | 'database' | 'refresh' | 'check' | 'alert' | 'user' | 'terminal' | 'clock' | 'send' | 'chevron' | 'evolution' | 'knowledge' | 'cost';

type LegacyOfficeIconName = Exclude<OfficeIconName, 'evolution' | 'knowledge' | 'cost'>;

const paths: Record<LegacyOfficeIconName, string[]> = {
  office: ['M8 22V9l8-4 8 4v13', 'M5 22h22', 'M12 22v-7h8v7', 'M11 11h2M19 11h2'],
  workspace: ['M5 10h9l2 3h11v13H5Z', 'M5 10V7h9l2 3', 'M10 18h12M10 22h8'],
  agent: ['M12 7h8a5 5 0 0 1 5 5v5a5 5 0 0 1-5 5h-8a5 5 0 0 1-5-5v-5a5 5 0 0 1 5-5Z', 'M16 7V4', 'M12 14h.01M20 14h.01', 'M13 18h6'],
  growth: ['M16 25V12', 'M16 12c-4 0-7-2-8-6 5 0 8 2 8 6Z', 'M16 16c4 0 7-2 8-6-5 0-8 2-8 6Z'],
  activity: ['M7 7h18v18H7Z', 'M11 12h10M11 17h10M11 22h6'],
  workflow: ['M8 10h6v6H8Z', 'M18 16h6v6h-6Z', 'M14 13h4', 'M21 16V10h-5'],
  monitor: ['M6 7h20v13H6Z', 'M12 25h8', 'M16 20v5'],
  coffee: ['M9 11h12v5a6 6 0 0 1-6 6 6 6 0 0 1-6-6v-5Z', 'M21 13h2a3 3 0 0 1 0 6h-2', 'M11 7v-2M16 7v-2'],
  file: ['M10 5h8l5 5v17H10Z', 'M18 5v6h5', 'M13 16h7M13 21h7'],
  search: ['M14 22a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z', 'M20 20l6 6'],
  message: ['M7 8h18v12H12l-5 5V8Z', 'M11 13h10M11 17h6'],
  database: ['M8 9c0-2 4-4 8-4s8 2 8 4-4 4-8 4-8-2-8-4Z', 'M8 9v10c0 2 4 4 8 4s8-2 8-4V9', 'M8 14c0 2 4 4 8 4s8-2 8-4'],
  refresh: ['M24 12a8 8 0 0 0-14-4l-2 3', 'M8 6v5h5', 'M8 20a8 8 0 0 0 14 4l2-3', 'M24 26v-5h-5'],
  check: ['M7 16l6 6 12-13'],
  alert: ['M16 5l12 22H4L16 5Z', 'M16 12v6M16 22h.01'],
  user: ['M16 16a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', 'M7 27c1.5-5 16.5-5 18 0'],
  terminal: ['M7 9h18v14H7Z', 'M11 14l3 2-3 2', 'M16 19h5'],
  clock: ['M16 6a10 10 0 1 1-10 10A10 10 0 0 1 16 6Z', 'M16 10v6l4 2'],
  send: ['M5 16 27 6l-7 21-4-8-7-3Z', 'M16 19 27 6'],
  chevron: ['m13 9 7 7-7 7'],
};

const tabPaths: Record<'office' | 'agent' | 'evolution' | 'knowledge' | 'cost', string[]> = {
  office: ['M4 20.5h16', 'M5.5 20.5V5.5h13v15', 'M8.5 9h2M14 9h2M8.5 12.5h2M14 12.5h2', 'M9 20.5v-4h6v4'],
  agent: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4.5 20c.8-3.2 3.3-5 7.5-5s6.7 1.8 7.5 5', 'M7.5 19.5h9'],
  evolution: ['M3.5 17.5 8.5 12l3.5 3 8.5-8', 'M16.5 7H20v3.5', 'M3.5 20.5h17'],
  knowledge: ['M4 5.5c2.7-.8 5.3-.3 8 1.3v13c-2.7-1.6-5.3-2.1-8-1.3Z', 'M20 5.5c-2.7-.8-5.3-.3-8 1.3v13c2.7-1.6 5.3-2.1 8-1.3Z', 'M12 6.8v13'],
  cost: ['M4 20h16', 'M7 20v-5M12 20v-8M17 20v-11', 'M7.5 4.5h4a2.5 2.5 0 1 1 0 5h-4a2.5 2.5 0 1 0 0 5h4', 'M9.5 3v2M9.5 16v2'],
};

const tabIconNames = new Set<OfficeIconName>(['office', 'agent', 'evolution', 'knowledge', 'cost']);

export function OfficeIcon({ name, size = 22, className = '' }: { name: OfficeIconName; size?: number; className?: string }) {
  const isTabIcon = tabIconNames.has(name);
  const iconPaths = isTabIcon ? tabPaths[name as keyof typeof tabPaths] : paths[name as LegacyOfficeIconName];
  return (
    <svg className={`office-icon ${className}`} width={size} height={size} viewBox={isTabIcon ? '0 0 24 24' : '0 0 32 32'} fill="none" aria-hidden="true">
      {iconPaths.map((d) => (
        <path key={d} d={d} stroke="currentColor" strokeWidth={isTabIcon ? 1.5 : 1.8} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}
