import type { ReactElement } from 'react'
import {
  Bird, BookOpen, Bot, Brain, Bug, Cat, Cloud, Code, Compass, Crown, Database, Dog, Eye, Fish, Flag, Flame,
  GitBranch, Globe, Hammer, Heart, Layers, ListChecks, MessageSquare, Moon, Package, Palette, Pencil, Rocket,
  Search, Server, Shield, Sparkles, Star, Sun, Terminal, TestTube, User, Users, Wrench, Zap,
  type LucideIcon
} from 'lucide-react'
import { isPaneIconId, type PaneIconId } from '@/lib/pane-identity'
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

/** A pane identity icon: a curated lucide glyph tinted with the identity color, or an emoji as-is. */
export function PaneIdentityIcon({ icon, color, className }: PaneIdentityIconProps): ReactElement {
  if (isPaneIconId(icon)) {
    const Icon = PANE_ICON_COMPONENTS[icon]
    return <Icon aria-hidden className={cn('h-3.5 w-3.5 shrink-0', className)} style={color ? { color } : undefined} />
  }
  return <span aria-hidden className={cn('shrink-0 text-xs leading-none', className)}>{icon}</span>
}
