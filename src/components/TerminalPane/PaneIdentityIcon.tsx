import type { ReactElement } from 'react'
import {
  Bird, BookOpen, Bot, Brain, Bug, Cat, Cloud, Code, Compass, Crown, Database, Dog, Eye, Fish, Flag, Flame,
  GitBranch, Globe, Hammer, Heart, Layers, ListChecks, MessageSquare, Moon, Package, Palette, Pencil, Rocket,
  Search, Server, Shield, Sparkles, Star, Sun, Terminal, TestTube, User, Users, Wrench, Zap,
  type LucideIcon
} from 'lucide-react'
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic'
import { isIconNameShape, isPaneIconId, type PaneIconId } from '@/lib/pane-identity'
import { cn } from '@/lib/utils'

export const PANE_ICON_COMPONENTS: Record<PaneIconId, LucideIcon> = {
  bot: Bot, brain: Brain, code: Code, bug: Bug, search: Search, shield: Shield, wrench: Wrench, rocket: Rocket,
  'book-open': BookOpen, pencil: Pencil, 'test-tube': TestTube, database: Database, server: Server, cloud: Cloud,
  globe: Globe, terminal: Terminal, 'git-branch': GitBranch, eye: Eye, zap: Zap, star: Star, flag: Flag,
  crown: Crown, heart: Heart, flame: Flame, sparkles: Sparkles, compass: Compass, hammer: Hammer,
  package: Package, palette: Palette, layers: Layers, 'list-checks': ListChecks, 'message-square': MessageSquare,
  user: User, users: Users, cat: Cat, dog: Dog, bird: Bird, fish: Fish, sun: Sun, moon: Moon
}

interface PaneIdentityIconProps {
  icon: string
  color?: string
  className?: string
}

/** Every lucide icon name, for the picker's search. */
export const ALL_ICON_NAMES: readonly string[] = iconNames
const KNOWN_ICON_NAMES = new Set<string>(iconNames)

/**
 * A pane identity icon: a lucide glyph tinted with the identity color, or an
 * emoji as-is. Suggested icons are static imports; any other lucide name is
 * loaded on demand (its own small chunk), so the full set costs nothing until
 * used. A name lucide does not know (hand-edited save file) renders nothing.
 */
export function PaneIdentityIcon({ icon, color, className }: PaneIdentityIconProps): ReactElement | null {
  const style = color ? { color } : undefined
  if (isPaneIconId(icon)) {
    const Icon = PANE_ICON_COMPONENTS[icon]
    return <Icon aria-hidden className={cn('h-3.5 w-3.5 shrink-0', className)} style={style} />
  }
  if (isIconNameShape(icon)) {
    if (!KNOWN_ICON_NAMES.has(icon)) return null
    return <DynamicIcon name={icon as IconName} aria-hidden className={cn('h-3.5 w-3.5 shrink-0', className)} style={style} />
  }
  return <span aria-hidden className={cn('shrink-0 text-xs leading-none', className)}>{icon}</span>
}
