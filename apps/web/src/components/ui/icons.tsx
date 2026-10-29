import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/** Small stroke icons (24px grid). Decorative by default: callers add a text label or aria-label. */
function base({ size = 20, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const CalendarIcon = (p: IconProps) => base({ ...p, children: (<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>) });
export const PlusIcon = (p: IconProps) => base({ ...p, children: <path d="M12 5v14M5 12h14" /> });
export const MenuIcon = (p: IconProps) => base({ ...p, children: <path d="M4 6h16M4 12h16M4 18h16" /> });
export const LogOutIcon = (p: IconProps) => base({ ...p, children: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /> });
export const SearchIcon = (p: IconProps) => base({ ...p, children: (<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>) });
export const MapPinIcon = (p: IconProps) => base({ ...p, children: (<><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></>) });
export const BellIcon = (p: IconProps) => base({ ...p, children: (<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>) });
export const CheckIcon = (p: IconProps) => base({ ...p, children: <path d="m5 12 5 5L20 7" /> });
export const XIcon = (p: IconProps) => base({ ...p, children: <path d="M18 6 6 18M6 6l12 12" /> });
export const AlertIcon = (p: IconProps) => base({ ...p, children: (<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>) });
export const InfoIcon = (p: IconProps) => base({ ...p, children: (<><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>) });
export const ClockIcon = (p: IconProps) => base({ ...p, children: (<><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>) });
export const ListIcon = (p: IconProps) => base({ ...p, children: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /> });
export const MapIcon = (p: IconProps) => base({ ...p, children: (<><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z" /><path d="M9 3v15M15 6v15" /></>) });
export const FilterIcon = (p: IconProps) => base({ ...p, children: <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" /> });
export const ChevronDownIcon = (p: IconProps) => base({ ...p, children: <path d="m6 9 6 6 6-6" /> });
export const ChevronRightIcon = (p: IconProps) => base({ ...p, children: <path d="m9 6 6 6-6 6" /> });
export const ArrowRightIcon = (p: IconProps) => base({ ...p, children: <path d="M5 12h14M12 5l7 7-7 7" /> });
export const ArrowLeftIcon = (p: IconProps) => base({ ...p, children: <path d="M19 12H5M12 19l-7-7 7-7" /> });
export const ExternalIcon = (p: IconProps) => base({ ...p, children: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /> });
export const NavigationIcon = (p: IconProps) => base({ ...p, children: <path d="m3 11 19-9-9 19-2-8-8-2Z" /> });
export const MailIcon = (p: IconProps) => base({ ...p, children: (<><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></>) });
export const StoreIcon = (p: IconProps) => base({ ...p, children: (<><path d="M4 9 5.5 4h13L20 9" /><path d="M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0A2.7 2.7 0 0 0 20 9" /><path d="M5 12v8h14v-8M10 20v-5h4v5" /></>) });
export const SwapIcon = (p: IconProps) => base({ ...p, children: <path d="m17 3 4 4-4 4M21 7H8M7 21l-4-4 4-4M3 17h13" /> });
export const TrashIcon = (p: IconProps) => base({ ...p, children: <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /> });
export const PulseIcon = (p: IconProps) => base({ ...p, children: <path d="M22 12h-4l-3 9L9 3l-3 9H2" /> });
export const RefreshIcon = (p: IconProps) => base({ ...p, children: <path d="M21 12a9 9 0 0 0-15.5-6.3L3 8M3 3v5h5M3 12a9 9 0 0 0 15.5 6.3L21 16M21 21v-5h-5" /> });
export const CrosshairIcon = (p: IconProps) => base({ ...p, children: (<><circle cx="12" cy="12" r="8" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>) });
export const PhoneIcon = (p: IconProps) => base({ ...p, children: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.2-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.8 2.1Z" /> });

/** The MedLink mark: a capsule over a location pin, drawn as one shape. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="4" fill="var(--brand)" />
      <path d="M16 6.5a7.5 7.5 0 0 0-7.5 7.5c0 5.4 7.5 11.5 7.5 11.5s7.5-6.1 7.5-11.5A7.5 7.5 0 0 0 16 6.5Z" fill="var(--on-brand)" opacity=".18" />
      <rect x="11" y="9.5" width="10" height="13" rx="5" transform="rotate(35 16 16)" fill="none" stroke="var(--on-brand)" strokeWidth="2" />
      <path d="m12.6 12.4 6.8 7.2" stroke="var(--on-brand)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The Google "G" in Google's own colours (it is a brand mark, so it does not follow the theme). Decorative: the button carries the label. */
export const GoogleIcon = ({ size = 20, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false" {...rest}>
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5Z" />
    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5Z" />
    <path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1Z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48Z" />
  </svg>
);
