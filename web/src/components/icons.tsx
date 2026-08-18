/**
 * Hand-authored inline SVG glyphs, each a 16x16 stroke icon that inherits colour from
 * `currentColor`. Every glyph is `aria-hidden="true"` and `focusable="false"` — it is never a
 * control's accessible name, so callers supply `aria-label` on the element that hosts it.
 */
interface IconProps {
  size?: number;
  className?: string;
}

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function IconCheck({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
    </svg>
  );
}

/** Panel-with-rail glyph marking the sidebar collapse control. */
export function IconPanelLeft({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.5 3V13" />
    </svg>
  );
}

export function IconAlertTriangle({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M8 2L14.5 13.5H1.5Z" />
      <path d="M8 6.5V9.5" />
      <path d="M8 11.5H8.01" />
    </svg>
  );
}

export function IconXOctagon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M5.5 1.5H10.5L14.5 5.5V10.5L10.5 14.5H5.5L1.5 10.5V5.5Z" />
      <path d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5" />
    </svg>
  );
}

export function IconInfoSquare({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
      <path d="M8 7V11.5" />
      <path d="M8 4.5H8.01" />
    </svg>
  );
}

export function IconChevronDown({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M4 6L8 10L12 6" />
    </svg>
  );
}

export function IconChevronRight({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M6 4L10 8L6 12" />
    </svg>
  );
}

export function IconX({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M4 4L12 12M12 4L4 12" />
    </svg>
  );
}

export function IconMenu({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M2 4H14M2 8H14M2 12H14" />
    </svg>
  );
}

export function IconSun({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1V2.5M8 13.5V15M1 8H2.5M13.5 8H15" />
      <path d="M3.05 3.05L4.11 4.11M11.89 11.89L12.95 12.95M3.05 12.95L4.11 11.89M11.89 4.11L12.95 3.05" />
    </svg>
  );
}

export function IconMoon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M14 8.5A6 6 0 1 1 7.5 2A4.7 4.7 0 0 0 14 8.5Z" />
    </svg>
  );
}

export function IconMonitor({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
      <path d="M5.5 14.5H10.5M8 11.5V14.5" />
    </svg>
  );
}

export function IconLink({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M6.5 9.5a3 3 0 0 0 4.5.32l2-2a3 3 0 0 0-4.24-4.24l-1 1" />
      <path d="M9.5 6.5a3 3 0 0 0-4.5-.32l-2 2a3 3 0 0 0 4.24 4.24l1-1" />
    </svg>
  );
}

export function IconDownload({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M8 2V10M8 10L5 7M8 10L11 7" />
      <path d="M2.5 12.5V13.5A1 1 0 0 0 3.5 14.5H12.5A1 1 0 0 0 13.5 13.5V12.5" />
    </svg>
  );
}

export function IconCopy({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
      <path d="M3.5 10.5H2.5A1 1 0 0 1 1.5 9.5V2.5A1 1 0 0 1 2.5 1.5H9.5A1 1 0 0 1 10.5 2.5V3.5" />
    </svg>
  );
}

export function IconHome({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M2 8L8 2.5L14 8" />
      <path d="M4 6.5V13.5H12V6.5" />
    </svg>
  );
}

export function IconMessageCircle({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M2.5 8A5.5 5.5 0 1 1 5.2 12.7L2 13.5L2.9 10.4A5.47 5.47 0 0 1 2.5 8Z" />
    </svg>
  );
}

export function IconFileText({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M4 1.5H10L13 4.5V14.5H4Z" />
      <path d="M10 1.5V4.5H13" />
      <path d="M6 8H11M6 10.5H11" />
    </svg>
  );
}

export function IconSearch({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.3 10.3L14 14" />
    </svg>
  );
}

export function IconFolder({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M1.5 4.5A1 1 0 0 1 2.5 3.5H6L7.5 5H13.5A1 1 0 0 1 14.5 6V12.5A1 1 0 0 1 13.5 13.5H2.5A1 1 0 0 1 1.5 12.5Z" />
    </svg>
  );
}

export function IconDatabase({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <ellipse cx="8" cy="3.5" rx="5.5" ry="2" />
      <path d="M2.5 3.5V12.5C2.5 13.6 5 14.5 8 14.5C11 14.5 13.5 13.6 13.5 12.5V3.5" />
      <path d="M2.5 8C2.5 9.1 5 10 8 10C11 10 13.5 9.1 13.5 8" />
    </svg>
  );
}

export function IconActivity({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <path d="M1.5 8H5L6.5 3.5L9.5 12.5L11 8H14.5" />
    </svg>
  );
}

export function IconKey({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <circle cx="5.5" cy="10.5" r="3" />
      <path d="M7.7 8.3L14 2" />
      <path d="M11 5L13 7" />
    </svg>
  );
}

export function IconClipboard({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...strokeProps}
    >
      <rect x="3" y="2.5" width="10" height="12" rx="1.5" />
      <rect x="6" y="1.5" width="4" height="2" rx="0.5" />
      <path d="M6 8H10M6 11H10" />
    </svg>
  );
}
