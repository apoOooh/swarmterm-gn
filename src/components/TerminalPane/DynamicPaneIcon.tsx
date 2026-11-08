import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic'

const KNOWN_ICON_NAMES = new Set<string>(iconNames)

interface DynamicPaneIconProps {
  icon: string
  className?: string
  style?: CSSProperties
  /** Shown while the icon loads and for a name lucide does not know. */
  fallback: ReactNode
}

/**
 * Any lucide icon by name. Lives in its own module and is only reached through
 * React.lazy in PaneIdentityIcon: `lucide-react/dynamic` carries the import map
 * of every icon, which must not ride in the startup bundle. An unknown name
 * (hand-edited save file) shows the caller's fallback, never a blank slot.
 */
export default function DynamicPaneIcon({ icon, className, style, fallback }: DynamicPaneIconProps): ReactElement {
  if (!KNOWN_ICON_NAMES.has(icon)) return <>{fallback}</>
  return <DynamicIcon name={icon as IconName} aria-hidden className={className} style={style} fallback={() => <>{fallback}</>} />
}
