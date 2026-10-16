/**
 * Inline SVG icons for the pairing panel (16px stroke style matching the
 * shell's nav icons). Held here rather than imported from
 * `@deepseek-ai/dsh-client-ui-primitives` so the panel's rendered tree carries
 * no closure-factory bundle import: the component stays renderable under the
 * package's own test runner.
 */
import type { SVGProps } from 'react'

/** Shared svg attrs for the 16px stroke icon family. */
function iconProps(props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    ...props,
  }
}

/** A QR-symbol glyph: three finder squares plus a payload dot. */
export function QrIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4z" />
      <path d="M9.5 9.5h1.6v1.6H9.5zM12.4 9.5h1.1M9.5 12.4v1.1M12 13.5h1.5v-1.5h-1.5z" />
    </svg>
  )
}

/** Copy glyph. */
export function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
      <path d="M2.5 10.5v-7A1.5 1.5 0 0 1 4 2h5.5" />
    </svg>
  )
}

/** Check glyph for the transient copied state. */
export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3 8.5 6.5 12l6.5-8" />
    </svg>
  )
}

/** Close glyph for the panel header. */
export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

/** Refresh glyph for the mint-again action. */
export function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M13 8a5 5 0 1 1-1.8-3.85" />
      <path d="M13.2 2.4V5.6H10" />
    </svg>
  )
}
